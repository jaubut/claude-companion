import type { JevOutcome, JevQuestion } from "./jev"
import type { TripRow } from "./trip-dashboard"
import { type Place, atPlace, fmtKm, haversineM, localHour, parseHomes, shortWhen } from "./trip-model"
import type { GeoEntry } from "./trip-store"

// Trip classifier (trips CONTRACT §4). Contract rules run first: a known vehicle
// that is not Jeremie's → personal (unless the calendar says shoot), a
// home↔home loop under 2 km → personal. Otherwise one Jev call: `choice`
// business/personal, plus `choice` over candidate clients. The evidence goes in
// the instructions: reverse-geocoded places and OSM categories, home, past
// classified trips within 300 m, client names/addresses, calendar events
// ±2 h. History and Jev are blended in log-odds:
//   logit P(business) = logit(Jev p) + logit((nBiz+1)/(n+2))     n = matching past trips
//   same for the client, over the business matches; confidence = class × client
// The trip is filed at ≥ threshold (COMPANION_TRIP_AUTOFILE_CONF, 0.85); otherwise needs_review.

export const MATCH_RADIUS_M = 300
export const HOME_LOOP_KM = 2
export const CALENDAR_PAD_MS = 2 * 60 * 60_000
export const MAX_CANDIDATES = 8
export const RULE_CONF = { notMine: 0.95, homeLoop: 0.9 } as const
export const DEFAULT_THRESHOLD = 0.85
/** Jev's probabilities are tempered to this range: on 2026-10-04 real trips it said 1 % business for work runs to Montréal. */
export const JEV_P_MIN = 0.1
export const JEV_P_MAX = 0.9
export const PRIOR_MIN_N = 10

export interface ClassifyInput {
  key: string
  /** Dashboard id when known: excluded from its own history. */
  tripId?: string | null
  startedAt: string
  endedAt: string | null
  start: { lat: number; lon: number; label?: string | null }
  end: { lat: number; lon: number; label?: string | null }
  km: number | null
  durationMin: number | null
  vehicle?: { kind: string; name?: string; mine: boolean } | null
}

export interface HistTrip {
  id: string
  startedAt: string
  startLat: number; startLon: number; endLat: number; endLon: number
  classification: "business" | "personal"
  clientSlug: string | null
}

export interface ClientInfo { slug: string; name: string; address?: string | null; city?: string | null }
/** Business / personal counts of Jeremie's classified trips in one distance band. */
export interface BandPrior { minKm: number; maxKm: number; business: number; personal: number }
export interface CalEvent { title: string; start: number; end: number; location?: string | null }

export interface ClassifyDeps {
  geocode: (lat: number, lon: number) => Promise<GeoEntry | null>
  history: () => Promise<HistTrip[]>
  homes: () => Promise<Place[]>
  clients: () => Promise<ClientInfo[]>
  /** Events overlapping [from, to] ms; absent = no calendar source. */
  calendar?: (from: number, to: number) => Promise<CalEvent[]>
  jev: (state: unknown, questions: Record<string, JevQuestion>) => Promise<JevOutcome>
  /** Distance-band base rates; absent = no prior. */
  priors?: () => Promise<BandPrior[]>
  threshold?: number
}

export interface ClassifyOpts {
  /** Only history that started before this (smoke: no peeking at later answers). */
  asOf?: number
}

export interface Ends { start: string | null; end: string | null; startCity: string | null; endCity: string | null }

export interface ClassifyResult {
  classification: "business" | "personal" | "unclassified"
  clientSlug: string | null
  clientName: string | null
  confidence: number
  decision: "filed" | "needs_review"
  classifiedBy: "rules" | "jev" | "none"
  rule: string | null
  labels: Ends
  /** Best other client for a "Business — X" option when the guess is personal. */
  altClient: ClientInfo | null
  evidenceLine: string
  evidence: Record<string, unknown>
}

export function autofileThreshold(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.COMPANION_TRIP_AUTOFILE_CONF)
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_THRESHOLD
}

// ── pure pieces ──────────────────────────────────────────────────────────────

