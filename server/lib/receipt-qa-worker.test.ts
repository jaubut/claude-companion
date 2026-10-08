import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type JevVerdict, decideJev, resetChartCache } from "./receipt-jev"
import { type ExpenseFields, type QaItem, getQaRow, insertQueued, onReceiptQa, useReceiptQaDb } from "./receipt-qa-store"
import { MAX_ATTEMPTS, auditFile, drainReceiptQa, workerDeps } from "./receipt-qa-worker"
import { runSonnetCli } from "./receipt-sonnet"
import { receiptPushPayload, wireReceiptQa } from "../wiring/receipt-qa"

// Receipt QA worker: Jev pass (code checks + fake System One over HTTP),
// Sonnet pass (fake runner + one fake `claude` binary), restart resume, kill
// switch, audit, WS frame + push. Never touches the real dashboard, Jev,
// claude, Turso or the real Companion db.

const DASH_KEY = "dash-SECRET-key-123456"
const JEV_KEY = "jev-SECRET-key-654321"
const NOW = Date.parse("2026-10-03T15:00:00Z")
const realDeps = { ...workerDeps }
const savedEnv = { ...process.env }

let home = ""
let dbPath = ""
let stderr = ""
const realWrite = process.stderr.write.bind(process.stderr)

interface Hit { method: string; path: string; key: string | null; auth: string | null; body: string }
let hits: Hit[] = []
let jevAnswer: () => Response = () => Response.json({})
let patchReply: () => Response = () => Response.json({ ok: true })
// Fake tls-dashboard-v2 POST /api/geo/office-distance (Granby office).
const GRANBY = "301 rue Notre-Dame, Granby, QC J2G 3L2"
const MONTREAL = "1234 rue Saint-Denis, Montréal, QC H2X 3J6"
const OFFICE_KM: Record<string, number> = { [GRANBY]: 1.2, "45 rue Principale, Granby, QC J2G 2T8": 0.8, [MONTREAL]: 82.4 }
let distanceReply: (address: string) => Response = (address) =>
  address in OFFICE_KM ? Response.json({ km: OFFICE_KM[address], method: "driving", lat: 45.4, lon: -72.7 }) : Response.json({ km: null, reason: "address not geocodable" })
let server: ReturnType<typeof Bun.serve>

let sonnetCalls: Array<{ prompt: string; imagePath: string }> = []
let sonnetText: string | null = ""
let frames: QaItem[] = []
let pushes: Array<{ title: string; body: string; userInfo?: Record<string, string>; collapseId?: string }> = []
let unwire: () => void = () => {}

function jev(code: string, confidence: number, extra: Partial<Record<"grocery" | "meal" | "trip", number>> = {}): () => Response {
  return () => Response.json({
    model: "jev-1.13", usage: { input_tokens: 1, output_tokens: 1 },
    answers: {
      gl_code: { type: "choice", choice: code, probabilities: {}, confidence },
      is_grocery: { type: "noul", noul: extra.grocery ?? 0.02 },
      is_meal: { type: "noul", noul: extra.meal ?? 0.02 },
      trip_context: { type: "noul", noul: extra.trip ?? 0.02 },
    },
  })
}

beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      hits.push({ method: req.method, path: u.pathname, key: req.headers.get("x-api-key"), auth: req.headers.get("authorization"), body: await req.text() })
      if (u.pathname === "/jev") return jevAnswer()
      if (u.pathname === "/api/geo/office-distance" && req.method === "POST") return distanceReply(String(JSON.parse(hits.at(-1)!.body).address ?? ""))
      if (req.method === "PATCH") return patchReply()
      return new Response("nope", { status: 404 })
    },
  })
})
afterAll(() => {
  server.stop(true)
  Object.assign(workerDeps, realDeps)
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "receipt-qa-"))
  process.env.HOME = home
  process.env.TLS_SECRETS_FILE = join(home, "secrets.env")
  writeFileSync(process.env.TLS_SECRETS_FILE, `TLS_DASHBOARD_API_KEY='${DASH_KEY}'  # jeremie.apies.dev\nTYPESAFE_API_KEY='${JEV_KEY}'\r\n`)
  process.env.COMPANION_DASHBOARD_URL = `http://127.0.0.1:${server.port}`
  process.env.COMPANION_JEV_URL = `http://127.0.0.1:${server.port}/jev`
  delete process.env.COMPANION_VAULT_UPSTREAM
  delete process.env.COMPANION_RECEIPT_QA
  dbPath = join(home, "test.db")
  process.env.COMPANION_DB_PATH = dbPath
  useReceiptQaDb(dbPath)
  resetChartCache()
  hits = []
  sonnetCalls = []
  sonnetText = ""
  frames = []
  pushes = []
  jevAnswer = jev("5776", 0.95)
  patchReply = () => Response.json({ ok: true })
  distanceReply = (address) =>
    address in OFFICE_KM ? Response.json({ km: OFFICE_KM[address], method: "driving", lat: 45.4, lon: -72.7 }) : Response.json({ km: null, reason: "address not geocodable" })
  Object.assign(workerDeps, realDeps, {
    dupQuery: async () => [],
    chartQuery: async () => [{ code: "5776", name: "Frais de représentation" }, { code: "5216", name: "Travel Expenses" }, { code: "2400", name: "Business MC" }],
    sonnet: async (prompt: string, imagePath: string) => {
      sonnetCalls.push({ prompt, imagePath })
      return sonnetText === null ? { kind: "error" as const, reason: "exit 1" } : { kind: "ok" as const, text: sonnetText }
    },
    fetchReceipt: async () => null,
    now: () => NOW,
  })
  unwire = wireReceiptQa({ broadcast: (f) => frames.push(f.item as QaItem), push: async (p) => { pushes.push(p) } })
  stderr = ""
  process.stderr.write = ((c: string | Uint8Array) => { stderr += String(c); return true }) as typeof process.stderr.write
})
afterEach(() => {
  process.stderr.write = realWrite
  unwire()
  rmSync(home, { recursive: true, force: true })
})

const ID = "accounting/2026-10/2026-10-01-resto-chez-paul"
const MEAL = {
  merchant: "Resto Chez Paul", date: "2026-10-01", total: "$114.98", subtotal: "$100.00", tps: "$5.00", tvq: "$9.98",
  tip: "", category: "Meals", category_code: "5776", purpose: "Lunch with client Acme about the October shoot", notes: "", currency: "CAD",
  address: "45 rue Principale, Granby, QC J2G 2T8",
} satisfies ExpenseFields
// Not a meal: Jev owns the GL code (the distance rule does not apply).
const OFFICE = { merchant: "Bureau en Gros", category: "Office", category_code: "5700", purpose: "Printer paper for the studio", address: GRANBY } satisfies ExpenseFields

function seed(fields: ExpenseFields = {}, id = ID): void {
  insertQueued({ expense_id: id, fields: { ...MEAL, ...fields }, receipt_file: "2026-10-01-1.pdf", image_path: "" })
}

// ── Jev decision mapping (pure) ──

const V = (code: string, confidence: number, o: Partial<JevVerdict> = {}): JevVerdict => ({ code, confidence, grocery: 0, meal: 0, trip: 0, ...o })

test("decideJev: agree at ≥ 0.9 with every check passing → jev_ok", () => {
  expect(decideJev(MEAL, [], V("5776", 0.9, { meal: 0.9, trip: 0.8 }))).toEqual({ status: "jev_ok", issues: [] })
})

test("decideJev: disagree / low confidence / missing code / failed check → to_review", () => {
  expect(decideJev(MEAL, [], V("5216", 0.97, { meal: 0.9, trip: 0.9 })).issues[0]).toMatchObject({ field: "category_code", suggestion: "5216" })
  expect(decideJev(MEAL, [], V("5776", 0.6, { meal: 0.9, trip: 0.9 })).status).toBe("to_review")
  const missing = decideJev({ ...MEAL, category_code: "" }, [], V("5776", 0.85, { meal: 0.9, trip: 0.9 }))
  expect(missing).toMatchObject({ status: "to_review", issues: [{ field: "category_code", suggestion: "5776" }] })
  expect(missing.fill).toBeUndefined()
  expect(decideJev(MEAL, [{ field: "tps", problem: "x" }], V("5776", 0.99, { meal: 0.9, trip: 0.9 })).status).toBe("to_review")
})

