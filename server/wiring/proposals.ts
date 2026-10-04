import { appendTurn, setTaskStatus, type Task } from "../lib/orchestrator-chat"
import { cancelDispatchTask, finishLive, liveOwner } from "../lib/dispatch-tasks"
import { approveBodyFix } from "./body-fix"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { type LiveStart, approveLive } from "./live"
import { emitTask, fileProposal, orchEmit, writeCtx } from "./orchestrator"

// Proposal approve / reject: the one path behind POST .../proposal/<id>/{approve|reject}
// (routes/orchestrator.ts) and the triage `approve` / `reject` options
// (wiring/triage.ts). A #Body fix for a Mac component keeps its host routing
// (wiring/body-fix.ts) whatever the mode.

export interface ApproveOpts { mode?: unknown; agent?: string | null; noteId?: string | null; cwd?: string | null }

/** Live start (P4) → {ok, taskId, dispatchTaskId, status, mode, replay}; errors keep their extra fields. */
export function liveResponse(out: LiveStart): Response {
  if (!out.ok) return Response.json({ ok: false, error: out.error, ...out.extra }, { status: out.status })
  return Response.json(out)
}

/** Approve files the proposal to Turso (replay on `filed` → 200, same id); mode "live" runs the tmux worker here. */
export async function approveProposal(task: Task, opts: ApproveOpts = {}, dispatch: DispatchWiring = dispatchWiring): Promise<Response> {
  const macFix = await approveBodyFix(task, dispatch)
  if (macFix) return macFix
  if (opts.mode === "live") {
    return liveResponse(await approveLive(task.taskId, { agent: opts.agent ?? null, noteId: opts.noteId ?? null, cwd: opts.cwd ?? null }, dispatch))
  }
  const out = await fileProposal(task.taskId, { agent: opts.agent ?? null, noteId: opts.noteId ?? null }, dispatch)
  if (!out.ok) return Response.json({ ok: false, error: out.error, taskId: task.taskId }, { status: out.status })
  return Response.json({ ok: true, taskId: task.taskId, status: "queued", dispatchTaskId: out.dispatchTaskId, replay: out.replay })
}

/** proposed → rejected; a Turso row an interrupted approve left behind is withdrawn (best effort). */
export function rejectProposal(task: Task, dispatch: DispatchWiring = dispatchWiring): Response {
  if (task.status !== "proposed") return Response.json({ ok: false, error: `not proposable (status ${task.status})` }, { status: 409 })
  setTaskStatus(task.taskId, "rejected")
  emitTask(task.taskId)
  orchEmit(appendTurn("orchestrator", `rejected [${task.taskId}] — not dispatched`, task.taskId, task.threadId))
  // An approve that died after the Turso insert but before markFiled left a
  // queued row behind: withdraw it (guarded queued → cancelled). A live approve
  // that died after its claim left a running row owned here: close that too.
  if (task.dispatchTaskId) {
    void writeCtx(dispatch, task.threadId).then(async (ctx) => {
      const out = await cancelDispatchTask(ctx, task.dispatchTaskId!)
      if (!out.ok && out.error === "running" && out.task.owner === liveOwner(ctx.host)) await finishLive(ctx, out.task.id, { status: "cancelled" })
    }).catch(() => {})
  }
  return Response.json({ ok: true, taskId: task.taskId, status: "rejected" })
}