const clamp = (p: number): number => Math.min(0.98, Math.max(0.02, p))
const logit = (p: number): number => Math.log(clamp(p) / (1 - clamp(p)))
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))
const round = (n: number): number => Math.round(n * 1000) / 1000

const temper = (p: number): number => Math.min(JEV_P_MAX, Math.max(JEV_P_MIN, p))

/**
 * P(yes) from Jev's p (null = no answer, tempered), k of n agreeing past trips at this place, and an
 * optional base rate (k of n over all trips of this distance). null when Jev and the place history are both silent.
 */
export function blend(p: number | null, k: number, n: number, prior: { k: number; n: number } | null = null, tempered = true): number | null {
  if (p === null && n === 0) return null
  const base = prior && prior.n >= PRIOR_MIN_N ? logit((prior.k + 1) / (prior.n + 2)) : 0
  return sigmoid((p === null ? 0 : logit(tempered ? temper(p) : p)) + (n > 0 ? logit((k + 1) / (n + 2)) : 0) + base)
}

/** The base rate for this distance: business k of n. */
export function bandPrior(priors: BandPrior[], km: number | null): { k: number; n: number } | null {
  if (km === null) return null
  const b = priors.find((x) => km >= x.minKm && km < x.maxKm)
  return b ? { k: b.business, n: b.business + b.personal } : null
}

const near = (aLat: number, aLon: number, bLat: number, bLon: number): boolean => haversineM(aLat, aLon, bLat, bLon) <= MATCH_RADIUS_M

export interface HistoryMatch { kind: "pair" | "place" | "none"; trips: HistTrip[]; nBiz: number; nPers: number; clients: Map<string, number> }

/** Past trips with both ends within 300 m (either direction); else trips touching the non-home destination. */
export function matchHistory(input: ClassifyInput, history: HistTrip[], homes: Place[]): HistoryMatch {
  const { start: s, end: e } = input
  const pair = history.filter((h) =>
    (near(h.startLat, h.startLon, s.lat, s.lon) && near(h.endLat, h.endLon, e.lat, e.lon)) ||
    (near(h.startLat, h.startLon, e.lat, e.lon) && near(h.endLat, h.endLon, s.lat, s.lon)))
  let kind: HistoryMatch["kind"] = pair.length ? "pair" : "none"
  let trips = pair
  if (!pair.length) {
    const dest = !atPlace(e.lat, e.lon, homes) ? e : !atPlace(s.lat, s.lon, homes) ? s : null
    if (dest) {
      trips = history.filter((h) => near(h.startLat, h.startLon, dest.lat, dest.lon) || near(h.endLat, h.endLon, dest.lat, dest.lon))
      if (trips.length) kind = "place"
    }
  }
  const clients = new Map<string, number>()
  for (const t of trips) if (t.classification === "business" && t.clientSlug) clients.set(t.clientSlug, (clients.get(t.clientSlug) ?? 0) + 1)
  return { kind, trips, nBiz: trips.filter((t) => t.classification === "business").length, nPers: trips.filter((t) => t.classification === "personal").length, clients }
}

const norm = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/** Clients worth asking Jev about: seen at this place, named in a label, recent business clients, same city. */
export function candidateClients(clients: ClientInfo[], match: HistoryMatch, history: HistTrip[], labels: string[], destCity: string | null, asOf: number): ClientInfo[] {
  const bySlug = new Map(clients.map((c) => [c.slug, c]))
  const out: string[] = []
  const add = (slug: string) => { if (!out.includes(slug)) out.push(slug) }
  for (const [slug] of [...match.clients].sort((a, b) => b[1] - a[1])) add(slug)
  const text = norm(labels.join(" "))
  for (const c of clients) {
    const n = norm(c.name)
    if (n.length >= 4 && text.includes(n)) add(c.slug)
  }
  const recent = new Map<string, number>()
  const cutoff = asOf - 180 * 86_400_000
  for (const h of history) {
    if (h.classification !== "business" || !h.clientSlug || Date.parse(h.startedAt) < cutoff) continue
    recent.set(h.clientSlug, (recent.get(h.clientSlug) ?? 0) + 1)
  }
  for (const [slug] of [...recent].sort((a, b) => b[1] - a[1]).slice(0, 5)) add(slug)
  if (destCity) {
    const city = norm(destCity)
    for (const c of clients) if (city && c.city && norm(c.city).includes(city)) add(c.slug)
  }
  return out.slice(0, MAX_CANDIDATES).map((slug) => bySlug.get(slug) ?? { slug, name: slug })
}

