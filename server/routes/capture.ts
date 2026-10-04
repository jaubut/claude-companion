import { getAuthToken } from "../lib/auth"
import { DashboardKeyMissing, DashboardUnreachable, fetchReceiptFile, postInbox } from "../lib/dashboard-client"
import { withIdempotency } from "../lib/idempotency"
import { companionLog } from "../lib/log"
import { captureReceipt } from "../lib/receipt-capture"
import { QA_STATUSES, type QaStatus, getQaRow, listQa } from "../lib/receipt-qa-store"
import { acceptByHuman, kickReceiptQa, resolveByHuman } from "../lib/receipt-qa-worker"
import { createLimiter } from "../lib/vault-guard"
import { HOP_HEADER, type UpstreamConfig, forwardVault, forwardedDevice, vaultUpstream } from "../lib/vault-upstream"

// Quick Capture + receipt QA (Jeremie, 2026-10-03). Behind the standard /api
// bearer gate (companion-server.ts).
//   POST /api/capture/inbox            {text, type_hint?}          → {ok, id}
//   POST /api/capture/receipt          {image?|pdf?, note?}        → {ok, expense_id, merchant, total, date, category, category_code, qa_status:"queued"}
//   GET  /api/receipts/qa?status=&limit=                           → {ok, items}
//   GET  /api/receipts/qa/:id/image                                → receipt bytes (private, max-age=300)
//   POST /api/receipts/qa/:id/resolve  {fields, note?}             → {ok}
//   POST /api/receipts/qa/:id/accept                               → {ok}
// :id is the dashboard expense id (`accounting/2026-10/…`), URL-encoded or not.
// Upstream mode (COMPANION_VAULT_UPSTREAM, the Mac): everything is forwarded
// to the store host, which alone talks to the dashboard and runs the QA queue.
// Never logged: the capture text, receipt fields, the key.

const INBOX = "/api/capture/inbox"
const RECEIPT = "/api/capture/receipt"
const QA = "/api/receipts/qa"
const QA_PREFIX = "/api/receipts/qa/"
const TEXT_MAX = 10_000
const HINT_MAX = 64
const RECEIPT_UPSTREAM_TIMEOUT_MS = 180_000
const ACTIONS = ["image", "resolve", "accept"] as const
type Action = typeof ACTIONS[number]

export const captureLimiter = createLimiter(30, 60_000)

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })
}

