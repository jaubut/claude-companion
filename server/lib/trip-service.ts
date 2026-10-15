import { type ClassifyInput, type ClassifyResult, type TripClassifier, logEvidence } from "./trip-classify"
import type { IngestOutcome, TripRow } from "./trip-dashboard"
import type { TripUpload } from "./trip-model"
import type { HistoryRow, Review, TripStore, UploadRow } from "./trip-store"

// Travel log upload flow (trips CONTRACT §1). The rule: once the server has a
// trip, it owns it. An upload is stored in companion.db first, classified
// (bounded by a budget), then pushed to the dashboard's /api/trips/ingest.
// Dashboard down → 202 `queued` and a background retry (exponential backoff,
// 1 min → 30 min); the phone drops it from its outbox either way.
// Replies: 200 ingested · 202 queued · 409 duplicate (the stored result) ·
// 502 dashboard_rejected (a 4xx the dashboard will keep refusing; the phone's
// retry re-pushes it) · 503 store_unavailable (could not persist it here).
// No confidence gate: every classified trip goes in filed, never with a client.
// An `unclassified` one (Jev failed, no history, or past the budget) is handed
// to the autofile sweep (lib/trip-autofile.ts), which files it later through
// `autofile` (machine PATCH). Human answers (phone PATCH, dashboard flips seen
// by the sweep) go through `override` / `recordHuman`: classify log + history.

export const CLASSIFY_BUDGET_MS = 8_000
export const RETRY_BASE_MS = 60_000
export const RETRY_MAX_MS = 30 * 60_000

export interface TripServiceDeps {
  store: TripStore
  classifier: Pick<TripClassifier, "classify">
  ingest: (payload: Record<string, unknown>) => Promise<IngestOutcome>
  /** Dashboard PATCH. Throws DashboardUnreachable / DashboardKeyMissing. */
  patch: (id: string, body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> | null }>
  /** Read-only Turso row for coords (history). null when absent or unreadable. */
  readRow: (id: string) => Promise<TripRow | null>
  /** An upload went in `unclassified` (dashboard id): the autofile sweep takes it from here. */
  onUnclassified?: (tripId: string) => void
  now?: () => number
  log?: (msg: string) => void
  budgetMs?: number
}

export interface Reply { status: number; body: Record<string, unknown> }

/** `final` = the dashboard will keep refusing it (409 already_classified, 423 quarter_locked). */
export type AutofileOutcome =
  | { kind: "filed"; classifiedBy: string | null }
  | { kind: "unclassified" }
  | { kind: "final"; error: string }
  | { kind: "retry"; error: string }

export const backoffMs = (attempts: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts))

export function uploadInput(u: TripUpload): ClassifyInput {
  return { key: u.clientTripId, startedAt: u.startedAt, endedAt: u.endedAt, start: u.start, end: u.end, km: u.km, durationMin: u.durationMin, vehicle: u.vehicle }
}

export function rowInput(r: TripRow): ClassifyInput {
  return {
    key: r.id, tripId: r.id, startedAt: r.startedAt, endedAt: r.endedAt,
    start: { lat: r.startLat, lon: r.startLon, label: r.startLabel }, end: { lat: r.endLat, lon: r.endLon, label: r.endLabel },
    km: r.km, durationMin: r.durationMin, vehicle: null,
  }
}

/** The dashboard ingest body (CONTRACT §2): the class whatever the confidence, never a client. */
export function ingestPayload(row: UploadRow): Record<string, unknown> {
  return {
    ...row.upload, source: "companion",
    classification: row.classification === "business" || row.classification === "personal" ? row.classification : "unclassified",
    classifierConfidence: row.confidence,
    classifiedBy: row.classifiedBy === "jev" ? "jev" : "rules",
  }
}

const reviewOf = (classification: string): Review => (classification === "business" || classification === "personal" ? "filed" : "needs_review")

function resultBody(row: UploadRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tripId: row.tripId, classification: row.classification, confidence: row.confidence, status: reviewOf(row.classification), ...extra }
}

