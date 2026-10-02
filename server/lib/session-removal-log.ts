// Removal log for lib/sessions.ts: one line per dropped session and a count
// the discovery tick drains.

import { companionLog } from "./log"
import type { Session } from "./sessions"

// Every removal is logged (key, pid, reason) and counted, so a session that
// "vanished from the phone" can be traced to the decision that dropped it.
let removedSinceDrain = 0

export function logRemoval(s: Session, reason: string): void {
  removedSinceDrain++
  const dim = "\x1b[2m"; const reset = "\x1b[0m"
  companionLog(`${dim}session removed${reset} ${s.key} pid=${s.pid || "-"} reason=${reason}`)
}

// How many sessions were removed since the last call. The discovery tick logs
// this once, and only when nonzero.
export function drainRemovalCount(): number {
  const n = removedSinceDrain
  removedSinceDrain = 0
  return n
}
