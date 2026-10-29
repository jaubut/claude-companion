import { createHash } from "node:crypto"
import { companionLog } from "../lib/log"
import { rowId, upsertRow } from "../lib/brain-trace"
import { getNote } from "../lib/dispatch-tasks"
import { addTodo } from "../lib/my-tasks"
import { TursoUnreachable } from "../lib/turso"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { emitTrace } from "./brain"

// bin/todo (POST /hooks/brain/todo): the brain adds a to-do for Jeremie on a
// project note. The trace row under the turn is the receipt he sees.

export interface TodoInput { text: string; noteId: string; due: string | null; sourceTurnId: string }

export async function addBrainTodo(p: TodoInput, dispatch: DispatchWiring = dispatchWiring): Promise<{ status: number; body: Record<string, unknown> }> {
  let note: Awaited<ReturnType<typeof getNote>>
  try {
    // A ref code (PRJ-OR1T) or the note id (projects/…).
    const byRef = /^[A-Z]{3}-[A-Z0-9]{4}$/.test(p.noteId) ? (await dispatch.query("SELECT id FROM notes WHERE ref_code = ?", [p.noteId]))[0]?.id : null
    note = await getNote(dispatch.query, byRef ? String(byRef) : p.noteId)
  } catch {
    return { status: 503, body: { ok: false, error: "turso_unreachable" } }
  }
  if (!note) return { status: 404, body: { ok: false, error: "no such note" } }
  // Stable per (turn, text): a retried call adds the to-do once.
  const id = createHash("sha256").update(`${p.sourceTurnId}\n${p.text}`).digest("hex").slice(0, 32)
  try {
    const { inserted } = await addTodo(dispatch.exec, { id, noteId: note.noteId, text: p.text, due: p.due })
    const row = upsertRow({
      id: `todo:${id}`, parentId: rowId.turn(p.sourceTurnId), turnId: p.sourceTurnId, kind: "todo", status: "done",
      title: `Added to-do: ${p.text}`, detail: [note.title ?? note.ref ?? note.noteId, p.due ? `due ${p.due}` : null].filter(Boolean).join(" · "), ref: { taskId: id },
    })
    if (row) emitTrace([row])
    return { status: 200, body: { ok: true, taskId: id, replay: !inserted } }
  } catch (err) {
    companionLog(`[brain] todo failed: ${err instanceof TursoUnreachable ? err.message : (err as Error)?.name ?? "error"}`)
    return { status: 503, body: { ok: false, error: "turso_unreachable" } }
  }
}