test("decideJev: grocery booked as business → to_review; grocery booked personal → jev_ok", () => {
  const maxi = { ...MEAL, merchant: "Maxi Granby", category: "Other", category_code: "5700", purpose: "Snacks for the shoot" }
  const r = decideJev(maxi, [], V("5700", 0.95))
  expect(r.issues.map((i) => i.problem)).toContain("grocery purchase booked as business (groceries are always personal)")
  // Jev noul catches a grocer the regex does not know
  expect(decideJev({ ...maxi, merchant: "Marché Tradition" }, [], V("5700", 0.95, { grocery: 0.8 })).status).toBe("to_review")
  const personal = { ...maxi, category_code: "", purpose: "Personal — not a business expense", reimbursable: "no" }
  expect(decideJev(personal, [], V("personal", 0.93))).toEqual({ status: "jev_ok", issues: [] })
})

test("decideJev: meal without trip/client context → to_review (50 km rule)", () => {
  const r = decideJev({ ...MEAL, purpose: "lunch" }, [], V("5776", 0.95, { meal: 0.9, trip: 0.1 }))
  expect(r.status).toBe("to_review")
  expect(r.issues[0]!.problem).toContain("50 km")
})

test("decideJev: Jev unavailable → to_review with jev_unavailable", () => {
  expect(decideJev(MEAL, [], null)).toEqual({ status: "to_review", issues: [{ field: "jev", problem: "jev_unavailable" }] })
})

test("decideJev: blank code + conf ≥ 0.9 + clean → jev_ok with fill; any flag or check → no fill", () => {
  const blank = { ...MEAL, category_code: "" }
  expect(decideJev(blank, [], V("5776", 0.92, { meal: 0.9, trip: 0.9 }))).toEqual({ status: "jev_ok", issues: [], fill: "5776" })
  expect(decideJev(blank, [{ field: "tps", problem: "x" }], V("5776", 0.99, { meal: 0.9, trip: 0.9 })).fill).toBeUndefined()
  expect(decideJev({ ...blank, purpose: "lunch" }, [], V("5776", 0.99, { meal: 0.9, trip: 0.1 })).fill).toBeUndefined()
  expect(decideJev(blank, [], V("personal", 0.99)).fill).toBeUndefined()
})

// ── Pass 1 end to end ──

