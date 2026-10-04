import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { getAuthToken } from "../lib/auth"
import { resetIdempotency } from "../lib/idempotency"
import { getQaRow, insertQueued, transition, useReceiptQaDb } from "../lib/receipt-qa-store"
import { auditFile } from "../lib/receipt-qa-worker"
import { recordPeer } from "../lib/vault-guard"
import { captureLimiter, handleCaptureRoute, parseItemPath } from "./capture"

// /api/capture/* + /api/receipts/* against a fake tls-dashboard-v2 and a fake
// upstream Companion. COMPANION_RECEIPT_QA=off here: the queue worker is
// covered in lib/receipt-qa-worker.test.ts and must not race these requests.

process.env.COMPANION_AUTH_TOKEN = process.env.COMPANION_AUTH_TOKEN || "capture-test-token-0123456789"
const TOKEN = getAuthToken()
const DASH_KEY = "dash-SECRET-key-123456"
const ID = "accounting/2026-10/2026-10-01-resto-chez-paul"
const savedEnv = { ...process.env }

interface Hit { method: string; path: string; key: string | null; auth: string | null; hop: string | null; body: string }
let hits: Hit[] = []
let up: Hit[] = []
let extract: () => Response = () => Response.json({})
let dash: ReturnType<typeof Bun.serve>
let upstream: ReturnType<typeof Bun.serve>
let upReply: (h: Hit) => Response = () => Response.json({ ok: true })
let home = ""
let stderr = ""
const realWrite = process.stderr.write.bind(process.stderr)
let jpeg = ""

const EXTRACTED = { merchant: "Resto Chez Paul", date: "2026-10-01", total: "$114.98", category: "Meals", purpose: "Business lunch", payment: "Visa ••1234", tps: "$5.00", tvq: "$9.98", tip: "", subtotal: "$100.00", address: "1 rue Principale, Granby", receipt_number: "", reimbursable: "", items: "2x table d'hôte", receiptFile: "2026-10-03-1.pdf" }

beforeAll(async () => {
  jpeg = (await sharp({ create: { width: 40, height: 60, channels: 3, background: "#ffffff" } }).jpeg().toBuffer()).toString("base64")
  dash = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      const h: Hit = { method: req.method, path: u.pathname, key: req.headers.get("x-api-key"), auth: null, hop: null, body: await req.text() }
      hits.push(h)
      if (u.pathname === "/api/inbox") return Response.json({ ok: true, id: 4242 })
      if (u.pathname === "/api/expense/extract") return extract()
      if (u.pathname === "/api/expense/save") return Response.json({ ok: true, id: ID, receiptFile: "2026-10-03-1.pdf" })
      if (u.pathname.startsWith("/api/expense/receipt/")) return new Response("%PDF-1.4 receipt", { headers: { "content-type": "application/pdf" } })
      if (req.method === "PATCH") return Response.json({ ok: true, id: ID })
      return new Response("nope", { status: 404 })
    },
  })
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
  home = mkdtempSync(join(tmpdir(), "capture-"))
  process.env.HOME = home
  process.env.TLS_SECRETS_FILE = join(home, "secrets.env")
  writeFileSync(process.env.TLS_SECRETS_FILE, `TLS_DASHBOARD_API_KEY='${DASH_KEY}'  # jeremie.apies.dev\n`)
  process.env.COMPANION_DASHBOARD_URL = `http://127.0.0.1:${dash.port}`
  process.env.COMPANION_RECEIPT_QA = "off"
  process.env.COMPANION_DB_PATH = join(home, "test.db")
  delete process.env.COMPANION_VAULT_UPSTREAM
  useReceiptQaDb(process.env.COMPANION_DB_PATH)
  hits = []
  up = []
  upReply = () => Response.json({ ok: true })
  extract = () => Response.json({ ok: true, data: EXTRACTED })
  captureLimiter.reset()
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

// ── Quick Capture → TLS inbox ──

test("inbox: forwards raw_text + type_hint with the X-API-Key from the vault", async () => {
  const r = await call("POST", "/api/capture/inbox", { text: "  idée: drone shot pour Granby  ", type_hint: "idea" })
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true, id: 4242 })
  expect(hits).toHaveLength(1)
  expect(hits[0]).toMatchObject({ method: "POST", path: "/api/inbox", key: DASH_KEY })
  expect(JSON.parse(hits[0]!.body)).toEqual({ raw_text: "idée: drone shot pour Granby", type_hint: "idea" })
  expect(stderr).not.toContain("drone shot")
  expect(stderr).not.toContain(DASH_KEY)
})

