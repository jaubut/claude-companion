import { createHash } from "node:crypto"
import type { SourceItem, TripFiling, TriageOption } from "./triage"
import type { ExecOutcome } from "./triage-engine"
import { type ClassifyInput, type ClientInfo, type Ends, type TripClassifier, logEvidence } from "./trip-classify"
import type { TripRow } from "./trip-dashboard"
import { TRIP_TZ, fmtKm, shortWhen } from "./trip-model"
import { rowInput, uploadInput, type TripService } from "./trip-service"
import type { LogRow, TripStore } from "./trip-store"

// Triage source `trip` (docs/orchestrator-triage-api.md): trips Jeremie has to
// confirm. Two inputs: uploads the classifier sent to review, and the review
// backlog on the dashboard (unclassified, last 60 days, closed, ≥ 0.5 km,
// oldest 20). An item shows once it has a classifier guess; missing guesses are
// computed one at a time in the background. The phrasing is deterministic
// (lib/triage.ts tripPhrase). A choice PATCHes the dashboard through
// TripService.override, which also feeds the history.
// Batch (2026-10-14): backlog trips whose guess is near-certain (Jev ≥ 95 % and
// every same-route past trip agrees) go on ONE card "classify all as
// suggested?" instead of one card each; nothing is filed without that tap.

export const BACKFILL_DAYS = 120
export const BACKFILL_CAP = 20
/** How much of the backlog is read (and guessed in the background) to find batch trips and count the rest. */
export const BACKLOG_SCAN = 500
export const BATCH_JEV_MIN = 0.95
/** Same-route past trips needed, all agreeing with the guess. */
export const BATCH_MIN_HISTORY = 2
export const BATCH_MIN_TRIPS = 2
export const BATCH_REF = "batch"
export const BACKFILL_MIN_KM = 0.5
export const COLLECT_TTL_MS = 60_000

export interface TripTriageDeps {
  store: TripStore
  classifier: Pick<TripClassifier, "classify">
  service: Pick<TripService, "override">
  /** Read-only Turso. All may throw TursoUnreachable. */
  backfill: (sinceIso: string, limit: number, minKm: number) => Promise<TripRow[]>
  classifications: (ids: string[]) => Promise<Map<string, string>>
  clients: () => Promise<ClientInfo[]>
  now?: () => number
  log?: (msg: string) => void
}

interface Candidate { tripId: string; startedAt: string; km: number | null; input: ClassifyInput; mode: "backfill" | "triage" }

const head = (label: string | null | undefined): string | null => label?.split(",")[0]?.trim() || null

/** "Granby → Montréal", or the place names when both ends are in the same city. */
export function routeText(l: Partial<Ends> | undefined): string {
  let from = l?.startCity ?? head(l?.start) ?? "?"
  let to = l?.endCity ?? head(l?.end) ?? "?"
  if (from === to) {
    from = head(l?.start) ?? from
    to = head(l?.end) ?? to
  }
  return `${from} → ${to}`
}

/** "Tue 9:10" this week, "Tue Aug 12 9:10" before that. */
export function whenText(iso: string, now: number, tz = TRIP_TZ()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || now - t < 6 * 86_400_000) return shortWhen(iso, tz)
  const md = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: tz }).format(new Date(t))
  const [day, hm] = shortWhen(iso, tz).split(" ")
  return `${day} ${md} ${hm}`
}

