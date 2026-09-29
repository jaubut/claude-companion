// Which tmux panes / ttys belong to the companion's own hidden `/help`
// enumeration sessions (lib/command-offpane.ts).
//
// Those sessions run a real `claude`. Three layers keep it invisible:
//
//   1. it is launched with `--settings {"disableAllHooks":true}`, so no hook
//      script runs at all (the companion's included);
//   2. it exports COMPANION_SCRAPE=1 and CLAUDE_CODE_SCRAPE_SESSION=1, and
//      hooks/_lib.sh exits before posting when either is set (for hooks that
//      run anyway, e.g. managed settings; needs the hooks re-installed);
//   3. this registry, checked BEFORE every recordSession call site that could
//      see the hidden claude: the hook router (hook-common.scrapeHookPassthrough,
//      first thing in routes/hooks.ts) answers a bare passthrough for any
//      /hooks/* from its pane/tty, and ps-discovery (discover.ts) skips its
//      tty. (rehydrate.ts registers from transcripts — the hidden session
//      writes none, and command-offpane deletes one by --session-id if it did.)
//      recordSession itself does not consult the registry.
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
export const SCRAPE_ENV_CLAUDE = "CLAUDE_CODE_SCRAPE_SESSION"

// `cc-scrape-<pid>-<seq>-<rand>`. Matched exactly, never by prefix alone: a
// user's own spawn is `cc-<basename>`, and a project folder named
// `scrape-something` must never be reaped.
const SCRAPE_NAME_RE = /^cc-scrape-\d+-\d+-[a-z0-9]{4,}$/

let nameSeq = 0
export function scrapeSessionName(): string {
  return `${SCRAPE_SESSION_PREFIX}${process.pid}-${++nameSeq}-${Math.random().toString(36).slice(2, 8).padEnd(4, "0")}`
}

export function isScrapeSessionName(name: string): boolean {
  return SCRAPE_NAME_RE.test(name)
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
