import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { resetIdempotency } from "../lib/idempotency"
import { recordPeer } from "../lib/vault-guard"
import { base64Size, transcriptOf } from "../lib/voice-memo"
import { captureLimiter, handleCaptureRoute, parseVoicePath, voiceChunkLimiter } from "./capture"

// /api/capture/voice* + /api/capture/projects against a stateful fake
// tls-dashboard-v2 (inbox recording + notes routes, shapes copied from its
// server/routes/inbox.ts + notes.ts) and a fake upstream Companion.

process.env.COMPANION_AUTH_TOKEN = process.env.COMPANION_AUTH_TOKEN || "capture-test-token-0123456789"
const TOKEN = getAuthToken()
const DASH_KEY = "dash-SECRET-key-123456"
const SPOKEN = "Réunion avec Julio, on tourne le drone samedi"
const savedEnv = { ...process.env }

interface Row {
  id: number; raw_text: string; type_hint: string; processed: number; result_id: string; created_at: string
  audio_filename: string | null; audio_mime: string | null; audio_blob: Uint8Array | null; chunks: Map<number, Uint8Array>
}
interface Hit { method: string; path: string; key: string | null; auth: string | null; hop: string | null; body: string }

let rows = new Map<number, Row>()
let nextId = 100
let notes: Array<Record<string, any>> = []
let autoTranscribe = true
let transcribeCalls = 0
let hits: Hit[] = []
let up: Hit[] = []
let upReply: (h: Hit) => Response = () => Response.json({ ok: true })
let dash: ReturnType<typeof Bun.serve>
let upstream: ReturnType<typeof Bun.serve>
let home = ""
let stderr = ""
const realWrite = process.stderr.write.bind(process.stderr)

const PROJECTS = [
  { id: "projects/2026-01-10-tls-dashboard", title: "TLS Dashboard", folder: "projects", status: "active", ref_code: "PRJ-WCLS" },
  { id: "projects/2026-02-01-fromagerie-julio", title: "Fromagerie Julio", folder: "projects", status: "active", ref_code: "" },
  { id: "projects/2025-05-01-old", title: "Old thing", folder: "projects", status: "done", ref_code: "PRJ-OLD1" },
  { id: "ideas/2026-03-01-x", title: "An idea", folder: "ideas", status: "active", ref_code: "IDE-AAAA" },
]

function entryJson(r: Row): Record<string, unknown> {
  return {
    id: r.id, raw_text: r.raw_text, type_hint: r.type_hint, processed: r.processed, result_id: r.result_id,
    created_at: r.created_at, processed_at: "", audio_filename: r.audio_filename, audio_mime: r.audio_mime,
    audio_bytes: r.audio_blob ? r.audio_blob.byteLength : null,
  }
}

function seedRow(over: Partial<Row> = {}): Row {
  const id = nextId++
  const r: Row = {
    id, raw_text: "", type_hint: "voice-memo", processed: 0, result_id: "", created_at: "2026-10-06 18:03:00",
    audio_filename: `2026-10-06-${id}.m4a`, audio_mime: "audio/mp4", audio_blob: new Uint8Array([9, 8, 7, 6, 5, 4]), chunks: new Map(), ...over,
  }
  if (!over.raw_text) r.raw_text = `[voice note: ${r.audio_filename}]\n\n${SPOKEN}`
  rows.set(id, r)
  return r
}

