import type { ApnsPayload } from "../lib/apns"
import { pushToAll } from "../lib/push"
import { parseMoney } from "../lib/receipt-checks"
import { type QaItem, onReceiptQa } from "../lib/receipt-qa-store"
import { startReceiptQaWorker } from "../lib/receipt-qa-worker"
import { broadcast } from "../state"

// Receipt QA → phone: a `receipt_qa` frame on every status change, and one
// APNs push when an item lands in `needs_human` (Sonnet could not settle it).

export interface ReceiptQaSinks {
  broadcast: (frame: Record<string, unknown>) => void
  push: (payload: ApnsPayload) => Promise<unknown>
}

function amount(total: string): string {
  const n = parseMoney(total)
  return n === null ? total : n.toFixed(2)
}

export function receiptPushPayload(item: QaItem): ApnsPayload {
  const first = item.issues[0]
  const merchant = item.merchant || "Receipt"
  return {
    title: "Receipt needs you",
    body: `${merchant} · ${amount(item.total)} $${first ? ` — ${first.problem}` : ""}`.slice(0, 240),
    category: "briefing",
    threadId: "receipt-qa",
    collapseId: `receipt-${item.expense_id}`.slice(0, 64),
    userInfo: { kind: "receipt_review", expense_id: item.expense_id },
  }
}

/** Register the listener. Returns the unsubscribe. */
export function wireReceiptQa(sinks: ReceiptQaSinks): () => void {
  return onReceiptQa((item) => {
    sinks.broadcast({ type: "receipt_qa", item })
    if (item.status === "needs_human") void sinks.push(receiptPushPayload(item)).catch(() => {})
  })
}

/** Boot (cli.ts): live sinks + resume the queue (store host only). */
export function startReceiptQa(): () => void {
  const unwire = wireReceiptQa({ broadcast, push: pushToAll })
  const stop = startReceiptQaWorker()
  return () => { unwire(); stop() }
}