export function createTripService(deps: TripServiceDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const budget = deps.budgetMs ?? (Number(process.env.COMPANION_TRIP_CLASSIFY_BUDGET_MS) || CLASSIFY_BUDGET_MS)
  const inflight = new Map<string, Promise<Reply>>()

  /** Classify within the budget; past it the trip goes in unclassified (the autofile sweep re-guesses it). */
  async function classifyStored(u: TripUpload): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), budget) })
    const res: ClassifyResult | null = await Promise.race([deps.classifier.classify(uploadInput(u)).catch(() => null), late]).finally(() => clearTimeout(timer))
    const t = now()
    const review = reviewOf(res?.classification ?? "unclassified")
    const logId = deps.store.log({
      tripKey: u.clientTripId, tripId: null, mode: "upload",
      classification: res?.classification ?? "unclassified", clientSlug: null, confidence: res?.confidence ?? 0,
      decision: review, classifiedBy: res?.classifiedBy ?? "none", rule: res ? res.rule : "timeout",
      evidence: res ? logEvidence(res) : { budgetMs: budget },
    }, t)
    if (res && (!u.start.label || !u.end.label)) {
      const labelled: TripUpload = { ...u, start: { ...u.start, label: u.start.label ?? res.labels.start ?? undefined }, end: { ...u.end, label: u.end.label ?? res.labels.end ?? undefined } }
      deps.store.updatePayload(labelled, t)
    }
    deps.store.setResult(u.clientTripId, {
      classification: res?.classification ?? "unclassified", clientSlug: null, confidence: res?.confidence ?? 0,
      review, classifiedBy: res?.classifiedBy ?? "none", logId,
    }, t)
    log(`[trips] ${u.clientTripId.slice(0, 8)} → ${res?.classification ?? "unclassified"} ${Math.round((res?.confidence ?? 0) * 100)}% ${review}${res?.rule ? ` (${res.rule})` : ""}`)
  }

  /** One push to the dashboard; the stored row moves to confirmed / pending (retry) / rejected. */
  async function push(row: UploadRow): Promise<Reply> {
    const out = await deps.ingest(ingestPayload(row)).catch((e): IngestOutcome => ({ kind: "retry", error: (e as Error)?.name ?? "error" }))
    const t = now()
    if (out.kind === "ok") {
      deps.store.confirm(row.clientTripId, out.tripId, t)
      if (row.logId !== null) deps.store.attachTripId(row.logId, out.tripId)
      if (reviewOf(row.classification) === "needs_review") deps.onUnclassified?.(out.tripId)
      const done = deps.store.upload(row.clientTripId)!
      return out.duplicate ? { status: 409, body: { ok: false, error: "duplicate", ...resultBody(done) } } : { status: 200, body: { ok: true, ...resultBody(done) } }
    }
    if (out.kind === "rejected") {
      deps.store.fail(row.clientTripId, out.error, null, t)
      log(`[trips] ${row.clientTripId.slice(0, 8)} rejected by the dashboard (${out.error})`)
      return { status: 502, body: { ok: false, error: "dashboard_rejected" } }
    }
    deps.store.fail(row.clientTripId, out.error, t + backoffMs(row.attempts), t)
    return { status: 202, body: { ok: true, ...resultBody(row, { tripId: null, status: "queued", review: reviewOf(row.classification) }) } }
  }

  async function runUpload(u: TripUpload): Promise<Reply> {
    let row = deps.store.upload(u.clientTripId)
    if (row?.state === "confirmed") {
      return { status: 409, body: { ok: false, error: "duplicate", ...resultBody(row) } }
    }
    if (!row) {
      try {
        deps.store.insertUpload(u, now())
      } catch (e) {
        log(`[trips] could not store an upload: ${(e as Error)?.message ?? e}`)
        return { status: 503, body: { ok: false, error: "store_unavailable" } }
      }
      await classifyStored(u)
      row = deps.store.upload(u.clientTripId)
      if (!row) return { status: 503, body: { ok: false, error: "store_unavailable" } }
    }
    return push(row)
  }

  /** POST /api/trips on the store host. One run per clientTripId at a time. */
  function upload(u: TripUpload): Promise<Reply> {
    const running = inflight.get(u.clientTripId)
    if (running) return running
    const p = runUpload(u).finally(() => inflight.delete(u.clientTripId))
    inflight.set(u.clientTripId, p)
    return p
  }

  let retrying: Promise<number> | null = null
  /** Push every due queued trip once (single-flight). Returns how many were confirmed. */
  async function retryRound(): Promise<number> {
    let ok = 0
    for (const row of deps.store.due(now())) {
      if (inflight.has(row.clientTripId)) continue
      const r = await push(row)
      if (r.status === 200 || r.status === 409) ok++
      else if (r.status === 202) break // still down: stop hammering it this round
    }
    if (ok) log(`[trips] retry pushed ${ok} queued trip${ok === 1 ? "" : "s"}`)
    return ok
  }

  function retryDue(): Promise<number> {
    // .finally runs after the assignment even when the round is synchronous (nothing due).
    retrying ??= retryRound().finally(() => { retrying = null })
    return retrying
  }

  /** Coords for the history: the stored upload, else the dashboard row (read-only). */
  async function historyRow(tripId: string, classification: string, clientSlug: string | null): Promise<HistoryRow | null> {
    const up = deps.store.byTripId(tripId)
    if (up) {
      const u = up.upload
      return { tripId, startLat: u.start.lat, startLon: u.start.lon, endLat: u.end.lat, endLon: u.end.lon, classification, clientSlug, startedAt: u.startedAt, at: now() }
    }
    const r = await deps.readRow(tripId).catch(() => null)
    return r ? { tripId, startLat: r.startLat, startLon: r.startLon, endLat: r.endLat, endLon: r.endLon, classification, clientSlug, startedAt: r.startedAt, at: now() } : null
  }

  /** A human answer already written to the dashboard: classify log + history + review resolved. Idempotent. */
  async function recordHuman(tripId: string, classification: string, clientSlug: string | null): Promise<void> {
    const t = now()
    if (classification !== "business" && classification !== "personal") return
    const slug = classification === "business" ? clientSlug : null
    const latest = deps.store.latestLog(tripId)
    if (latest && latest.humanClassification === classification && (latest.humanClientSlug ?? null) === slug) return
    deps.store.markHuman(tripId, classification, slug, t)
    const h = await historyRow(tripId, classification, slug)
    if (h) deps.store.saveHistory(h)
    deps.store.resolve(tripId, t)
  }

  /**
   * File a backlog trip as the machine: PATCH {classification, classifiedBy, classifierConfidence},
   * which the dashboard applies only to an unclassified trip in an open quarter. Never a client, never recordHuman.
   */
  async function autofile(tripId: string, r: ClassifyResult): Promise<AutofileOutcome> {
    if (r.classification === "unclassified") return { kind: "unclassified" }
    const classifiedBy = r.classifiedBy === "jev" ? "jev" : "rules"
    let res: { status: number; json: Record<string, unknown> | null }
    try {
      res = await deps.patch(tripId, { classification: r.classification, classifiedBy, classifierConfidence: r.confidence })
    } catch (e) {
      return { kind: "retry", error: (e as Error)?.name ?? "error" }
    }
    if (res.status === 409 || res.status === 423) return { kind: "final", error: typeof res.json?.error === "string" ? res.json.error : `http_${res.status}` }
    if (res.status < 200 || res.status >= 300 || res.json?.ok === false) return { kind: "retry", error: `http_${res.status}` }
    deps.store.log({
      tripKey: tripId, tripId, mode: "backfill", classification: r.classification, clientSlug: null, confidence: r.confidence,
      decision: "filed", classifiedBy, rule: r.rule, evidence: logEvidence(r),
    }, now())
    return { kind: "filed", classifiedBy: typeof res.json?.classifiedBy === "string" ? res.json.classifiedBy : null }
  }

  /**
   * PATCH a trip as Jeremie (phone Trips tab): `classified_by: "human"`.
   * Throws DashboardUnreachable / DashboardKeyMissing; any reply is passed back.
   */
  async function override(tripId: string, change: { classification?: string; clientSlug?: string | null; purpose?: string }): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const body: Record<string, unknown> = { classified_by: "human", classifiedBy: "human" }
    if (change.classification !== undefined) body.classification = change.classification
    if (change.clientSlug !== undefined) { body.client_slug = change.clientSlug; body.clientSlug = change.clientSlug }
    if (change.purpose !== undefined) body.purpose = change.purpose
    const r = await deps.patch(tripId, body)
    if (r.status >= 200 && r.status < 300 && r.json?.ok !== false && change.classification) {
      await recordHuman(tripId, change.classification, change.classification === "business" ? change.clientSlug ?? null : null)
    }
    return r
  }

  return {
    upload, retryDue, override, recordHuman, autofile,
    queued: (): UploadRow[] => deps.store.unconfirmed(),
  }
}

export type TripService = ReturnType<typeof createTripService>
