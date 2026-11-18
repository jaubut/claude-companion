import { type TraceRow, getRow, rowId, upsertRow } from "./brain-trace"
import type { BuilderReport } from "./builder-jobs"
import { workerReceipt } from "./worker-pr-link"
import type { SupervisedTaskSnapshot } from "./worker-supervisor"

// One live brain_trace card per headless worker turn (row `headless:<jobId>`):
// family/model, step, plan progress (ref.progress), latest summary and elapsed,
// rewritten in place at most once per THROTTLE_MS and only when step, plan or summary changed. It never touches
// the chat thread, so it never wakes the brain; finish() collapses it into the
// same text as the PR ready / completed / blocked receipt.

export const THROTTLE_MS = 1_000

type Snap = SupervisedTaskSnapshot

export interface WorkerProgressTraceDeps {
  host: string
  now(): number
  trace(rows: TraceRow[]): void
  schedule?(fn: () => void, ms: number): void
}

/** The receipt posted to the brain thread when a turn ends (it wakes the brain). */
export function receiptText(t: Snap): string {
  return workerReceipt(t)
}

const cardId = (t: Snap): string => rowId.headless(t.turnCount <= 1 ? t.taskId : `${t.taskId}:t${t.turnCount}`)
const keyOf = (t: Snap): string => `${t.step ?? ""}\n${t.progress?.done ?? ""}/${t.progress?.total ?? ""}\n${t.result}`

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function createWorkerProgressTrace(deps: WorkerProgressTraceDeps) {
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.() })
  const jobs = new Map<string, { sentKey: string | null; lastAt: number; pending: boolean; latest: Snap }>()

  function write(t: Snap, status: TraceRow["status"], detail: string): void {
    const title = `${t.family}${t.model ? ` · ${t.model}` : ""} — ${t.title}`
    const progress = t.progress ? { progress: t.progress } : {}
    const row = upsertRow({ id: cardId(t), kind: "agent", status, title, detail, ref: { taskId: t.taskId, host: deps.host, ...progress } }, deps.now())
    if (row) deps.trace([row])
  }

  function flush(id: string): void {
    const j = jobs.get(id)
    if (!j) return
    j.pending = false
    const key = keyOf(j.latest)
    if (key === j.sentKey) return
    j.sentKey = key; j.lastAt = deps.now()
    const t = j.latest
    const plan = t.progress && t.progress.source !== "none" ? ` (${t.progress.done}/${t.progress.total})` : ""
    write(t, "running", `${t.step ?? "Working"}${plan} · ${elapsed(j.lastAt - t.startedAt)}${t.result ? `\n${t.result}` : ""}`)
  }

  function finish(t: Snap, status: TraceRow["status"], detail: string): void {
    jobs.delete(cardId(t))
    write(t, status, detail)
  }

  return {
    /** Every supervisor state change. Running → throttled card; interrupted → closes an open card. */
    update(t: Snap): void {
      const id = cardId(t)
      if (t.status === "interrupted") {
        if (getRow(id)) finish(t, "error", t.step ?? "Interrupted")
        return
      }
      if (t.status !== "running") return
      const j = jobs.get(id) ?? { sentKey: null, lastAt: -Infinity, pending: false, latest: t }
      jobs.set(id, j)
      j.latest = t
      if (j.pending || keyOf(t) === j.sentKey) return
      const wait = j.lastAt + THROTTLE_MS - deps.now()
      if (wait <= 0) return flush(id)
      j.pending = true
      schedule(() => flush(id), wait)
    },
    /** Turn ended: the card becomes the receipt. */
    finish(t: Snap): void {
      finish(t, t.status === "completed" ? "done" : "error", receiptText(t))
    },
  }
}

/**
 * `builder_jobs` reports for headless workers, at most one `progress` per job per THROTTLE_MS: a change inside the
 * window waits for one trailing send of the latest. task / done / aborted pass at once and drop a pending progress.
 */
export function throttleJobReports(send: (r: BuilderReport) => void, now: () => number, schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms).unref?.() }) {
  const jobs = new Map<string, { lastAt: number; pending: BuilderReport | null }>()
  return (r: BuilderReport): void => {
    const j = jobs.get(r.id) ?? { lastAt: -Infinity, pending: null }
    if (r.event !== "progress") {
      if (r.event === "task") jobs.set(r.id, { lastAt: now(), pending: null })
      else jobs.delete(r.id)
      send(r)
      return
    }
    jobs.set(r.id, j)
    // A trailing send is already queued: it flushes the latest, so never send around it (a stale report would follow).
    if (j.pending) { j.pending = r; return }
    const wait = j.lastAt + THROTTLE_MS - now()
    if (wait <= 0) { j.lastAt = now(); send(r); return }
    j.pending = r
    schedule(() => {
      if (jobs.get(r.id) !== j || !j.pending) return
      const latest = j.pending
      j.pending = null; j.lastAt = now(); send(latest)
    }, wait)
  }
}