async function fakeDashboard(req: Request): Promise<Response> {
  const u = new URL(req.url)
  const body = await req.text()
  hits.push({ method: req.method, path: u.pathname + u.search, key: req.headers.get("x-api-key"), auth: null, hop: null, body })
  const p = u.pathname
  const j = body ? JSON.parse(body) : {}
  let m: RegExpExecArray | null
  if (req.method === "POST" && p === "/api/inbox/recording/start") {
    const id = nextId++
    const filename = `2026-10-06-${id}.m4a`
    rows.set(id, { id, raw_text: `[voice note: ${filename}]`, type_hint: j.type_hint, processed: 0, result_id: "", created_at: "2026-10-06 18:03:00", audio_filename: filename, audio_mime: j.mime, audio_blob: null, chunks: new Map() })
    return Response.json({ ok: true, id, filename })
  }
  if (req.method === "POST" && (m = /^\/api\/inbox\/recording\/(\d+)\/chunk$/.exec(p))) {
    const bytes = new Uint8Array(Buffer.from(j.audio, "base64"))
    rows.get(Number(m[1]))!.chunks.set(j.seq, bytes)
    return Response.json({ ok: true, seq: j.seq, bytes: bytes.byteLength })
  }
  if (req.method === "POST" && (m = /^\/api\/inbox\/recording\/(\d+)\/finalize$/.exec(p))) {
    const r = rows.get(Number(m[1]))
    if (!r) return Response.json({ ok: false, error: "not found" }, { status: 404 })
    if (r.chunks.size === 0) return r.audio_blob ? Response.json({ ok: true, alreadyFinal: true }) : Response.json({ ok: false, error: "no chunks" }, { status: 400 })
    const seqs = [...r.chunks.keys()].sort((a, b) => a - b)
    for (let i = 0; i < seqs.length; i++) if (seqs[i] !== i) return Response.json({ ok: false, error: `missing chunk ${i}`, have: seqs }, { status: 409 })
    r.audio_blob = new Uint8Array(Buffer.concat(seqs.map((s) => r.chunks.get(s)!)))
    r.chunks.clear()
    if (autoTranscribe) r.raw_text = `[voice note: ${r.audio_filename}]\n\n${SPOKEN}`
    return Response.json({ ok: true, bytes: r.audio_blob.byteLength, chunks: seqs.length })
  }
  if (req.method === "POST" && (m = /^\/api\/inbox\/(\d+)\/transcribe$/.exec(p))) {
    transcribeCalls++
    const r = rows.get(Number(m[1]))
    if (!r) return Response.json({ ok: false, error: "not found" }, { status: 404 })
    if (/^\[voice note:[^\]]+\]\s*$/.test(r.raw_text)) {
      if (!r.audio_blob) return Response.json({ ok: false, error: "no audio blob on this entry" }, { status: 400 })
      r.raw_text = `[voice note: ${r.audio_filename}]\n\n${SPOKEN}`
      return Response.json({ ok: true, transcript: SPOKEN, cached: false })
    }
    return Response.json({ ok: true, transcript: r.raw_text, cached: true })
  }
  if (req.method === "GET" && (m = /^\/api\/inbox\/(\d+)$/.exec(p))) {
    const r = rows.get(Number(m[1]))
    return r ? Response.json({ ok: true, entry: entryJson(r) }) : Response.json({ ok: false, error: "not found" }, { status: 404 })
  }
  if (req.method === "POST" && p === "/api/inbox") return Response.json({ ok: true, id: nextId++ })
  if (req.method === "GET" && p === "/api/inbox") {
    return Response.json([...rows.values()].filter((r) => !r.processed).map((r) => ({ id: r.id, raw_text: r.raw_text, type_hint: r.type_hint, processed: r.processed, result_id: r.result_id, created_at: r.created_at, processed_at: "", audio_filename: r.audio_filename })))
  }
  if (req.method === "PATCH" && (m = /^\/api\/inbox\/(\d+)$/.exec(p))) {
    const r = rows.get(Number(m[1]))
    if (r) { r.processed = 1; r.result_id = j.result_id ?? "" }
    return Response.json({ ok: true })
  }
  if (req.method === "GET" && (m = /^\/api\/inbox\/audio\/([^/]+)$/.exec(p))) {
    const r = [...rows.values()].find((x) => x.audio_filename === decodeURIComponent(m![1]!))
    return r?.audio_blob ? new Response(r.audio_blob, { headers: { "content-type": r.audio_mime! } }) : new Response("404 Not Found", { status: 404 })
  }
  if (req.method === "POST" && p === "/api/note") {
    const id = `${j.folder}/${j.date}-${String(j.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`
    notes.push({ ...j, id })
    return Response.json({ ok: true, id, ref_code: "MTG-ABCD", filename: `${id.split("/")[1]}.md` })
  }
  if (req.method === "GET" && p === "/api/note") {
    const ref = u.searchParams.get("ref")
    const id = u.searchParams.get("id")
    const n = PROJECTS.find((x) => (ref && x.ref_code === ref) || (id && x.id === id))
    return n ? Response.json(n) : new Response("404 Not Found", { status: 404 })
  }
  if (req.method === "GET" && p === "/api/notes" && u.searchParams.get("lite") === "1") return Response.json(PROJECTS)
  return new Response("nope", { status: 404 })
}

