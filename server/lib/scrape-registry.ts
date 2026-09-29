// Which tmux panes / ttys belong to the companion's own hidden `/help`
// enumeration sessions (lib/command-offpane.ts).
//
// Those sessions run a real `claude`. Four layers keep it invisible:
//
//   1. it is launched with `--settings {"disableAllHooks":true,…}`, so no hook
//      script runs at all (the companion's included), and with a throwaway
//      HOME, so it writes no sessions/<pid>.json or transcript that
//      ps-discovery / rehydrate could read (lib/command-offpane-home.ts);
//   2. it exports COMPANION_SCRAPE=1 and CLAUDE_CODE_SCRAPE_SESSION=1, and
//      hooks/_lib.sh exits before posting when either is set (for hooks that
//      run anyway, e.g. managed settings; needs the hooks re-installed);
//   3. this registry of its pane/tty: the hook router
//      (hook-common.scrapeHookPassthrough, first thing in routes/hooks.ts)
//      answers a bare passthrough for any /hooks/* from them, and ps-discovery
//      (discover.ts) skips a marked tty;
//   4. ps-discovery also skips a process whose ENVIRONMENT sets a scrape var
//      (`envHasScrapeVar`; read only for ttys owned by this user) — covers a
//      hidden claude from another companion server, or one whose tty mark has
//      lapsed. The command line is never consulted: a user's own
//      `claude -p "… COMPANION_SCRAPE=1 …"` is a real session.
//
// recordSession (sessions.ts) itself does not consult the registry: the
// checks sit at the call sites above. The module is dependency-free so any of
// them can import it.

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

// The pid of the companion server that created the session, from its name.
export function scrapeSessionOwner(name: string): number | null {
  if (!isScrapeSessionName(name)) return null
  const pid = Number(name.slice(SCRAPE_SESSION_PREFIX.length).split("-")[0])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

// A process environment (NAME=value entries) that sets a scrape var.
export function envHasScrapeVar(entries: Iterable<string>): boolean {
  for (const e of entries) {
    const eq = e.indexOf("=")
    if (eq <= 0) continue
    const name = e.slice(0, eq)
    if ((name === SCRAPE_ENV || name === SCRAPE_ENV_CLAUDE) && e.length > eq + 1) return true
  }
  return false
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
