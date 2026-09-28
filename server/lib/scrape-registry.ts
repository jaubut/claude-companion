// Which tmux panes / ttys belong to the companion's own hidden `/help`
// enumeration sessions (lib/command-offpane.ts).
//
// Those sessions run a real `claude`, so every hook it fires looks exactly
// like a user session: SessionStart registers it in the picker, a Stop would
// push. Two layers keep it invisible:
//
//   1. the hidden session exports COMPANION_SCRAPE=1 and hooks/_lib.sh exits
//      before posting anything (needs the hooks re-installed);
//   2. this registry, checked by the hook router and by recordSession, so the
//      server drops them even with stale hook scripts, and ps-discovery never
//      lists them.
//
// Dependency-free on purpose: sessions.ts imports it.

// Pane ids (%N) are never reused within a tmux server's lifetime, so a pane
// can stay marked long after its session is killed — that is what catches a
// late SessionEnd hook.
const PANE_GRACE_MS = 10 * 60 * 1000
// A pty IS reused, quickly on macOS: the next Terminal window may get the same
// ttysNNN. Keep a released tty only long enough for the dying claude's last
// hook, never long enough to swallow a real session that inherits it.
const TTY_GRACE_MS = 5_000

const panes = new Map<string, number>() // pane → expiresAt (Infinity while live)
const ttys = new Map<string, number>()

export const SCRAPE_SESSION_PREFIX = "cc-scrape-"
export const SCRAPE_ENV = "COMPANION_SCRAPE"

export function isScrapeSessionName(name: string): boolean {
  return name.startsWith(SCRAPE_SESSION_PREFIX)
}

// "/dev/ttys007" and "ttys007" are the same terminal (hooks send the former,
// ps the latter).
function normTty(tty: string): string {
  return tty.replace(/^\/dev\//, "")
}

function live(map: Map<string, number>, k: string, now: number): boolean {
  const exp = map.get(k)
  if (exp === undefined) return false
  if (exp > now) return true
  map.delete(k)
  return false
}

export function markScrapeTarget(t: { pane?: string; tty?: string }): void {
  if (t.pane) panes.set(t.pane, Number.POSITIVE_INFINITY)
  if (t.tty) ttys.set(normTty(t.tty), Number.POSITIVE_INFINITY)
}

export function releaseScrapeTarget(t: { pane?: string; tty?: string }, now = Date.now()): void {
  if (t.pane) panes.set(t.pane, now + PANE_GRACE_MS)
  if (t.tty) ttys.set(normTty(t.tty), now + TTY_GRACE_MS)
}

// Does this hook / discovery record come from a hidden enumeration session?
export function isScrapeTarget(meta: { tmuxPane?: string; tty?: string }, now = Date.now()): boolean {
  if (meta.tmuxPane && live(panes, meta.tmuxPane, now)) return true
  if (meta.tty && live(ttys, normTty(meta.tty), now)) return true
  return false
}

// Tests only.
export function resetScrapeRegistry(): void {
  panes.clear()
  ttys.clear()
}