function fail(status: number, error: string, message?: string): Response {
  return json({ ok: false, error, ...(message ? { message } : {}) }, status)
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const v = await req.json().catch(() => null) as unknown
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function device(req: Request): string {
  return (req.headers.get("x-companion-device") || req.headers.get("user-agent") || "unknown").replace(/[^\x20-\x7e]/g, "").slice(0, 64)
}

function limited(): Response | null {
  const wait = captureLimiter.take()
  return wait === null ? null : json({ ok: false, error: "rate_limited", retry_after: wait }, 429, { "Retry-After": String(wait) })
}

// ── Upstream (the Mac) ──

async function forwardJson(up: UpstreamConfig, req: Request, path: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<Response> {
  const r = await forwardVault(up, req.method, path, device(req), body, { pull: false, timeoutMs })
  companionLog(`capture ${req.method} ${path.split("?")[0]!.slice(0, 40)} upstream=${r.status}`)
  const headers: Record<string, string> = { "Cache-Control": "no-store", "content-type": r.json ? "application/json" : "text/plain;charset=utf-8" }
  if (r.retryAfter) headers["Retry-After"] = r.retryAfter
  return new Response(r.text, { status: r.status, headers })
}

async function forwardImage(up: UpstreamConfig, req: Request, path: string): Promise<Response> {
  try {
    const res = await fetch(up.base + path, {
      headers: { authorization: `Bearer ${getAuthToken()}`, "x-companion-device": forwardedDevice(device(req)), [HOP_HEADER]: "1" },
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    })
    if (res.status >= 300 && res.status < 400) { void res.body?.cancel(); return fail(502, "upstream_unreachable") }
    const headers: Record<string, string> = { "Cache-Control": res.headers.get("cache-control") || "private, max-age=300" }
    headers["content-type"] = res.headers.get("content-type") || "application/octet-stream"
    return new Response(await res.arrayBuffer(), { status: res.status, headers })
  } catch {
    return fail(502, "upstream_unreachable")
  }
}

// ── Store host ──

async function inbox(body: Record<string, unknown>): Promise<Response> {
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) return fail(400, "text_required")
  if (text.length > TEXT_MAX) return fail(413, "text_too_long", `max ${TEXT_MAX} characters`)
  if (body.type_hint !== undefined && typeof body.type_hint !== "string") return fail(400, "bad_type_hint")
  const hint = String(body.type_hint ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, HINT_MAX)
  try {
    const r = await postInbox(text, hint)
    const id = r.json?.id
    if (r.status !== 200 || r.json?.ok !== true || (typeof id !== "number" && typeof id !== "string")) {
      companionLog(`capture inbox refused (HTTP ${r.status})`)
      return fail(502, "dashboard_error")
    }
    companionLog(`capture inbox → #${id}${hint ? ` (${hint})` : ""}`)
    return json({ ok: true, id })
  } catch (e) {
    if (e instanceof DashboardKeyMissing) return fail(503, "dashboard_key_missing")
    if (e instanceof DashboardUnreachable) return fail(502, "dashboard_unreachable")
    throw e
  }
}

async function receipt(body: Record<string, unknown>): Promise<Response> {
  const out = await captureReceipt(body)
  if (!out.ok) return fail(out.status, out.error, out.message)
  kickReceiptQa()
  return json(out.body)
}

function list(url: URL): Response {
  const status = url.searchParams.get("status") || "all"
  if (status !== "all" && !(QA_STATUSES as readonly string[]).includes(status)) return fail(400, "bad_status")
  const raw = url.searchParams.get("limit")
  const limit = raw ? Number(raw) : undefined
  if (limit !== undefined && !Number.isFinite(limit)) return fail(400, "bad_limit")
  return json({ ok: true, items: listQa(status as QaStatus | "all", limit) })
}

async function image(id: string): Promise<Response> {
  const row = getQaRow(id)
  if (!row) return fail(404, "not_found")
  const headers = (mime: string): Record<string, string> => ({ "Content-Type": mime, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" })
  try {
    const got = row.receipt_file ? await fetchReceiptFile(row.receipt_file) : null
    if (got) return new Response(got.bytes, { headers: headers(got.mime) })
  } catch (e) {
    if (e instanceof DashboardKeyMissing) return fail(503, "dashboard_key_missing")
    if (!(e instanceof DashboardUnreachable)) throw e
    if (!row.image_path) return fail(502, "dashboard_unreachable")
  }
  const local = row.image_path ? Bun.file(row.image_path) : null
  if (local && await local.exists()) return new Response(local, { headers: headers(row.image_path.endsWith(".pdf") ? "application/pdf" : "image/jpeg") })
  return fail(404, "no_receipt")
}

async function act(req: Request, id: string, action: Action): Promise<Response> {
  if (action === "image") return req.method === "GET" ? image(id) : fail(405, "method_not_allowed")
  if (req.method !== "POST") return fail(405, "method_not_allowed")
  if (action === "accept") {
    const r = acceptByHuman(id)
    return r.ok ? json({ ok: true }) : fail(r.status, r.error)
  }
  const body = await readBody(req)
  if (!body) return fail(400, "bad_json")
  const r = await resolveByHuman(id, body.fields, body.note)
  return r.ok ? json({ ok: true }) : fail(r.status, r.error)
}

/** `/api/receipts/qa/<id>/<action>` → parts; id may be encoded or carry raw slashes. */
export function parseItemPath(pathname: string): { id: string; action: Action } | null {
  const rest = pathname.slice(QA_PREFIX.length)
  const slash = rest.lastIndexOf("/")
  if (slash <= 0) return null
  const action = rest.slice(slash + 1) as Action
  if (!ACTIONS.includes(action)) return null
  let id: string
  try { id = decodeURIComponent(rest.slice(0, slash)) } catch { return null }
  if (!id || id.length > 300 || id.includes("..") || /[\x00-\x1f\x7f]/.test(id)) return null
  return { id, action }
}

export async function handleCaptureRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname
  const isCapture = p === INBOX || p === RECEIPT
  if (!isCapture && p !== QA && !p.startsWith(QA_PREFIX)) return null

  const up = vaultUpstream()
  if (up && req.headers.get(HOP_HEADER)) return fail(508, "upstream_loop")

  if (isCapture) {
    if (req.method !== "POST") return fail(405, "method_not_allowed")
    const wait = limited()
    if (wait) return wait
    const body = await readBody(req)
    if (!body) return fail(400, "bad_json")
    const scope = p === INBOX ? "capture-inbox" : "capture-receipt"
    return withIdempotency(req, scope, () => {
      if (up) return forwardJson(up, req, p, body, p === RECEIPT ? RECEIPT_UPSTREAM_TIMEOUT_MS : undefined)
      return p === INBOX ? inbox(body) : receipt(body)
    })
  }

  if (p === QA) {
    if (req.method !== "GET") return fail(405, "method_not_allowed")
    return up ? forwardJson(up, req, `${QA}${url.search}`) : list(url)
  }

  const item = parseItemPath(p)
  if (!item) return fail(404, "not_found")
  if (up) {
    const path = `${QA_PREFIX}${encodeURIComponent(item.id)}/${item.action}`
    if (item.action === "image") return req.method === "GET" ? forwardImage(up, req, path) : fail(405, "method_not_allowed")
    if (req.method !== "POST") return fail(405, "method_not_allowed")
    const body = item.action === "resolve" ? await readBody(req) : undefined
    if (item.action === "resolve" && !body) return fail(400, "bad_json")
    return forwardJson(up, req, path, body ?? undefined)
  }
  return act(req, item.id, item.action)
}
