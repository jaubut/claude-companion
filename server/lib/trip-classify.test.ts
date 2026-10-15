import { expect, test } from "bun:test"
import type { JevOutcome, JevQuestion } from "./jev"
import { type ClassifyDeps, type ClassifyInput, DEFAULT_HOME, HISTORY_MIN_CONF, type HistTrip, bandPrior, blend, historyFrom, homesFrom, candidateClients, createTripClassifier, logEvidence, matchHistory } from "./trip-classify"
import type { TripRow } from "./trip-dashboard"
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
    ...over,
  }
  return { deps, calls }
}

test("rule: a known vehicle that is not Jeremie's → personal, no Jev call", async () => {
  const h = harness()
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO, { vehicle: { kind: "bluetooth", name: "Rental", mine: false } }))
  expect(r).toMatchObject({ classification: "personal", classifiedBy: "rules", rule: "not_my_vehicle", confidence: 0.95 })
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
  expect(r).toMatchObject({ classification: "personal", rule: "home_loop" })
  const longer = await createTripClassifier(harness({ answers: { kind: choice("personal", { business: 0.2, personal: 0.8 }) } }).deps).classify(trip(HOME, HOME, { km: 25 }))
  expect(longer.rule).toBeNull()
})

test("Jev confident business → business with no client; candidate clients are evidence text only", async () => {
  const h = harness({ answers: { kind: choice("business", { business: 0.95, personal: 0.05 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO))
  expect(r).toMatchObject({ classification: "business", classifiedBy: "jev" })
  expect("clientSlug" in r).toBe(false)
  expect(r.confidence).toBeGreaterThanOrEqual(0.85)
  const q = h.calls[0]!.questions
  expect(Object.keys(q)).toEqual(["kind"])
  expect(String(q.kind!.instructions)).toContain("Studio Humance, Montréal")
  expect(String(q.kind!.instructions)).toContain("(home)")
  expect(String(q.kind!.instructions)).toContain("Known client places near here: Humance")
  expect(r.labels).toEqual({ start: "Rue Principale, Granby", end: "Studio Humance, Montréal", startCity: "Granby", endCity: "Montréal" })
  expect(r.evidenceLine).toContain("Jev 95 % business")
})

test("no confidence gate: a lukewarm guess is still a class, with its confidence (= the class confidence)", async () => {
  const h = harness({ answers: { kind: choice("business", { business: 0.55, personal: 0.45 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO))
  expect(r).toMatchObject({ classification: "business", classifiedBy: "jev", confidence: 0.55 })
  expect("decision" in r).toBe(false)
})

test("history at the same route lifts a lukewarm Jev answer over the bar", async () => {
  const past = [1, 2, 3, 4].map((i) => hist(`t${i}`, HOME, STUDIO, "business", "humance"))
  const h = harness({ history: past, answers: { kind: choice("business", { business: 0.7, personal: 0.3 }), client: choice("humance", { humance: 0.8, none: 0.2 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(STUDIO, HOME)) // reversed direction still matches
  expect(r.evidence.history).toMatchObject({ kind: "pair", n: 4, business: 4 })
  expect(r.confidence).toBeGreaterThan(0.9)
  expect(r.evidenceLine).toContain("4 past trips (same route): 4 business (Humance), 0 personal")
})

test("history disagreeing with Jev pulls it under the bar", async () => {
  const past = [1, 2, 3, 4, 5].map((i) => hist(`p${i}`, HOME, GROCERY, "personal"))
  const h = harness({ history: past, answers: { kind: choice("business", { business: 0.8, personal: 0.2 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, GROCERY, { km: 4 }))
  expect(r.classification).toBe("personal")
  expect(r.confidence).toBeLessThan(0.85)
})

test("Jev down: history alone decides; no history either → unclassified", async () => {
  const past = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => hist(`p${i}`, HOME, GROCERY, "personal"))
  const r = await createTripClassifier(harness({ history: past, answers: null }).deps).classify(trip(HOME, GROCERY, { km: 4 }))
  expect(r).toMatchObject({ classification: "personal", classifiedBy: "rules", rule: "history_only" })
  const none = await createTripClassifier(harness({ answers: null }).deps).classify(trip(HOME, STUDIO))
  expect(none).toMatchObject({ classification: "unclassified", confidence: 0, rule: "no_evidence" })
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

test("logEvidence keeps the line, the labels and the candidates; never a client", async () => {
  const h = harness({ answers: { kind: choice("personal", { business: 0.4, personal: 0.6 }) } })
  const r = await createTripClassifier(h.deps).classify(trip(HOME, STUDIO))
  const e = logEvidence(r)
  expect(e.line).toBe(r.evidenceLine)
  expect(e.labels).toEqual(r.labels)
  expect(e.candidates).toEqual(["humance"])
  expect("clientNames" in e || "altClient" in e).toBe(false)
})

test("Jev is tempered to 0.1–0.9; the distance base rate can overrule an extreme Jev answer", async () => {
  expect(blend(0.999, 0, 0)!).toBeCloseTo(0.9, 5)
  expect(blend(0.001, 0, 0)!).toBeCloseTo(0.1, 5)
  const priors = async () => [{ minKm: 40, maxKm: 100_000, business: 166, personal: 4 }, { minKm: 0, maxKm: 10, business: 89, personal: 225 }]
  // A long run Jev calls 1 % business: the base rate turns it business, unsure.
  const long = harness({ priors, answers: { kind: choice("personal", { business: 0.01, personal: 0.99 }) } })
  const r = await createTripClassifier(long.deps).classify(trip(HOME, STUDIO, { km: 81 }))
  expect(r.classification).toBe("business")
  expect(r.confidence).toBeLessThan(0.85)
  expect(r.evidenceLine).toContain("of trips this long are business")
  // A neutral Jev on a long trip: the base rate files it business.
  const neutral = harness({ priors, answers: { kind: choice("business", { business: 0.5, personal: 0.5 }) } })
  const n = await createTripClassifier(neutral.deps).classify(trip(HOME, STUDIO, { km: 81 }))
  expect(n.classification).toBe("business")
  expect(n.confidence).toBeGreaterThan(0.9)
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

const row = (id: string, classification: string, clientSlug: string | null = null, extra: Partial<TripRow> = {}): TripRow => ({
  id, startedAt: "2026-09-01T09:00:00Z", endedAt: null, startLat: 1, startLon: 2, endLat: 3, endLon: 4, startLabel: null, endLabel: null, km: 5, durationMin: 6,
  classification, clientSlug, status: "closed", updatedAt: null, classifiedBy: null, classifierConfidence: null, approvalId: null, ...extra,
})

test("historyFrom: billable counts as business, unclassified is dropped, Jeremie's answer wins", () => {
  const h = historyFrom([row("a", "billable", "brp"), row("b", "unclassified"), row("c", "personal")], [{ id: "c", startedAt: "2026-09-01T09:00:00Z", startLat: 1, startLon: 2, endLat: 3, endLon: 4, classification: "business", clientSlug: "humance" }])
  expect(h.map((x) => [x.id, x.classification, x.clientSlug])).toEqual([["a", "business", "brp"], ["c", "business", "humance"]])
})

test("historyFrom quality gate: an unapproved jev 0.6 guess is dropped; human, imports, approved and sure guesses are kept", () => {
  expect(HISTORY_MIN_CONF).toBe(0.85)
  const h = historyFrom([
    row("guess", "business", null, { classifiedBy: "jev", classifierConfidence: 0.6 }),
    row("human", "personal", null, { classifiedBy: "human", classifierConfidence: 0.6 }),
    row("import", "business"),
    row("approved", "business", null, { classifiedBy: "jev", classifierConfidence: 0.6, approvalId: "2026-Q3" }),
    row("sure", "personal", null, { classifiedBy: "rules", classifierConfidence: 0.9 }),
  ], [])
  expect(h.map((x) => x.id)).toEqual(["human", "import", "approved", "sure"])
})
