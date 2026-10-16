import {
  type DispatchColumns, type FileInput, type WriteCtx, type WriteOutcome, TITLE_MAX, getDispatchTask, ledger, readVia,
} from "./dispatch-tasks"
import type { QueryFn, SqlArg } from "./turso"

// ── live mode (P4) ───────────────────────────────────────────────────────────
// A live run is a Turso row filed already claimed (`running`, owner
// `companion:<host>`), worked by the Companion's tmux runner. dispatch-run only
// picks `queued` rows and its stall reaper skips `companion:%`, so the row is
// this host's until finishLive / cancelLive moves it — each guarded on
// `dispatch_status = 'running' AND dispatch_owner = <this host>`.

export const liveOwner = (host: string): string => `companion:${host}`

/**
 * File a task already claimed by this host under a pre-generated id. INSERT OR
 * IGNORE: a replay with the same id is a no-op (inserted=false, no ledger row).
 */
export async function claimLive(ctx: WriteCtx, input: FileInput): Promise<{ id: string; inserted: boolean }> {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX)
  const { affected } = await ctx.exec(
    "INSERT OR IGNORE INTO tasks (id, note_id, text, description, done, position, assignee, dispatch_status, dispatch_owner, dispatch_started_at, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 0, (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE note_id = ?), ?, 'running', ?, datetime('now'), datetime('now'), datetime('now'))",
    [input.id, input.noteId, title, input.description, input.noteId, `agent:${input.agent}`, liveOwner(ctx.host)],
  )
  const inserted = affected > 0
  if (inserted) await ledger(ctx, { id: input.id, agent: input.agent }, "running", `→running (live): ${title}`, { mode: "live", op: "claim", note: input.noteId })
  return { id: input.id, inserted }
}

export type LiveOutcome =
  | { status: "completed"; prUrl?: string | null; resultRef?: string | null }
  | { status: "failed"; blocker: string }
  | { status: "cancelled" }

/** The last GitHub PR URL in a worker's final output, if any. */
export function detectPrUrl(text: string): string | null {
  const all = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)
  return all ? all[all.length - 1]! : null
}

/** The last result-note ref code (RES-XXXX) in a worker's final output, if any. */
export function detectResultRef(text: string): string | null {
  const all = text.match(/\bRES-[A-Z0-9]{4,8}\b/g)
  return all ? all[all.length - 1]! : null
}

function liveSets(cols: DispatchColumns, o: LiveOutcome): { sets: string[]; args: SqlArg[] } {
  const sets = ["dispatch_status = ?", "updated_at = datetime('now')", "dispatch_completed_at = datetime('now')"]
  const args: SqlArg[] = [o.status]
  if (o.status === "cancelled") sets.push("done = 1")
  if (o.status === "failed") { sets.push("dispatch_blocker = ?"); args.push(o.blocker.slice(0, 500)) }
  if (o.status === "completed" && o.prUrl && cols.prUrl) { sets.push("dispatch_pr_url = ?"); args.push(o.prUrl) }
  if (o.status === "completed" && o.resultRef && cols.resultRef) { sets.push("dispatch_result_ref = ?"); args.push(o.resultRef) }
  return { sets, args }
}

/**
 * running (owned by this host) → completed (pr when a PR URL is known) | failed
 * | cancelled. One guarded UPDATE; the ledger row only when it moved the row,
 * so a second stop hook, or a stop after a cancel, is a no-op.
 */
export async function finishLive(ctx: WriteCtx, id: string, outcome: LiveOutcome): Promise<WriteOutcome> {
  const query = readVia(ctx.exec)
  const owner = liveOwner(ctx.host)
  const { sets, args } = liveSets(ctx.cols, outcome)
  const { affected } = await ctx.exec(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND dispatch_status = 'running' AND dispatch_owner = ?`,
    [...args, id, owner],
  )
  const after = await getDispatchTask(query, ctx.cols, id)
  if (!after) return { ok: false, error: "no_such_task" }
  if (affected === 0) return { ok: false, error: "conflict", task: after.task }
  // Ledger vocabulary = the Turso state (dispatch.sh's); a PR rides in meta.
  const why = outcome.status === "failed" ? ` (${outcome.blocker})` : after.task.prUrl ? ` (PR ${after.task.prUrl})` : ""
  await ledger(ctx, after.task, outcome.status, `→${outcome.status} (live): ${after.task.title}${why}`, {
    from: "running", mode: "live", op: outcome.status === "cancelled" ? "cancel" : "finish",
    ...(after.task.prUrl ? { pr: after.task.prUrl } : {}),
  })
  return { ok: true, task: after.task }
}

/** Ids of the running live rows this host owns (boot reconcile). */
export async function listLiveOwned(query: QueryFn, host: string): Promise<string[]> {
  const rows = await query(
    "SELECT id FROM tasks WHERE dispatch_status = 'running' AND dispatch_owner = ? AND done = 0",
    [liveOwner(host)],
  )
  return rows.map((r) => String(r.id))
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
