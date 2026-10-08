// Reading a tmux pane and recognising what Claude Code is showing in it.
// Used by the dialog watcher (mirror what's on screen) and the orchestrator
// wiring (don't type into a worker until its input box is up).

import { realpathSync } from "node:fs"
import { readdir, realpath } from "node:fs/promises"
import { join } from "node:path"

// ── Which tmux server ────────────────────────────────────────────────────
//
// A pane id (%N) is only unique WITHIN one tmux server. Sessions launched on
// the durable `tmux -L cc` socket (~/.local/bin/ccd) live on a different
// server than the default one, and after a resurrect their pane ids overlap
// the default server's. So a pane is addressed by (socket, pane) everywhere:
// every tmux call carries `-S <socket>` when the session's socket is known,
// and every map keyed by pane uses paneKey(). "" = the default server.

// $TMUX is "<socket path>,<server pid>,<session idx>". The socket is the
// first field; anything that is not an absolute path → "".
export function tmuxSocketFromEnv(tmuxEnv: string | null | undefined): string {
  const first = (tmuxEnv ?? "").split(",")[0]?.trim() ?? ""
  return first.startsWith("/") ? first : ""
}

// Global tmux flags selecting the server: [] for the default one.
export function tmuxSocketFlags(socket?: string | null): string[] {
  return socket ? ["-S", socket] : []
}

// The argv prefix for one tmux invocation against `socket`'s server.
export function tmuxArgv(socket?: string | null): string[] {
  return ["tmux", ...tmuxSocketFlags(socket)]
}

// ── Which server spawned sessions land on ────────────────────────────────
//
// COMPANION_TMUX_SOCKET names a `tmux -L <name>` server for every session the
// companion spawns (phone spawn + orchestrator workers). On the Linux host the
// default server lives in an ssh login scope, so a logout or reboot kills it;
// `-L cc` is owned by systemd user units and survives. COMPANION_TMUX_CONF is
// the config that server should start with (`-f`, new-session only). Unset →
// the default server, flag-for-flag the pre-socket behaviour.
type Env = Record<string, string | undefined>

const SOCKET_NAME = /^[A-Za-z0-9_.-]+$/

// The configured socket name, or "" for the default server. A name carrying a
// "/" or shell metacharacters is refused (default server) rather than handed
// to tmux or spliced into the AppleScript launch line.
export function spawnSocketName(env: Env = process.env): string {
  const name = (env.COMPANION_TMUX_SOCKET ?? "").trim()
  return SOCKET_NAME.test(name) ? name : ""
}

// Global flags selecting the spawn server: ["-L", name] or [].
export function spawnServerFlags(env: Env = process.env): string[] {
  const name = spawnSocketName(env)
  return name ? ["-L", name] : []
}

// Flags for the one call that may start the spawn server: the -L pair plus
// `-f <conf>` when COMPANION_TMUX_CONF is set. The conf is ignored without a
// socket name, so the default server never gets a config it didn't have.
export function spawnNewSessionFlags(env: Env = process.env): string[] {
  const flags = spawnServerFlags(env)
  const conf = (env.COMPANION_TMUX_CONF ?? "").trim()
  return flags.length && conf ? [...flags, "-f", conf] : flags
}

// The socket PATH of the spawn server — the same string discovery records from
// $TMUX (tmux realpaths $TMUX_TMPDIR/tmux-<uid>, hence /private/tmp on macOS) —
// so a spawned session and its task can be addressed with `-S`. "" when unset.
export function spawnSocketPath(env: Env = process.env, uid: number | undefined = process.getuid?.()): string {
  const name = spawnSocketName(env)
  if (!name || uid === undefined) return ""
  const dir = join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`)
  try {
    return join(realpathSync(dir), name)
  } catch {
    return join(dir, name)
  }
}

// Identity of a pane across servers: the bare id on the default server (so
// every existing key is unchanged), "<socket>|<pane>" on any other.
export function paneKey(pane: string, socket?: string | null): string {
  return socket ? `${socket}|${pane}` : pane
}

// The tmux address a session carries (Session, InjectTarget, …).
export interface PaneRef {
  pane: string
  socket: string
}

export function paneRefOf(t: { tmuxPane?: string; tmuxSocket?: string } | null | undefined): PaneRef | null {
  const pane = t?.tmuxPane?.trim() ?? ""
  return pane ? { pane, socket: t?.tmuxSocket ?? "" } : null
}

// `tmux [-S sock] <cmd> -t <session> …rest`: addressing a session we spawned by
// NAME (orchestrator kill / send-keys). Names are unique per server only, so
// the socket recorded at spawn time must ride along.
export function sessionCmdArgv(socket: string | null | undefined, cmd: string, session: string, ...rest: string[]): string[] {
  return [...tmuxArgv(socket), cmd, "-t", session, ...rest]
}

// `tmux [-S sock] send-keys -t <pane> …rest` minus the leading "tmux".
export function sendKeysArgs(ref: PaneRef, ...rest: string[]): string[] {
  return [...tmuxSocketFlags(ref.socket), "send-keys", "-t", ref.pane, ...rest]
}

// Every tmux server socket this user owns: $TMUX_TMPDIR (else /tmp)/tmux-<uid>/*.
// Paths are realpath'd so they compare equal to what $TMUX reports
// (/private/tmp/… on macOS).
export async function listTmuxSockets(
  env: Record<string, string | undefined> = process.env,
  uid: number | undefined = process.getuid?.(),
): Promise<string[]> {
  if (uid === undefined) return []
  const base = join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`)
  try {
    const dir = await realpath(base)
    return (await readdir(dir)).map((name) => join(dir, name))
  } catch {
    return []
  }
}