const pct = (p: number): string => `${Math.round(p * 100)} %`

function historyText(m: HistoryMatch, names: Map<string, string>): string | null {
  if (m.kind === "none") return null
  const top = [...m.clients].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s]) => names.get(s) ?? s)
  const where = m.kind === "pair" ? "same route" : "this place"
  return `${m.trips.length} past trip${m.trips.length === 1 ? "" : "s"} (${where}): ${m.nBiz} business${top.length ? ` (${top.join(", ")})` : ""}, ${m.nPers} personal`
}

// ── classifier ───────────────────────────────────────────────────────────────

export function createTripClassifier(deps: ClassifyDeps) {
  const threshold = deps.threshold ?? autofileThreshold()

  async function classify(input: ClassifyInput, opts: ClassifyOpts = {}): Promise<ClassifyResult> {
    const asOf = opts.asOf ?? Date.now()
    const [g0, g1, homes, allHistory, clients, priors] = await Promise.all([
      deps.geocode(input.start.lat, input.start.lon).catch(() => null),
      deps.geocode(input.end.lat, input.end.lon).catch(() => null),
      deps.homes().catch(() => [] as Place[]),
      deps.history().catch(() => [] as HistTrip[]),
      deps.clients().catch(() => [] as ClientInfo[]),
      deps.priors ? deps.priors().catch(() => [] as BandPrior[]) : Promise.resolve([] as BandPrior[]),
    ])
    const history = allHistory.filter((h) => h.id !== input.tripId && h.id !== input.key && (!opts.asOf || Date.parse(h.startedAt) < opts.asOf))
    const labels: Ends = {
      start: input.start.label?.trim() || g0?.label || null, end: input.end.label?.trim() || g1?.label || null,
      startCity: g0?.city ?? null, endCity: g1?.city ?? null,
    }
    const startHome = atPlace(input.start.lat, input.start.lon, homes)
    const endHome = atPlace(input.end.lat, input.end.lon, homes)
    const t0 = Date.parse(input.startedAt)
    const t1 = input.endedAt ? Date.parse(input.endedAt) : t0
    const events = deps.calendar ? await deps.calendar(t0 - CALENDAR_PAD_MS, t1 + CALENDAR_PAD_MS).catch(() => [] as CalEvent[]) : []
    const shoot = events.some((ev) => /\b(shoot|tournage|filming|captation)\b/i.test(`${ev.title} ${ev.location ?? ""}`))
    const match = matchHistory(input, history, homes)
    const names = new Map(clients.map((c) => [c.slug, c.name]))
    const base: Record<string, unknown> = {
      start: { label: labels.start, category: g0?.category ?? null, home: startHome },
      end: { label: labels.end, category: g1?.category ?? null, home: endHome },
      km: input.km, durationMin: input.durationMin, when: shortWhen(input.startedAt), vehicle: input.vehicle ?? null,
      history: { kind: match.kind, n: match.trips.length, business: match.nBiz, personal: match.nPers, clients: Object.fromEntries(match.clients) },
      calendar: events.map((ev) => ({ title: ev.title, location: ev.location ?? null })),
    }
    const finish = (r: Omit<ClassifyResult, "decision" | "labels" | "evidence" | "evidenceLine" | "altClient"> & { altClient?: ClientInfo | null }, extra: Record<string, unknown>, line: string[]): ClassifyResult => ({
      ...r, altClient: r.altClient ?? null, confidence: round(r.confidence), labels,
      decision: r.classification !== "unclassified" && r.confidence >= threshold ? "filed" : "needs_review",
      evidence: { ...base, ...extra, labels, threshold }, evidenceLine: line.filter(Boolean).join(" · "),
    })

    // Rules (contract §4).
    if (input.vehicle && input.vehicle.kind !== "none" && !input.vehicle.mine && !shoot) {
      return finish({ classification: "personal", clientSlug: null, clientName: null, confidence: RULE_CONF.notMine, classifiedBy: "rules", rule: "not_my_vehicle" }, {}, [`not your vehicle${input.vehicle.name ? ` (${input.vehicle.name})` : ""}`])
    }
    if (startHome && endHome && input.km !== null && input.km < HOME_LOOP_KM) {
      return finish({ classification: "personal", clientSlug: null, clientName: null, confidence: RULE_CONF.homeLoop, classifiedBy: "rules", rule: "home_loop" }, {}, [`home loop, ${fmtKm(input.km)}`])
    }

    const destCity = !endHome ? labels.endCity : !startHome ? labels.startCity : null
    const candidates = candidateClients(clients, match, history, [labels.start ?? "", labels.end ?? ""], destCity, asOf)
    const hist = historyText(match, names)
    const hour = localHour(input.startedAt)
    const evidence = [
      `Trip: ${labels.start ?? "unknown place"}${startHome ? " (home)" : ""} → ${labels.end ?? "unknown place"}${endHome ? " (home)" : ""}, ${fmtKm(input.km)}, ${input.durationMin ?? "?"} min, ${shortWhen(input.startedAt)}.`,
      g0?.category || g1?.category ? `Place types: start ${g0?.category ?? "?"}, end ${g1?.category ?? "?"}.` : "",
      hist ? `History: ${hist}.` : "No classified past trips near these places.",
      events.length ? `Calendar around the trip: ${events.slice(0, 4).map((ev) => `${ev.title}${ev.location ? ` @ ${ev.location}` : ""}`).join("; ")}.` : "",
      input.vehicle ? `Vehicle: ${input.vehicle.kind}${input.vehicle.name ? ` ${input.vehicle.name}` : ""}${input.vehicle.mine ? " (his)" : ""}.` : "",
      hour !== null && (hour < 6 || hour >= 21) ? "Late-night or early-morning trip." : "",
    ].filter(Boolean).join("\n")
    const questions: Record<string, JevQuestion> = {
      kind: {
        type: "choice",
        instructions: `Jeremie runs Tech Lab Studio, a one-person video production studio in Granby, Québec; he drives to shoots, client meetings and gear errands in Granby, the Eastern Townships and Montréal. Was this car trip for his business (deductible mileage) or personal?\n${evidence}`,
        criteria: {
          business: "work travel: a shoot, a client's place, a meeting, a gear or supplier errand, or coming back from one",
          personal: "groceries, family, friends, sport, leisure, personal errands, or going home from a personal outing",
        },
      },
    }
    if (candidates.length) {
      const criteria: Record<string, string> = {}
      for (const c of candidates) criteria[c.slug] = [c.name, c.address, c.city].filter(Boolean).join(", ")
      criteria.none = "none of these clients / not client work"
      questions.client = { type: "choice", instructions: `If this trip was business, which client was it for?\n${evidence}`, criteria }
    }
    const out = await deps.jev({ trip: base, evidence }, questions).catch((): JevOutcome => ({ ok: false, error: "throw", latencyMs: 0 }))
    const kindA = out.ok ? out.answers.kind : undefined
    const pJev = kindA?.type === "choice" ? (kindA.probabilities.business ?? (kindA.choice === "business" ? kindA.confidence : 1 - kindA.confidence)) : null
    const prior = bandPrior(priors, input.km)
    const pBiz = blend(pJev, match.nBiz, match.nBiz + match.nPers, prior)
    const jevInfo = { ok: out.ok, ...(out.ok ? {} : { error: out.error }), latencyMs: out.latencyMs, pBusiness: pJev === null ? null : round(pJev) }
    if (pBiz === null) {
      return finish({ classification: "unclassified", clientSlug: null, clientName: null, confidence: 0, classifiedBy: "none", rule: "no_evidence", altClient: candidates[0] ?? null }, { jev: jevInfo, candidates: candidates.map((c) => c.slug) }, ["no Jev answer and no history"])
    }
    const business = pBiz >= 0.5
    const classConf = business ? pBiz : 1 - pBiz
    // Client: Jev's pick blended with how often that client shows up in the business matches.
    const clientA = out.ok ? out.answers.client : undefined
    let clientSlug: string | null = null
    let clientConf = 1
    if (clientA?.type === "choice") {
      // `probabilities[choice]`, not `confidence`: Jev's confidence is a separate certainty score.
      clientSlug = clientA.choice === "none" ? null : clientA.choice
      const pc = clientA.probabilities[clientA.choice] ?? clientA.confidence
      // A client's share counts only the business matches that carry a client (most past rows have none).
      const labelled = [...match.clients.values()].reduce((a, b) => a + b, 0)
      clientConf = (clientSlug ? blend(pc, match.clients.get(clientSlug) ?? 0, labelled, null, false) : blend(pc, match.nBiz - labelled, match.nBiz, null, false)) ?? pc
    } else if (match.clients.size) {
      const [slug, k] = [...match.clients].sort((a, b) => b[1] - a[1])[0]!
      clientSlug = slug
      clientConf = (k + 1) / ([...match.clients.values()].reduce((a, b) => a + b, 0) + 2)
    }
    const client = clientSlug ? candidates.find((c) => c.slug === clientSlug) ?? { slug: clientSlug, name: names.get(clientSlug) ?? clientSlug } : null
    const confidence = business ? classConf * clientConf : classConf
    const line = [
      pJev !== null ? `Jev ${pct(pJev)} business` : "Jev unavailable",
      hist ?? "",
      prior && prior.n >= PRIOR_MIN_N ? `${pct((prior.k + 1) / (prior.n + 2))} of trips this long are business` : "",
      endHome ? "ends at home" : startHome ? "leaves home" : "",
    ]
    return finish({
      classification: business ? "business" : "personal",
      clientSlug: business ? client?.slug ?? null : null, clientName: business ? client?.name ?? null : null,
      confidence, classifiedBy: pJev !== null ? "jev" : "rules", rule: pJev !== null ? null : "history_only",
      altClient: business ? null : client ?? candidates[0] ?? null,
    }, { jev: jevInfo, prior, pBusiness: round(pBiz), classConf: round(classConf), clientConf: round(clientConf), candidates: candidates.map((c) => c.slug) }, line)
  }

  return { classify, threshold }
}

