import { expect, test } from "bun:test"
import type { JevOutcome, JevQuestion } from "./jev"
import { type ClassifyDeps, type ClassifyInput, DEFAULT_HOME, type HistTrip, autofileThreshold, bandPrior, blend, historyFrom, homesFrom, candidateClients, createTripClassifier, logEvidence, matchHistory } from "./trip-classify"
import type { Place } from "./trip-model"
import type { GeoEntry } from "./trip-store"

const HOME: Place = { lat: 45.4021, lon: -72.7271, radiusM: 300 }
const STUDIO = { lat: 45.5300, lon: -73.6000 } // a client's place in Montréal
const GROCERY = { lat: 45.4100, lon: -72.7000 }

const GEO: Record<string, GeoEntry> = {
  "45.402,-72.727": { label: "Rue Principale, Granby", city: "Granby", category: "place=house" },
  "45.530,-73.600": { label: "Studio Humance, Montréal", city: "Montréal", category: "office=company" },
  "45.410,-72.700": { label: "IGA, Granby", city: "Granby", category: "shop=supermarket" },
}

const trip = (start: { lat: number; lon: number }, end: { lat: number; lon: number }, extra: Partial<ClassifyInput> = {}): ClassifyInput => ({
  key: "client-trip-0001", startedAt: "2026-10-06T09:10:00-04:00", endedAt: "2026-10-06T10:05:00-04:00",
  start, end, km: 82, durationMin: 55, vehicle: { kind: "carplay", name: "Mazda", mine: true }, ...extra,
})

const hist = (id: string, start: { lat: number; lon: number }, end: { lat: number; lon: number }, classification: "business" | "personal", clientSlug: string | null = null, startedAt = "2026-09-01T09:00:00-04:00"): HistTrip =>
  ({ id, startedAt, startLat: start.lat, startLon: start.lon, endLat: end.lat, endLon: end.lon, classification, clientSlug })

const choice = (choiceKey: string, probabilities: Record<string, number>) => ({ type: "choice" as const, choice: choiceKey, probabilities, confidence: probabilities[choiceKey] ?? 0 })

interface Harness { deps: ClassifyDeps; calls: { state: unknown; questions: Record<string, JevQuestion> }[] }

function harness(opts: Partial<Omit<ClassifyDeps, "history">> & { answers?: Record<string, ReturnType<typeof choice>> | null; history?: HistTrip[] } = {}): Harness {
  const { answers, history, ...over } = opts
  const calls: Harness["calls"] = []
  const deps: ClassifyDeps = {
    geocode: async (lat, lon) => GEO[`${lat.toFixed(3)},${lon.toFixed(3)}`] ?? null,
    history: async () => history ?? [],
    homes: async () => [HOME],
    clients: async () => [
      { slug: "humance", name: "Humance", address: "1 rue du Studio", city: "Montréal" },
      { slug: "brp", name: "BRP", address: null, city: "Valcourt" },
    ],
    jev: async (state, questions): Promise<JevOutcome> => {
      calls.push({ state, questions })
      if (answers === null) return { ok: false, error: "timeout", latencyMs: 2000 }
      return { ok: true, model: "jev-latest", answers: answers ?? {}, latencyMs: 180 }
    },
    threshold: 0.85,
    ...over,
  }
  return { deps, calls }
}

test("rule: a known vehicle that is not Jeremie's → personal, no Jev call", async () => {
  const h = harness()
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO, { vehicle: { kind: "bluetooth", name: "Rental", mine: false } }))
  expect(r).toMatchObject({ classification: "personal", classifiedBy: "rules", rule: "not_my_vehicle", decision: "filed", confidence: 0.95 })
  expect(h.calls.length).toBe(0)
})

