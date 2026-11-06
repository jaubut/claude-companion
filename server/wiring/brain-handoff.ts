import { createHash } from "node:crypto"
import { BRAIN_THREAD } from "../lib/brain"
import { openDeliveries } from "../lib/brain-store"
import { rowId, upsertRow } from "../lib/brain-trace"
import { fileHandoff, getNote } from "../lib/dispatch-tasks"
import { companionLog } from "../lib/log"
import { getTurn } from "../lib/orchestrator-chat"
import { TursoUnreachable } from "../lib/turso"
import { emitTrace } from "./brain"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { writeCtx } from "./orchestrator"

// bin/propose --handoff (POST /hooks/brain/propose, handoff: true): a tasks row for a builder the brain hands work to
// by relay. The id is the TASK id and the dispatch/<id> branch; the relay's DONE links the PR, so the shepherd reads
// this row's origin instead of treating the PR as unknown.

export interface HandoffInput { title: string; prompt: string; noteId: string; reasoning: string; sourceTurnId: string }

/**
 * The origin is decided here, never by the caller. `jeremie` only for his own turn that the brain is answering right
 * now: an event, a peer's message or a turn already closed reads `unknown`.
 */
export function handoffOrigin(turnId: string): "jeremie" | "unknown" {
  const turn = getTurn(turnId)
  const open = openDeliveries().some((r) => r.turnId === turnId && r.state === "typed")
  return turn?.role === "user" && turn.threadId === BRAIN_THREAD && open ? "jeremie" : "unknown"
}

export async function addBrainHandoff(p: HandoffInput, dispatch: DispatchWiring = dispatchWiring): Promise<{ status: number; body: Record<string, unknown> }> {
  const origin = handoffOrigin(p.sourceTurnId)
  try {
    const note = await getNote(dispatch.query, p.noteId)
    if (!note) return { status: 404, body: { ok: false, error: "no such note" } }
    // Stable per (turn, resolved note, prompt): a retried call files one row, with the origin of the first. Namespaced so it never meets addBrainTodo's id.
    const id = createHash("sha256").update(`handoff\n${p.sourceTurnId}\n${note.noteId}\n${p.prompt}`).digest("hex").slice(0, 32)
    const description = `${p.prompt}\n\n— Handed off from Companion #Brain${p.reasoning ? `\nWhy: ${p.reasoning}` : ""}`
    const ctx = await writeCtx(dispatch, BRAIN_THREAD)
    const { inserted } = await fileHandoff(ctx, { id, noteId: note.noteId, title: p.title, description, origin })
    // No origin column: nothing was stored, so nothing may be claimed.
    const filed = !ctx.cols.origin ? "unknown" : inserted ? origin : String((await dispatch.query("SELECT origin FROM tasks WHERE id = ?", [id]))[0]?.origin ?? "unknown")
    const row = upsertRow({
      id: `handoff:${id}`, parentId: rowId.turn(p.sourceTurnId), turnId: p.sourceTurnId, kind: "agent", status: "done",
      title: `Handed off: ${p.title}`, detail: note.title ?? note.ref ?? note.noteId, ref: { taskId: id },
    })
    if (row) emitTrace([row])
    return { status: 200, body: { ok: true, taskId: id, origin: filed, replay: !inserted } }
  } catch (err) {
    companionLog(`[brain] handoff failed: ${err instanceof TursoUnreachable ? err.message : (err as Error)?.name ?? "error"}`)
    return { status: 503, body: { ok: false, error: "turso_unreachable" } }
  }
}
