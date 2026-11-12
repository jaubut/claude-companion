// Per-session "waiting for input" API (PRJ-OR1T Phase 9), split from
// sessions.ts. State stays in sessions.ts; these functions only touch it at
// call time, so the sessions.ts <-> session-waiting.ts import cycle is safe.

import { type Session, emit, project, sessions } from "./sessions"
import { type WaitingKind, removeReason, upsertReason } from "./waiting"

export interface WaitingSession {
  key: string
  cwd: string
  kind: string
  ref: string
  since: number
}

// Add one reason and re-project. Returns the projected epoch ms on the record,
// or 0 if the key is unknown. Re-asserting the same (kind, ref) keeps its
// original stamp; a new ref on the same kind is a new reason.
export function setSessionWaiting(key: string, kind: WaitingKind, ref = ""): number {
  const s = sessions.get(key)
  if (!s) return 0
  s.waitingReasons = upsertReason(s.waitingReasons, kind, ref, Date.now())
  project(s)
  emit()
  return s.waitingSince
}

// Drop one reason (or every reason of a kind, or all of them) and re-project.
// Idempotent: clearing what isn't there is a no-op with no emit, because the
// phone can send an answer over both the WS and REST paths.
export function clearSessionWaiting(key: string, kind?: WaitingKind, ref?: string): boolean {
  const s = sessions.get(key)
  if (!s) return false
  const next = removeReason(s.waitingReasons, kind, ref)
  if (next.length === s.waitingReasons.length) return false
  s.waitingReasons = next
  project(s)
  emit()
  return true
}

// The collapse escape hatch. A request captures its sessionKey once at
// creation, and the identity collapse (weak sid:/cwd: → strong tty:) can make
// that key stale before the approval resolves; the dialog watcher's liveness
// sweep closes an already-deleted key the same way. An exact (kind, ref) match
// over a handful of live records, not a heuristic. Returns the session it
// cleared so the caller can announce that session's surviving state.
export function clearSessionWaitingByRef(kind: WaitingKind, ref: string): Session | null {
  for (const s of sessions.values()) {
    if (!s.waitingReasons.some((r) => r.kind === kind && r.ref === ref)) continue
    s.waitingReasons = removeReason(s.waitingReasons, kind, ref)
    project(s)
    emit()
    return s
  }
  return null
}

function waitingList(): WaitingSession[] {
  const out: WaitingSession[] = []
  for (const s of sessions.values()) {
    if (s.waitingSince) {
      out.push({ key: s.key, cwd: s.cwd, kind: s.waitingKind, ref: s.waitingRef, since: s.waitingSince })
    }
  }
  return out
}

// The three legacy scalars every shipped client still reads, derived from the
// most recent waiter, plus the full list for clients that can address a
// session. Replaces state.ts's host-wide singleton.
export function waitingSummary(): {
  waitingForInput: boolean
  waitingCwd: string
  waitingKey: string
  waitingSessions: WaitingSession[]
} {
  const waitingSessions = waitingList()
  const newest = waitingSessions.reduce<WaitingSession | null>(
    (a, b) => (a && a.since >= b.since ? a : b),
    null,
  )
  return {
    waitingForInput: waitingSessions.length > 0,
    waitingCwd: newest?.cwd ?? "",
    waitingKey: newest?.key ?? "",
    waitingSessions,
  }
}

// Clear on behalf of an inject. With a target, clear exactly that target. With
// none, clear the single waiter if there is exactly one — otherwise clear
// nothing and report how many were waiting, so the caller can log a refusal.
// Guessing here would blank the badge of a session that never got the text.
// An inject answers turn-end only: text typed into a terminal does not answer
// a pending approval or close a dialog, so those badges stay lit.
export function clearWaitingForTarget(
  target: Session | null,
  kind: WaitingKind = "turn-end",
): { cleared: Session | null; refused: number } {
  if (target) {
    return { cleared: clearSessionWaiting(target.key, kind) ? target : null, refused: 0 }
  }
  // Count over each session's RAW reason list, never the projected scalar: a
  // session holding turn-end AND approval projects as "approval" and would
  // drop out of the count, blanking a badge the inject did answer.
  const waiting: Session[] = []
  for (const s of sessions.values()) {
    if (s.waitingReasons.some((r) => r.kind === kind)) waiting.push(s)
  }
  const only = waiting.length === 1 ? waiting[0]! : null
  if (!only) return { cleared: null, refused: waiting.length }
  clearSessionWaiting(only.key, kind)
  return { cleared: only, refused: 0 }
}
