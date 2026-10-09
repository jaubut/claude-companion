// Footage-copy progress: each `rename-footage/ingest.ts --apply` run on this
// host, for the phone's progress row.
//
// The copy-progress mod inside Claude Code POSTs /hooks/copy-progress on every
// 2 s poll of a run, with raw facts only (counts, bytes, timestamps). This
// store is the single owner of the live state: it derives `state`, the average
// rate and the ETA once, and announces the full host list as one idempotent
// `copy_jobs` frame (≤ 1 / EMIT_MIN_MS, trailing).
//
// Frame of reference: `startedAt` / `copyStartedAt` are sticky (first non-null
// value wins); totals keep their last non-zero value (the mod reports 0 on a
// parse miss). A finished job stays FINISHED_KEEP_MS then drops; an unfinished
// one with no report for STALE_MS drops (session killed). Not persisted: a
// restart loses the row, the mod's next report recreates it.
//
// `sessionKey` is the session registry key, resolved at read / emit time
// through deps.resolveKey. Unresolvable → null; the job is still listed (it is
// host-level, unlike the gauge).

export const FINISHED_KEEP_MS = 60_000
export const STALE_MS = 120_000
export const EMIT_MIN_MS = 2_000
export const MAX_JOBS = 16

// Open-ended on the wire: clients map a state they don't know to neutral.
export type CopyJobState = "hashing" | "copying" | "done" | "failed"

export interface CopyJobItem {
  jobId: string
  sessionKey: string | null
  label: string
  state: CopyJobState
  totalFiles: number
  doneFiles: number
  totalBytes: number
  doneBytes: number
  failed: number
  current: string | null
  startedAt: number
  copyStartedAt: number | null
  finishedAt: number | null
  bytesPerSec: number | null
  etaSec: number | null
  at: number
}

// The `copy_jobs` WS frame: every job on this host. `jobs: []` clears the row.
export interface CopyJobsFrame {
  type: "copy_jobs"
  jobs: CopyJobItem[]
  at: number
}

export interface CopyJobsSnapshot {
  ok: true
  jobs: CopyJobItem[]
}

// The /hooks/copy-progress body after validation: every field but jobId optional.
export interface CopyReport {
  sessionId: string | null
  jobId: string
  label: string | null
  startedAt: number | null
  copyStartedAt: number | null
  totalFiles: number | null
  totalBytes: number | null
  doneFiles: number | null
  doneBytes: number | null
  current: string | null
  failed: number | null
  finished: boolean
  at: number | null
}

export interface CopyJobsDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  // Session id → registry key, null when the registry doesn't know it.
  resolveKey(sessionId: string): string | null
  emit(frame: CopyJobsFrame): void
}

interface Entry {
  jobId: string
  sessionId: string | null
  label: string
  totalFiles: number
  doneFiles: number
  totalBytes: number
  doneBytes: number
  failed: number
  current: string | null
  finished: boolean
  startedAt: number
  copyStartedAt: number | null
  finishedAt: number | null // server receipt time of the first finished report
  at: number // reporter's time when given, else receipt
  reportedAt: number // server receipt time of the last report (staleness)
}

const ID_MAX = 200
const LABEL_MAX = 200
const CURRENT_MAX = 512

function finiteNonNeg(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
}

function boundedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const s = v.trim()
  return s && s.length <= max ? s : null
}

// Validates a /hooks/copy-progress body. Only job_id is required; a field of
// the wrong type counts as absent. Returns null when the body is unusable.
export function parseCopyReport(body: unknown): CopyReport | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const jobId = boundedString(b.job_id, ID_MAX)
  if (!jobId) return null
  return {
    sessionId: boundedString(b.session_id, ID_MAX),
    jobId,
    label: boundedString(b.label, LABEL_MAX),
    startedAt: finiteNonNeg(b.started_at) || null,
    copyStartedAt: finiteNonNeg(b.copy_started_at) || null,
    totalFiles: finiteNonNeg(b.total_files),
    totalBytes: finiteNonNeg(b.total_bytes),
    doneFiles: finiteNonNeg(b.done_files),
    doneBytes: finiteNonNeg(b.done_bytes),
    current: boundedString(b.current, CURRENT_MAX),
    failed: finiteNonNeg(b.failed),
    finished: b.finished === true,
    at: finiteNonNeg(b.at) || null,
  }
}

export function stateOf(e: { finished: boolean; failed: number; copyStartedAt: number | null }): CopyJobState {
  if (e.finished) return e.failed > 0 ? "failed" : "done"
  return e.copyStartedAt === null ? "hashing" : "copying"
}

// Average since the copy phase began (same figure as the terminal), in the
// reporter's clock. Null while hashing or before the first byte lands.
export function rateOf(doneBytes: number, copyStartedAt: number | null, at: number): number | null {
  if (copyStartedAt === null || doneBytes <= 0 || at <= copyStartedAt) return null
  return Math.round(doneBytes / ((at - copyStartedAt) / 1000))
}

export function etaOf(totalBytes: number, doneBytes: number, bytesPerSec: number | null): number | null {
  if (!bytesPerSec) return null
  return Math.max(0, Math.round((totalBytes - doneBytes) / bytesPerSec))
}

export class CopyJobStore {
  private entries = new Map<string, Entry>()
  private lastEmitAt = Number.NEGATIVE_INFINITY
  private emitTimer: unknown = null
  private sweepTimer: unknown = null

