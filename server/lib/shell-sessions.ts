// Plain terminal sessions spawned from the phone: a login shell in a detached
// tmux session, no agent. Jeremie asked for Moshi-style terminals in the app
// (2026-10-25): open a shell on a host, type `claude` himself, see the
// `--resume` line after /exit.
//
// A shell has no hooks, so nothing tells lib/sessions.ts it exists. tmux is
// the record instead: the session carries the user option `@companion_shell`
// and every field the phone shows (pane, cwd, created) is read back from tmux.
// So a server restart loses nothing, `exit` in the shell ends the record by
// itself, and no store can drift from what is actually running.
//
// Always tmux, never herdr: the phone's terminal view attaches the pane with
// `tmux attach-session` under a PTY (lib/terminal-bridge.ts).
//
// Shells never enter the sessions Map: inject, triage, canvas status and the
// waiting rollup only ever see agents. They are appended to the session list
// on the wire (wireSessions), `agent: "shell"`, so the phone's drawer and
// rail, host stamping and liveness work unchanged. If Jeremie runs `claude`
// in one, its hooks register a normal Claude session on the same pane.

import { userInfo } from "node:os"
import { DETACHED_COLS, DETACHED_ROWS, uniqueTmuxSessionName } from "./spawn-session"
import { spawnNewSessionFlags, spawnServerFlags, spawnSocketPath, tmuxArgv } from "./tmux-pane"
import { type DetachedDeps, createConfirmed, realDetachedDeps } from "./tmux-spawn-confirm"

export const SHELL_OPTION = "@companion_shell"
export const SHELL_KEY_PREFIX = "shell:"

export interface ShellSession {
  key: string // "shell:<tmux session name>"
  name: string // tmux session name, e.g. "sh-claude-companion"
  cwd: string // the pane's current directory, live
  tmuxPane: string
  tmuxSocket: string // "" = the default tmux server
  createdAt: number // ms epoch
  panePid: number // the pane's process: the login shell
  // The Claude session running inside this shell, "" for none (linkClaude).
  claudeKey: string
}

// What the phone gets in the session list: the Session fields it decodes,
// agent "shell". `label` is what the row shows under the glyph.
export function shellWire(s: ShellSession): Record<string, unknown> {
  return {
    key: s.key,
    agent: "shell",
    label: s.name,
    title: "",
    cwd: s.cwd,
    sessionId: "",
    tty: "",
    tmuxPane: s.tmuxPane,
    tmuxSocket: s.tmuxSocket,
    panePid: s.panePid,
    claudeKey: s.claudeKey,
    firstSeenAt: s.createdAt,
    lastSeenAt: s.createdAt,
    agentStatus: "",
    waitingFor: "",
    model: "",
  }
}

// The login shell to start: $SHELL, else the account's shell (launchd and
// systemd units often run without $SHELL), else /bin/sh. Absolute paths only;
// it is an argv entry, never parsed by a shell.
export function loginShell(env: Record<string, string | undefined> = process.env, account = () => userInfo().shell): string {
  const candidates = [env.SHELL, (() => { try { return account() ?? "" } catch { return "" } })()]
  for (const c of candidates) {
    const s = (c ?? "").trim()
    if (/^\/[A-Za-z0-9_./-]+$/.test(s)) return s
  }
  return "/bin/sh"
}

// new-session for a shell: sized like an agent spawn, started in `cwd` by tmux
// (`-c`, no `cd` command line), the shell exec'd straight from argv.
export function shellNewSessionArgv(
  name: string,
  cwd: string,
  shell: string,
  serverEnv: Record<string, string | undefined> = process.env,
): string[] {
  return [
    ...tmuxArgv(), ...spawnNewSessionFlags(serverEnv),
    "new-session", "-d",
    "-x", String(DETACHED_COLS), "-y", String(DETACHED_ROWS),
    "-s", name, "-c", cwd,
    "--", shell, "-l",
  ]
}

export type SpawnShellResult =
  | { ok: true; session: ShellSession }
  | { ok: false; error: string }