async function runBounded(argv: string[], timeoutMs = 1_000): Promise<string | null> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => { try { p.kill() } catch { /* gone */ } }, timeoutMs)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(timer)
    return code === 0 ? out : null
  } catch {
    return null
  }
}

// "#{pane_id} #{pane_tty}" lines → tty → pane.
export function parsePaneTtys(out: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of out.split("\n")) {
    const [pane, tty] = line.trim().split(" ")
    if (pane && tty && /^%\d+$/.test(pane)) m.set(tty, pane)
  }
  return m
}

// tty → (socket, pane) over every server this user runs. Used when a
// process's environment is unreadable, so its $TMUX cannot tell us.
export async function mapTtysToPanes(
  sockets?: string[],
  list: (socket: string) => Promise<string | null> = (s) => runBounded([...tmuxArgv(s), "list-panes", "-a", "-F", "#{pane_id} #{pane_tty}"]),
): Promise<Map<string, PaneRef>> {
  const out = new Map<string, PaneRef>()
  for (const socket of sockets ?? await listTmuxSockets()) {
    const raw = await list(socket)
    if (!raw) continue
    for (const [tty, pane] of parsePaneTtys(raw)) if (!out.has(tty)) out.set(tty, { pane, socket })
  }
  return out
}

// Resolve a tmux pane id from the pty it's hosting. Used when the hook
// stack didn't capture $TMUX_PANE at registration time (Linux server-spawn
// path: claude inherits $TMUX_PANE but the hook script may have raced the
// initial registration, leaving the session with a tty but no pane). tmux
// itself knows the mapping — ask it.
//
// One server only: the default one, or `socket`'s. resolveTmuxRefFromTty below
// asks every server and also says which one answered.
export async function resolveTmuxPaneFromTty(tty: string, socket?: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([...tmuxArgv(socket), "list-panes", "-a", "-F", "#{pane_id} #{pane_tty}"], {
      stdout: "pipe", stderr: "pipe",
    })
    const out = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if ((proc.exitCode ?? 1) !== 0) return null
    return parsePaneTtys(out).get(tty) ?? null
  } catch {
    return null
  }
}

// (socket, pane) hosting `tty`, over every tmux server this user runs — a
// session on `tmux -L cc` is invisible to a bare `tmux list-panes`. Falls back
// to the default server when no socket directory can be listed.
export async function resolveTmuxRefFromTty(
  tty: string,
  map: () => Promise<Map<string, PaneRef>> = () => mapTtysToPanes(),
): Promise<PaneRef | null> {
  const hit = (await map()).get(tty)
  if (hit) return hit
  const pane = await resolveTmuxPaneFromTty(tty)
  return pane ? { pane, socket: "" } : null
}


// ── Reading a pane ───────────────────────────────────────────────────────

// `signal` (optional) kills the capture: a stalled tmux must not hold up a
// caller that has a deadline (command-scrape's dirty-pane verification).
// `escapes` adds `-e`: SGR attributes are kept, so a parser can tell Claude
// Code's dim predicted reply from text the user typed (lib/command-menu.ts).
export async function capturePane(
  sessionName: string,
  signal?: AbortSignal,
  opts: { escapes?: boolean; socket?: string } = {},
): Promise<string | null> {
  try {
    const args = [...tmuxArgv(opts.socket), "capture-pane", "-t", sessionName, "-p", ...(opts.escapes ? ["-e"] : [])]
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" })
    const kill = () => { try { p.kill() } catch { /* already gone */ } }
    if (signal?.aborted) kill()
    signal?.addEventListener("abort", kill, { once: true })
    try {
      const out = await new Response(p.stdout).text()
      return (await p.exited) === 0 && !signal?.aborted ? out : null
    } finally {
      signal?.removeEventListener("abort", kill)
    }
  } catch {
    return null
  }
}

