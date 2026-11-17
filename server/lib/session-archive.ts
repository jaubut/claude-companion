// Keeps the drawer clean: idle sessions with no activity for a day and "done" ones (a worker card whose task
// finished, an ended row) after an hour leave the live list. Archived = out of the list until real activity
// brings the session back (sessions.ts archiveSession). Runs at boot and every minute; the first passes after
// boot discovery are the one-time prune of whatever a deploy finds stale.

import { type EndedStore, endedStore } from "./ended-sessions"
import { type Session, archiveSession, listSessions } from "./sessions"

const HOUR_MS = 60 * 60 * 1000
const WORKER_PANE = "headless:worker:"
const SWEEP_EVERY_MS = 60_000

export interface ArchivePolicy { idleMs: number; doneMs: number }

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** COMPANION_ARCHIVE_IDLE_HOURS (24) and COMPANION_ARCHIVE_DONE_MINUTES (60). */
export function archivePolicyFromEnv(): ArchivePolicy {
  return {
    idleMs: envNumber("COMPANION_ARCHIVE_IDLE_HOURS", 24) * HOUR_MS,
    doneMs: envNumber("COMPANION_ARCHIVE_DONE_MINUTES", 60) * 60_000,
  }
}

/** When a worker card's task finished, or null while it runs (or for a non-worker row). */
export type WorkerDoneAt = (taskId: string) => number | null

/** Why `s` should leave the drawer now, or null to keep it. */
export function archiveReason(s: Session, now: number, policy: ArchivePolicy, workerDoneAt: WorkerDoneAt): string | null {
  const worker = s.herdrPane?.startsWith(WORKER_PANE) ?? false
  // brain, Brain · Boost, repo leads: orchestrator-owned and pinned
  if (s.taskId && !worker) return null
  if (worker) {
    const doneAt = workerDoneAt(s.taskId || s.herdrPane!.slice(WORKER_PANE.length))
    return doneAt !== null && now - doneAt >= policy.doneMs ? "done" : null
  }
  if (s.agentStatus === "busy" || s.waitingSince > 0) return null
  // never one Jeremie started in the last 24 h
  if (now - s.firstSeenAt < 24 * HOUR_MS) return null
  return now - (s.lastActiveAt ?? s.lastSeenAt) >= policy.idleMs ? "idle" : null
}

/** One pass. Returns how many sessions and ended rows left the drawer. */
export function archiveStaleSessions(
  workerDoneAt: WorkerDoneAt,
  policy: ArchivePolicy = archivePolicyFromEnv(),
  now = Date.now(),
  ended: EndedStore = endedStore,
): number {
  let n = 0
  for (const s of listSessions()) {
    const reason = archiveReason(s, now, policy, workerDoneAt)
    if (reason && archiveSession(s.key, reason)) n++
  }
  for (const e of ended.list()) {
    if (now - e.endedAt >= policy.doneMs) { ended.drop(e.key); n++ }
  }
  return n
}

/** Boot: one pass now (the deploy prune), then every minute. */
export function startSessionArchive(workerDoneAt: WorkerDoneAt): void {
  archiveStaleSessions(workerDoneAt)
  setInterval(() => archiveStaleSessions(workerDoneAt), SWEEP_EVERY_MS).unref()
}
