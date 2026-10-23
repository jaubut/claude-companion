// What is left of the live-run helpers: live mode (slice A) and the blocked-task
// takeover (slice B of docs/one-stream-plan.md) are gone. Companion never claims
// a row; blocked tasks go through the guarded unblock/requeue in lib/dispatch-tasks.ts.

/** The last GitHub PR URL in a worker's final output, if any. */
export function detectPrUrl(text: string): string | null {
  const all = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)
  return all ? all[all.length - 1]! : null
}