test("inbox: 503 dashboard_key_missing when the vault has no key; nothing sent", async () => {
  writeFileSync(process.env.TLS_SECRETS_FILE!, "OTHER_KEY='x'\n")
  const r = await call("POST", "/api/capture/inbox", { text: "hello" })
  expect(r.status).toBe(503)
  expect(r.json).toEqual({ ok: false, error: "dashboard_key_missing" })
  expect(hits).toEqual([])
})

test("inbox: validation (empty, > 10k, bad hint, bad JSON, method)", async () => {
  expect((await call("POST", "/api/capture/inbox", { text: "   " })).json.error).toBe("text_required")
  expect((await call("POST", "/api/capture/inbox", { text: "x".repeat(10_001) })).status).toBe(413)
  expect((await call("POST", "/api/capture/inbox", { text: "x".repeat(10_000) })).status).toBe(200)
  expect((await call("POST", "/api/capture/inbox", { text: "x", type_hint: 3 })).json.error).toBe("bad_type_hint")
  expect((await call("POST", "/api/capture/inbox", [1])).json.error).toBe("bad_json")
  expect((await call("GET", "/api/capture/inbox")).status).toBe(405)
})

test("inbox: dashboard down → 502 dashboard_unreachable", async () => {
  process.env.COMPANION_DASHBOARD_URL = "http://127.0.0.1:9"
  const r = await call("POST", "/api/capture/inbox", { text: "x" })
  expect(r).toMatchObject({ status: 502, json: { ok: false, error: "dashboard_unreachable" } })
})

// ── Receipt: extract → save → queued ──

test("receipt: extract then save straight away → queued row, contract response", async () => {
  const r = await call("POST", "/api/capture/receipt", { image: `data:image/jpeg;base64,${jpeg}`, note: "dîner client Acme" })
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true, expense_id: ID, merchant: "Resto Chez Paul", total: "$114.98", date: "2026-10-01", category: "Meals", category_code: "", qa_status: "queued" })
  expect(hits.map((h) => `${h.method} ${h.path} ${h.key === DASH_KEY}`)).toEqual(["POST /api/expense/extract true", "POST /api/expense/save true"])
  const sentExtract = JSON.parse(hits[0]!.body)
  expect(sentExtract.image.startsWith("data:image/jpeg;base64,")).toBe(true)
  const saved = JSON.parse(hits[1]!.body)
  expect(saved).toMatchObject({ merchant: "Resto Chez Paul", total: "$114.98", notes: "dîner client Acme", receiptFile: "2026-10-03-1.pdf" })
  expect(saved.category_code).toBeUndefined()
  const row = getQaRow(ID)!
  expect(row.status).toBe("queued") // kill switch on: QA skipped, save still works
  expect(row.receipt_file).toBe("2026-10-03-1.pdf")
  expect(existsSync(row.image_path)).toBe(true)
  expect(statSync(row.image_path).mode & 0o777).toBe(0o600)
  expect(stderr).not.toContain("Resto Chez Paul")
  expect(stderr).not.toContain(DASH_KEY)
})

test("receipt: a PDF goes as pdf; wrong / oversize / missing payloads are refused before the dashboard", async () => {
  const pdf = Buffer.from("%PDF-1.4\n%fake receipt").toString("base64")
  expect((await call("POST", "/api/capture/receipt", { pdf })).status).toBe(200)
  expect(JSON.parse(hits[0]!.body).pdf).toBe(pdf)
  hits = []
  expect((await call("POST", "/api/capture/receipt", {})).json.error).toBe("image_or_pdf_required")
  expect((await call("POST", "/api/capture/receipt", { image: jpeg, pdf })).json.error).toBe("image_or_pdf_required")
  expect((await call("POST", "/api/capture/receipt", { image: "!!!notbase64" })).json.error).toBe("bad_base64")
  expect((await call("POST", "/api/capture/receipt", { image: Buffer.from("hello world").toString("base64") })).status).toBe(415)
  expect((await call("POST", "/api/capture/receipt", { pdf: jpeg })).status).toBe(415)
  const big = Buffer.alloc(12 * 1024 * 1024 + 10, 0xff).toString("base64")
  expect((await call("POST", "/api/capture/receipt", { image: big })).status).toBe(413)
  expect(hits).toEqual([])
})

