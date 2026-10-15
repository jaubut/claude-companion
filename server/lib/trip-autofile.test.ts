import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { RETRY_UNCLASSIFIED_MS, createTripAutofile, sqlTime } from "./trip-autofile"
import type { ClassifyInput, ClassifyResult } from "./trip-classify"
import { readBandCounts, readTrip } from "./trip-dashboard"
import { createTripService } from "./trip-service"
import { createTripStore } from "./trip-store"
import type { QueryFn, Row } from "./turso"

// The background auto-file sweep against a real sqlite `trip_entries` (Turso's
// shape) and a real companion.db store; the dashboard PATCH is a fake that
// applies the machine classify like tls-dashboard-v2 does (conditional on unclassified).

const guess = (classification: ClassifyResult["classification"], confidence: number, classifiedBy: ClassifyResult["classifiedBy"] = "jev"): ClassifyResult => ({
  classification, confidence, classifiedBy, rule: null,
  labels: { start: null, end: null, startCity: null, endCity: null }, evidenceLine: "", evidence: {},
})

interface Reply { status: number; json: Record<string, unknown> | null }

function rig(opts: { approvalColumn?: boolean; echo?: boolean } = {}) {
  let clock = Date.parse("2026-10-15T12:00:00Z")
  const turso = new Database(":memory:")
  turso.exec(`CREATE TABLE trip_entries (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
    start_label TEXT, end_label TEXT, km REAL, duration_min INTEGER, classification TEXT DEFAULT 'unclassified', client_slug TEXT,
    status TEXT DEFAULT 'closed', updated_at TEXT, classifier_confidence REAL, classified_by TEXT${opts.approvalColumn === false ? "" : ", approval_id TEXT"}
  )`)
  const query: QueryFn = async (sql, args) => turso.query(sql).all(...args) as Row[]
  const add = (id: string, startedAt = "2026-08-01T09:00:00-04:00", extra: Record<string, string | number | null> = {}) => {
    const row: Record<string, string | number | null> = { id, started_at: startedAt, ended_at: startedAt, start_lat: 45.4, start_lon: -72.7, end_lat: 45.5, end_lon: -73.6, km: 80, duration_min: 50, ...extra }
    const cols = Object.keys(row)
    turso.query(`INSERT INTO trip_entries (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row))
  }

  const store = createTripStore(new Database(":memory:"))
  const patched: { id: string; body: Record<string, unknown> }[] = []
  const forced = new Map<string, Reply>()
  const service = createTripService({
    store, now: () => clock,
    classifier: { classify: async () => guess("unclassified", 0, "none") },
    ingest: async () => ({ kind: "retry", error: "unused" }),
    patch: async (id, body) => {
      patched.push({ id, body })
      const f = forced.get(id)
      if (f) return f
      turso.query("UPDATE trip_entries SET classification = ?, classified_by = ?, classifier_confidence = ?, updated_at = ? WHERE id = ? AND classification = 'unclassified'")
        .run(String(body.classification), String(body.classifiedBy), Number(body.classifierConfidence), sqlTime(clock), id)
      return { status: 200, json: { ok: true, id, ...(opts.echo === false ? {} : { classifiedBy: body.classifiedBy }) } }
    },
    readRow: async (id) => (await readTrip(query, id)).row,
  })

  const answers = new Map<string, ClassifyResult>()
  const classified: string[] = []
  const logs: string[] = []
  const autofile = createTripAutofile({
    query, service, now: () => clock, log: (m) => logs.push(m),
    hasLog: (id) => store.latestLog(id) !== null,
    classify: async (input: ClassifyInput) => {
      classified.push(input.key)
      return answers.get(input.key) ?? guess("business", 0.9)
    },
  })
  const flip = (id: string, classification: string) =>
    turso.query("UPDATE trip_entries SET classification = ?, classified_by = 'human', updated_at = ? WHERE id = ?").run(classification, sqlTime(clock), id)
  return { autofile, store, turso, add, answers, classified, patched, forced, logs, flip, tick: (ms: number) => { clock += ms } }
}

test("a 0.55 business guess is PATCHed as the machine: classifiedBy jev, its confidence, no client", async () => {
  const r = rig()
  r.add("t1")
  r.answers.set("t1", guess("business", 0.55))
  await r.autofile.sweep()
  expect(r.patched).toEqual([{ id: "t1", body: { classification: "business", classifiedBy: "jev", classifierConfidence: 0.55 } }])
  expect("clientSlug" in r.patched[0]!.body || "client_slug" in r.patched[0]!.body).toBe(false)
  expect(r.store.latestLog("t1")).toMatchObject({ mode: "backfill", classification: "business", confidence: 0.55, classifiedBy: "jev", clientSlug: null })
  // Filed: the next sweep does not see it any more.
  r.tick(15 * 60_000)
  await r.autofile.sweep()
  expect(r.patched.length).toBe(1)
})

test("an unclassified result is not PATCHed and is retried after 1 h", async () => {
  const r = rig()
  r.add("t2")
  r.answers.set("t2", guess("unclassified", 0, "none"))
  await r.autofile.sweep()
  expect(r.patched).toEqual([])
  expect(r.classified).toEqual(["t2"])
  r.tick(30 * 60_000)
  await r.autofile.sweep()
  expect(r.classified).toEqual(["t2"])
  r.tick(RETRY_UNCLASSIFIED_MS)
  r.answers.set("t2", guess("personal", 0.7))
  await r.autofile.sweep()
  expect(r.classified).toEqual(["t2", "t2"])
  expect(r.patched.map((p) => p.body.classification)).toEqual(["personal"])
})

test("409 already_classified and 423 quarter_locked are not retried", async () => {
  const r = rig()
  r.add("t3")
  r.add("t4")
  r.forced.set("t3", { status: 409, json: { error: "already_classified" } })
  r.forced.set("t4", { status: 423, json: { error: "quarter_locked", quarter: "2026-Q3" } })
  await r.autofile.sweep()
  expect(r.patched.map((p) => p.id)).toEqual(["t3", "t4"])
  r.tick(3 * RETRY_UNCLASSIFIED_MS)
  await r.autofile.sweep()
  expect(r.patched.length).toBe(2)
  expect(r.classified).toEqual(["t3", "t4"])
})

test("the human sync records a dashboard flip once: twice gives one history row", async () => {
  const r = rig()
  r.add("t5")
  r.answers.set("t5", guess("business", 0.6))
  await r.autofile.sweep()
  r.tick(60_000)
  r.flip("t5", "personal")
  r.tick(10 * 60_000)
  await r.autofile.sweep()
  const first = r.store.latestLog("t5")!
  expect(first).toMatchObject({ classification: "business", humanClassification: "personal" })
  expect(r.store.history()).toEqual([expect.objectContaining({ tripId: "t5", classification: "personal", startLat: 45.4 })])
  r.tick(10 * 60_000)
  await r.autofile.sweep()
  expect(r.store.latestLog("t5")!.humanAt).toBe(first.humanAt)
  expect(r.store.history().length).toBe(1)
})

test("the human sync ignores trips the companion never classified", async () => {
  const r = rig()
  r.add("t6", "2026-08-01T09:00:00-04:00", { classification: "business", classified_by: "human", updated_at: "2026-10-15 11:00:00" })
  await r.autofile.sweep()
  expect(r.store.latestLog("t6")).toBeNull()
  expect(r.store.history()).toEqual([])
})

test("no approval_id column yet (dashboard schema not applied): no PATCH, one log line, never throws", async () => {
  const r = rig({ approvalColumn: false })
  r.add("t7")
  await r.autofile.sweep()
  r.tick(10 * 60_000)
  await r.autofile.sweep()
  expect(r.patched).toEqual([])
  expect(r.logs.length).toBe(1)
  expect(r.logs[0]).toContain("autofile paused")
})

test("a dashboard reply without classifiedBy (old dashboard) stops the sweep for good", async () => {
  const r = rig({ echo: false })
  r.add("t8", "2026-08-01T09:00:00-04:00")
  r.add("t9", "2026-08-02T09:00:00-04:00")
  await r.autofile.sweep()
  expect(r.patched.map((p) => p.id)).toEqual(["t8"])
  r.tick(RETRY_UNCLASSIFIED_MS)
  r.add("t10", "2026-08-03T09:00:00-04:00")
  await r.autofile.sweep()
  expect(r.patched.length).toBe(1)
  expect(r.logs.filter((l) => l.includes("classifiedBy")).length).toBe(1)
})

test("sweep is single-flight", async () => {
  const r = rig()
  r.add("t11")
  const [a, b] = await Promise.all([r.autofile.sweep(), r.autofile.sweep()])
  expect(a).toBe(b)
  expect(r.classified).toEqual(["t11"])
})

test("readBandCounts counts imports, human and approved rows, and sure machine guesses only", async () => {
  const r = rig()
  r.add("i1", undefined, { classification: "business" }) // import: classified_by NULL
  r.add("h1", undefined, { classification: "personal", classified_by: "human" })
  r.add("j1", undefined, { classification: "business", classified_by: "jev", classifier_confidence: 0.6 }) // dropped
  r.add("j2", undefined, { classification: "business", classified_by: "jev", classifier_confidence: 0.6, approval_id: "q3" })
  r.add("j3", undefined, { classification: "personal", classified_by: "rules", classifier_confidence: 0.9 })
  const bands = await readBandCounts((sql, args) => Promise.resolve(r.turso.query(sql).all(...args) as Row[]))
  expect(bands).toEqual([{ minKm: 40, maxKm: 100_000, business: 2, personal: 2 }])
})
