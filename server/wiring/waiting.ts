import { broadcast } from "../state"
import {
  type Session,
  clearSessionWaiting,
  clearSessionWaitingByRef,
  getSessionByKey,
  setSessionWaiting,
} from "../lib/sessions"
import type { WaitingKind } from "../lib/waiting"

// The ONLY writer of the `waiting_input` frame (PRJ-OR1T Phase 11). Every
// mutation announces, so a call site cannot change the state without telling
// the phone, and the frame always carries the DERIVED state after the mutation:
// a clear that leaves another reason standing broadcasts `waiting: true` with
// the surviving kind. Four hand-built frames could not honour that rule.
//
// It never pushes: APNs stays owned by the Stop path in routes/hooks.ts and by
// wiring/events.ts's approval/question pushes.

// `lastMessage` is intentionally NOT on this frame — the full assistant text
// already streamed via assistant_text events during the turn (and via the Stop
// hook's recordTurnEnd transcript delta read). Including a truncated tail used
// to produce a duplicate, chopped copy in the iOS feed beside the full reply.
function announce(session: Session): void {
  if (session.waitingSince > 0) {
    broadcast({
      type: "waiting_input",
      waiting: true,
      key: session.key,
      cwd: session.cwd,
      kind: session.waitingKind,
      ref: session.waitingRef,
      since: session.waitingSince,
    })
    return
  }
  broadcast({ type: "waiting_input", waiting: false, key: session.key, cwd: session.cwd })
}

// Announce a session's current derived state. Null is a no-op: the inject paths
// pass whatever clearWaitingForTarget cleared, which is null when it refused.
export function announceWaiting(session: Session | null): void {
  if (!session) return
  announce(session)
}

// A Stop hook with no cwd registers no session, so there is nothing to key the
// frame to — the legacy keyless "somebody is waiting" frame every shipped
// client still understands.
export function announceKeylessWaiting(): void {
  broadcast({
    type: "waiting_input",
    waiting: true,
    cwd: "",
    key: "",
    since: Date.now(),
    kind: "turn-end",
  })
}

export function markWaiting(key: string, kind: WaitingKind, ref = ""): void {
  setSessionWaiting(key, kind, ref)
  announceWaiting(getSessionByKey(key))
}

export function unmarkWaiting(key: string, kind: WaitingKind, ref?: string): void {
  if (clearSessionWaiting(key, kind, ref)) {
    announceWaiting(getSessionByKey(key))
    return
  }
  // The key missed. A request captures its sessionKey once at creation and the
  // identity collapse can stale it before the approval resolves; the dialog
  // watcher's liveness sweep closes an already-deleted key the same way. Fall
  // back to an exact (kind, ref) scan over the live records.
  if (ref === undefined) return
  announceWaiting(clearSessionWaitingByRef(kind, ref))
}