test("receipt: extract failure → 422 extract_failed with the dashboard's message; nothing saved", async () => {
  extract = () => Response.json({ ok: false, error: "Receipt extraction failed (400). The photo may be HEIC." }, { status: 422 })
  const r = await call("POST", "/api/capture/receipt", { image: jpeg })
  expect(r.status).toBe(422)
  expect(r.json).toEqual({ ok: false, error: "extract_failed", message: "Receipt extraction failed (400). The photo may be HEIC." })
  expect(hits.map((h) => h.path)).toEqual(["/api/expense/extract"])
  extract = () => Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 })
  expect((await call("POST", "/api/capture/receipt", { image: jpeg })).json.error).toBe("extract_failed")
  extract = () => Response.json({ ok: false, error: "Failed to parse extraction" })
  expect((await call("POST", "/api/capture/receipt", { image: jpeg })).status).toBe(422)
  expect(getQaRow(ID)).toBeNull()
})

test("receipt: key missing → 503; Idempotency-Key replays without a second save", async () => {
  writeFileSync(process.env.TLS_SECRETS_FILE!, "")
  expect((await call("POST", "/api/capture/receipt", { image: jpeg })).json).toEqual({ ok: false, error: "dashboard_key_missing" })
  writeFileSync(process.env.TLS_SECRETS_FILE!, `TLS_DASHBOARD_API_KEY='${DASH_KEY}'\n`)
  const a = await call("POST", "/api/capture/receipt", { image: jpeg }, { "idempotency-key": "k1" })
  const b = await call("POST", "/api/capture/receipt", { image: jpeg }, { "idempotency-key": "k1" })
  expect(b.json).toEqual(a.json)
  expect(b.headers.get("idempotent-replayed")).toBe("true")
  expect(hits.filter((h) => h.path === "/api/expense/save")).toHaveLength(1)
})

// ── QA list / image / resolve / accept ──

function seed(status: "needs_human" | "jev_ok" = "needs_human"): void {
  insertQueued({ expense_id: ID, fields: { ...EXTRACTED, category_code: "", notes: "" } as Record<string, string>, receipt_file: "2026-10-03-1.pdf", image_path: "" })
  transition(ID, status, { issues: [{ field: "purpose", problem: "meal without trip or client context" }] })
}

test("qa list: status filter, contract item shape, validation", async () => {
  seed()
  const r = await call("GET", "/api/receipts/qa?status=needs_human&limit=50")
  expect(r.status).toBe(200)
  expect(r.json.items).toHaveLength(1)
  expect(Object.keys(r.json.items[0]).sort()).toEqual(["category", "category_code", "changes", "created_at", "date", "expense_id", "issues", "merchant", "purpose", "status", "total", "updated_at"])
  expect((await call("GET", "/api/receipts/qa?status=jev_ok")).json.items).toEqual([])
  expect((await call("GET", "/api/receipts/qa")).json.items).toHaveLength(1)
  expect((await call("GET", "/api/receipts/qa?status=bogus")).status).toBe(400)
  expect((await call("GET", "/api/receipts/qa?limit=abc")).status).toBe(400)
})

test("qa image: proxies the dashboard receipt with private caching; unknown id 404", async () => {
  seed()
  const r = await call("GET", `/api/receipts/qa/${encodeURIComponent(ID)}/image`)
  expect(r.status).toBe(200)
  expect(r.headers.get("content-type")).toBe("application/pdf")
  expect(r.headers.get("cache-control")).toBe("private, max-age=300")
  expect(new TextDecoder().decode(r.bytes)).toBe("%PDF-1.4 receipt")
  expect(hits.at(-1)).toMatchObject({ path: "/api/expense/receipt/2026-10-03-1.pdf", key: DASH_KEY })
  expect((await call("GET", `/api/receipts/qa/${ID}/image`)).status).toBe(200) // raw slashes work too
  expect((await call("GET", "/api/receipts/qa/accounting%2Fnope/image")).status).toBe(404)
})

