import type { ClassifyInput, ClassifyResult } from "./trip-classify"
import { readBackfill, readHumanSince } from "./trip-dashboard"
import { type TripService, rowInput } from "./trip-service"
import type { QueryFn } from "./turso"

// Background auto-file (trips-auto-quarterly). Every closed, located trip ends
// up business or personal with no confidence gate; Jeremie approves per
// quarter on the dashboard. One sweep, single-flight, on a 10-min tick and when
// an upload went in unclassified:
//   1. the Turso backlog (unclassified, last 400 days, oldest first, 50 per
//      sweep, one at a time — each PATCH re-prices the year) → classify →
//      service.autofile (machine PATCH). An `unclassified` answer is retried after
//      1 h; 409 already_classified / 423 quarter_locked are skipped for good.
//   2. the human sync: trips Jeremie flipped on the dashboard since the
//      watermark → service.recordHuman (idempotent), only for trips this server
//      classified (they have a log row).
// State is in memory: a restart re-reads Turso and re-syncs the last 30 days.
// Guards: a Turso read failure (e.g. no `approval_id` column before the
// dashboard schema) pauses the sweep with one log line; a PATCH reply without
// `classifiedBy` means an old dashboard that would record the machine as
// human, so the sweep stops until restart.

export const AUTOFILE_TICK_MS = 10 * 60_000
export const AUTOFILE_BATCH = 50
export const AUTOFILE_WINDOW_DAYS = 400
export const RETRY_UNCLASSIFIED_MS = 60 * 60_000
export const HUMAN_RESYNC_DAYS = 30
const HUMAN_BATCH = 200
const DAY_MS = 86_400_000

export interface TripAutofileDeps {
  query: QueryFn
  classify: (input: ClassifyInput) => Promise<ClassifyResult>
  service: Pick<TripService, "autofile" | "recordHuman">
  /** True when companion.db has a classify-log row for this dashboard id. */
  hasLog: (tripId: string) => boolean
  now?: () => number
  log?: (msg: string) => void
}

export interface SweepStats { filed: number; unclassified: number; skipped: number; human: number }

/** SQLite `datetime('now')` format, the dashboard's `updated_at`. */
export const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

export function createTripAutofile(deps: TripAutofileDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const retryAt = new Map<string, number>()
  const skipped = new Set<string>()
  let watermark = sqlTime(now() - HUMAN_RESYNC_DAYS * DAY_MS)
  let paused: string | null = null
  let refused = false
  let running: Promise<SweepStats> | null = null

  async function fileBacklog(stats: SweepStats): Promise<void> {
    const since = new Date(now() - AUTOFILE_WINDOW_DAYS * DAY_MS).toISOString()
    // Over-fetch so trips waiting for a retry or skipped for good do not starve the rest.
    const due = (await readBackfill(deps.query, since, AUTOFILE_BATCH * 4, 0))
      .filter((r) => !skipped.has(r.id) && (retryAt.get(r.id) ?? 0) <= now())
      .slice(0, AUTOFILE_BATCH)
    for (const row of due) {
      const res = await deps.classify(rowInput(row)).catch(() => null)
      const out = res ? await deps.service.autofile(row.id, res) : { kind: "unclassified" as const }
      if (out.kind === "unclassified") {
        stats.unclassified++
        retryAt.set(row.id, now() + RETRY_UNCLASSIFIED_MS)
      } else if (out.kind === "final") {
        stats.skipped++
        skipped.add(row.id)
      } else if (out.kind === "retry") {
        log(`[trips] autofile: dashboard refused ${row.id} (${out.error}), next sweep`)
        return
      } else if (out.classifiedBy === null) {
        refused = true
        log("[trips] autofile stopped: the dashboard reply has no classifiedBy (an old dashboard records machine PATCHes as human); restart after the dashboard deploys")
        return
      } else {
        stats.filed++
        retryAt.delete(row.id)
      }
    }
  }

  async function syncHuman(stats: SweepStats): Promise<void> {
    for (const row of await readHumanSince(deps.query, watermark, HUMAN_BATCH)) {
      if (row.updatedAt && row.updatedAt > watermark) watermark = row.updatedAt
      if (!deps.hasLog(row.id)) continue
      const cls = row.classification === "billable" ? "business" : row.classification
      await deps.service.recordHuman(row.id, cls, row.clientSlug)
      stats.human++
    }
  }

  async function run(): Promise<SweepStats> {
    const stats: SweepStats = { filed: 0, unclassified: 0, skipped: 0, human: 0 }
    if (refused) return stats
    try {
      await fileBacklog(stats)
      if (!refused) await syncHuman(stats)
    } catch (e) {
      const why = (e as Error)?.message ?? String(e)
      if (paused === null) log(`[trips] autofile paused: Turso read failed (${why}); the dashboard's approval_id column may not exist yet`)
      paused = why
      return stats
    }
    if (paused !== null) log("[trips] autofile resumed")
    paused = null
    if (stats.filed || stats.unclassified || stats.skipped) {
      log(`[trips] autofile: ${stats.filed} filed, ${stats.unclassified} unclassified (retry in 1 h), ${stats.skipped} skipped`)
    }
    return stats
  }

  /** One sweep (single-flight: a call during a sweep gets that sweep). */
  function sweep(): Promise<SweepStats> {
    running ??= run().finally(() => { running = null })
    return running
  }

  return { sweep }
}

export type TripAutofile = ReturnType<typeof createTripAutofile>
