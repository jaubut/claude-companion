import { readSecretValue } from "./secret-store"

// tls-dashboard-v2 client for Quick Capture + receipts. Auth is the headless
// admin header `X-API-Key: <TLS_DASHBOARD_API_KEY>`, the key read per call from
// the vault store (~/.config/tls-agent/secrets.env) — never from process.env,
// never logged, never put in an error. Base URL: COMPANION_DASHBOARD_URL
// (default https://jeremie.apies.dev). Redirects are refused: the key header
// must never follow a 30x to another origin.

export const DASHBOARD_KEY_NAME = "TLS_DASHBOARD_API_KEY"
const DEFAULT_URL = "https://jeremie.apies.dev"
const DEFAULT_TIMEOUT_MS = 15_000
// extract = image → B&W PDF (puppeteer) + a vision call: slow by design.
export const EXTRACT_TIMEOUT_MS = 120_000

export class DashboardKeyMissing extends Error {
  constructor() { super("dashboard_key_missing"); this.name = "DashboardKeyMissing" }
}

/** Network error, timeout, redirect or 5xx/429: worth a retry later. */
export class DashboardUnreachable extends Error {
  constructor(public readonly status: number, reason: string) {
    super(`dashboard unreachable: ${reason}`)
    this.name = "DashboardUnreachable"
  }
}

export interface DashReply { status: number; json: Record<string, unknown> | null }

export function dashboardBase(): string {
  const raw = (process.env.COMPANION_DASHBOARD_URL || DEFAULT_URL).trim()
  return raw.replace(/\/+$/, "")
}

export function dashboardKey(): string | null {
  return readSecretValue(DASHBOARD_KEY_NAME)
}

/** `accounting/2026-10/x` → `accounting/2026-10/x` with each segment encoded. */
export function encodeIdPath(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/")
}

async function send(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const key = dashboardKey()
  if (!key) throw new DashboardKeyMissing()
  const headers: Record<string, string> = { "X-API-Key": key, Accept: "application/json" }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  let res: Response
  try {
    res = await fetch(dashboardBase() + path, {
      method, headers, redirect: "manual",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new DashboardUnreachable(0, e instanceof Error ? e.name : "network")
  }
  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel()
    throw new DashboardUnreachable(res.status, "redirect refused")
  }
  if (res.status >= 500 || res.status === 429) {
    void res.body?.cancel()
    throw new DashboardUnreachable(res.status, `http ${res.status}`)
  }
  return res
}

/** Any JSON body (arrays included); `value` is undefined for a non-JSON body. Same error rules as dashboardJson. */
export async function dashboardValue(method: string, path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ status: number; value: unknown }> {
  const res = await send(method, path, body, timeoutMs)
  const text = await res.text().catch(() => "")
  try {
    return { status: res.status, value: JSON.parse(text) as unknown }
  } catch {
    return { status: res.status, value: undefined } // non-JSON body (e.g. an HTML 404)
  }
}

/** JSON call. 4xx come back as a reply (caller decides); 5xx/network throw. */
export async function dashboardJson(method: string, path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DashReply> {
  const { status, value } = await dashboardValue(method, path, body, timeoutMs)
  const json = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  return { status, json }
}

/** Raw bytes (receipt PDF, voice memo audio). null on 404. */
export async function dashboardBytes(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const res = await send("GET", path, undefined, timeoutMs)
  if (res.status === 404) { void res.body?.cancel(); return null }
  if (!res.ok) { void res.body?.cancel(); throw new DashboardUnreachable(res.status, `http ${res.status}`) }
  const mime = res.headers.get("content-type") || "application/octet-stream"
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime }
}

// ── Typed calls ──

export function postInbox(text: string, typeHint: string): Promise<DashReply> {
  return dashboardJson("POST", "/api/inbox", { raw_text: text, type_hint: typeHint })
}

export function extractReceipt(input: { image?: string; pdf?: string }): Promise<DashReply> {
  return dashboardJson("POST", "/api/expense/extract", input, EXTRACT_TIMEOUT_MS)
}

export function saveExpense(fields: Record<string, unknown>): Promise<DashReply> {
  return dashboardJson("POST", "/api/expense/save", fields, 60_000)
}

export function patchExpense(id: string, fields: Record<string, unknown>): Promise<DashReply> {
  return dashboardJson("PATCH", `/api/expense/${encodeIdPath(id)}`, fields)
}

/** `{km, method, lat, lon}` | `{km: null, reason}` — tls-dashboard-v2 POST /api/geo/office-distance (Granby office). */
export function officeDistance(address: string): Promise<DashReply> {
  return dashboardJson("POST", "/api/geo/office-distance", { address })
}

export function fetchReceiptFile(filename: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  return dashboardBytes(`/api/expense/receipt/${encodeURIComponent(filename)}`)
}

// ── Voice memos (inbox_entries rows with type_hint "voice-memo") ──

// Deepgram on a 30-min memo, a ~30 MB audio download: both outlast the default.
export const VOICE_SLOW_TIMEOUT_MS = 120_000

export function startRecording(mime: string, typeHint: string): Promise<DashReply> {
  return dashboardJson("POST", "/api/inbox/recording/start", { mime, type_hint: typeHint })
}

export function postRecordingChunk(id: number, seq: number, audio: string): Promise<DashReply> {
  return dashboardJson("POST", `/api/inbox/recording/${id}/chunk`, { seq, audio }, 30_000)
}

export function finalizeRecording(id: number): Promise<DashReply> {
  return dashboardJson("POST", `/api/inbox/recording/${id}/finalize`, {}, 60_000)
}

export function transcribeInbox(id: number): Promise<DashReply> {
  return dashboardJson("POST", `/api/inbox/${id}/transcribe`, {}, VOICE_SLOW_TIMEOUT_MS)
}

/** `{ok, entry}` — tls-dashboard-v2 GET /api/inbox/:id. */
export function getInboxEntry(id: number): Promise<DashReply> {
  return dashboardJson("GET", `/api/inbox/${id}`)
}

/** Unprocessed rows (a JSON array). */
export function listInbox(): Promise<{ status: number; value: unknown }> {
  return dashboardValue("GET", "/api/inbox")
}

export function patchInbox(id: number, resultId: string): Promise<DashReply> {
  return dashboardJson("PATCH", `/api/inbox/${id}`, { result_id: resultId })
}

export function fetchInboxAudio(filename: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  return dashboardBytes(`/api/inbox/audio/${encodeURIComponent(filename)}`, VOICE_SLOW_TIMEOUT_MS)
}

export function createNote(note: Record<string, unknown>): Promise<DashReply> {
  return dashboardJson("POST", "/api/note", note, 30_000)
}

/** One note by id or ref_code (`PRJ-XXXX`); 404 → status 404. */
export function getNote(q: { id?: string; ref?: string }): Promise<DashReply> {
  const qs = q.ref ? `ref=${encodeURIComponent(q.ref)}` : `id=${encodeURIComponent(q.id ?? "")}`
  return dashboardJson("GET", `/api/note?${qs}`)
}

/** Index-only projection of every note (a JSON array). */
export function listNotesLite(): Promise<{ status: number; value: unknown }> {
  return dashboardValue("GET", "/api/notes?lite=1", undefined, 30_000)
}
