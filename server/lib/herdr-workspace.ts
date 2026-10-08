import type { Session } from "./sessions"
import { closeHerdrWorkspaceWhenIdle, forgetHerdrAgent, herdrOwnerFor, herdrPaneOf, type HerdrOwner } from "./herdr"
import { companionLog } from "./log"

// A herdr session this server spawned is gone (SessionEnd, pid-dead prune):
// close its `cc-<dir>` workspace once the pane is back at its shell, and only
// while no other live session (a forked background claude inherits
// $HERDR_PANE_ID) sits in that pane.
//
// Ownership is the spawn record (herdr.ts herdrOwnerFor), looked up now: a
// SessionStart that beat the spawn reply left `herdrAgent` empty on the
// session. The close re-checks it against herdr (workspace id, label = agent
// name, terminal id), and the record is dropped once released, so a later
// workspace that reuses the pane id never inherits it.
const releasing = new Set<string>()

export function releaseHerdrWorkspace(s: Session, live: () => Session[], close = closeHerdrWorkspaceWhenIdle): void {
  const pane = herdrPaneOf(s)
  if (!pane) return
  const owner: HerdrOwner | undefined = herdrOwnerFor(pane) ?? (s.herdrAgent ? { name: s.herdrAgent } : undefined)
  if (!owner) return
  const occupied = () => live().some((o) => o.herdrPane === pane)
  // The session that took the pane over (a fork) releases it when it ends.
  if (occupied() || releasing.has(pane)) return
  releasing.add(pane)
  void close(pane, { stillFree: () => !occupied(), owner })
    .catch(() => "")
    .then((ws) => {
      releasing.delete(pane)
      if (ws || !occupied()) forgetHerdrAgent(pane)
      if (ws) companionLog(`\x1b[35mherdr workspace closed\x1b[0m ${ws} (pane ${pane} back at its shell)`)
    })
}
