import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { type SourceItem, allowedActions, fallbackPhrase, heuristicSeverity, validatePhrase } from "./triage"
import { createTriageEngine } from "./triage-engine"
import { createTriageStore } from "./triage-store"
import type { ClassifyInput, ClassifyResult } from "./trip-classify"
import type { TripRow } from "./trip-dashboard"
import { buildTripReport, formatTripReport } from "./trip-report"
import { createTripStore } from "./trip-store"
import { createTripTriage, routeText, tripItem, whenText } from "./trip-triage"

const NOW = Date.parse("2026-10-08T12:00:00-04:00")

const row = (id: string, startedAt: string, extra: Partial<TripRow> = {}): TripRow => ({
  id, startedAt, endedAt: null, startLat: 45.4021, startLon: -72.7271, endLat: 45.5017, endLon: -73.5673,
  startLabel: null, endLabel: null, km: 82.3, durationMin: 60, classification: "unclassified", clientSlug: null, status: "closed", ...extra,
})

const guess = (over: Partial<ClassifyResult> = {}): ClassifyResult => ({
  classification: "business", clientSlug: "humance", clientName: "Humance", confidence: 0.7, decision: "needs_review",
  classifiedBy: "jev", rule: null, labels: { start: "Rue Principale, Granby", end: "Studio Humance, Montréal", startCity: "Granby", endCity: "Montréal" },
  altClient: null, evidenceLine: "Jev 70 % business · 2 past trips (same route): 2 business (Humance), 0 personal", evidence: { km: 82 }, ...over,
})

function rig(opts: { backlog?: TripRow[]; result?: (i: ClassifyInput) => ClassifyResult; classifications?: Map<string, string> } = {}) {
  const store = createTripStore(new Database(":memory:"))
  const classified: string[] = []
  const overrides: { id: string; change: Record<string, unknown> }[] = []
  let overrideStatus = 200
  const classes = opts.classifications ?? new Map<string, string>()
  const triage = createTripTriage({
    store, now: () => NOW,
    classifier: { classify: async (i) => { classified.push(i.key); return opts.result?.(i) ?? guess() } },
    service: { override: async (id, change) => { overrides.push({ id, change }); classes.set(id, String(change.classification)); return { status: overrideStatus, json: { ok: overrideStatus === 200 } } } },
    backfill: async (_since, limit) => (opts.backlog ?? []).slice(0, limit),
    classifications: async (ids) => new Map(ids.map((id) => [id, classes.get(id) ?? "unclassified"])),
    clients: async () => [{ slug: "humance", name: "Humance" }, { slug: "brp", name: "BRP" }],
  })
  return { store, triage, classified, overrides, setOverrideStatus: (s: number) => { overrideStatus = s } }
}

test("backlog trips get a background guess, then show as cards, oldest first", async () => {
  const r = rig({ backlog: [row("trip_a", "2026-08-20T09:10:00-04:00"), row("trip_b", "2026-10-06T09:10:00-04:00")] })
  expect(await r.triage.collect()).toEqual([]) // no guesses yet
  await r.triage.idle()
  expect(r.classified).toEqual(["trip_a", "trip_b"])
  const items = await r.triage.collect()
  expect(items.map((i) => i.refId)).toEqual(["trip_a", "trip_b"])
  const b = items[1]!
  expect(b.facts.problem).toBe("Trip Granby → Montréal, 82 km, Tue 9:10 — business?")
  expect(items[0]!.facts.problem).toBe("Trip Granby → Montréal, 82 km, Thu Aug 20 9:10 — business?")
  expect(b.facts.evidence).toContain("Jev 70 % business")
  expect(b.ref).toMatchObject({ source: "trip", tripId: "trip_b", guess: "business", clientSlug: "humance", clientName: "Humance" })
  expect(r.store.latestLog("trip_b")?.mode).toBe("backfill")
})

test("the card: guess first, other client, personal, snooze; low severity; trip actions only", async () => {
  const r = rig({ backlog: [row("trip_b", "2026-10-06T09:10:00-04:00")] })
  await r.triage.collect()
  await r.triage.idle()
  const src = (await r.triage.collect())[0]!
  const p = fallbackPhrase(src)
  expect(p.options.map((o) => [o.label, o.action])).toEqual([
    ["Business — Humance", { kind: "classify", classification: "business", clientSlug: "humance" }],
    ["Business — other client", { kind: "classify_custom" }],
    ["Personal", { kind: "classify", classification: "personal" }],
    ["Snooze for a day", { kind: "snooze", hours: 24 }],
  ])
  expect(p.recommended).toBe("a")
  expect(p.title).toBe("Trip Granby → Montréal")
  expect(p.context).toContain("2 past trips")
  expect(heuristicSeverity(src)).toBe("low")
  expect(allowedActions(src)).toEqual(["classify", "classify_custom", "snooze"])
})

