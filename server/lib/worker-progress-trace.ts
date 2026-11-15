import { type TraceRow, getRow, rowId, upsertRow } from "./brain-trace"
import type { SupervisedTaskSnapshot } from "./worker-supervisor"

// One live brain_trace card per headless worker turn (row `headless:<jobId>`):
// family/model, step, latest summary and elapsed, rewritten in place at most
// once per THROTTLE_MS and only when step or summary changed. It never touches
// the chat thread, so it never wakes the brain; finish() collapses it into the
// same text as the PR ready / completed / blocked receipt.

const THROTTLE_MS = 10_000

type Snap = SupervisedTaskSnapshot

export interface WorkerProgressTraceDeps {
  host: string
  now(): number
  trace(rows: TraceRow[]): void
  schedule?(fn: () => void, ms: number): void
}

/** The receipt posted to the brain thread when a turn ends (it wakes the brain). */
export function receiptText(t: Snap): string {
  if (t.status === "completed") {
    const result = t.result ? `\nResult: ${t.result.slice(0, 600)}` : ""
    return t.prUrl ? `PR ready [${t.taskId}] ${t.repo} — ${t.prUrl}${result}` : `completed [${t.taskId}] ${t.repo} — ${t.title}${result}`
  }
  return `blocked [${t.taskId}] ${t.repo} — ${t.title}\nError: ${(t.error || "worker failed").slice(0, 400)}`
}

const cardId = (t: Snap): string => rowId.headless(t.turnCount <= 1 ? t.taskId : `${t.taskId}:t${t.turnCount}`)
const keyOf = (t: Snap): string => `${t.step ?? ""}\n${t.result}`

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function createWorkerProgressTrace(deps: WorkerProgressTraceDeps) {
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.() })
  const jobs = new Map<string, { sentKey: string | null; lastAt: number; pending: boolean; latest: Snap }>()

  function write(t: Snap, status: TraceRow["status"], detail: string): void {
    const title = `${t.family}${t.model ? ` · ${t.model}` : ""} — ${t.title}`
    const row = upsertRow({ id: cardId(t), kind: "agent", status, title, detail, ref: { taskId: t.taskId, host: deps.host } }, deps.now())
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
    write(t, "running", `${t.step ?? "Working"} · ${elapsed(j.lastAt - t.startedAt)}${t.result ? `\n${t.result}` : ""}`)
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