test("Jev fill: blank code + confident + clean → PATCH category_code, by:jev change, audit, jev_ok", async () => {
  seed({ ...OFFICE, category_code: "" })
  jevAnswer = jev("5700", 0.95)
  await drainReceiptQa()
  const row = getQaRow(ID)!
  expect(row).toMatchObject({ status: "jev_ok", category_code: "5700", issues: [] })
  expect(row.changes).toEqual([{ field: "category_code", from: "", to: "5700", by: "jev" }])
  const patches = hits.filter((h) => h.method === "PATCH")
  expect(patches).toHaveLength(1)
  expect(patches[0]!.key).toBe(DASH_KEY)
  expect(JSON.parse(patches[0]!.body)).toEqual({ category_code: "5700" })
  expect(hits.some((h) => h.path === "/api/geo/office-distance")).toBe(false) // not a meal
  const audit = readFileSync(auditFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(audit).toEqual([expect.objectContaining({ expense_id: ID, by: "jev", field: "category_code", from: "", to: "5700", reason: "jev conf 0.95" })])
  expect(sonnetCalls).toHaveLength(0)
  expect(frames.map((f) => f.status)).toEqual(["queued", "jev_ok"])
})

test("Jev fill refused: grocery flag, conf 0.85, or a non-blank code Jev disagrees with → to_review, no write", async () => {
  sonnetText = null // keep rows in to_review
  seed({ category_code: "", merchant: "Maxi Granby", category: "Other", purpose: "Snacks for the shoot" }, `${ID}-g`)
  jevAnswer = jev("5700", 0.97)
  await drainReceiptQa()
  expect(getQaRow(`${ID}-g`)!.status).toBe("to_review")
  seed({ ...OFFICE, category_code: "" }, `${ID}-l`)
  jevAnswer = jev("5700", 0.85)
  await drainReceiptQa()
  expect(getQaRow(`${ID}-l`)!.issues[0]).toMatchObject({ field: "category_code", suggestion: "5700" })
  seed(OFFICE, `${ID}-n`) // saved 5700
  jevAnswer = jev("5783", 0.97)
  await drainReceiptQa()
  const n = getQaRow(`${ID}-n`)!
  expect(n).toMatchObject({ status: "to_review", category_code: "5700", changes: [] })
  expect(hits.some((h) => h.method === "PATCH")).toBe(false)
  expect(existsSync(auditFile())).toBe(false)
})

test("Jev fill: dashboard PATCH 5xx → retried later, not dropped", async () => {
  seed({ category_code: "" })
  jevAnswer = jev("5776", 0.95, { meal: 0.9, trip: 0.9 })
  patchReply = () => new Response("down", { status: 503 })
  await drainReceiptQa()
  expect(getQaRow(ID)!).toMatchObject({ status: "queued", attempts: 1 })
  patchReply = () => Response.json({ ok: true })
  workerDeps.now = () => NOW + 3_600_000
  await drainReceiptQa()
  expect(getQaRow(ID)!).toMatchObject({ status: "jev_ok", category_code: "5776" })
})

test("Jev pass: fake System One agrees → jev_ok; request carries the vault key and the chart", async () => {
  seed()
  jevAnswer = jev("5776", 0.95, { meal: 0.9, trip: 0.9 })
  expect(await drainReceiptQa()).toBe(1)
  expect(getQaRow(ID)!.status).toBe("jev_ok")
  const call = hits.find((h) => h.path === "/jev")!
  expect(call.auth).toBe(`Bearer ${JEV_KEY}`)
  const sent = JSON.parse(call.body)
  expect(sent.model).toBe("jev-latest")
  expect(Object.keys(sent.questions.gl_code.criteria)).toEqual(expect.arrayContaining(["5216", "5776", "personal"]))
  expect(sent.questions.gl_code.criteria["2400"]).toBeUndefined() // never a card account
  expect(frames.map((f) => f.status)).toEqual(["queued", "jev_ok"])
})

test("Jev pass: HTTP error → to_review / jev_unavailable; a missing key too", async () => {
  sonnetText = null // keep the row in to_review (Sonnet backs off)
  seed()
  jevAnswer = () => new Response("boom", { status: 500 })
  await drainReceiptQa()
  expect(getQaRow(ID)!.issues).toContainEqual({ field: "jev", problem: "jev_unavailable" })
  writeFileSync(process.env.TLS_SECRETS_FILE!, `TLS_DASHBOARD_API_KEY='${DASH_KEY}'\n`)
  seed({}, `${ID}-2`)
  jevAnswer = jev("5776", 0.99, { meal: 0.9, trip: 0.9 })
  await drainReceiptQa()
  expect(getQaRow(`${ID}-2`)!.status).toBe("to_review")
})

test("Jev pass: duplicate check down → retried with backoff, then reviewed", async () => {
  sonnetText = null
  seed()
  workerDeps.dupQuery = async () => { throw new Error("turso down") }
  await drainReceiptQa()
  let row = getQaRow(ID)!
  expect(row).toMatchObject({ status: "queued", attempts: 1 })
  expect(row.next_attempt_at).toBe(NOW + 30_000)
  let t = NOW
  workerDeps.now = () => t
  for (let i = 1; i < MAX_ATTEMPTS; i++) { t += 3_600_000; await drainReceiptQa() }
  row = getQaRow(ID)!
  expect(row.status).toBe("to_review")
  expect(row.issues).toContainEqual({ field: "total", problem: "duplicate check unavailable" })
})

// ── Meal GL rule: office distance decides 5216 vs 5776 ──

function auditLines(): Array<Record<string, unknown>> {
  return readFileSync(auditFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l))
}

test("meal rule: Granby address (≤ 50 km) → 5776 set in code, by:rule change + audit", async () => {
  seed({ category_code: "", address: GRANBY })
  jevAnswer = jev("5216", 0.97, { meal: 0.9, trip: 0.1 }) // Jev's pick and trip noul do not decide a meal
  await drainReceiptQa()
  const row = getQaRow(ID)!
  expect(row).toMatchObject({ status: "jev_ok", category_code: "5776", issues: [] })
  expect(row.changes).toEqual([{ field: "category_code", from: "", to: "5776", by: "rule" }])
  expect(row.jev).toMatchObject({ office_km: 1.2 })
  const dist = hits.find((h) => h.path === "/api/geo/office-distance")!
  expect(dist).toMatchObject({ method: "POST", key: DASH_KEY })
  expect(JSON.parse(dist.body)).toEqual({ address: GRANBY })
  expect(JSON.parse(hits.find((h) => h.method === "PATCH")!.body)).toEqual({ category_code: "5776" })
  expect(auditLines()).toEqual([expect.objectContaining({ expense_id: ID, by: "rule", field: "category_code", from: "", to: "5776", reason: "meal 1.2 km from office (≤ 50 km)" })])
})

