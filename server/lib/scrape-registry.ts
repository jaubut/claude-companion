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
// late SessionEnd hook. A NEW server hands out %0, %1… again, so each pane
// mark carries the pid of the server that numbered it and only counts while
// that server is the current one (noteTmuxServer).
const PANE_GRACE_MS = 10 * 60 * 1000
// A pty IS reused, quickly on macOS: the next Terminal window may get the same
// ttysNNN. Keep a released tty only long enough for the dying claude's last
// hook, never long enough to swallow a real session that inherits it.
const TTY_GRACE_MS = 5_000

// pane → expiresAt (Infinity while live) + its tmux server's pid (null: unknown)
const panes = new Map<string, { exp: number; serverPid: number | null }>()
const ttys = new Map<string, number>()
// Pid of the current tmux server as last seen by lib/command-offpane.ts
// (null: none running; undefined: never seen).
let tmuxServer: number | null | undefined = undefined

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

interface ScrapeTarget { pane?: string; tty?: string; serverPid?: number | null }

// Is a mark numbered by `serverPid` about the current server's panes?
function currentServer(serverPid: number | null): boolean {
  return serverPid === null || tmuxServer === undefined || serverPid === tmuxServer
}

export function markScrapeTarget(t: ScrapeTarget): void {
  const serverPid = t.serverPid ?? null
  if (t.pane) {
    // A late mark for a stale server never overwrites the current server's
    // mark on the same (reused) id.
    const cur = panes.get(t.pane)
    const clobbers = cur && cur.serverPid !== serverPid && currentServer(cur.serverPid) && !currentServer(serverPid)
    if (!clobbers) panes.set(t.pane, { exp: Number.POSITIVE_INFINITY, serverPid })
  }
  if (t.tty) ttys.set(normTty(t.tty), Number.POSITIVE_INFINITY)
}

// A pane of a server that is already gone is unmarked, never given a grace:
// the next server may hand its id to an unrelated session.
export function releaseScrapeTarget(t: ScrapeTarget, now = Date.now()): void {
  const serverPid = t.serverPid ?? null
  if (t.pane) {
    const cur = panes.get(t.pane)
    if (currentServer(serverPid)) {
      // Only our own mark gets the grace — never another server's on this id.
      if (!cur || cur.serverPid === serverPid || cur.serverPid === null) panes.set(t.pane, { exp: now + PANE_GRACE_MS, serverPid })
    } else if (cur && (cur.serverPid === serverPid || serverPid === null)) {
      panes.delete(t.pane)
    }
  }
  if (t.tty) ttys.set(normTty(t.tty), now + TTY_GRACE_MS)
}

// Does this hook / discovery record come from a hidden enumeration session?
// `tmuxServerPid` is the hook's OWN server (from its $TMUX, see
// tmuxServerPidOf): when both it and the mark's server are known they must
// match — that holds even after a tmux restart no reap has noticed yet.
export function isScrapeTarget(meta: { tmuxPane?: string; tty?: string; tmuxServerPid?: number | null }, now = Date.now()): boolean {
  if (meta.tmuxPane) {
    const m = panes.get(meta.tmuxPane)
    if (m && m.exp <= now) panes.delete(meta.tmuxPane)
    else if (m) {
      const hookServer = meta.tmuxServerPid ?? null
      const sameServer = hookServer !== null && m.serverPid !== null ? hookServer === m.serverPid : currentServer(m.serverPid)
      if (sameServer) return true
    }
  }
  if (meta.tty && live(ttys, normTty(meta.tty), now)) return true
  return false
}

// The current tmux server's pid (null: none running). When it changes, the
// old server's pane ids will be handed out again, so no mark of another
// server (nor of an unknown one) may survive. Tty marks keep their own short
// grace.
export function noteTmuxServer(pid: number | null): void {
  if (tmuxServer !== undefined && pid !== tmuxServer) {
    for (const [pane, m] of panes) if (m.serverPid !== pid) panes.delete(pane)
  }
  tmuxServer = pid
}

// $TMUX is "<socket>,<server pid>,<session idx>"; anything else → null.
export function tmuxServerPidOf(tmuxEnv: string | null | undefined): number | null {
  const pid = Number((tmuxEnv ?? "").split(",")[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

// Tests only.
export function resetScrapeRegistry(): void {
  panes.clear()
  ttys.clear()
  tmuxServer = undefined
}