// `cwd` must already be resolved (spawn-session.ts resolveSpawnCwd).
// `resume`: a Claude session id (recent-sessions.ts SESSION_ID_RE, checked by
// the caller) typed into the new shell as `claude --resume <id>` — typed, so
// the shell stays when claude exits, exactly as if Jeremie had typed it.
export async function spawnShellSession(cwd: string, deps: DetachedDeps = realDetachedDeps, resume?: string): Promise<SpawnShellResult> {
  if (!deps.which("tmux")) return { ok: false, error: "tmux_not_found: a terminal session needs tmux on this host" }
  const has = async (n: string) => (await deps.run([...tmuxArgv(), ...spawnServerFlags(), "has-session", "-t", `=${n}`])).code === 0
  const name = await uniqueTmuxSessionName(cwd, "shell", has)
  const error = await createConfirmed(name, shellNewSessionArgv(name, cwd, loginShell()), deps)
  if (error) return { ok: false, error }
  // `-t name`, not `=name`: tmux 3.6 refuses the exact-match prefix here.
  // An untagged shell would run untracked, so it is killed instead.
  const tmux = (...args: string[]) => deps.run([...tmuxArgv(), ...spawnServerFlags(), ...args])
  const tag = await tmux("set-option", "-t", name, SHELL_OPTION, "1")
  if (tag.code !== 0) {
    await tmux("kill-session", "-t", `=${name}`)
    return { ok: false, error: `tmux set-option: ${tag.stderr.trim() || tag.code}` }
  }
  const sessions = await readShellSessions(deps)
  const session = sessions.find((s) => s.name === name)
  if (!session) return { ok: false, error: "session_exited" }
  // Links stand until the next poll re-checks them.
  const linked = new Map(store.list().map((s) => [s.key, s.claudeKey]))
  store.replace(sessions.map((s) => ({ ...s, claudeKey: linked.get(s.key) ?? "" })))
  if (resume) {
    await tmux("send-keys", "-t", session.tmuxPane, "-l", `claude --resume ${resume}`)
    await tmux("send-keys", "-t", session.tmuxPane, "Enter")
  }
  return { ok: true, session }
}

// socket_path: the server's real socket, the same string a hook reports from
// $TMUX — so the phone can tell a Claude session running in this shell.
const LIST_FORMAT = ["#{session_name}", `#{${SHELL_OPTION}}`, "#{pane_id}", "#{pane_current_path}", "#{session_created}", "#{socket_path}", "#{pane_pid}"].join("\t")

// Every tagged shell on the spawn server. No server running → [].
export async function readShellSessions(deps: Pick<DetachedDeps, "run"> = realDetachedDeps): Promise<ShellSession[]> {
  const r = await deps.run([...tmuxArgv(), ...spawnServerFlags(), "list-sessions", "-F", LIST_FORMAT])
  if (r.code !== 0) return []
  return parseShellList(r.stdout, spawnSocketPath())
}