test("rule: not-mine is skipped when the calendar says shoot, and when there is no vehicle route", async () => {
  const shoot = harness({ answers: { kind: choice("business", { business: 0.9, personal: 0.1 }) }, calendar: async () => [{ title: "Tournage Humance", start: 0, end: 1, location: "Montréal" }] })
  const r1 = await createTripClassifier(shoot.deps).classify(trip(HOME, STUDIO, { vehicle: { kind: "bluetooth", mine: false } }))
  expect(r1.rule).not.toBe("not_my_vehicle")
  expect(shoot.calls.length).toBe(1)
  expect(String(shoot.calls[0]!.questions.kind!.instructions)).toContain("Tournage Humance @ Montréal")
  const none = harness({ answers: { kind: choice("personal", { business: 0.3, personal: 0.7 }) } })
  const r2 = await createTripClassifier(none.deps).classify(trip(HOME, STUDIO, { vehicle: { kind: "none", mine: false } }))
  expect(r2.rule).toBeNull()
})

test("rule: home↔home loop under 2 km → personal", async () => {
  const h = harness()
  const r = await createTripClassifier(h.deps).classify(trip(HOME, { lat: 45.4031, lon: -72.7265 }, { km: 1.4 }))
  expect(r).toMatchObject({ classification: "personal", rule: "home_loop", decision: "filed" })
  const longer = await createTripClassifier(harness({ answers: { kind: choice("personal", { business: 0.2, personal: 0.8 }) } }).deps).classify(trip(HOME, HOME, { km: 25 }))
  expect(longer.rule).toBeNull()
})

