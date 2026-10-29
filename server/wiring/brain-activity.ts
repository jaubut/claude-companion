import { type BrainActivity, type BrainActivityKind, brainToolStep } from "../lib/brain"
import { type RowInput, type TraceRow, rowId, upsertRow } from "../lib/brain-trace"

// What the brain is doing right now, for the phone: one `activity` on the
// `brain` frame (the 🧠 glyph and the live line under the turn) and one trace
// row per tool call under the turn in flight ("Reading notes" running →
// "Read notes" done). Fed by the brain's PreToolUse / PostToolUse hooks and
// the supervisor's busy / compacting flags.

export interface ActivityInput { busy: boolean; compacting: boolean; flushing: boolean }

export function createBrainActivity(deps: { now(): number; changed(): void; trace(rows: TraceRow[]): void }) {
  let current: BrainActivity | null = null
  let step: { kind: BrainActivityKind; label: string } | null = null
  let turnId: string | null = null
  let last: ActivityInput = { busy: false, compacting: false, flushing: false }
  /** Step rows still running, by row id (done title): a turn that ends closes them (a denied call has no PostToolUse). */
  const open = new Map<string, Omit<RowInput, "status">>()

  function sync(i: ActivityInput = last): void {
    last = i
    if (!i.busy) {
      step = null
      const closed = [...open.values()].map((r) => upsertRow({ ...r, status: "done" })).filter((r): r is TraceRow => !!r)
      open.clear()
      if (closed.length) deps.trace(closed)
    }
    const next = i.compacting ? { kind: "compacting" as const, label: "Compacting memory" }
      : !i.busy ? null
      : step ?? { kind: "thinking" as const, label: i.flushing ? "Saving memory" : "Thinking" }
    if (next?.kind === current?.kind && next?.label === current?.label) return
    current = next ? { ...next, since: deps.now() } : null
    deps.changed()
  }

  return {
    get: (): BrainActivity | null => current,
    sync,
    /** The user turn the brain is answering (null for events and control turns): steps nest under it. */
    turn(id: string | null): void { turnId = id },
    /** A tool call started (phase "pre") or ran ("post"). Its trace row goes out through deps.trace. */
    tool(phase: "pre" | "post", tool: string, input: Record<string, unknown>, toolUseId: string): void {
      const s = brainToolStep(tool, input)
      step = phase === "pre" ? { kind: s.kind, label: s.running } : null
      sync()
      const id = rowId.step(toolUseId)
      if (!turnId || !toolUseId || (phase === "post" && !open.has(id))) return
      const base = { id, parentId: rowId.turn(turnId), turnId, kind: "step" as const, title: s.done, detail: s.detail, ref: { step: s.kind } }
      if (phase === "pre") open.set(id, base)
      else open.delete(id)
      const row = upsertRow(phase === "pre" ? { ...base, status: "running", title: s.running } : { ...base, status: "done" })
      if (row) deps.trace([row])
    },
  }
}