// `fallbackSocket` only when tmux printed no socket_path.
export function parseShellList(stdout: string, fallbackSocket: string): ShellSession[] {
  const out: ShellSession[] = []
  for (const line of stdout.split("\n")) {
    const [name, tag, pane, cwd, created, socketPath, panePid] = line.split("\t")
    const socket = socketPath?.startsWith("/") ? socketPath : fallbackSocket
    if (tag !== "1" || !name || !pane) continue
    out.push({
      key: `${SHELL_KEY_PREFIX}${name}`,
      name,
      cwd: cwd ?? "",
      tmuxPane: pane,
      tmuxSocket: socket,
      createdAt: Number(created) * 1000 || 0,
      panePid: Number(panePid) || 0,
      claudeKey: "",
    })
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

// ── The live list ────────────────────────────────────────────────────────

type Listener = (shells: ShellSession[]) => void

function sameList(a: ShellSession[], b: ShellSession[]): boolean {
  return a.length === b.length && a.every((s, i) => {
    const o = b[i]!
    return s.key === o.key && s.cwd === o.cwd && s.tmuxPane === o.tmuxPane && s.tmuxSocket === o.tmuxSocket
      && s.claudeKey === o.claudeKey
  })
}

export function createShellStore() {
  let shells: ShellSession[] = []
  const listeners = new Set<Listener>()
  return {
    list: (): ShellSession[] => shells,
    get: (key: string): ShellSession | undefined => shells.find((s) => s.key === key),
    // Emits only on a real change (a shell came, went, or cd'd).
    replace(next: ShellSession[]): boolean {
      if (sameList(shells, next)) return false
      shells = next
      for (const fn of listeners) {
        try { fn(shells) } catch { /* ignore */ }
      }
      return true
    },
    on(fn: Listener): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export const store = createShellStore()

export const listShellSessions = (): ShellSession[] => store.list()
export const getShellSession = (key: string): ShellSession | undefined => store.get(key)
export const onShellSessions = (fn: Listener): (() => void) => store.on(fn)

// The session list as every client reads it: agents first (lib/sessions.ts
// order), then shells. No shells → the agent list itself, unchanged.
export function wireSessions<T>(agents: T[]): (T | Record<string, unknown>)[] {
  const shells = store.list()
  return shells.length ? [...agents, ...shells.map(shellWire)] : agents
}

// ── Which Claude runs inside a shell ─────────────────────────────────────
//
// Moshi ties a session to its pane by process ancestry, not by a reported
// string, and so does this. Fast path: a Claude session on the same tmux
// server and pane as the shell. When that session's pid and the process
// table are both known, the pid must also descend from the shell's pane
// process (#{pane_pid}); a pane id reused after the shell died, or a stale
// hook record, then fails the check. No pid or no table → the pane match
// alone decides.

export type ProcTable = Map<number, number> // pid → ppid

export interface AgentRef { key: string; pid: string; tmuxPane: string; tmuxSocket?: string }

export function parseProcTable(stdout: string): ProcTable {
  const t: ProcTable = new Map()
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) t.set(Number(m[1]), Number(m[2]))
  }
  return t
}

export async function readProcTable(run: DetachedDeps["run"] = realDetachedDeps.run): Promise<ProcTable | null> {
  const r = await run(["ps", "-A", "-o", "pid=,ppid="], 2_000)
  return r.code === 0 ? parseProcTable(r.stdout) : null
}

// Is `pid` `ancestor` or one of its descendants? Bounded walk (pid 1 is the root).
export function descends(pid: number, ancestor: number, table: ProcTable): boolean {
  let p = pid
  for (let i = 0; i < 64 && p > 1; i++) {
    if (p === ancestor) return true
    const parent = table.get(p)
    if (parent === undefined || parent === p) return false
    p = parent
  }
  return false
}

export function linkClaude(shells: ShellSession[], agents: AgentRef[], table: ProcTable | null): ShellSession[] {
  return shells.map((s) => {
    const match = agents.find((a) => {
      if (a.tmuxPane !== s.tmuxPane || (a.tmuxSocket ?? "") !== s.tmuxSocket) return false
      const pid = Number(a.pid)
      if (!pid || !table || !s.panePid) return true
      return descends(pid, s.panePid, table)
    })
    return { ...s, claudeKey: match?.key ?? "" }
  })
}

// One tmux read every few seconds, so an `exit` (or a cd) reaches the phone,
// and a `claude` started in a shell gets linked to it. Skipped while tmux is
// missing; a host with no shells pays one cheap list-sessions per tick, and
// `ps` runs only when some agent sits in a shell's pane.
export const SHELL_POLL_MS = 3_000

export function startShellPoll(
  agents: () => AgentRef[],
  deps: DetachedDeps = realDetachedDeps,
  everyMs = SHELL_POLL_MS,
): () => void {
  if (!deps.which("tmux")) return () => undefined
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const shells = await readShellSessions(deps)
      const list = agents()
      const panes = new Set(shells.map((s) => `${s.tmuxSocket}|${s.tmuxPane}`))
      const inPane = list.some((a) => panes.has(`${a.tmuxSocket ?? ""}|${a.tmuxPane}`))
      store.replace(linkClaude(shells, list, inPane ? await readProcTable(deps.run) : null))
    } finally { busy = false }
  }
  void tick()
  const timer = setInterval(() => void tick(), everyMs)
  return () => clearInterval(timer)
}
