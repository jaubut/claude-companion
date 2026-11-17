import type { SupervisedTaskSnapshot } from "./worker-supervisor"
import { type WorkerReceipt, type WorkerTurn, loadReceipts, reportTurn, saveReceipts } from "./worker-task-store"

// ponytail: unacked receipts past this drop oldest first (no brain host polling at all); a real queue if that ever matters.
const OUTBOX_MAX = 200

/** The worker host's receipt outbox: exactly one receipt per finished dispatch turn, on disk until the brain host acks it. */
export function createReceiptOutbox(file: string, now: () => number, onReceipt?: () => void) {
  const outbox = loadReceipts(file)
  return {
    enqueue(task: SupervisedTaskSnapshot, turns: readonly WorkerTurn[]): void {
      const id = `${task.taskId}#${task.turnCount}@${task.completedAt ?? task.updatedAt}`
      if (outbox.some((r) => r.id === id)) return
      const report = reportTurn(turns)
      const latest = turns.findLast((x) => x.endedAt !== null && !!x.result)
      outbox.push({ id, at: now(), latest: latest && latest !== report ? latest.result : null, task })
      if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX)
      saveReceipts(file, outbox)
      try { onReceipt?.() } catch { /* best effort */ }
    },
    pending(): WorkerReceipt[] { return [...outbox] },
    /** The brain host delivered these: drop them from the outbox. */
    ack(ids: string[]): number {
      const before = outbox.length
      for (let i = outbox.length - 1; i >= 0; i--) if (ids.includes(outbox[i]!.id)) outbox.splice(i, 1)
      if (outbox.length !== before) saveReceipts(file, outbox)
      return before - outbox.length
    },
  }
}
