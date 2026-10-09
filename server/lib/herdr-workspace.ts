import type { Session } from "./sessions"
import { closeHerdrWorkspaceWhenIdle, forgetHerdrAgent, herdrOwnerFor, herdrPaneOf, type HerdrOwner } from "./herdr"
import { companionLog } from "./log"

// Opt-in (COMPANION_HERDR_AUTOCLOSE=1 exactly; read per call so tests can
// toggle it). Off by default: herdr 0.9.3 has no atomic conditional close, so
// `workspace close` can still destroy a pane split open during the last
// foreground check (Codex reproduced this on PR #157). See docs/herdr-spawn.md.
export function herdrAutocloseEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.COMPANION_HERDR_AUTOCLOSE === "1"
}

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
  // Without the spawn record only the name is known; the close refuses an
  // owner with no workspace or terminal id (never on the label alone).
  const owner: HerdrOwner | undefined = herdrOwnerFor(pane) ?? (s.herdrAgent ? { name: s.herdrAgent } : undefined)
  if (!owner) return
  const occupied = () => live().some((o) => o.herdrPane === pane)
  // The session that took the pane over (a fork) releases it when it ends.
  if (occupied() || releasing.has(pane)) return
  if (!herdrAutocloseEnabled()) {
    // No close and no herdr calls; the record still goes, so it never leaks.
    forgetHerdrAgent(pane)
    companionLog(`\x1b[2mherdr workspace ${owner.workspaceId || pane} left open (COMPANION_HERDR_AUTOCLOSE off)\x1b[0m`)
    return
  }
  releasing.add(pane)
  void close(pane, { stillFree: () => !occupied(), owner })
    .catch(() => "")
    .then((ws) => {
      releasing.delete(pane)
      if (ws || !occupied()) forgetHerdrAgent(pane)
      if (ws) companionLog(`\x1b[35mherdr workspace closed\x1b[0m ${ws} (pane ${pane} back at its shell)`)
    })
}