test("meal rule: Montréal address (> 50 km) → 5216 overrides a saved 5776", async () => {
  seed({ address: MONTREAL }) // saved 5776
  jevAnswer = jev("5776", 0.95, { meal: 0.9, trip: 0.9 })
  await drainReceiptQa()
  const row = getQaRow(ID)!
  expect(row).toMatchObject({ status: "jev_ok", category_code: "5216" })
  expect(row.changes).toEqual([{ field: "category_code", from: "5776", to: "5216", by: "rule" }])
  expect(auditLines()[0]).toMatchObject({ by: "rule", to: "5216", reason: "meal 82.4 km from office (> 50 km)" })
})

test("meal rule: meal detected by Jev's noul alone (category not a meal)", async () => {
  seed({ category: "Other", category_code: "", address: MONTREAL })
  jevAnswer = jev("5776", 0.95, { meal: 0.8, trip: 0.9 })
  await drainReceiptQa()
  expect(getQaRow(ID)!).toMatchObject({ status: "jev_ok", category_code: "5216" })
})

test("meal rule: missing / ungeocodable address or endpoint down → to_review 'meal address unresolved', no code written", async () => {
  sonnetText = null // keep rows in to_review
  jevAnswer = jev("5776", 0.99, { meal: 0.9, trip: 0.9 })
  seed({ category_code: "", address: "" })
  await drainReceiptQa()
  let row = getQaRow(ID)!
  expect(row).toMatchObject({ status: "to_review", category_code: "", changes: [] })
  expect(row.issues).toEqual([{ field: "address", problem: "meal address unresolved: no address on the receipt" }])
  expect(hits.some((h) => h.path === "/api/geo/office-distance")).toBe(false)

  seed({ category_code: "", address: "zzz nowhere" }, `${ID}-g`)
  await drainReceiptQa()
  row = getQaRow(`${ID}-g`)!
  expect(row).toMatchObject({ status: "to_review", category_code: "" })
  expect(row.issues).toEqual([{ field: "address", problem: "meal address unresolved: address not geocodable" }])

  distanceReply = () => new Response("down", { status: 503 })
  seed({ category_code: "", address: GRANBY }, `${ID}-u`)
  await drainReceiptQa()
  row = getQaRow(`${ID}-u`)!
  expect(row).toMatchObject({ status: "to_review", category_code: "" })
  expect(row.issues[0]!.problem).toBe("meal address unresolved: office-distance endpoint unavailable")

  distanceReply = () => Response.json({ error: "not_found" }, { status: 404 }) // endpoint not deployed
  seed({ category_code: "", address: GRANBY }, `${ID}-4`)
  await drainReceiptQa()
  expect(getQaRow(`${ID}-4`)!.issues[0]!.problem).toBe("meal address unresolved: http 404")

  expect(hits.some((h) => h.method === "PATCH")).toBe(false)
  expect(existsSync(auditFile())).toBe(false)
})

test("meal rule: groceries stay personal (no distance lookup); a personal meal is not booked", async () => {
  sonnetText = null
  seed({ merchant: "Maxi Granby", category: "Meals", category_code: "", purpose: "Snacks", address: GRANBY })
  jevAnswer = jev("5776", 0.97, { meal: 0.9, grocery: 0.9 })
  await drainReceiptQa()
  expect(getQaRow(ID)!.issues.map((i) => i.problem)).toContain("grocery purchase booked as business (groceries are always personal)")
  seed({ category_code: "", purpose: "Personal — not a business expense", reimbursable: "no", address: MONTREAL }, `${ID}-p`)
  jevAnswer = jev("personal", 0.95, { meal: 0.9 })
  await drainReceiptQa()
  expect(getQaRow(`${ID}-p`)!).toMatchObject({ category_code: "", changes: [] })
  expect(hits.some((h) => h.path === "/api/geo/office-distance")).toBe(false)
  expect(hits.some((h) => h.method === "PATCH")).toBe(false)
})

