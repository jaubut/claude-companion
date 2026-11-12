import { createHash } from "node:crypto"
import { BRAIN_THREAD, brainFiling } from "../lib/brain"
import { proposeSeen, rememberPropose } from "../lib/brain-store"
import { type TraceRow, rowId, upsertRow } from "../lib/brain-trace"
import { createProposal } from "../lib/orchestrator-chat"
import { DEFAULT_AGENT, getNote, resolveAgent } from "../lib/dispatch-tasks"
import { emitTask } from "./orchestrator"
import { approveProposal } from "./proposals"
import type { BrainDeps, ProposeInput } from "./brain-types"

/** A proposal from bin/propose (POST /hooks/brain/propose, auth done by the route). Split out of createBrainWiring. */
export async function proposeFromBrain(deps: BrainDeps, trace: (rows: Array<TraceRow | null>) => void, p: ProposeInput): Promise<{ status: number; body: Record<string, unknown> }> {
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
      trace([
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
        trace([upsertRow({ id: rowId.agent(task.taskId), kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: body.status === "queued" ? "dispatched" : "waits for the dashboard stamp", ref: { taskId: String(body.dispatchTaskId ?? "") } })])
        return { status: 200, body: { ...body, proposalId: task.taskId } }
      }
      deps.log(`[brain] auto-file failed (${String(body.error)}): left as a proposal`)
      trace([upsertRow({ id: rowId.agent(task.taskId), kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: "couldn't dispatch — tap to file it" })])
      return { status: 200, body: { ok: true, proposalId: task.taskId, status: "proposed", error: body.error ?? null } }
}
