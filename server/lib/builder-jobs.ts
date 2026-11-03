// Builder-job progress: the brain's relay tasks (TASK → PROGRESS… → DONE /
// ABORTED), for the iOS progress ring next to the brain thread's menu.
//
// The relay mod in the brain's Claude session POSTs /hooks/builder-progress on
// each relay event it sees (it already swallows PROGRESS like ACK, so no model
// turn). This store owns the state and announces the full list as one
// idempotent `builder_jobs` frame on every change. It is state, never chat.
//
// `task` creates the job (title, builder); `progress` creates it too when the
// TASK was missed (restart) and updates pct / step; `done` / `aborted` drop it
// and leave a tombstone (bounded, unknown ids too) so a late, out-of-order
// PROGRESS / TASK for a finished job is ignored instead of recreating it.
// No update for STALE_MS → `stale: true` (frame re-sent); DROP_MS → dropped.
// Not persisted: a restart loses the list, the next PROGRESS recreates the job.

export const STALE_MS = 10 * 60_000
export const DROP_MS = 2 * 60 * 60_000
export const MAX_JOBS = 16
export const MAX_TOMBSTONES = 64

export type BuilderEvent = "task" | "progress" | "done" | "aborted"

export interface BuilderReport {
  event: BuilderEvent
  id: string
  title: string | null
  builder: string | null
  pct: number | null
  step: string | null
}

export interface BuilderJobItem {
  id: string
  title: string
  builder: string | null
  /** 0-100, or null = indeterminate (spinner). */
  pct: number | null
  step: string | null
  startedAt: number
  updatedAt: number
  stale: boolean
}

// The `builder_jobs` WS frame: every active job, full list (replace). `jobs: []` clears.
export interface BuilderJobsFrame {
  type: "builder_jobs"
  jobs: BuilderJobItem[]
  at: number
}

export interface BuilderJobsDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  emit(frame: BuilderJobsFrame): void
}

const EVENTS = new Set<string>(["task", "progress", "done", "aborted"])
const ID_RE = /^[\w.-]{1,100}$/

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/[\x00-\x1f\x7f]+/g, " ").trim()
  return s ? s.slice(0, max) : null
}

// Validates a /hooks/builder-progress body; null when unusable. A pct outside
// 0-100 or not a number counts as absent (indeterminate).
export function parseBuilderReport(body: unknown): BuilderReport | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (typeof b.event !== "string" || !EVENTS.has(b.event)) return null
  if (typeof b.id !== "string" || !ID_RE.test(b.id)) return null
  const pct = typeof b.pct === "number" && Number.isFinite(b.pct) && b.pct >= 0 && b.pct <= 100 ? Math.round(b.pct) : null
  return { event: b.event as BuilderEvent, id: b.id, title: text(b.title, 200), builder: text(b.builder, 100), pct, step: text(b.step, 120) }
}

export class BuilderJobStore {
  private jobs = new Map<string, Omit<BuilderJobItem, "stale">>()
  private finished = new Set<string>()
  private timer: unknown = null

  constructor(private deps: BuilderJobsDeps) {}

  report(r: BuilderReport): void {
    const now = this.deps.now()
    const prev = this.jobs.get(r.id)
    if (r.event === "done" || r.event === "aborted") {
      this.finished.delete(r.id)
      this.finished.add(r.id)
      if (this.finished.size > MAX_TOMBSTONES) this.finished.delete(this.finished.values().next().value!)
      if (!prev) return
      this.jobs.delete(r.id)
    } else {
      if (this.finished.has(r.id)) return
      if (!prev) this.makeRoom()
      this.jobs.set(r.id, {
        id: r.id,
        title: r.title ?? prev?.title ?? r.id,
        builder: r.builder ?? prev?.builder ?? null,
        // A TASK re-send keeps the progress; a PROGRESS without pct is indeterminate.
        pct: r.event === "progress" ? r.pct : prev?.pct ?? null,
        step: r.event === "progress" ? r.step : prev?.step ?? null,
        startedAt: prev?.startedAt ?? now,
        updatedAt: now,
      })
    }
    this.flush()
  }

  frame(): BuilderJobsFrame {
    this.sweep()
    return { type: "builder_jobs", jobs: this.items(), at: this.deps.now() }
  }

  stop(): void {
    if (this.timer) this.deps.clearTimer(this.timer)
    this.timer = null
    this.jobs.clear()
    this.finished.clear()
  }

  // Drops jobs past DROP_MS; true when the list changed.
  private sweep(): boolean {
    const now = this.deps.now()
    let changed = false
    for (const [id, j] of this.jobs) if (now - j.updatedAt >= DROP_MS) changed = this.jobs.delete(id) || changed
    return changed
  }

  private items(): BuilderJobItem[] {
    const now = this.deps.now()
    return [...this.jobs.values()]
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
      .map((j) => ({ ...j, stale: now - j.updatedAt >= STALE_MS }))
  }

  private makeRoom(): void {
    if (this.jobs.size < MAX_JOBS) return
    const oldest = [...this.jobs.values()].reduce((a, b) => (b.updatedAt < a.updatedAt ? b : a))
    this.jobs.delete(oldest.id)
  }

  private flush(): void {
    this.sweep()
    this.deps.emit({ type: "builder_jobs", jobs: this.items(), at: this.deps.now() })
    this.arm()
  }

  // One timer at the next stale flip or drop; each fires a fresh frame.
  private arm(): void {
    if (this.timer) this.deps.clearTimer(this.timer)
    this.timer = null
    const now = this.deps.now()
    let next = Number.POSITIVE_INFINITY
    for (const j of this.jobs.values()) {
      const staleAt = j.updatedAt + STALE_MS
      next = Math.min(next, staleAt > now ? staleAt : j.updatedAt + DROP_MS)
    }
    if (next === Number.POSITIVE_INFINITY) return
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      this.flush()
    }, Math.max(0, next - now))
  }
}
