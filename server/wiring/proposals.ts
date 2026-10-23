import { BODY_CHANNEL } from "../lib/body"
import { appendTurn, createProposal, getTask, setTaskStatus, type Task } from "../lib/orchestrator-chat"
import { approveUrl, cancelDispatchTask } from "../lib/dispatch-tasks"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { bodyFixStore } from "./body-investigate"
import { emitTask, fileProposal, orchEmit, writeCtx } from "./orchestrator"

// Proposal approve / reject: the one path behind POST .../proposal/<id>/{approve|reject}
// (routes/orchestrator.ts) and the triage `approve` / `reject` options
// (wiring/triage.ts). Approve files ONE Turso row and nothing else
// (docs/one-stream-plan.md): `queued` when the tap is Jeremie's own (byHand),
// else `pending` until the dashboard release stamp queues it; dispatch-run runs it. A #Body fix card for a Mac component is tagged requires_host=mac so
// only the Mac's dispatch-run claims it. Revise (Opus's rescope: the resolver
// and a No on a repo card) rejects the old one and files the new one.

export interface ApproveOpts { agent?: string | null; noteId?: string | null }

// A tap makes it Jeremie's (origin "jeremie", past the queue guard) only when the prompt is his own
// conversation's: #Body prompts carry log/investigation text and an Opus rescope carries PR text.
const RESCOPED = "Opus rescoped"
const byHand = (t: Task): boolean => t.threadId !== BODY_CHANNEL && !(t.reasoning ?? "").startsWith(RESCOPED)

/** {status:"queued"} or {status:"pending_approval", approveUrl} — the one filed-row answer for every Companion entry point. */
export function filedStatus(dispatchTaskId: string, queued: boolean): { status: "queued" } | { status: "pending_approval"; approveUrl: string } {
  return queued ? { status: "queued" } : { status: "pending_approval", approveUrl: approveUrl(dispatchTaskId) }
}

/** Approve → {ok, taskId, dispatchTaskId, status, approveUrl?, replay}; replay on `filed` → 200, same id. */
export async function approveProposal(task: Task, opts: ApproveOpts = {}, dispatch: DispatchWiring = dispatchWiring): Promise<Response> {
  const requiresHost = bodyFixStore.card(task.taskId)?.host === "mac" ? "mac" as const : null
  const out = await fileProposal(task.taskId, { agent: opts.agent ?? null, noteId: opts.noteId ?? null, byHand: byHand(task), requiresHost }, dispatch)
  if (!out.ok) return Response.json({ ok: false, error: out.error, taskId: task.taskId }, { status: out.status })
  return Response.json({
    ok: true, taskId: task.taskId, dispatchTaskId: out.dispatchTaskId, ...filedStatus(out.dispatchTaskId, out.queued), replay: out.replay,
  })
}

/** proposed → rejected; a Turso row an interrupted approve left behind is withdrawn (best effort). */
export function rejectProposal(task: Task, dispatch: DispatchWiring = dispatchWiring): Response {
  if (task.status !== "proposed") return Response.json({ ok: false, error: `not proposable (status ${task.status})` }, { status: 409 })
  setTaskStatus(task.taskId, "rejected")
  emitTask(task.taskId)
  orchEmit(appendTurn("orchestrator", `rejected [${task.taskId}] — not dispatched`, task.taskId, task.threadId))
  // An approve that died after the Turso insert but before markFiled left a
  // pending row behind: withdraw it (guarded pending → cancelled).
  if (task.dispatchTaskId) {
    void writeCtx(dispatch, task.threadId).then((ctx) => cancelDispatchTask(ctx, task.dispatchTaskId!)).catch(() => {})
  }
  return Response.json({ ok: true, taskId: task.taskId, status: "rejected" })
}

interface Revision { title: string; prompt: string; why: string }

/**
 * Opus rescoped a proposal: the old one is rejected, the rescoped one filed in the same thread and marked
 * Opus-created through `markCreated` (the resolver store's: it never re-resolves its own rescope).
 * Returns the new proposal id; null when the old one is gone or no longer proposed.
 */
export function reviseProposal(taskId: string, r: Revision, markCreated: (taskId: string, now: number) => void, dispatch: DispatchWiring = dispatchWiring): string | null {
  const old = getTask(taskId)
  if (!old || old.status !== "proposed") return null
  const res = rejectProposal(old, dispatch)
  if (!res.ok) return null
  // Keep the old title's `[repo:<name>]` routing marker (Body fixes): dispatch-run routes on it.
  const marker = /^\[repo:[A-Za-z0-9._-]+\] /.exec(old.title ?? "")?.[0] ?? ""
  const title = r.title && marker && !r.title.startsWith("[repo:") ? marker + r.title : r.title || old.title || null
  const next = createProposal(r.prompt, old.cwd, `${RESCOPED} [${old.taskId}]: ${r.why}`.slice(0, 500), old.threadId, {
    noteId: old.noteId ?? null, agent: old.agent ?? null, title,
  })
  markCreated(next.taskId, Date.now())
  emitTask(next.taskId)
  orchEmit(appendTurn("orchestrator", `🤖 Opus rescoped [${old.taskId}] → proposal [${next.taskId}]: ${r.title || r.prompt.slice(0, 120)}`, next.taskId, old.threadId))
  return next.taskId
}