test("a personal guess leads with Personal and offers the best client second", () => {
  const store = createTripStore(new Database(":memory:"))
  const id = store.log({ tripKey: "t", tripId: "t", mode: "backfill", classification: "personal", clientSlug: null, confidence: 0.6, decision: "needs_review", classifiedBy: "jev", rule: null,
    evidence: { labels: { start: "IGA, Granby", end: "Rue Principale, Granby", startCity: "Granby", endCity: "Granby" }, line: "", altClient: { slug: "brp", name: "BRP" } } }, NOW)
  const src = tripItem({ tripId: "t", startedAt: "2026-10-07T18:00:00-04:00", km: 3.2 }, store.logRow(id)!, NOW)
  expect(src.facts.problem).toBe("Trip IGA → Rue Principale, 3.2 km, Wed 18:00 — business?")
  expect(fallbackPhrase(src).options.map((o) => o.label)).toEqual(["Personal", "Business — BRP", "Business — other client", "Snooze for a day"])
})

test("validatePhrase accepts the trip kinds and nothing else for a trip", () => {
  const src: SourceItem = { source: "trip", refId: "t", version: "v", title: "Trip", project: null, createdAt: 0, updatedAt: 0, facts: {}, url: null,
    ref: { source: "trip", tripId: "t", guess: "business", clientSlug: "x", clientName: "X", altSlug: null, altName: null } }
  const ok = validatePhrase(JSON.stringify({ problem: "p", action: "a", options: [
    { label: "Business — X", action: { kind: "classify", classification: "business", clientSlug: "x" } },
    { label: "Personal", action: { kind: "classify", classification: "personal", clientSlug: "x" } },
  ] }), src)
  expect(ok?.options.map((o) => o.action)).toEqual([{ kind: "classify", classification: "business", clientSlug: "x" }, { kind: "classify", classification: "personal" }])
  expect(validatePhrase(JSON.stringify({ problem: "p", action: "a", options: [{ label: "x", action: { kind: "merge" } }, { label: "y", action: { kind: "snooze" } }] }), src)).toBeNull()
  expect(validatePhrase(JSON.stringify({ problem: "p", action: "a", options: [{ label: "x", action: { kind: "classify", classification: "billable" } }, { label: "y", action: { kind: "snooze" } }] }), src)).toBeNull()
})

test("needs_review uploads become cards; one classified elsewhere is resolved and dropped", async () => {
  const classes = new Map<string, string>()
  const r = rig({ classifications: classes })
  for (const [cid, tid] of [["client-trip-0001", "trip_u1"], ["client-trip-0002", "trip_u2"]] as const) {
    r.store.insertUpload({ clientTripId: cid, startedAt: "2026-10-07T09:10:00-04:00", endedAt: "2026-10-07T10:00:00-04:00", start: { lat: 45.4, lon: -72.7 }, end: { lat: 45.5, lon: -73.6 }, km: 82, durationMin: 50, vehicle: { kind: "carplay", mine: true }, detection: { startedBy: "carplay", endedBy: "carplay", confidence: 1 }, appVersion: "1" }, NOW)
    const logId = r.store.log({ tripKey: cid, tripId: tid, mode: "upload", classification: "business", clientSlug: "humance", confidence: 0.7, decision: "needs_review", classifiedBy: "jev", rule: null, evidence: { line: "x" } }, NOW)
    r.store.setResult(cid, { classification: "business", clientSlug: "humance", confidence: 0.7, review: "needs_review", classifiedBy: "jev", logId }, NOW)
    r.store.confirm(cid, tid, NOW)
  }
  classes.set("trip_u2", "personal")
  const items = await r.triage.collect()
  expect(items.map((i) => i.refId)).toEqual(["trip_u1"])
  expect(r.store.needsReview().map((u) => u.tripId)).toEqual(["trip_u1"])
  expect(r.classified).toEqual([]) // it already had a guess
})

test("an upload that timed out is re-guessed in the background (mode triage)", async () => {
  const r = rig()
  r.store.insertUpload({ clientTripId: "client-trip-0003", startedAt: "2026-10-07T09:10:00-04:00", endedAt: "2026-10-07T10:00:00-04:00", start: { lat: 45.4, lon: -72.7 }, end: { lat: 45.5, lon: -73.6 }, km: 82, durationMin: 50, vehicle: { kind: "carplay", mine: true }, detection: { startedBy: "carplay", endedBy: "carplay", confidence: 1 }, appVersion: "1" }, NOW)
  const logId = r.store.log({ tripKey: "client-trip-0003", tripId: "trip_u3", mode: "upload", classification: "unclassified", clientSlug: null, confidence: 0, decision: "needs_review", classifiedBy: "none", rule: "timeout", evidence: {} }, NOW)
  r.store.setResult("client-trip-0003", { classification: "unclassified", clientSlug: null, confidence: 0, review: "needs_review", classifiedBy: "none", logId }, NOW)
  r.store.confirm("client-trip-0003", "trip_u3", NOW)
  expect(await r.triage.collect()).toEqual([])
  await r.triage.idle()
  expect(r.classified).toEqual(["client-trip-0003"])
  expect(r.store.latestLog("trip_u3")?.mode).toBe("triage")
  expect((await r.triage.collect()).map((i) => i.refId)).toEqual(["trip_u3"])
})

