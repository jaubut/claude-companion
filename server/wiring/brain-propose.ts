import { createHash } from "node:crypto"
import { BRAIN_THREAD, brainFiling } from "../lib/brain"
import { proposeSeen, rememberPropose } from "../lib/brain-store"
import { type TraceRow, rowId, upsertRow } from "../lib/brain-trace"
import { DEFAULT_AGENT, getNote, resolveAgent } from "../lib/dispatch-tasks"
import { createProposal, getTask } from "../lib/orchestrator-chat"
import type { DispatchWiring } from "./dispatch"
import { emitTask } from "./orchestrator"
import { approveProposal } from "./proposals"

export interface ProposeInput {
  title: string
  prompt: string
  noteId: string
  agent: string | null
  reasoning: string
  sourceTurnId: string
}

/** The resolver leaves a proposal alone once it is handed off: the brain is filing it, or it is no longer `proposed`. */
export const proposalHandedOff = (taskId: string): boolean =>
  brainFiling.has(taskId) || getTask(taskId)?.status !== "proposed"

/** A proposal from bin/propose (POST /hooks/brain/propose, auth done by the route). */
export async function executeBrainPropose(
  p: ProposeInput,
  deps: {
    dispatch: DispatchWiring
    log: (msg: string) => void
    trace: (rows: Array<TraceRow | null>) => void
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const agent = resolveAgent(p.agent ?? DEFAULT_AGENT)
  if (!agent) return { status: 400, body: { ok: false, error: "unknown_agent" } }
  let note: Awaited<ReturnType<typeof getNote>>
  try {
    note = await getNote(deps.dispatch.query, p.noteId)
  } catch {
    return { status: 503, body: { ok: false, error: "turso_unreachable" } }
  }
  if (!note) return { status: 404, body: { ok: false, error: "no such note" } }
  // Dedupe and create with no await between: two identical calls can never both create.
  const hash = createHash("sha256").update(p.prompt).digest("hex").slice(0, 32)
  const seen = proposeSeen(p.sourceTurnId, hash)
  if (seen) return { status: 200, body: { ok: true, proposalId: seen, replay: true } }
  const task = createProposal(p.prompt, "", p.reasoning, BRAIN_THREAD, { noteId: note.noteId, agent, title: p.title })
  brainFiling.add(task.taskId) // no await since the insert: triage never sees it un-flagged
  rememberPropose(p.sourceTurnId, hash, task.taskId)
  const project = note.ref ?? note.title ?? note.noteId
  const repoId = rowId.repo(p.sourceTurnId, project)
  deps.trace([
    upsertRow({ id: repoId, parentId: rowId.turn(p.sourceTurnId), turnId: p.sourceTurnId, kind: "repo", status: "running", title: note.title ?? project, detail: project }),
    upsertRow({ id: rowId.agent(task.taskId), parentId: repoId, turnId: p.sourceTurnId, kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: "waits for your tap" }),
  ])
  emitTask(task.taskId)
  // The brain hands off: filed and queued at once, no Approve card (Jeremie, 2026-10-29).
  // The trace row is what he sees; a failed file stays a proposal he can tap.
  let res: Response, body: Record<string, unknown>
  try {
    res = await approveProposal(task, {}, deps.dispatch)
    body = await res.json() as Record<string, unknown>
  } finally {
    brainFiling.delete(task.taskId)
  }
  if (res.ok) {
    deps.trace([upsertRow({ id: rowId.agent(task.taskId), kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: body.status === "queued" ? "dispatched" : "waits for the dashboard stamp", ref: { taskId: String(body.dispatchTaskId ?? "") } })])
    return { status: 200, body: { ...body, proposalId: task.taskId } }
  }
  deps.log(`[brain] auto-file failed (${String(body.error)}): left as a proposal`)
  deps.trace([upsertRow({ id: rowId.agent(task.taskId), kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: "couldn't dispatch — tap to file it" })])
  return { status: 200, body: { ok: true, proposalId: task.taskId, status: "proposed", error: body.error ?? null } }
}
