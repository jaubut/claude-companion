import { type JevOutcome, type JevQuestion, systemOne } from "../lib/jev"
import { companionLog } from "../lib/log"
import { db } from "../lib/orchestrator-db"
import { type ClientInfo, type HistTrip, LEARNED_HOME_RADIUS_M, createTripClassifier, historyFrom, homesFrom } from "../lib/trip-classify"
import { type BandCount, type TripRow, fetchClients, ingestTrip, patchTrip, readBackfill, readBandCounts, readClassifications, readLocatedTrips, readTrip } from "../lib/trip-dashboard"
import { createGeocoder } from "../lib/trip-geocode"
import { type Place, learnHomes } from "../lib/trip-model"
import { createTripService } from "../lib/trip-service"
import { createTripStore } from "../lib/trip-store"
import { createTripTriage } from "../lib/trip-triage"
import { tursoQuery } from "../lib/turso"
import { vaultUpstream } from "../lib/vault-upstream"

// Travel log, live instance (store host only; the Mac forwards /api/trips* to
// Zettlab). companion.db for the queue / cache / log, Nominatim for places,
// Jev for the decision, Turso read-only for history + backlog, the dashboard
// API for every write. Built on first use so importing it has no side effects.

export const CACHE_TTL_MS = 10 * 60_000
export const RETRY_TICK_MS = 60_000
const HOME_WINDOW_MS = 120 * 86_400_000

function jev(state: unknown, questions: Record<string, JevQuestion>): Promise<JevOutcome> {
  if (process.env.NODE_ENV === "test" || process.env.COMPANION_TRIP_JEV?.trim() === "0") return Promise.resolve({ ok: false, error: "off", latencyMs: 0 })
  return systemOne(state, questions)
}

/** A TTL cache that keeps the last good value when a refresh fails. */
function cached<T>(load: () => Promise<T>, fallback: T, ttl = CACHE_TTL_MS): () => Promise<T> {
  let entry: { at: number; value: T } | null = null
  let loading: Promise<T> | null = null
  return () => {
    if (entry && Date.now() - entry.at < ttl) return Promise.resolve(entry.value)
    loading ??= load().then((value) => { entry = { at: Date.now(), value }; return value })
      .catch(() => entry?.value ?? fallback).finally(() => { loading = null })
    return loading
  }
}



function build() {
  const store = createTripStore(db)
  const geocoder = createGeocoder({ store })
  const located = cached(() => readLocatedTrips(tursoQuery), [] as TripRow[])
  const clients = cached(fetchClients, [] as ClientInfo[])
  const history = async (): Promise<HistTrip[]> => historyFrom(await located(), store.history().map((h) => ({
    id: h.tripId, startedAt: h.startedAt, startLat: h.startLat, startLon: h.startLon, endLat: h.endLat, endLon: h.endLon,
    classification: h.classification === "business" ? "business" : "personal", clientSlug: h.clientSlug,
  })))
  const priors = cached(() => readBandCounts(tursoQuery), [] as BandCount[], 60 * 60_000)
  const homes = async (): Promise<Place[]> => homesFrom(process.env.COMPANION_TRIP_HOME, learnHomes(await located(), Date.now() - HOME_WINDOW_MS, 5, LEARNED_HOME_RADIUS_M))
  const classifier = createTripClassifier({ geocode: geocoder.reverse, history, homes, clients, jev, priors })
  const service = createTripService({
    store, classifier, ingest: ingestTrip, patch: patchTrip, log: companionLog,
    readRow: async (id) => (await readTrip(tursoQuery, id)).row,
  })
  const triage = createTripTriage({
    store, classifier, service, clients: fetchClients, log: companionLog,
    backfill: (since, limit, minKm) => readBackfill(tursoQuery, since, limit, minKm),
    classifications: (ids) => readClassifications(tursoQuery, ids),
  })
  service.onChange(() => triage.invalidate())
  return { store, classifier, service, triage, clients }
}

export type TripsLive = ReturnType<typeof build>
let live: TripsLive | null = null
/** The wired instance (built on first use). */
export function tripsLive(): TripsLive {
  live ??= build()
  return live
}

/** True on the host that owns trips (not the Mac forwarding upstream). */
export const ownsTrips = (): boolean => !vaultUpstream()

/** Boot (cli.ts): retry queued uploads every minute, prune daily. No-op on an upstream-forwarding host. */
export function startTrips(): () => void {
  if (!ownsTrips()) return () => {}
  const { service, store } = tripsLive()
  let lastPrune = 0
  const tick = setInterval(() => {
    void service.retryDue().catch((e) => companionLog(`[trips] retry failed: ${(e as Error)?.message ?? e}`))
    if (Date.now() - lastPrune > 86_400_000) { lastPrune = Date.now(); store.prune(Date.now()) }
  }, RETRY_TICK_MS)
  ;(tick as unknown as { unref?: () => void }).unref?.()
  void service.retryDue().catch(() => {})
  return () => clearInterval(tick)
}