test("qa resolve: PATCHes the dashboard, human_done, changes by human, audited", async () => {
  seed()
  const r = await call("POST", `/api/receipts/qa/${encodeURIComponent(ID)}/resolve`, { fields: { category_code: "5216", purpose: "Shoot Montréal (80 km)" }, note: "souper tournage" })
  expect(r).toMatchObject({ status: 200, json: { ok: true } })
  const patch = hits.find((h) => h.method === "PATCH")!
  expect(patch.path).toBe(`/api/expense/${ID}`)
  expect(patch.key).toBe(DASH_KEY)
  expect(JSON.parse(patch.body)).toEqual({ category_code: "5216", purpose: "Shoot Montréal (80 km)", notes: "souper tournage" })
  const row = getQaRow(ID)!
  expect(row.status).toBe("human_done")
  expect(row.changes.map((c) => `${c.field}:${c.by}`)).toEqual(["category_code:human", "purpose:human", "notes:human"])
  expect(readFileSync(auditFile(), "utf8")).toContain('"by":"human"')
  expect(readFileSync(auditFile(), "utf8")).not.toContain(DASH_KEY)
})

test("qa resolve: non-editable field / bad body / unknown id refused; accept marks done without a PATCH", async () => {
  seed()
  const base = `/api/receipts/qa/${encodeURIComponent(ID)}`
  expect((await call("POST", `${base}/resolve`, { fields: { ledger_id: "x" } })).json.error).toBe("field_not_editable")
  expect((await call("POST", `${base}/resolve`, { fields: "x" })).json.error).toBe("bad_fields")
  expect((await call("POST", "/api/receipts/qa/nope/resolve", { fields: {} })).status).toBe(404)
  expect((await call("GET", `${base}/accept`)).status).toBe(405)
  expect((await call("POST", `${base}/accept`)).json).toEqual({ ok: true })
  expect(getQaRow(ID)!.status).toBe("human_done")
  expect(hits.some((h) => h.method === "PATCH")).toBe(false)
  expect(parseItemPath("/api/receipts/qa/a%2F..%2Fb/accept")).toBeNull()
  expect(parseItemPath("/api/receipts/qa/x/delete")).toBeNull()
})

// ── Upstream mode (the Mac) ──

test("upstream: capture + qa routes forward to the store host (bearer, hop, device); no local dashboard call", async () => {
  process.env.COMPANION_VAULT_UPSTREAM = `http://127.0.0.1:${upstream.port}`
  upReply = (h) => h.path.startsWith("/api/capture/inbox") ? Response.json({ ok: true, id: 7 }) : Response.json({ ok: true, items: [] })
  const a = await call("POST", "/api/capture/inbox", { text: "note from the Mac", type_hint: "note" })
  expect(a.json).toEqual({ ok: true, id: 7 })
  expect(up[0]).toMatchObject({ method: "POST", path: "/api/capture/inbox", auth: `Bearer ${TOKEN}`, hop: "1", key: null })
  expect(JSON.parse(up[0]!.body)).toEqual({ text: "note from the Mac", type_hint: "note" })
  await call("POST", "/api/capture/receipt", { image: jpeg })
  expect(JSON.parse(up[1]!.body)).toEqual({ image: jpeg })
  await call("GET", "/api/receipts/qa?status=needs_human&limit=5")
  expect(up[2]!.path).toBe("/api/receipts/qa?status=needs_human&limit=5")
  await call("POST", `/api/receipts/qa/${encodeURIComponent(ID)}/resolve`, { fields: { purpose: "x" } })
  expect(up[3]!.path).toBe(`/api/receipts/qa/${encodeURIComponent(ID)}/resolve`)
  upReply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=300" } })
  const img = await call("GET", `/api/receipts/qa/${encodeURIComponent(ID)}/image`)
  expect([...img.bytes]).toEqual([1, 2, 3])
  expect(img.headers.get("content-type")).toBe("image/jpeg")
  expect(hits).toEqual([])
  expect(getQaRow(ID)).toBeNull()
  // a forwarded call arriving at a server that is itself in upstream mode = loop
  expect((await call("POST", "/api/capture/inbox", { text: "x" }, { "x-companion-vault-hop": "1" })).status).toBe(508)
  expect(up[0]!.body).not.toContain(DASH_KEY)
})

test("capture POSTs are rate limited", async () => {
  for (let i = 0; i < 30; i++) await call("POST", "/api/capture/inbox", { text: `n${i}` })
  const r = await call("POST", "/api/capture/inbox", { text: "one more" })
  expect(r.status).toBe(429)
  expect(r.headers.get("retry-after")).toBeTruthy()
})