beforeAll(() => {
  dash = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: fakeDashboard })
  upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      const h: Hit = { method: req.method, path: u.pathname + u.search, key: req.headers.get("x-api-key"), auth: req.headers.get("authorization"), hop: req.headers.get("x-companion-vault-hop"), body: await req.text() }
      up.push(h)
      return upReply(h)
    },
  })
})
afterAll(() => {
  dash.stop(true)
  upstream.stop(true)
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "capture-voice-"))
  process.env.HOME = home
  process.env.TLS_SECRETS_FILE = join(home, "secrets.env")
  writeFileSync(process.env.TLS_SECRETS_FILE, `TLS_DASHBOARD_API_KEY='${DASH_KEY}'\n`)
  process.env.COMPANION_DASHBOARD_URL = `http://127.0.0.1:${dash.port}`
  process.env.COMPANION_VOICE_TRANSCRIPT_WAIT_MS = "0"
  delete process.env.COMPANION_VAULT_UPSTREAM
  rows = new Map()
  notes = []
  autoTranscribe = true
  transcribeCalls = 0
  hits = []
  up = []
  upReply = () => Response.json({ ok: true })
  captureLimiter.reset()
  voiceChunkLimiter.reset()
  resetIdempotency()
  stderr = ""
  process.stderr.write = ((c: string | Uint8Array) => { stderr += String(c); return true }) as typeof process.stderr.write
})
afterEach(() => {
  process.stderr.write = realWrite
  rmSync(home, { recursive: true, force: true })
})

