import { type WriteCtx, type WriteOutcome, getDispatchTask, ledger, readVia } from "./dispatch-tasks"
import type { SqlArg } from "./turso"

// Owner-guarded Turso writes for the blocked-task takeover (slice B of
// docs/one-stream-plan.md replaces it with unblock/requeue). Live mode (P4,
// claimLive/finishLive) is gone: Companion files `pending` rows only.

/** The last GitHub PR URL in a worker's final output, if any. */
export function detectPrUrl(text: string): string | null {
  const all = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)
  return all ? all[all.length - 1]! : null
}

// ── takeover ─────────────────────────────────────────────────────────────────
// A blocked task Jeremie takes over in an interactive session (wiring/takeover.ts).
// The claim is ONE guarded UPDATE that also sets the owner: dispatch-run's stall
// sweep skips only a non-NULL `companion:%` owner, and its reap UPDATEs are not
// owner-guarded. Finish is guarded on `running AND owner = ours`, so Stop,
// SessionEnd and the tick race safely (the first wins, the rest are no-ops). The
// owner stays on the row afterwards (audit; the PR safety net skips it).

export const TAKEOVER_OWNER = "companion:takeover:"
export const takeoverOwner = (name: string): string => `${TAKEOVER_OWNER}${name}`

export type TakeoverOutcome =
  | { status: "completed"; prUrl?: string | null; what?: string | null }
  | { status: "blocked"; blocker: string }

/**
 * blocked (not done, at the `updated_at` the caller read) → running, owned by the
 * takeover session. 0 rows → conflict with the current row (it moved first).
 */
export async function claimTakeover(ctx: WriteCtx, id: string, seenUpdatedAt: string, name: string, runId: string): Promise<WriteOutcome> {
  const sets = [
    "dispatch_status = 'running'", "dispatch_owner = ?", "dispatch_started_at = datetime('now')", "dispatch_run_id = ?",
    "dispatch_blocker = NULL", "dispatch_completed_at = NULL", "updated_at = datetime('now')",
    ...(ctx.cols.prUrl ? ["dispatch_pr_url = NULL"] : []),
  ]
  const { affected } = await ctx.exec(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND dispatch_status = 'blocked' AND done = 0 AND updated_at = ?`,
    [takeoverOwner(name), runId, id, seenUpdatedAt],
  )
  const after = await getDispatchTask(readVia(ctx.exec), ctx.cols, id)
  if (!after) return { ok: false, error: "no_such_task" }
  if (affected === 0) return { ok: false, error: after.task.status === "running" ? "running" : "conflict", task: after.task }
  await ledger(ctx, after.task, "running", `→running (takeover ${name}): ${after.task.title}`, {
    from: "blocked", mode: "takeover", op: "claim", session: name,
  })
  return { ok: true, task: after.task }
}

/** running (owned by this takeover) → completed (+ PR) | blocked. One guarded UPDATE; the ledger row only when it moved. */
export async function finishTakeover(ctx: WriteCtx, id: string, name: string, outcome: TakeoverOutcome): Promise<WriteOutcome> {
  const sets = ["dispatch_status = ?", "updated_at = datetime('now')", "dispatch_completed_at = datetime('now')"]
  const args: SqlArg[] = [outcome.status]
  if (outcome.status === "blocked") { sets.push("dispatch_blocker = ?"); args.push(outcome.blocker.slice(0, 500)) }
  if (outcome.status === "completed" && outcome.prUrl && ctx.cols.prUrl) { sets.push("dispatch_pr_url = ?"); args.push(outcome.prUrl) }
  const { affected } = await ctx.exec(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND dispatch_status = 'running' AND dispatch_owner = ?`,
    [...args, id, takeoverOwner(name)],
  )
  const after = await getDispatchTask(readVia(ctx.exec), ctx.cols, id)
  if (!after) return { ok: false, error: "no_such_task" }
  if (affected === 0) return { ok: false, error: "conflict", task: after.task }
  const why = outcome.status === "blocked" ? ` (${outcome.blocker})` : outcome.prUrl ? ` (PR ${outcome.prUrl})` : outcome.what ? ` (${outcome.what})` : ""
  await ledger(ctx, after.task, outcome.status, `→${outcome.status} (takeover ${name}): ${after.task.title}${why}`, {
    from: "running", mode: "takeover", op: "finish", session: name,
    ...(outcome.status === "completed" && outcome.prUrl ? { pr: outcome.prUrl } : {}),
  })
  return { ok: true, task: after.task }
}