export function tripItem(c: { tripId: string; startedAt: string; km: number | null }, g: LogRow, now: number): SourceItem {
  const labels = (g.evidence.labels ?? {}) as Partial<Ends>
  const route = routeText(labels)
  const line = typeof g.evidence.line === "string" ? g.evidence.line : ""
  const guess = g.classification === "business" || g.classification === "personal" ? g.classification : "unclassified"
  const cands = Array.isArray(g.evidence.candidates) ? (g.evidence.candidates as unknown[]).filter((x): x is string => typeof x === "string") : []
  const names = (g.evidence.clientNames ?? {}) as Record<string, string>
  const alt = guess === "business" ? null : g.evidence.altClient as { slug?: string; name?: string } | null | undefined
  const altSlug = alt?.slug ?? (guess === "business" ? null : cands[0] ?? null)
  const t = Date.parse(c.startedAt) || now
  return {
    source: "trip", refId: c.tripId, version: `unclassified|${g.id}`, title: `Trip ${route}`, project: "Travel log",
    createdAt: t, updatedAt: t,
    facts: { problem: `Trip ${route}, ${fmtKm(c.km)}, ${whenText(c.startedAt, now)} — business?`, evidence: line },
    url: null,
    ref: {
      source: "trip", tripId: c.tripId, guess,
      clientSlug: g.clientSlug, clientName: g.clientSlug ? names[g.clientSlug] ?? g.clientSlug : null,
      altSlug, altName: altSlug ? alt?.name ?? names[altSlug] ?? altSlug : null,
    },
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/**
 * Safe to file without looking: Jev's own p ≥ 95 % for the guessed class, and ≥ BATCH_MIN_HISTORY
 * past trips on the same route (both ends within 300 m) all with that class — and, for business,
 * no past trip there for another client.
 */
export function batchEligible(g: LogRow): boolean {
  if (g.classification !== "business" && g.classification !== "personal") return false
  const jev = g.evidence.jev as { pBusiness?: unknown } | undefined
  const p = num(jev?.pBusiness)
  if (p === null || (g.classification === "business" ? p : 1 - p) < BATCH_JEV_MIN) return false
  const h = (g.evidence.history ?? {}) as { kind?: unknown; n?: unknown; business?: unknown; personal?: unknown; clients?: unknown }
  const n = num(h.n) ?? 0
  if (h.kind !== "pair" || n < BATCH_MIN_HISTORY) return false
  const agree = num(g.classification === "business" ? h.business : h.personal) ?? 0
  if (agree !== n) return false
  const clients = h.clients && typeof h.clients === "object" ? Object.keys(h.clients) : []
  return g.classification === "personal" || clients.every((c) => c === g.clientSlug)
}

export interface BatchMember { tripId: string; startedAt: string; km: number | null; guess: LogRow }

/** The one card for all batch trips; `hidden` = backlog trips on no card at all. */
export function batchItem(members: BatchMember[], hidden: number, now: number): SourceItem {
  const trips: TripFiling[] = members.map((m) => ({
    tripId: m.tripId, classification: m.guess.classification as "business" | "personal", clientSlug: m.guess.classification === "business" ? m.guess.clientSlug : null,
  }))
  const counts = new Map<string, number>()
  for (const m of members) {
    const names = (m.guess.evidence.clientNames ?? {}) as Record<string, string>
    const key = m.guess.classification === "personal" ? "personal" : m.guess.clientSlug ? `business (${names[m.guess.clientSlug] ?? m.guess.clientSlug})` : "business (no client)"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const oldest = Math.min(...members.map((m) => Date.parse(m.startedAt) || now))
  const version = createHash("sha1").update(members.map((m) => `${m.tripId}:${m.guess.id}`).sort().join(",")).digest("hex").slice(0, 16)
  const n = members.length
  return {
    source: "trip", refId: `${BATCH_REF}:${version}`, version: `batch|${version}`, title: `${n} trips ready to file as suggested`, project: "Travel log",
    createdAt: oldest, updatedAt: oldest,
    facts: {
      problem: `${n} trips with Jev ≥ 95 % and same-route history all agreeing: classify all as suggested?${hidden ? ` ${hidden} more unclassified trip${hidden === 1 ? "" : "s"} wait in the backlog.` : ""}`,
      evidence: [...counts].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c} ${k}`).join(" · ") + (hidden ? ` · backlog not shown: ${hidden}` : ""),
    },
    url: null,
    ref: { source: "trip_batch", trips, hidden },
  }
}

export function createTripTriage(deps: TripTriageDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  let cache: { at: number; items: SourceItem[] } | null = null
  // Bumped by every invalidation, so a build that raced a new guess never caches its stale list.
  let generation = 0
  const drop = () => { cache = null; generation++ }
  const queue: Candidate[] = []
  const queued = new Set<string>()
  const attempted = new Set<string>()
  const listeners = new Set<() => void>()
  // ponytail: in memory — after a restart a declined batch is offered once more (nothing is filed without a tap).
  const declined = new Set<string>()
  let draining: Promise<void> | null = null

  // A guess the card can use: not answered yet, and not a budget timeout (unless re-guessing it already failed).
  const guessable = (g: LogRow): boolean => g.humanAt === null && (g.rule !== "timeout" || attempted.has(g.tripId ?? g.tripKey))
  const notify = () => { for (const fn of listeners) try { fn() } catch { /* not ours */ } }

  function enqueue(c: Candidate): void {
    if (queued.has(c.tripId) || attempted.has(c.tripId)) return
    queued.add(c.tripId)
    queue.push(c)
    draining ??= drain().finally(() => { draining = null })
  }

  async function drain(): Promise<void> {
    while (queue.length) {
      const c = queue.shift()!
      try {
        const r = await deps.classifier.classify(c.input)
        deps.store.log({
          tripKey: c.tripId, tripId: c.tripId, mode: c.mode, classification: r.classification, clientSlug: r.clientSlug,
          confidence: r.confidence, decision: r.decision, classifiedBy: r.classifiedBy, rule: r.rule, evidence: logEvidence(r),
        }, now())
      } catch (err) {
        log(`[trips] guess ${c.tripId} failed: ${(err as Error)?.message ?? err}`)
      } finally {
        attempted.add(c.tripId)
        queued.delete(c.tripId)
      }
      drop()
      notify()
    }
  }

  async function build(): Promise<SourceItem[]> {
    const t = now()
    const items: SourceItem[] = []
    const seen = new Set<string>()
    const uploads = deps.store.needsReview()
    const current = await deps.classifications(uploads.map((u) => u.tripId!))
    for (const u of uploads) {
      const id = u.tripId!
      const cls = current.get(id)
      if (cls !== undefined && cls !== "unclassified") { deps.store.resolve(id, t); continue }
      seen.add(id)
      const g = deps.store.latestLog(id)
      if (g && guessable(g)) items.push(tripItem({ tripId: id, startedAt: u.upload.startedAt, km: u.upload.km }, g, t))
      else if (!g || g.humanAt === null) enqueue({ tripId: id, startedAt: u.upload.startedAt, km: u.upload.km, input: { ...uploadInput(u.upload), tripId: id }, mode: "triage" })
    }
    const since = new Date(t - BACKFILL_DAYS * 86_400_000).toISOString()
    const singles: SourceItem[] = []
    let batch: BatchMember[] = []
    let backlog = 0
    for (const r of await deps.backfill(since, BACKLOG_SCAN, BACKFILL_MIN_KM)) {
      if (seen.has(r.id)) continue
      backlog++
      const g = deps.store.latestLog(r.id)
      if (g && guessable(g)) {
        if (!declined.has(r.id) && batchEligible(g)) batch.push({ tripId: r.id, startedAt: r.startedAt, km: r.km, guess: g })
        else singles.push(tripItem({ tripId: r.id, startedAt: r.startedAt, km: r.km }, g, t))
      } else if (!g) enqueue({ tripId: r.id, startedAt: r.startedAt, km: r.km, input: rowInput(r), mode: "backfill" })
    }
    if (batch.length < BATCH_MIN_TRIPS) {
      singles.push(...batch.map((m) => tripItem(m, m.guess, t)))
      singles.sort((a, b) => a.createdAt - b.createdAt)
      batch = []
    }
    const shown = singles.slice(0, BACKFILL_CAP)
    items.push(...shown)
    if (batch.length) items.push(batchItem(batch, backlog - shown.length - batch.length, t))
    return items
  }

  /** The trip items; cached for a minute, invalidated by a new guess or a human answer. Keeps the last list when Turso is down. */
  async function collect(): Promise<SourceItem[]> {
    if (cache && now() - cache.at < COLLECT_TTL_MS) return cache.items
    const gen = generation
    try {
      const items = await build()
      if (gen === generation) cache = { at: now(), items }
      return items
    } catch (err) {
      log(`[trips] triage sources unavailable (${(err as Error)?.message ?? "error"}) — keeping the last list`)
      return cache?.items ?? []
    }
  }

  /** Re-read one item: null once the dashboard trip is classified. Throws TursoUnreachable. */
  async function current(src: SourceItem): Promise<SourceItem | null> {
    if (src.ref.source === "trip_batch") return (await build()).find((i) => i.ref.source === "trip_batch") ?? null
    if (src.ref.source !== "trip") return null
    const cls = (await deps.classifications([src.ref.tripId])).get(src.ref.tripId)
    if (cls !== "unclassified") return null
    const g = deps.store.latestLog(src.ref.tripId)
    return g && guessable(g) ? { ...src, version: `unclassified|${g.id}` } : null
  }

  /** Approve = file each trip still unclassified as suggested; reject = one card each from now on. */
  async function executeBatch(trips: TripFiling[], option: TriageOption): Promise<ExecOutcome> {
    if (option.action.kind === "reject") {
      for (const f of trips) declined.add(f.tripId)
      drop()
      return { kind: "done", detail: { review: trips.length } }
    }
    if (option.action.kind !== "approve") return { kind: "error", status: 400, error: "wrong_action" }
    let filed = 0
    let skipped = 0
    const failed: string[] = []
    for (const f of trips) {
      // Re-read right before each write: a trip answered elsewhere during the batch is never overwritten.
      if ((await deps.classifications([f.tripId])).get(f.tripId) !== "unclassified") { skipped++; continue }
      const r = await deps.service.override(f.tripId, { classification: f.classification, clientSlug: f.clientSlug })
      if (r.status >= 200 && r.status < 300 && r.json?.ok !== false) filed++
      else failed.push(f.tripId)
    }
    drop()
    if (!filed && failed.length) return { kind: "error", status: 502, error: "dashboard_error", extra: { failed: failed.length } }
    return { kind: "done", detail: { filed, skipped, failed: failed.length } }
  }

  async function execute(src: SourceItem, option: TriageOption, text: string | null): Promise<ExecOutcome> {
    if (src.ref.source === "trip_batch") return executeBatch(src.ref.trips, option)
    if (src.ref.source !== "trip") return { kind: "error", status: 400, error: "wrong_source" }
    const a = option.action
    let change: { classification: string; clientSlug: string | null }
    if (a.kind === "classify") change = { classification: a.classification, clientSlug: a.classification === "business" ? a.clientSlug ?? null : null }
    else if (a.kind === "classify_custom") {
      const slug = (text ?? "").trim()
      const clients = await deps.clients()
      if (!clients.some((c) => c.slug === slug)) return { kind: "error", status: 400, error: "unknown_client" }
      change = { classification: "business", clientSlug: slug }
    } else return { kind: "error", status: 400, error: "wrong_action" }
    const r = await deps.service.override(src.ref.tripId, change)
    if (r.status === 404) return { kind: "stale", reason: "trip gone" }
    if (r.status < 200 || r.status >= 300 || r.json?.ok === false) return { kind: "error", status: 502, error: "dashboard_error", extra: { upstreamStatus: r.status } }
    drop()
    return { kind: "done", detail: { classification: change.classification, ...(change.clientSlug ? { clientSlug: change.clientSlug } : {}) } }
  }

  return {
    collect, current, execute,
    invalidate: drop,
    onGuess(fn: () => void): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** Test seam: background guesses finished. */
    async idle(): Promise<void> { while (draining) await draining },
  }
}

export type TripTriage = ReturnType<typeof createTripTriage>
