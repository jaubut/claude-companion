import { readdir } from "node:fs/promises"
import { BRAIN_AGENT, BRAIN_THREAD } from "../lib/brain"
import { localBodyHost } from "../lib/body-investigate"
import { processEnvEntries } from "../lib/discover"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { prState, realGh } from "../lib/triage-pr"
import { type ExecFn, type Row, TursoUnreachable } from "../lib/turso"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// bin/task-cancel (POST /hooks/brain/task-cancel): the brain cancels an
// obsolete or superseded dispatch task itself. Every check is made here, from
// Turso, never from the brain's word:
//   the task exists (full id or an unambiguous 8-char prefix) · its assignee is
//   agent:* (Jeremie's own to-dos never) · not running, unless its worker is
//   provably gone · not already done, cancelled or merged.
// An open dispatch/* PR is left alone (the brain closes it with bin/pr-close).

export const TASK_CANCEL_ACTION = "brain:task-cancel"
export const TASK_REASON_MAX = 300
export const TASK_REF = /^[A-Za-z0-9-]{8,64}$/

export interface TaskCancelInput { task: string; reason: string }
export interface TaskCancelDeps {
  exec: ExecFn
  /** True only when the running task's worker is provably gone. */
  workerGone(task: Row): Promise<boolean>
  /** The task's PR state on GitHub (OPEN | MERGED | CLOSED | unknown). */
  prState(url: string): Promise<string>
  event(text: string): void
}
type Out = { status: number; body: Record<string, unknown> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } })

/** The task by full id or 8-char prefix; null = none or ambiguous (refused alike). */
async function findTask(exec: ExecFn, ref: string): Promise<Row | null> {
  const { rows } = await exec(
    "SELECT id, text, assignee, done, dispatch_status, dispatch_owner, dispatch_pr_url, updated_at FROM tasks WHERE id = ? OR (length(?) = 8 AND substr(id, 1, 8) = ?) LIMIT 2",
    [ref, ref, ref],
  )
  const exact = rows.find((r) => String(r.id) === ref)
  if (exact) return exact
  return rows.length === 1 ? rows[0]! : null
}

export async function cancelAgentTask(p: TaskCancelInput, deps: TaskCancelDeps = realDeps): Promise<Out> {
  try {
    const t = await findTask(deps.exec, p.task)
    if (!t) return fail(404, "not_found")
    const id = String(t.id)
    if (!String(t.assignee ?? "").startsWith("agent:")) return fail(403, "not_agent_task")
    if (String(t.done) === "1" || t.dispatch_status === "cancelled") return fail(409, "already_final", { dispatchStatus: t.dispatch_status ?? null, done: String(t.done) === "1" })
    if (t.dispatch_status === "running" && !(await deps.workerGone(t).catch(() => false))) return fail(409, "running", { owner: t.dispatch_owner ?? null })
    const reason = redactSecrets(p.reason).slice(0, TASK_REASON_MAX)
    // Compare-and-set on the row we checked: a runner claiming it meanwhile wins.
    const { affected } = await deps.exec(
      "UPDATE tasks SET dispatch_status = 'cancelled', done = 1, dispatch_blocker = ?, dispatch_completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND done = 0 AND dispatch_status IS ? AND updated_at IS ?",
      [`Cancelled by the brain: ${reason}`, id, t.dispatch_status ?? null, t.updated_at ?? null],
    )
    if (affected === 0) return fail(409, "changed")
    const prUrl = typeof t.dispatch_pr_url === "string" && t.dispatch_pr_url ? t.dispatch_pr_url : null
    const pr = prUrl ? await deps.prState(prUrl).catch(() => "unknown") : null
    const title = String(t.text ?? "").slice(0, 80)
    try {
      await deps.exec(
        "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
        [BRAIN_AGENT, TASK_CANCEL_ACTION, "task", id, `cancelled by the brain: ${reason}`.slice(0, 200),
          JSON.stringify({ from: t.dispatch_status ?? null, reason, prUrl, prState: pr, source: "companion" })],
      )
    } catch (err) {
      companionLog(`[brain] task-cancel: activity row failed (${(err as Error)?.name ?? "error"})`)
    }
    deps.event(`Brain cancelled task ${id.slice(0, 8)} (${title}): ${reason}`)
    companionLog(`[brain] task-cancel ${id.slice(0, 8)} from ${String(t.dispatch_status ?? "none")}`)
    const openPr = prUrl && pr !== "MERGED" && pr !== "CLOSED" ? { pr: prUrl, prState: pr, note: "the PR is not closed: use bin/pr-close" } : {}
    return { status: 200, body: { ok: true, cancelled: id, from: t.dispatch_status ?? null, ...openPr } }
  } catch (err) {
    companionLog(`[brain] task-cancel: turso ${err instanceof TursoUnreachable ? err.message : (err as Error)?.name ?? "error"}`)
    return fail(503, "turso_unreachable")
  }
}

/**
 * A running task's worker is gone when it ran on this host and no local
 * process carries DISPATCH_TASK_ID=<id> (herdr and legacy workers alike).
 * Another host, or no /proc to read, can't be proven gone.
 */
async function workerGoneHere(task: Row): Promise<boolean> {
  if (process.platform !== "linux" || String(task.dispatch_owner ?? "").toLowerCase() !== localBodyHost()) return false
  const marker = `DISPATCH_TASK_ID=${String(task.id)}`
  for (const pid of (await readdir("/proc")).filter((d) => /^\d+$/.test(d))) {
    if ((await processEnvEntries(pid))?.includes(marker)) return false
  }
  return true
}

const realDeps: TaskCancelDeps = {
  exec: (sql, args) => dispatchWiring.exec(sql, args),
  workerGone: workerGoneHere,
  prState: (url) => prState(realGh, url),
  event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
}
