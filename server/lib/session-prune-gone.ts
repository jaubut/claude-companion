// Drops live sessions whose cwd and process are both gone, and every headless
// worker row whose task is no longer running: a finished worker leaves the
// drawer even while its worktree stays. sessions.ts's own prune skips them
// because a headless row's pid is the server's. Runs at boot (rehydrate
// re-records finished workers) and on a short interval.

import { existsSync } from "node:fs"
import { isAgentPidAlive } from "./agent-pid"
import { listSessions, removeSessionByKey } from "./sessions"

const WORKER_PANE = "headless:worker:"
const PRUNE_EVERY_MS = 5_000

/** Removes each gone session (removeSessionByKey logs and pushes to clients). Returns how many. */
export function pruneGoneSessions(isTaskRunning: (taskId: string) => boolean): number {
  let removed = 0
  for (const s of listSessions()) {
    const pane = s.herdrPane ?? ""
    const worker = pane.startsWith(WORKER_PANE)
    if (!worker && (!s.cwd || existsSync(s.cwd))) continue
    // brain and agy headless rows are kept alive by their own feeds
    if (pane.startsWith("headless:") && !worker) continue
    if (s.taskId && isTaskRunning(s.taskId)) continue
    if (isAgentPidAlive(s.pid, s.agent)) continue
    if (removeSessionByKey(s.key)) removed++
  }
  return removed
}

/** One pass now, then every few seconds. */
export function startGoneSessionPrune(isTaskRunning: (taskId: string) => boolean): void {
  pruneGoneSessions(isTaskRunning)
  setInterval(() => pruneGoneSessions(isTaskRunning), PRUNE_EVERY_MS).unref()
}