interface Reply { status: number; json: Record<string, any>; headers: Headers; bytes: Uint8Array }

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-companion-device": "test-phone", ...extra }
  const req = new Request(`http://localhost:4245${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  recordPeer(req, "127.0.0.1")
  const res = (await handleCaptureRoute(req, new URL(req.url)))!
  const bytes = new Uint8Array(await res.arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : {}, headers: res.headers, bytes }
}

const b64 = (bytes: number[] | Uint8Array): string => Buffer.from(Uint8Array.from(bytes)).toString("base64")

// ── Upload ──

test("start → chunk ×3 → finalize: one m4a in the dashboard, transcript returned, nothing spoken in the log", async () => {
  const s = await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" })
  expect(s.status).toBe(200)
  expect(Object.keys(s.json).sort()).toEqual(["filename", "id", "ok"])
  const { id, filename } = s.json
  expect(filename).toMatch(/\.m4a$/)
  expect(JSON.parse(hits[0]!.body)).toEqual({ mime: "audio/mp4", type_hint: "voice-memo" })
  expect(hits[0]!.key).toBe(DASH_KEY)

  for (const [seq, part] of [[1, [4, 5, 6]], [0, [1, 2, 3]], [2, [7, 8]]] as const) {
    const c = await call("POST", `/api/capture/voice/${id}/chunk`, { seq, audio: b64([...part]) })
    expect(c).toMatchObject({ status: 200, json: { ok: true, seq, bytes: part.length } })
  }
  const retry = await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 1, audio: b64([4, 5, 6]) }) // resumable by seq
  expect(retry.status).toBe(200)

  const f = await call("POST", `/api/capture/voice/${id}/finalize`)
  expect(f.status).toBe(200)
  expect(f.json).toEqual({ ok: true, bytes: 8, transcript: SPOKEN })
  expect([...rows.get(id)!.audio_blob!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(transcribeCalls).toBe(0) // waits on the dashboard's own Deepgram run, never a second one
  expect(hits.every((h) => h.key === DASH_KEY)).toBe(true)
  expect(stderr).not.toContain("Julio")
  expect(stderr).not.toContain(DASH_KEY)

  // a chunk after finalize would rebuild the blob from that chunk alone
  const late = await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 0, audio: b64([1]) })
  expect(late).toMatchObject({ status: 409, json: { ok: false, error: "already_finalized" } })
  expect(rows.get(id)!.chunks.size).toBe(0)
  // finalize again (lost response, retried) is idempotent and still reports the size
  expect((await call("POST", `/api/capture/voice/${id}/finalize`)).json).toEqual({ ok: true, bytes: 8, transcript: SPOKEN })
})

test("finalize before Deepgram lands → transcript null; transcribe retry returns it without the marker", async () => {
  autoTranscribe = false
  const { id } = (await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" })).json
  await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 0, audio: b64([1, 2]) })
  const f = await call("POST", `/api/capture/voice/${id}/finalize`)
  expect(f.json).toEqual({ ok: true, bytes: 2, transcript: null })
  const t = await call("POST", `/api/capture/voice/${id}/transcribe`)
  expect(t).toMatchObject({ status: 200, json: { ok: true, transcript: SPOKEN } })
  const cached = await call("POST", `/api/capture/voice/${id}/transcribe`) // dashboard returns raw_text when cached
  expect(cached.json).toEqual({ ok: true, transcript: SPOKEN })
})

test("finalize: missing chunk → 409 missing_chunks with what the dashboard has; no chunks → 400; transcribe before finalize → 409", async () => {
  const { id } = (await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" })).json
  expect((await call("POST", `/api/capture/voice/${id}/finalize`)).json).toEqual({ ok: false, error: "no_chunks" })
  expect((await call("POST", `/api/capture/voice/${id}/transcribe`)).json).toEqual({ ok: false, error: "not_finalized" })
  await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 0, audio: b64([1]) })
  await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 2, audio: b64([3]) })
  const f = await call("POST", `/api/capture/voice/${id}/finalize`)
  expect(f).toMatchObject({ status: 409, json: { ok: false, error: "missing_chunks", have: [0, 2] } })
})

test("start validation: mime must be audio/*; bad JSON; method", async () => {
  expect((await call("POST", "/api/capture/voice/start", { mime: "video/mp4" })).json).toEqual({ ok: false, error: "bad_mime" })
  expect((await call("POST", "/api/capture/voice/start", {})).status).toBe(400)
  expect((await call("POST", "/api/capture/voice/start", { mime: "audio/mp4\nX: y" })).status).toBe(400)
  expect((await call("POST", "/api/capture/voice/start", [1])).json.error).toBe("bad_json")
  expect((await call("GET", "/api/capture/voice/start")).status).toBe(405)
  expect(hits).toEqual([])
  expect((await call("POST", "/api/capture/voice/start", { mime: "audio/x-m4a" })).status).toBe(200)
})

test("chunk validation: 512 KB decoded passes, one byte more → 413; bad seq / base64 refused before the dashboard", async () => {
  const { id } = (await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" })).json
  hits = []
  const max = new Uint8Array(512 * 1024).fill(7)
  expect(base64Size(b64(max))).toBe(512 * 1024)
  expect((await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 0, audio: b64(max) })).json).toEqual({ ok: true, seq: 0, bytes: 512 * 1024 })
  hits = []
  const big = await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 1, audio: b64(new Uint8Array(512 * 1024 + 1)) })
  expect(big).toMatchObject({ status: 413, json: { ok: false, error: "chunk_too_large" } })
  expect((await call("POST", `/api/capture/voice/${id}/chunk`, { seq: -1, audio: b64([1]) })).json.error).toBe("bad_seq")
  expect((await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 1.5, audio: b64([1]) })).json.error).toBe("bad_seq")
  expect((await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 1, audio: "!!notbase64" })).json.error).toBe("bad_base64")
  expect((await call("POST", `/api/capture/voice/${id}/chunk`, { seq: 1 })).json.error).toBe("audio_required")
  expect(hits).toEqual([])
})

test("a 40-chunk upload is not rate limited, and chunks don't eat the capture budget", async () => {
  const { id } = (await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" })).json
  for (let seq = 0; seq < 40; seq++) {
    const r = await call("POST", `/api/capture/voice/${id}/chunk`, { seq, audio: b64([seq]) })
    expect(r.status).toBe(200)
  }
  expect((await call("POST", `/api/capture/voice/${id}/finalize`)).json.bytes).toBe(40)
  expect((await call("POST", "/api/capture/inbox", { text: "still allowed" })).status).toBe(200)
})

test("voice POSTs other than chunk share the capture limiter (30/min)", async () => {
  for (let i = 0; i < 30; i++) await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" })
  const r = await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" })
  expect(r).toMatchObject({ status: 429, json: { ok: false, error: "rate_limited" } })
  expect(r.headers.get("retry-after")).toBeTruthy()
})

// ── Review ──

test("list ?status=pending: only unprocessed voice-memo rows, VoiceMemo shape, transcript without the marker", async () => {
  const a = seedRow()
  const b = seedRow({ raw_text: "[voice note: x.m4a]", audio_filename: "x.m4a" }) // untranscribed
  seedRow({ type_hint: "voice", raw_text: "[voice note: old.webm]\n\nold dashboard voice note" })
  seedRow({ processed: 1, result_id: "meetings/2026-10-05-x" })
  seedRow({ type_hint: "idea", raw_text: "idée", audio_filename: null })
  const r = await call("GET", "/api/capture/voice?status=pending")
  expect(r.status).toBe(200)
  expect(r.json.items.map((i: any) => i.id).sort()).toEqual([a.id, b.id].sort())
  const item = r.json.items.find((i: any) => i.id === a.id)
  expect(item).toEqual({ id: a.id, filename: a.audio_filename, created_at: "2026-10-06T18:03:00Z", transcript: SPOKEN, status: "pending", note_id: null })
  expect(r.json.items.find((i: any) => i.id === b.id).transcript).toBeNull()
  expect((await call("GET", "/api/capture/voice")).json.items).toHaveLength(2) // pending is the default
  expect((await call("GET", "/api/capture/voice?status=all")).json.error).toBe("bad_status")
  expect((await call("POST", "/api/capture/voice")).status).toBe(405)
})

test("get one memo; not_found / not_voice_memo / bad path", async () => {
  const a = seedRow()
  const r = await call("GET", `/api/capture/voice/${a.id}`)
  expect(r.json).toEqual({ ok: true, item: { id: a.id, filename: a.audio_filename, created_at: "2026-10-06T18:03:00Z", transcript: SPOKEN, status: "pending", note_id: null } })
  expect(await call("GET", "/api/capture/voice/424242")).toMatchObject({ status: 404, json: { ok: false, error: "not_found" } })
  const idea = seedRow({ type_hint: "idea" })
  for (const [m, suffix, body] of [["GET", "", undefined], ["GET", "/audio", undefined], ["POST", "/validate", { transcript: "x" }], ["POST", "/discard", undefined], ["POST", "/finalize", undefined], ["POST", "/transcribe", undefined], ["POST", "/chunk", { seq: 0, audio: b64([1]) }]] as const) {
    expect(await call(m, `/api/capture/voice/${idea.id}${suffix}`, body)).toMatchObject({ status: 400, json: { ok: false, error: "not_voice_memo" } })
  }
  expect(rows.get(idea.id)!.processed).toBe(0)
  expect((await call("GET", "/api/capture/voice/abc")).status).toBe(404)
  expect((await call("GET", `/api/capture/voice/${a.id}/delete`)).status).toBe(404)
  expect(parseVoicePath("/api/capture/voice/12/chunk")).toEqual({ id: 12, action: "chunk" })
  expect(parseVoicePath("/api/capture/voice/12")).toEqual({ id: 12, action: null })
  expect(parseVoicePath("/api/capture/voice/..%2F1/chunk")).toBeNull()
})

test("audio: dashboard bytes + content-type pass through; Range → 206", async () => {
  const a = seedRow()
  const r = await call("GET", `/api/capture/voice/${a.id}/audio`)
  expect(r.status).toBe(200)
  expect([...r.bytes]).toEqual([9, 8, 7, 6, 5, 4])
  expect(r.headers.get("content-type")).toBe("audio/mp4")
  expect(r.headers.get("cache-control")).toBe("private, max-age=300")
  expect(r.headers.get("accept-ranges")).toBe("bytes")
  expect(hits.at(-1)).toMatchObject({ method: "GET", path: `/api/inbox/audio/${a.audio_filename}`, key: DASH_KEY })
  const part = await call("GET", `/api/capture/voice/${a.id}/audio`, undefined, { range: "bytes=1-3" })
  expect(part.status).toBe(206)
  expect([...part.bytes]).toEqual([8, 7, 6])
  expect(part.headers.get("content-range")).toBe("bytes 1-3/6")
  expect([...(await call("GET", `/api/capture/voice/${a.id}/audio`, undefined, { range: "bytes=-2" })).bytes]).toEqual([5, 4])
  expect((await call("GET", `/api/capture/voice/${a.id}/audio`, undefined, { range: "bytes=9-" })).status).toBe(416)
  const noBlob = seedRow({ audio_blob: null })
  expect((await call("GET", `/api/capture/voice/${noBlob.id}/audio`)).status).toBe(404)
  expect((await call("POST", `/api/capture/voice/${a.id}/audio`)).status).toBe(405)
})

test("validate: meetings/ note with transcript, audio reference and project, then the inbox row points at it", async () => {
  const a = seedRow()
  const r = await call("POST", `/api/capture/voice/${a.id}/validate`, { transcript: `  ${SPOKEN} — corrigé  `, title: "Call Julio", project: "PRJ-WCLS" })
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true, note_id: "meetings/2026-10-06-call-julio" })
  expect(notes).toHaveLength(1)
  const n = notes[0]!
  expect(n).toMatchObject({ folder: "meetings", title: "Call Julio", tags: ["voice-memo", "meeting", "PRJ-WCLS"] })
  expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const url = `/api/inbox/audio/${a.audio_filename}`
  expect(n.body).toBe(`Projet: PRJ-WCLS\n\n${SPOKEN} — corrigé\n\n---\nAudio: [${a.audio_filename}](${url})\n`)
  expect(n.meta).toEqual({ source: "companion-voice-memo", inbox_id: a.id, audio_filename: a.audio_filename, audio_url: url, project: "PRJ-WCLS" })
  const patch = hits.find((h) => h.method === "PATCH")!
  expect(patch.path).toBe(`/api/inbox/${a.id}`)
  expect(JSON.parse(patch.body)).toEqual({ result_id: "meetings/2026-10-06-call-julio" })
  expect(rows.get(a.id)!.audio_blob).not.toBeNull() // audio never deleted
  expect((await call("GET", `/api/capture/voice/${a.id}`)).json.item).toMatchObject({ status: "validated", note_id: "meetings/2026-10-06-call-julio" })
  expect((await call("GET", "/api/capture/voice?status=pending")).json.items).toEqual([])
  // a repeat (double tap / lost reply) returns the same note, creates nothing
  expect((await call("POST", `/api/capture/voice/${a.id}/validate`, { transcript: "again" })).json).toEqual({ ok: true, note_id: "meetings/2026-10-06-call-julio" })
  expect(notes).toHaveLength(1)
  expect(stderr).not.toContain("Julio")
})

test("validate: project by note id without ref_code; default title; no project → no project line", async () => {
  const a = seedRow()
  await call("POST", `/api/capture/voice/${a.id}/validate`, { transcript: "t1", project: "projects/2026-02-01-fromagerie-julio" })
  expect(notes[0]!.body.startsWith("Projet: projects/2026-02-01-fromagerie-julio\n\n")).toBe(true)
  expect(notes[0]!.meta.project).toBe("projects/2026-02-01-fromagerie-julio")
  expect(notes[0]!.title).toMatch(/^Voice memo \d{2}:\d{2}$/)
  const b = seedRow()
  await call("POST", `/api/capture/voice/${b.id}/validate`, { transcript: "t2", title: "  ", project: null })
  expect(notes[1]!.body).toBe(`t2\n\n---\nAudio: [${b.audio_filename}](/api/inbox/audio/${b.audio_filename})\n`)
  expect(notes[1]!.tags).toEqual(["voice-memo", "meeting"])
  expect(notes[1]!.meta.project).toBeUndefined()
})

test("validate refusals: transcript required / > 50 000, bad types, unknown project, not finalized, discarded", async () => {
  const a = seedRow()
  const base = `/api/capture/voice/${a.id}/validate`
  expect((await call("POST", base, {})).json.error).toBe("transcript_required")
  expect((await call("POST", base, { transcript: "   " })).json.error).toBe("transcript_required")
  expect((await call("POST", base, { transcript: "x".repeat(50_001) })).status).toBe(413)
  expect((await call("POST", base, { transcript: "x", title: 3 })).json.error).toBe("bad_title")
  expect((await call("POST", base, { transcript: "x", project: ["a"] })).json.error).toBe("bad_project")
  expect((await call("POST", base, { transcript: "x", project: "PRJ-NOPE" })).json).toEqual({ ok: false, error: "unknown_project" })
  expect(notes).toEqual([])
  const unfinished = seedRow({ audio_blob: null })
  expect((await call("POST", `/api/capture/voice/${unfinished.id}/validate`, { transcript: "x" })).json.error).toBe("not_finalized")
  expect((await call("POST", base, { transcript: "x".repeat(50_000) })).status).toBe(200)
})

test("discard: PATCH result_id \"discarded\", audio kept, idempotent; validate afterwards refused", async () => {
  const a = seedRow()
  expect(await call("POST", `/api/capture/voice/${a.id}/discard`)).toMatchObject({ status: 200, json: { ok: true } })
  expect(JSON.parse(hits.find((h) => h.method === "PATCH")!.body)).toEqual({ result_id: "discarded" })
  expect(rows.get(a.id)!.audio_blob).not.toBeNull()
  expect((await call("GET", `/api/capture/voice/${a.id}`)).json.item).toMatchObject({ status: "discarded", note_id: null })
  expect((await call("POST", `/api/capture/voice/${a.id}/discard`)).json).toEqual({ ok: true })
  expect((await call("POST", `/api/capture/voice/${a.id}/validate`, { transcript: "x" })).json).toEqual({ ok: false, error: "already_discarded" })
  const b = seedRow({ processed: 1, result_id: "meetings/2026-10-06-y" })
  expect((await call("POST", `/api/capture/voice/${b.id}/discard`)).json).toEqual({ ok: false, error: "already_validated" })
})

test("projects: active project notes only, {id, ref_code|null, title}", async () => {
  const r = await call("GET", "/api/capture/projects")
  expect(r.json).toEqual({ ok: true, items: [
    { id: "projects/2026-02-01-fromagerie-julio", ref_code: null, title: "Fromagerie Julio" },
    { id: "projects/2026-01-10-tls-dashboard", ref_code: "PRJ-WCLS", title: "TLS Dashboard" },
  ] })
  expect(hits[0]!.path).toBe("/api/notes?lite=1")
  expect((await call("POST", "/api/capture/projects")).status).toBe(405)
})

test("dashboard key missing → 503; dashboard down → 502; no dashboard GET /inbox/:id yet → 502 dashboard_error", async () => {
  writeFileSync(process.env.TLS_SECRETS_FILE!, "OTHER='x'\n")
  expect((await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" })).json).toEqual({ ok: false, error: "dashboard_key_missing" })
  expect((await call("GET", "/api/capture/voice/1")).status).toBe(503)
  expect((await call("GET", "/api/capture/projects")).status).toBe(503)
  writeFileSync(process.env.TLS_SECRETS_FILE!, `TLS_DASHBOARD_API_KEY='${DASH_KEY}'\n`)
  process.env.COMPANION_DASHBOARD_URL = "http://127.0.0.1:9"
  expect((await call("GET", "/api/capture/voice?status=pending")).json).toEqual({ ok: false, error: "dashboard_unreachable" })
  expect((await call("GET", "/api/capture/voice/1/audio")).status).toBe(502)
  process.env.COMPANION_DASHBOARD_URL = `http://127.0.0.1:${dash.port}/legacy` // every path 404s as plain text
  expect((await call("GET", "/api/capture/voice/1")).json).toEqual({ ok: false, error: "dashboard_error" })
})

