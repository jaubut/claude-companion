import type { Session } from "./sessions"
import { closeHerdrWorkspaceWhenIdle, herdrPaneOf } from "./herdr"
import { companionLog } from "./log"

// A herdr session this server spawned is gone (SessionEnd, pid-dead prune):
// close its `cc-<dir>` workspace once the pane is back at its shell, and only
// while no other live session (a forked background claude inherits
// $HERDR_PANE_ID) sits in that pane.
export function releaseHerdrWorkspace(s: Session, live: () => Session[], close = closeHerdrWorkspaceWhenIdle): void {
  const pane = herdrPaneOf(s)
  if (!pane || !s.herdrAgent) return
  const free = () => !live().some((o) => o.herdrPane === pane)
  if (!free()) return
  void close(pane, { stillFree: free }).then((ws) => {
    if (ws) companionLog(`\x1b[35mherdr workspace closed\x1b[0m ${ws} (pane ${pane} back at its shell)`)
  })
}