  constructor(private deps: CopyJobsDeps) {}

  report(r: CopyReport): void {
    const now = this.deps.now()
    const prev = this.entries.get(r.jobId)
    if (!prev) this.makeRoom()
    const finished = r.finished || !!prev?.finished
    const totalFiles = r.totalFiles || prev?.totalFiles || 0
    const totalBytes = r.totalBytes || prev?.totalBytes || 0
    this.entries.set(r.jobId, {
      jobId: r.jobId,
      sessionId: r.sessionId ?? prev?.sessionId ?? null,
      label: r.label ?? prev?.label ?? r.jobId,
      totalFiles,
      doneFiles: r.doneFiles ?? prev?.doneFiles ?? 0,
      totalBytes,
      doneBytes: r.doneBytes ?? prev?.doneBytes ?? 0,
      failed: r.failed ?? prev?.failed ?? 0,
      current: finished ? null : r.current,
      finished,
      startedAt: prev?.startedAt ?? r.startedAt ?? r.at ?? now,
      copyStartedAt: prev?.copyStartedAt ?? r.copyStartedAt,
      finishedAt: prev?.finishedAt ?? (finished ? now : null),
      at: r.at ?? now,
      reportedAt: now,
    })
    this.schedule()
    this.armSweep()
  }

  // Drops finished jobs past FINISHED_KEEP_MS and silent ones past STALE_MS.
  sweep(): number {
    const now = this.deps.now()
    let n = 0
    for (const [id, e] of this.entries) {
      if (now < this.deadlineOf(e)) continue
      this.entries.delete(id)
      n++
    }
    if (n > 0) this.schedule()
    return n
  }

  snapshot(): CopyJobsSnapshot {
    this.sweep()
    return { ok: true, jobs: this.items() }
  }

  // The current list as a frame: sent to a phone on /ws open (when non-empty).
  frame(): CopyJobsFrame {
    this.sweep()
    return { type: "copy_jobs", jobs: this.items(), at: this.deps.now() }
  }

  // Clears every job and timer (shutdown, tests).
  stop(): void {
    if (this.sweepTimer) this.deps.clearTimer(this.sweepTimer)
    if (this.emitTimer) this.deps.clearTimer(this.emitTimer)
    this.sweepTimer = null
    this.emitTimer = null
    this.entries.clear()
    this.lastEmitAt = Number.NEGATIVE_INFINITY
  }

  private deadlineOf(e: Entry): number {
    return e.finishedAt !== null ? e.finishedAt + FINISHED_KEEP_MS : e.reportedAt + STALE_MS
  }

  // At MAX_JOBS: evict the oldest finished job, else the least recently reported.
  private makeRoom(): void {
    if (this.entries.size < MAX_JOBS) return
    let victim: Entry | null = null
    for (const e of this.entries.values()) {
      if (!victim) { victim = e; continue }
      const a = victim.finishedAt, b = e.finishedAt
      if (b !== null && (a === null || b < a)) victim = e
      else if (a === null && b === null && e.reportedAt < victim.reportedAt) victim = e
    }
    if (victim) this.entries.delete(victim.jobId)
  }

  private items(): CopyJobItem[] {
    return [...this.entries.values()]
      .sort((a, b) => a.startedAt - b.startedAt || a.jobId.localeCompare(b.jobId))
      .map((e) => this.item(e))
  }

  private item(e: Entry): CopyJobItem {
    const state = stateOf(e)
    const bytesPerSec = state === "hashing" ? null : rateOf(e.doneBytes, e.copyStartedAt, e.at)
    return {
      jobId: e.jobId,
      sessionKey: e.sessionId ? this.deps.resolveKey(e.sessionId) : null,
      label: e.label,
      state,
      totalFiles: e.totalFiles,
      doneFiles: e.doneFiles,
      totalBytes: e.totalBytes,
      doneBytes: e.doneBytes,
      failed: e.failed,
      current: e.current,
      startedAt: e.startedAt,
      copyStartedAt: e.copyStartedAt,
      finishedAt: e.finishedAt,
      bytesPerSec,
      etaSec: state === "copying" ? etaOf(e.totalBytes, e.doneBytes, bytesPerSec) : null,
      at: e.at,
    }
  }

  // ≤ 1 frame / EMIT_MIN_MS for the host, trailing: the frame sent when the
  // window opens carries the list at that moment.
  private schedule(): void {
    if (this.emitTimer) return
    const wait = this.lastEmitAt + EMIT_MIN_MS - this.deps.now()
    if (wait <= 0) { this.flush(); return }
    this.emitTimer = this.deps.setTimer(() => {
      this.emitTimer = null
      this.flush()
    }, wait)
  }

  private flush(): void {
    const now = this.deps.now()
    this.lastEmitAt = now
    this.deps.emit({ type: "copy_jobs", jobs: this.items(), at: now })
  }

  // One timer at the earliest drop deadline; re-armed after each sweep.
  private armSweep(): void {
    if (this.sweepTimer) this.deps.clearTimer(this.sweepTimer)
    this.sweepTimer = null
    let next = Number.POSITIVE_INFINITY
    for (const e of this.entries.values()) next = Math.min(next, this.deadlineOf(e))
    if (next === Number.POSITIVE_INFINITY) return
    this.sweepTimer = this.deps.setTimer(() => {
      this.sweepTimer = null
      this.sweep()
      this.armSweep()
    }, Math.max(0, next - this.deps.now()))
  }
}