export type TripClassifier = ReturnType<typeof createTripClassifier>

/** What the classify log keeps for a decision (the triage card is rebuilt from it). */
export function logEvidence(r: ClassifyResult): Record<string, unknown> {
  const clientNames: Record<string, string> = {}
  if (r.clientSlug && r.clientName) clientNames[r.clientSlug] = r.clientName
  if (r.altClient) clientNames[r.altClient.slug] = r.altClient.name
  return { ...r.evidence, labels: r.labels, line: r.evidenceLine, altClient: r.altClient, clientNames }
}

// ── evidence sources (pure; wiring/trips.ts feeds them) ──────────────────────

export const DEFAULT_HOME = "45.39,-72.73,1500" // Granby, city-level on purpose (public repo); the exact spot is learned
export const LEARNED_HOME_RADIUS_M = 300

/**
 * Homes: COMPANION_TRIP_HOME (exact, set per host) plus the learned ones; without a
 * configured home, the learned ones replace the city-level default — on 2026-10-04 real
 * trips its 1.5 km radius counted half of Granby as "home".
 */
export function homesFrom(configured: string | undefined, learned: Place[]): Place[] {
  const set = configured?.trim() ? parseHomes(configured, LEARNED_HOME_RADIUS_M) : []
  if (set.length) return [...set, ...learned]
  return learned.length ? learned : parseHomes(DEFAULT_HOME, 1500)
}

export function historyFrom(rows: TripRow[], overrides: HistTrip[]): HistTrip[] {
  const byId = new Map<string, HistTrip>()
  for (const r of rows) {
    const cls = r.classification === "billable" ? "business" : r.classification
    if (cls !== "business" && cls !== "personal") continue
    byId.set(r.id, { id: r.id, startedAt: r.startedAt, startLat: r.startLat, startLon: r.startLon, endLat: r.endLat, endLon: r.endLon, classification: cls, clientSlug: r.clientSlug })
  }
  for (const o of overrides) byId.set(o.id, o) // Jeremie's answer wins over a stale row
  return [...byId.values()]
}