test("Jev confident business + client → filed with the client; evidence goes into the instructions", async () => {
  const h = harness({ answers: { kind: choice("business", { business: 0.95, personal: 0.05 }), client: choice("humance", { humance: 0.95, brp: 0.03, none: 0.02 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO))
  expect(r).toMatchObject({ classification: "business", clientSlug: "humance", clientName: "Humance", classifiedBy: "jev", decision: "filed" })
  expect(r.confidence).toBeGreaterThanOrEqual(0.85)
  const q = h.calls[0]!.questions
  expect(Object.keys(q.client!.type === "choice" ? q.client!.criteria : {})).toEqual(expect.arrayContaining(["humance", "none"]))
  expect(String(q.kind!.instructions)).toContain("Studio Humance, Montréal")
  expect(String(q.kind!.instructions)).toContain("(home)")
  expect(r.labels).toEqual({ start: "Rue Principale, Granby", end: "Studio Humance, Montréal", startCity: "Granby", endCity: "Montréal" })
  expect(r.evidenceLine).toContain("Jev 95 % business")
})

test("below the threshold → needs_review; the threshold is an env knob", async () => {
  const h = harness({ answers: { kind: choice("business", { business: 0.7, personal: 0.3 }), client: choice("humance", { humance: 0.8, none: 0.2 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO))
  expect(r.classification).toBe("business")
  expect(r.decision).toBe("needs_review")
  const lax = await createTripClassifier({ ...h.deps, threshold: 0.5 }).classify(trip(HOME, STUDIO))
  expect(lax.decision).toBe("filed")
  expect(autofileThreshold({ COMPANION_TRIP_AUTOFILE_CONF: "0.9" })).toBe(0.9)
  expect(autofileThreshold({ COMPANION_TRIP_AUTOFILE_CONF: "nope" })).toBe(0.85)
  expect(autofileThreshold({})).toBe(0.85)
})

test("history at the same route lifts a lukewarm Jev answer over the bar", async () => {
  const past = [1, 2, 3, 4].map((i) => hist(`t${i}`, HOME, STUDIO, "business", "humance"))
  const h = harness({ history: past, answers: { kind: choice("business", { business: 0.7, personal: 0.3 }), client: choice("humance", { humance: 0.8, none: 0.2 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(STUDIO, HOME)) // reversed direction still matches
  expect(r.evidence.history).toMatchObject({ kind: "pair", n: 4, business: 4 })
  expect(r.decision).toBe("filed")
  expect(r.evidenceLine).toContain("4 past trips (same route): 4 business (Humance), 0 personal")
})

test("history disagreeing with Jev pulls it under the bar", async () => {
  const past = [1, 2, 3, 4, 5].map((i) => hist(`p${i}`, HOME, GROCERY, "personal"))
  const h = harness({ history: past, answers: { kind: choice("business", { business: 0.8, personal: 0.2 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, GROCERY, { km: 4 }))
  expect(r.classification).toBe("personal")
  expect(r.decision).toBe("needs_review")
})

test("Jev down: history alone decides; no history either → unclassified", async () => {
  const past = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => hist(`p${i}`, HOME, GROCERY, "personal"))
  const r = await createTripClassifier(harness({ history: past, answers: null }).deps).classify(trip(HOME, GROCERY, { km: 4 }))
  expect(r).toMatchObject({ classification: "personal", classifiedBy: "rules", rule: "history_only", decision: "filed" })
  const none = await createTripClassifier(harness({ answers: null }).deps).classify(trip(HOME, STUDIO))
  expect(none).toMatchObject({ classification: "unclassified", confidence: 0, decision: "needs_review", rule: "no_evidence" })
})

test("asOf hides later history and the trip itself (no peeking in the smoke)", async () => {
  const past = [hist("self", HOME, STUDIO, "business", "humance", "2026-10-06T09:10:00-04:00"), hist("later", HOME, STUDIO, "business", "humance", "2026-10-20T09:00:00-04:00")]
  const h = harness({ history: past, answers: null })
  const r = await createTripClassifier(h.deps).classify({ ...trip(HOME, STUDIO), tripId: "self" }, { asOf: Date.parse("2026-10-06T09:10:00-04:00") })
  expect(r.classification).toBe("unclassified")
})

test("matchHistory: pair first, else the non-home destination; client counts from business matches", () => {
  const past = [hist("a", HOME, STUDIO, "business", "humance"), hist("b", GROCERY, STUDIO, "business", "brp"), hist("c", GROCERY, HOME, "personal")]
  const pair = matchHistory(trip(HOME, STUDIO), past, [HOME])
  expect(pair.kind).toBe("pair")
  expect(pair.trips.map((t) => t.id)).toEqual(["a"])
  const place = matchHistory(trip({ lat: 46.8, lon: -71.2 }, STUDIO), past, [HOME])
  expect(place.kind).toBe("place")
  expect([...place.clients]).toEqual([["humance", 1], ["brp", 1]])
  expect(matchHistory(trip(HOME, HOME), past, [HOME]).kind).toBe("none") // no destination away from home
})

test("candidateClients: history, names in labels, recent business clients, same city — capped", () => {
  const clients = [{ slug: "humance", name: "Humance" }, { slug: "iga", name: "IGA Granby" }, { slug: "mtl", name: "Studio X", city: "Montréal" }, { slug: "far", name: "Far Away" }]
  const match = matchHistory(trip(HOME, STUDIO), [hist("a", HOME, STUDIO, "business", "humance")], [HOME])
  const c = candidateClients(clients, match, [hist("r", HOME, GROCERY, "business", "far", "2026-01-01T00:00:00Z")], ["IGA Granby, Granby"], "Montréal", Date.parse("2026-10-06T00:00:00Z"))
  expect(c.map((x) => x.slug)).toEqual(["humance", "iga", "mtl"]) // "far" is older than 180 days
})

test("blend: log-odds of Jev and smoothed history", () => {
  expect(blend(null, 0, 0)).toBeNull()
  expect(blend(0.7, 0, 0)!).toBeCloseTo(0.7, 5)
  expect(blend(0.7, 4, 4)!).toBeGreaterThan(0.9)
  expect(blend(0.7, 0, 4)!).toBeLessThan(0.5)
  expect(blend(null, 3, 3)!).toBeCloseTo(0.8, 5)
})

test("logEvidence keeps what the triage card needs", async () => {
  const h = harness({ answers: { kind: choice("personal", { business: 0.4, personal: 0.6 }), client: choice("none", { humance: 0.3, none: 0.7 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO))
  const e = logEvidence(r)
  expect(e.line).toBe(r.evidenceLine)
  expect(e.labels).toEqual(r.labels)
  expect((e.altClient as { slug: string }).slug).toBe("humance")
  expect(e.clientNames).toEqual({ humance: "Humance" })
})

test("the client pick reads Jev's probability for the choice, not its confidence score", async () => {
  // Real Jev 2026-10-04: {choice:"brp", probabilities:{brp:0.93}, confidence:0.89} vs a 55/45 split with confidence 0.1.
  const client = { type: "choice" as const, choice: "humance", probabilities: { humance: 0.97, brp: 0.02, none: 0.01 }, confidence: 0.2 }
  const h = harness({ answers: { kind: choice("business", { business: 0.99, personal: 0.01 }), client } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO))
  expect(r.evidence.clientConf).toBeCloseTo(0.97, 2)
})

test("Jev is tempered to 0.1–0.9; the distance base rate can overrule an extreme Jev answer", async () => {
  expect(blend(0.999, 0, 0)!).toBeCloseTo(0.9, 5)
  expect(blend(0.001, 0, 0)!).toBeCloseTo(0.1, 5)
  const priors = async () => [{ minKm: 40, maxKm: 100_000, business: 166, personal: 4 }, { minKm: 0, maxKm: 10, business: 89, personal: 225 }]
  // A long run Jev calls 1 % business: no longer filed personal, it goes to review.
  const long = harness({ priors, answers: { kind: choice("personal", { business: 0.01, personal: 0.99 }) } })
  const r = await createTripClassifier(long.deps).classify(trip(HOME, STUDIO, { km: 81 }))
  expect(r.decision).toBe("needs_review")
  expect(r.evidenceLine).toContain("of trips this long are business")
  // A neutral Jev on a long trip: the base rate files it business.
  const neutral = harness({ priors, answers: { kind: choice("business", { business: 0.5, personal: 0.5 }), client: choice("none", { humance: 0.02, none: 0.98 }) } })
  const n = await createTripClassifier(neutral.deps).classify(trip(HOME, STUDIO, { km: 81 }))
  expect(n).toMatchObject({ classification: "business", clientSlug: null, decision: "filed" })
  // A band with too few trips adds nothing.
  expect(blend(0.5, 0, 0, { k: 5, n: 5 })!).toBeCloseTo(0.5, 5)
  expect(bandPrior([{ minKm: 0, maxKm: 10, business: 1, personal: 2 }], null)).toBeNull()
})

test("homesFrom: a configured home is used with the learned ones; otherwise learned replaces the city-level default", () => {
  const learned = [{ lat: 45.4021, lon: -72.7271, radiusM: 300 }]
  expect(homesFrom("45.5,-73.6", learned)).toEqual([{ lat: 45.5, lon: -73.6, radiusM: 300 }, ...learned])
  expect(homesFrom(undefined, learned)).toEqual(learned)
  expect(homesFrom("", [])).toEqual([{ lat: 45.39, lon: -72.73, radiusM: 1500 }])
  expect(DEFAULT_HOME).toBe("45.39,-72.73,1500")
})

test("historyFrom: billable counts as business, unclassified is dropped, Jeremie's answer wins", () => {
  const row = (id: string, classification: string, clientSlug: string | null = null) => ({ id, startedAt: "2026-09-01T09:00:00Z", endedAt: null, startLat: 1, startLon: 2, endLat: 3, endLon: 4, startLabel: null, endLabel: null, km: 5, durationMin: 6, classification, clientSlug, status: "closed" })
  const h = historyFrom([row("a", "billable", "brp"), row("b", "unclassified"), row("c", "personal")], [{ id: "c", startedAt: "2026-09-01T09:00:00Z", startLat: 1, startLon: 2, endLat: 3, endLon: 4, classification: "business", clientSlug: "humance" }])
  expect(h.map((x) => [x.id, x.classification, x.clientSlug])).toEqual([["a", "business", "brp"], ["c", "business", "humance"]])
})

test("client share counts only the past business trips that carry a client", async () => {
  // 20 business trips here, 2 tagged brp, 18 untagged: Jev's brp pick must not be dragged down to 2/20.
  const past = [...[1, 2].map((i) => hist(`b${i}`, HOME, STUDIO, "business", "brp")), ...Array.from({ length: 18 }, (_, i) => hist(`u${i}`, HOME, STUDIO, "business"))]
  const h = harness({ history: past, answers: { kind: choice("business", { business: 0.9, personal: 0.1 }), client: choice("brp", { brp: 0.9, humance: 0.05, none: 0.05 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO))
  expect(r.clientSlug).toBe("brp")
  expect(Number(r.evidence.clientConf)).toBeGreaterThan(0.9)
})
