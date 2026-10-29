import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { resetIdempotency } from "../lib/idempotency"
import { recordPeer } from "../lib/vault-guard"

// brain-v2 voice takes (routes/capture.ts + lib/voice-memo.ts) against a small
// fake tls-dashboard-v2 inbox (same shapes as capture-voice.test.ts's): a
// `brainTurnId` only archives the take, best effort; a start with `{mime}`
// alone is untouched; a brain take is never validated or discarded as a memo.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-voice-brain-")), "test.db")
process.env.COMPANION_AUTH_TOKEN = process.env.COMPANION_AUTH_TOKEN || "voice-brain-test-token-0123456789"
const savedEnv = { ...process.env }

interface Row { id: number; processed: number; result_id: string; audio_filename: string; audio_bytes: number | null }
let rows = new Map<number, Row>()
let nextId = 500
let patches: Array<{ id: number; result_id: string }> = []
let patchFails = false
let dash: ReturnType<typeof Bun.serve>
let handleCaptureRoute: typeof import("./capture")["handleCaptureRoute"]
let captureLimiter: typeof import("./capture")["captureLimiter"]
let chat: typeof import("../lib/orchestrator-chat")
let home = ""

async function fakeDashboard(req: Request): Promise<Response> {
  const p = new URL(req.url).pathname
  const text = await req.text()
  const j = text ? JSON.parse(text) as Record<string, unknown> : {}
  let m: RegExpExecArray | null
  if (req.method === "POST" && p === "/api/inbox/recording/start") {
    const id = nextId++
    rows.set(id, { id, processed: 0, result_id: "", audio_filename: `2026-10-28-${id}.m4a`, audio_bytes: 6 })
    return Response.json({ ok: true, id, filename: `2026-10-28-${id}.m4a` })
  }
  if (req.method === "PATCH" && (m = /^\/api\/inbox\/(\d+)$/.exec(p))) {
    if (patchFails) return Response.json({ ok: false, error: "boom" }, { status: 500 })
    const r = rows.get(Number(m[1]))
    patches.push({ id: Number(m[1]), result_id: String(j.result_id) })
    if (r) { r.processed = 1; r.result_id = String(j.result_id ?? "") }
    return Response.json({ ok: true })
  }
  if (req.method === "GET" && (m = /^\/api\/inbox\/(\d+)$/.exec(p))) {
    const r = rows.get(Number(m[1]))
    if (!r) return Response.json({ ok: false, error: "not found" }, { status: 404 })
    return Response.json({ ok: true, entry: { ...r, raw_text: `[voice note: ${r.audio_filename}]\n\nhello`, type_hint: "voice-memo", created_at: "2026-10-28 18:00:00", audio_mime: "audio/mp4" } })
  }
  return new Response("nope", { status: 404 })
}

beforeAll(async () => {
  dash = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: fakeDashboard })
  const cap = await import("./capture")
  handleCaptureRoute = cap.handleCaptureRoute
  captureLimiter = cap.captureLimiter
  chat = await import("../lib/orchestrator-chat")
  ;(await import("../lib/orchestrator-channels")).ensureChannel("brain", "Brain")
})
afterAll(() => {
  dash.stop(true)
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
  rmSync(home, { recursive: true, force: true })
})
beforeEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = mkdtempSync(join(tmpdir(), "voice-brain-"))
  process.env.HOME = home
  process.env.TLS_SECRETS_FILE = join(home, "secrets.env")
  writeFileSync(process.env.TLS_SECRETS_FILE, "TLS_DASHBOARD_API_KEY='dash-SECRET-key-123456'\n")
  process.env.COMPANION_DASHBOARD_URL = `http://127.0.0.1:${dash.port}`
  process.env.COMPANION_BRAIN = "1"
  delete process.env.COMPANION_VAULT_UPSTREAM
  rows = new Map()
  patches = []
  patchFails = false
  captureLimiter.reset()
  resetIdempotency()
})

async function call(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://localhost:4245${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${getAuthToken()}` }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  recordPeer(req, "127.0.0.1")
  const res = (await handleCaptureRoute(req, new URL(req.url)))!
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const voiceTurn = () => chat.appendTurn("user", "spoken ask", null, "brain", { kind: "voice", source: "app" })

test("start with {mime} only → unchanged: no inbox patch, a plain memo", async () => {
  const r = await call("/api/capture/voice/start", { mime: "audio/mp4" })
  expect(r.status).toBe(200)
  expect(Object.keys(r.json).sort()).toEqual(["filename", "id", "ok"])
  expect(patches).toEqual([])
})

test("a valid brainTurnId archives the take: inbox row brain:<turn>, the turn card gets audioId", async () => {
  const t = voiceTurn()
  const r = await call("/api/capture/voice/start", { mime: "audio/mp4", brainTurnId: t.id })
  expect(r.status).toBe(200)
  expect(patches).toEqual([{ id: r.json.id as number, result_id: `brain:${t.id}` }])
  expect(chat.getTurn(t.id)!.card).toMatchObject({ kind: "voice", audioId: String(r.json.id) })
})

test("a bad brainTurnId is ignored and the start still succeeds", async () => {
  for (const bad of ["../x", "a b", 42, "x".repeat(65)]) {
    const r = await call("/api/capture/voice/start", { mime: "audio/mp4", brainTurnId: bad })
    expect(r.status).toBe(200)
  }
  expect(patches).toEqual([])
})

test("a patch failure → the start still succeeds", async () => {
  patchFails = true
  const r = await call("/api/capture/voice/start", { mime: "audio/mp4", brainTurnId: voiceTurn().id })
  expect(r.status).toBe(200)
  expect(r.json.ok).toBe(true)
})

test("validate / discard on a brain:* row → 409 brain_take", async () => {
  const r = await call("/api/capture/voice/start", { mime: "audio/mp4", brainTurnId: voiceTurn().id })
  const id = r.json.id as number
  expect(rows.get(id)!.result_id).toStartWith("brain:")
  expect(await call(`/api/capture/voice/${id}/validate`, { transcript: "hello" })).toEqual({ status: 409, json: { ok: false, error: "brain_take" } })
  expect(await call(`/api/capture/voice/${id}/discard`)).toEqual({ status: 409, json: { ok: false, error: "brain_take" } })
})