// A freshly-spawned Claude renders its boot screen (welcome box + the input
// frame + the auto-mode/shortcuts footer) only once the TUI is ready to accept
// keystrokes. ps-discovery surfaces the process seconds earlier, and keys sent
// before the box is up are silently dropped. Gate on these markers.
export function paneInputReady(pane: string): boolean {
  return /Welcome back|auto mode|for shortcuts|to interrupt/.test(pane)
}

// Onboarding dialogs (new-MCP-server enable, folder-trust) overlay the input box
// AFTER the welcome/footer renders — so paneInputReady alone is fooled and the
// prompt lands on the dialog. Detect them and Escape to dismiss before sending.
export function paneHasDialog(pane: string): boolean {
  return /new MCP servers found|wish to enable|Do you trust|Select any you wish|enable this MCP/i.test(pane)
}

// Which tmux session owns this pane? The worker-identity resolver's tier 2:
// a hook carries $TMUX_PANE (%N), the orchestrator knows the session name it
// spawned (cc-<project>), and this is the only bridge between them.
//
// Called only when a cwd holds two or more candidate tasks, so the common
// single-worker path never pays for a subprocess. Null on anything unexpected
// — a malformed pane id, a dead pane, a slow tmux — and the caller refuses to
// guess rather than treating the failure as a match.
const PANE_ID = /^%\d+$/

export async function tmuxSessionForPane(pane: string, socket?: string): Promise<string | null> {
  if (!PANE_ID.test(pane)) return null
  try {
    const p = Bun.spawn([...tmuxArgv(socket), "display-message", "-p", "-t", pane, "#S"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      p.kill()
    }, 1_000)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(timer)
    if (timedOut || code !== 0) return null
    return out.trim() || null
  } catch {
    return null
  }
}

// Does anyone have this pane's tmux session open in a terminal right now?
// `#{session_attached}` counts attached clients. Null when tmux can't say
// (bad id, dead pane, slow tmux) — callers treat that as "unknown".
export async function tmuxPaneAttached(pane: string, socket?: string): Promise<boolean | null> {
  if (!PANE_ID.test(pane)) return null
  try {
    const p = Bun.spawn([...tmuxArgv(socket), "display-message", "-p", "-t", pane, "#{session_attached}"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      p.kill()
    }, 1_000)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(timer)
    if (timedOut || code !== 0) return null
    const n = Number(out.trim())
    return Number.isFinite(n) ? n > 0 : null
  } catch {
    return null
  }
}

// ── Pane width ───────────────────────────────────────────────────────────
//
// Live 2026-10-08 (pane %204): a tiny tmux client attached with
// `window-size latest` squeezed the window to 11 columns. The /compact keep
// text wrapped to ~50 rows, the read-back mismatched, and one Ctrl-U (which
// clears ONE wrapped row) left the rest in the box — every phone inject after
// that was refused input_not_empty for ~10h. Below this width the input box
// cannot be read back reliably, so nothing is typed into it.
export const MIN_INJECT_PANE_WIDTH = 40

export function paneTooNarrow(width: number | null | undefined): boolean {
  return typeof width === "number" && width < MIN_INJECT_PANE_WIDTH
}

// `#{pane_width}` in columns. Null when tmux can't say (bad id, dead pane,
// slow tmux) — callers treat that as unknown, not as narrow.
export async function tmuxPaneWidth(ref: PaneRef, signal?: AbortSignal): Promise<number | null> {
  if (!PANE_ID.test(ref.pane)) return null
  try {
    const p = Bun.spawn([...tmuxArgv(ref.socket), "display-message", "-p", "-t", ref.pane, "#{pane_width}"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const kill = () => { try { p.kill() } catch { /* gone */ } }
    const timer = setTimeout(kill, 1_000)
    if (signal?.aborted) kill()
    signal?.addEventListener("abort", kill, { once: true })
    try {
      const out = await new Response(p.stdout).text()
      const code = await p.exited
      if (code !== 0 || signal?.aborted) return null
      const n = Number(out.trim())
      return Number.isInteger(n) && n > 0 ? n : null
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", kill)
    }
  } catch {
    return null
  }
}