test("meal rule: Grain de Folie fixture (Granby) → 5776", async () => {
  workerDeps.now = () => Date.parse("2026-10-08T18:00:00Z")
  const grain = {
    merchant: "Grain de Folie", date: "2026-10-08", total: "$30.41", subtotal: "$23.00", tps: "$1.15", tvq: "$2.29", tip: "$3.97",
    category: "Meals", category_code: "", purpose: "Business meal at Grain de Folie in Granby, QC.", notes: "", currency: "CAD", address: GRANBY,
  } satisfies ExpenseFields
  const gid = "accounting/2026-10/2026-10-08-grain-de-folie-1161"
  insertQueued({ expense_id: gid, fields: grain, receipt_file: "2026-10-08-1.pdf", image_path: "" })
  jevAnswer = jev("5776", 0.7, { meal: 0.95, trip: 0.2 })
  await drainReceiptQa()
  expect(getQaRow(gid)!).toMatchObject({ status: "jev_ok", category_code: "5776", issues: [] })
  expect(getQaRow(gid)!.changes).toEqual([{ field: "category_code", from: "", to: "5776", by: "rule" }])
  // Saved 5776 already (as booked): agrees, nothing written.
  insertQueued({ expense_id: `${gid}-b`, fields: { ...grain, category_code: "5776" }, receipt_file: "", image_path: "" })
  hits = []
  await drainReceiptQa()
  expect(getQaRow(`${gid}-b`)!).toMatchObject({ status: "jev_ok", category_code: "5776", changes: [] })
  expect(hits.some((h) => h.method === "PATCH")).toBe(false)
})

test("meal rule: Sonnet may not change a meal code the rule set or could not resolve", async () => {
  seed({ category_code: "", address: "" })
  jevAnswer = jev("5776", 0.99, { meal: 0.9, trip: 0.9 })
  sonnetText = '{"resolved":true,"patch":{"category_code":"5216"},"reason":"looks like a trip"}'
  await drainReceiptQa()
  const row = getQaRow(ID)!
  expect(row.status).toBe("needs_human")
  expect(row.issues.at(-1)!.problem).toBe("patch refused: meal GL code is decided by office distance")
  expect(hits.some((h) => h.method === "PATCH")).toBe(false)
})

// ── Pass 2: Sonnet ──

// A row that reaches the Sonnet pass: no GL code, Jev down → to_review.
function review(fields: ExpenseFields = {}): void {
  seed({ category_code: "", ...fields })
  jevAnswer = () => new Response("x", { status: 500 })
}