test("transcriptOf strips only the marker", () => {
  expect(transcriptOf("[voice note: a.m4a]")).toBeNull()
  expect(transcriptOf("[voice note: a.m4a]\n\n  hello  ")).toBe("hello")
  expect(transcriptOf("plain text")).toBe("plain text")
})

// ── Upstream mode (the Mac) ──

test("upstream: every voice route forwards to the store host (bearer, hop, device); no local dashboard call", async () => {
  process.env.COMPANION_VAULT_UPSTREAM = `http://127.0.0.1:${upstream.port}`
  upReply = (h) => h.path.endsWith("/audio")
    ? new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "audio/mp4" } })
    : Response.json({ ok: true, echo: h.path })
  const calls: Array<[string, string, unknown?]> = [
    ["POST", "/api/capture/voice/start", { mime: "audio/mp4" }],
    ["POST", "/api/capture/voice/7/chunk", { seq: 0, audio: b64(new Uint8Array(512 * 1024)) }],
    ["POST", "/api/capture/voice/7/finalize"],
    ["POST", "/api/capture/voice/7/transcribe"],
    ["GET", "/api/capture/voice?status=pending"],
    ["GET", "/api/capture/voice/7"],
    ["POST", "/api/capture/voice/7/validate", { transcript: "t", title: "x", project: "PRJ-WCLS" }],
    ["POST", "/api/capture/voice/7/discard"],
    ["GET", "/api/capture/projects"],
  ]
  for (const [m, p, body] of calls) {
    const r = await call(m, p, body)
    expect(r.json).toEqual({ ok: true, echo: p })
  }
  expect(up.map((h) => `${h.method} ${h.path}`)).toEqual(calls.map(([m, p]) => `${m} ${p}`))
  for (const h of up) expect(h).toMatchObject({ auth: `Bearer ${TOKEN}`, hop: "1", key: null })
  expect(JSON.parse(up[1]!.body).audio.length).toBe(b64(new Uint8Array(512 * 1024)).length) // ~700 KB JSON body intact
  expect(JSON.parse(up[6]!.body)).toEqual({ transcript: "t", title: "x", project: "PRJ-WCLS" })

  const audio = await call("GET", "/api/capture/voice/7/audio", undefined, { range: "bytes=2-" })
  expect(audio.status).toBe(206)
  expect([...audio.bytes]).toEqual([3, 4])
  expect(audio.headers.get("content-type")).toBe("audio/mp4")
  expect(up.at(-1)).toMatchObject({ method: "GET", path: "/api/capture/voice/7/audio", hop: "1" })
  upReply = () => Response.json({ ok: false, error: "not_found" }, { status: 404 })
  expect(await call("GET", "/api/capture/voice/8/audio")).toMatchObject({ status: 404, json: { ok: false, error: "not_found" } })
  expect(hits).toEqual([])
  expect((await call("POST", "/api/capture/voice/start", { mime: "audio/mp4" }, { "x-companion-vault-hop": "1" })).status).toBe(508)
})