test("choose through the engine: classify PATCHes via override, custom needs a known client slug", async () => {
  const r = rig({ backlog: [row("trip_a", "2026-08-20T09:10:00-04:00"), row("trip_b", "2026-10-06T09:10:00-04:00"), row("trip_c", "2026-10-07T09:10:00-04:00")] })
  await r.triage.collect()
  await r.triage.idle()
  r.triage.invalidate()
  const engine = createTriageEngine({
    collect: () => r.triage.collect(), current: (s) => r.triage.current(s), execute: (s, o, t) => r.triage.execute(s, o, t),
    phrase: async () => null, store: createTriageStore(new Database(":memory:")), broadcast: () => {}, now: () => NOW,
  })
  const listed = await engine.list()
  expect(listed.items.map((i) => i.id)).toEqual(["trip:trip_a", "trip:trip_b", "trip:trip_c"])
  const a = await engine.choose({ id: "trip:trip_a", optionId: "a", idemKey: "k1" })
  expect(a.status).toBe(200)
  expect(a.body.detail).toEqual({ classification: "business", clientSlug: "humance" })
  expect(r.overrides[0]).toEqual({ id: "trip_a", change: { classification: "business", clientSlug: "humance" } })
  r.triage.invalidate()
  const noText = await engine.choose({ id: "trip:trip_b", optionId: "b" })
  expect(noText.status).toBe(422)
  const unknown = await engine.choose({ id: "trip:trip_b", optionId: "b", text: "nobody" })
  expect(unknown.body.error).toBe("unknown_client")
  const custom = await engine.choose({ id: "trip:trip_b", optionId: "b", text: "brp" })
  expect(custom.status).toBe(200)
  expect(r.overrides[1]).toEqual({ id: "trip_b", change: { classification: "business", clientSlug: "brp" } })
  r.triage.invalidate()
  const personal = await engine.choose({ id: "trip:trip_c", optionId: "c" })
  expect(personal.status).toBe(200)
  expect(r.overrides[2]).toEqual({ id: "trip_c", change: { classification: "personal", clientSlug: null } })
})

test("stale: a trip classified elsewhere since the card was built → 409; dashboard 404 → stale", async () => {
  const classes = new Map<string, string>()
  const r = rig({ backlog: [row("trip_a", "2026-08-20T09:10:00-04:00")], classifications: classes })
  await r.triage.collect()
  await r.triage.idle()
  r.triage.invalidate()
  const src = (await r.triage.collect())[0]!
  expect(await r.triage.current(src)).toMatchObject({ refId: "trip_a" })
  classes.set("trip_a", "business")
  expect(await r.triage.current(src)).toBeNull()
  classes.set("trip_a", "unclassified")
  r.setOverrideStatus(404)
  expect(await r.triage.execute(src, { id: "a", label: "x", action: { kind: "classify", classification: "personal" } }, null)).toEqual({ kind: "stale", reason: "trip gone" })
})

test("routeText and whenText", () => {
  expect(routeText({ start: "A, Granby", end: "B, Granby", startCity: "Granby", endCity: "Granby" })).toBe("A → B")
  expect(routeText({ start: "Rue X", end: null })).toBe("Rue X → ?")
  expect(whenText("2026-10-06T09:10:00-04:00", NOW, "America/Toronto")).toBe("Tue 9:10")
  expect(whenText("2026-08-20T09:10:00-04:00", NOW, "America/Toronto")).toBe("Thu Aug 20 9:10")
})

test("trip-report: auto-file rate, overrides of filed trips, guess agreement", () => {
  const store = createTripStore(new Database(":memory:"))
  const log = (tripId: string, classification: string, decision: "filed" | "needs_review", mode: "upload" | "backfill" = "upload", clientSlug: string | null = null, rule: string | null = null) =>
    store.log({ tripKey: tripId, tripId, mode, classification, clientSlug, confidence: 0.9, decision, classifiedBy: rule ? "rules" : "jev", rule, evidence: {} }, NOW)
  log("t1", "business", "filed", "upload", "humance")
  log("t2", "personal", "filed", "upload", null, "home_loop")
  log("t3", "business", "needs_review")
  log("t4", "business", "needs_review", "backfill", "brp")
  store.markHuman("t1", "business", "brp", NOW)  // filed, client corrected
  store.markHuman("t2", "personal", null, NOW)   // filed, kept
  store.markHuman("t4", "business", "brp", NOW)  // guess right
  const rep = buildTripReport(store.logSince(0))
  expect(rep).toMatchObject({ uploads: 3, filed: 2, review: 1, answered: 3, filedAnswered: 2, filedOverridden: 1, guessAnswered: 1, guessClassAgree: 1, guessFullAgree: 1 })
  expect(rep.byRule).toEqual({ jev: 2, home_loop: 1 })
  expect(rep.overrides).toEqual([{ tripKey: "t1", was: "business/humance", now: "business/brp" }])
  const text = formatTripReport(rep, 30, 0.85)
  expect(text).toContain("auto-file rate 67 %")
  expect(text).toContain("filed then corrected by Jeremie: 1 of 2")
})