test("Sonnet: resolved + allowlisted patch → dashboard PATCH, sonnet_fixed, changes + audit (no secrets)", async () => {
  review()
  sonnetText = '```json\n{"resolved":true,"patch":{"category_code":"5776","purpose":"Lunch with client Acme (Granby)"},"reason":"client lunch in Granby"}\n```'
  await drainReceiptQa()
  const row = getQaRow(ID)!
  expect(row.status).toBe("sonnet_fixed")
  expect(row.category_code).toBe("5776")
  expect(row.changes).toEqual([
    { field: "category_code", from: "", to: "5776", by: "sonnet" },
    { field: "purpose", from: MEAL.purpose, to: "Lunch with client Acme (Granby)", by: "sonnet" },
  ])
  const patch = hits.find((h) => h.method === "PATCH")!
  expect(patch.path).toBe(`/api/expense/${ID}`)
  expect(patch.key).toBe(DASH_KEY)
  expect(JSON.parse(patch.body)).toEqual({ category_code: "5776", purpose: "Lunch with client Acme (Granby)" })
  expect(sonnetCalls[0]!.prompt).toContain("Groceries are ALWAYS personal")
  expect(sonnetCalls[0]!.prompt).toContain("5776 Frais de représentation")
  const audit = readFileSync(auditFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(audit).toHaveLength(2)
  expect(audit[0]).toMatchObject({ expense_id: ID, by: "sonnet", field: "category_code", from: "", to: "5776", reason: "client lunch in Granby" })
  expect(Object.keys(audit[0]).sort()).toEqual(["by", "expense_id", "field", "from", "reason", "to", "ts"])
  const all = readFileSync(auditFile(), "utf8") + stderr
  expect(all).not.toContain(DASH_KEY)
  expect(all).not.toContain(JEV_KEY)
  expect(stderr).not.toContain("Lunch with client")
  expect(frames.map((f) => f.status)).toEqual(["queued", "to_review", "sonnet_fixed"])
  expect(pushes).toEqual([])
})

test("Sonnet: disallowed field → needs_human + push, nothing patched", async () => {
  review()
  sonnetText = '{"resolved":true,"patch":{"category_code":"5776","payment":"Visa ••1234"},"reason":"x"}'
  await drainReceiptQa()
  const row = getQaRow(ID)!
  expect(row.status).toBe("needs_human")
  expect(row.issues.at(-1)!.problem).toContain("payment not allowed")
  expect(hits.some((h) => h.method === "PATCH")).toBe(false)
  expect(pushes).toHaveLength(1)
  expect(pushes[0]).toMatchObject({ title: "Receipt needs you", userInfo: { kind: "receipt_review", expense_id: ID } })
  expect(pushes[0]!.body).toBe("Resto Chez Paul · 114.98 $ — jev_unavailable")
})

test("Sonnet: a code outside the chart, or amounts still off, are refused", async () => {
  review()
  sonnetText = '{"resolved":true,"patch":{"category_code":"2400"},"reason":"x"}'
  await drainReceiptQa()
  expect(getQaRow(ID)!.issues.at(-1)!.problem).toContain("not in chart")
  seed({ category_code: "", tps: "$7.00" }, `${ID}-b`)
  sonnetText = '{"resolved":true,"patch":{"category_code":"5776"},"reason":"x"}'
  await drainReceiptQa()
  expect(getQaRow(`${ID}-b`)!.status).toBe("needs_human")
})

test("Sonnet: total only when arithmetic proves it wrong and the patch adds up", async () => {
  review({ total: "$120.00" })
  sonnetText = '{"resolved":true,"patch":{"category_code":"5776","total":"114.98"},"reason":"image shows 114.98"}'
  await drainReceiptQa()
  expect(getQaRow(ID)!.status).toBe("sonnet_fixed")
  expect(JSON.parse(hits.find((h) => h.method === "PATCH")!.body).total).toBe("114.98")
  seed({ category_code: "" }, `${ID}-c`)
  sonnetText = '{"resolved":true,"patch":{"category_code":"5776","total":"99.00"},"reason":"x"}'
  await drainReceiptQa()
  expect(getQaRow(`${ID}-c`)!.issues.at(-1)!.problem).toContain("total change not proven")
})

test("Sonnet: unresolved / bad JSON → needs_human + push", async () => {
  review()
  sonnetText = '{"resolved":false,"patch":{},"reason":"where was the meal eaten?"}'
  await drainReceiptQa()
  expect(getQaRow(ID)!.issues.at(-1)!.problem).toBe("unresolved: where was the meal eaten?")
  seed({ category_code: "" }, `${ID}-d`)
  sonnetText = "I think it is fine."
  await drainReceiptQa()
  expect(getQaRow(`${ID}-d`)!).toMatchObject({ status: "needs_human" })
  expect(getQaRow(`${ID}-d`)!.issues.at(-1)!.problem).toBe("unparseable answer")
  expect(pushes.map((p) => p.userInfo?.expense_id)).toEqual([ID, `${ID}-d`])
})

test("Sonnet: a duplicate goes straight to the human (never auto-resolved)", async () => {
  seed({ category_code: "" })
  workerDeps.dupQuery = async () => [{ id: "accounting/2026-10/dupe", merchant: "Resto Chez Paul", total: "$114.98" }]
  await drainReceiptQa()
  expect(getQaRow(ID)!.status).toBe("needs_human")
  expect(sonnetCalls).toHaveLength(0)
})

test("Sonnet unavailable → backoff; dashboard PATCH 5xx → backoff, then needs_human", async () => {
  review()
  sonnetText = null
  await drainReceiptQa()
  expect(getQaRow(ID)!).toMatchObject({ status: "to_review", attempts: 1 })
  let t = NOW
  workerDeps.now = () => t
  for (let i = 1; i < MAX_ATTEMPTS; i++) { t += 3_600_000; await drainReceiptQa() }
  expect(getQaRow(ID)!.issues.at(-1)).toEqual({ field: "sonnet", problem: "sonnet_unavailable" })
  seed({ category_code: "" }, `${ID}-e`)
  sonnetText = '{"resolved":true,"patch":{"category_code":"5776"},"reason":"x"}'
  patchReply = () => new Response("down", { status: 503 })
  t += 3_600_000
  await drainReceiptQa()
  expect(getQaRow(`${ID}-e`)!).toMatchObject({ status: "to_review", attempts: 1 })
  patchReply = () => Response.json({ ok: true })
  t += 3_600_000
  await drainReceiptQa()
  expect(getQaRow(`${ID}-e`)!.status).toBe("sonnet_fixed")
})

test("the cached receipt is fetched for Sonnet and deleted once settled", async () => {
  review()
  workerDeps.fetchReceipt = async () => ({ bytes: new TextEncoder().encode("%PDF-1.4 fake"), mime: "application/pdf" })
  sonnetText = '{"resolved":true,"patch":{"category_code":"5776"},"reason":"x"}'
  await drainReceiptQa()
  const path = sonnetCalls[0]!.imagePath
  expect(path.endsWith(".pdf")).toBe(true)
  expect(path.startsWith(home)).toBe(true)
  expect(existsSync(path)).toBe(false)
  expect(getQaRow(ID)!.image_path).toBe("")
})

// ── Restart + kill switch ──

test("restart resumes the queue from sqlite", async () => {
  seed()
  seed({}, `${ID}-2`)
  useReceiptQaDb(dbPath) // a new process opening the same file
  jevAnswer = jev("5776", 0.95, { meal: 0.9, trip: 0.9 })
  expect(await drainReceiptQa()).toBe(2)
  expect(getQaRow(`${ID}-2`)!.status).toBe("jev_ok")
})

test("kill switch COMPANION_RECEIPT_QA=off: nothing runs, rows stay queued", async () => {
  process.env.COMPANION_RECEIPT_QA = "off"
  seed()
  expect(await drainReceiptQa()).toBe(0)
  expect(getQaRow(ID)!.status).toBe("queued")
  expect(hits).toEqual([])
})

test("upstream mode: the worker never runs on the Mac", async () => {
  process.env.COMPANION_VAULT_UPSTREAM = "https://zettlab.example.ts.net"
  seed()
  expect(await drainReceiptQa()).toBe(0)
})

// ── Wiring + CLI ──

test("receipt_qa frame on every status change; push payload contract", () => {
  const seen: unknown[] = []
  const off = onReceiptQa((i) => seen.push(i.status))
  seed()
  off()
  expect(seen).toEqual(["queued"])
  expect(frames[0]).toMatchObject({ expense_id: ID, status: "queued", issues: [], changes: [] })
  const p = receiptPushPayload({ ...frames[0]!, status: "needs_human", issues: [{ field: "date", problem: "date is in the future" }] })
  expect(p).toMatchObject({ title: "Receipt needs you", body: "Resto Chez Paul · 114.98 $ — date is in the future", userInfo: { kind: "receipt_review", expense_id: ID } })
  expect(p.collapseId!.startsWith("receipt-accounting/")).toBe(true)
  expect(p.collapseId!.length).toBeLessThanOrEqual(64)
})

test("runSonnetCli: absolute binary, sonnet, tools denied, Read pinned to the receipt, JSON wrapper parsed", async () => {
  const bin = join(home, "claude")
  const argsFile = join(home, "args.txt")
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argsFile}'\necho 'warning line'\necho '{"type":"result","result":"{\\"resolved\\":false,\\"patch\\":{},\\"reason\\":\\"r\\"}"}'\n`)
  chmodSync(bin, 0o700)
  process.env.COMPANION_CLAUDE_BIN = bin
  const r = await runSonnetCli("PROMPT", "/tmp/x/receipt.jpg")
  expect(r).toEqual({ kind: "ok", text: '{"resolved":false,"patch":{},"reason":"r"}' })
  const args = readFileSync(argsFile, "utf8").split("\n")
  expect(args.slice(0, 2)).toEqual(["-p", "PROMPT"])
  expect(args[args.indexOf("--model") + 1]).toBe("sonnet")
  expect(args).toContain("--strict-mcp-config")
  for (const t of ["Bash", "Edit", "Write", "WebFetch", "Task"]) expect(args).toContain(t)
  expect(args[args.indexOf("--allowed-tools") + 1]).toBe("Read(//tmp/x/receipt.jpg)")
  writeFileSync(bin, "#!/bin/sh\nexit 3\n")
  expect(await runSonnetCli("P", "")).toEqual({ kind: "error", reason: "exit 3" })
  process.env.COMPANION_CLAUDE_BIN = join(home, "missing")
  expect((await runSonnetCli("P", "")).kind).toBe("error")
})
