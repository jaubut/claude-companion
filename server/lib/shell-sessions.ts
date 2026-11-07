// Plain terminal sessions spawned from the phone: a login shell in a herdr
// workspace, no agent. Jeremie asked for Moshi-style terminals in the app
// (2026-10-25): open a shell on a host, type `claude` himself, see the
// `--resume` line after /exit.
//
// A shell has no hooks, so nothing tells lib/sessions.ts it exists. herdr is
// the record instead: a pane carrying SHELL_PANE_MARK is a shell, and every
// field the phone shows (pane, cwd) is read back from herdr. So a server
// restart loses nothing, `exit` in the shell ends the record by itself, and no
// store can drift from what is actually running. A herdr restore brings the
// pane back with its mark and a new shell, which is the same row. A split or a
// new tab carries no mark, so a human's pane is never a row, whatever is left.
//
// Herdr-only (docs/herdr-only-migration.md, Stage 2): new shells are herdr
// panes, and the phone's terminal view attaches them with `herdr terminal
// attach` under a PTY (lib/terminal-bridge.ts). A `claude` typed in one runs
// with $HERDR_PANE_ID, so it is an ordinary mirrored herdr session. tmux
// shells from before (tagged `@companion_shell`, Stage 5 deletes this) stay
// listed and attachable, never created.
//
// Shells never enter the sessions Map: inject, triage, canvas status and the
// waiting rollup only ever see agents. They are appended to the session list
// on the wire (wireSessions), `agent: "shell"`, so the phone's drawer and
// rail, host stamping and liveness work unchanged. If Jeremie runs `claude`
// in one, its hooks register a normal Claude session on the same pane.

import { endedStore, endedWire } from "./ended-sessions"
import { type Herdr, SHELL_PANE_MARK, herdrErrorCode, herdrPaneOf, herdrPaneShellPid, realHerdr } from "./herdr"
import { uniqueTmuxSessionName } from "./spawn-session"
import { spawnServerFlags, spawnSocketPath, tmuxArgv } from "./tmux-pane"
import { type DetachedDeps, realDetachedDeps } from "./tmux-spawn-confirm"

export const SHELL_OPTION = "@companion_shell"
export const SHELL_KEY_PREFIX = "shell:"

export interface ShellDeps extends DetachedDeps { h: Herdr }
export const realShellDeps: ShellDeps = { ...realDetachedDeps, h: realHerdr }

export interface ShellSession {
  key: string // "shell:<name>"
  name: string // workspace label (tmux: session name), e.g. "sh-claude-companion"
  cwd: string // the pane's current directory, live
  herdrPane: string // "" = a tmux shell from before Stage 2
  terminalId: string // what `herdr terminal attach` takes
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
    herdrPane: s.herdrPane,
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

// `session` on a failure: the shell exists and works, only what was asked of it
// failed (a resume herdr refused).
export type SpawnShellResult =
  | { ok: true; session: ShellSession }
  | { ok: false; error: string; session?: ShellSession }

// Spawns and closes take turns: a name comes from a read of what exists, so a
// double tap must see the first shell (herdr allows two workspaces with one
// label), and a Close must not race a spawn onto its name or a second Close.
let turn: Promise<unknown> = Promise.resolve()
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const next = turn.then(fn)
  turn = next.catch(() => undefined)
  return next
}

// `cwd` must already be resolved (spawn-session.ts resolveSpawnCwd).
// `resume`: a Claude session id (recent-sessions.ts SESSION_ID_RE, checked by
// the caller) typed into the new shell as `claude --resume <id>` — typed, so
// the shell stays when claude exits, exactly as if Jeremie had typed it.
export function spawnShellSession(cwd: string, deps: ShellDeps = realShellDeps, resume?: string): Promise<SpawnShellResult> {
  return inTurn(() => spawnShell(cwd, deps, resume))
}

async function spawnShell(cwd: string, deps: ShellDeps, resume?: string): Promise<SpawnShellResult> {
  const gate = await deps.h.gate()
  if (gate) return { ok: false, error: `herdr_unavailable: ${gate}` }
  // The name must come from herdr, not the store: a stale read would reuse a
  // live label. Every label, shell or not: no two workspaces share one. A closed
  // name too: Close takes only a name, so a retry can't be told from a new close.
  const labels = await herdrLabels(deps.h)
  if (!labels) return { ok: false, error: "herdr_unavailable: workspace list failed" }
  const taken = new Set([...labels, ...closedShells.map((c) => c.name), ...(await readTmuxShells(deps)).map((s) => s.name)])
  const name = await uniqueTmuxSessionName(cwd, "shell", async (n) => taken.has(n))
  let pane = ""
  let terminal = ""
  try {
    const r = await deps.h.call(["workspace", "create", "--cwd", cwd, "--label", name, "--no-focus"])
    const root = r.root_pane as { pane_id?: string; terminal_id?: string } | undefined
    pane = root?.pane_id ?? ""
    terminal = root?.terminal_id ?? ""
  } catch (err) {
    return { ok: false, error: `herdr workspace create: ${(err as Error).message}` }
  }
  // A failed spawn closes nothing, whatever it leaves: a marked pane is a row
  // that `exit` ends, and closeShellPane refuses an unmarked one anyway.
  if (!pane || !terminal) return { ok: false, error: "herdr workspace create: no root_pane" }
  try {
    await deps.h.call(["pane", "rename", pane, SHELL_PANE_MARK])
  } catch (err) {
    return { ok: false, error: herdrErrorCode(err) === "pane_not_found" ? "session_exited" : `herdr pane rename: ${(err as Error).message}` }
  }
  // Never the cached rows, and by terminal: a pane id can be reissued.
  const shells = await readHerdrShells(deps.h)
  const session = shells?.find((s) => s.terminalId === terminal)
  if (!shells || !session) return { ok: false, error: "session_exited" }
  replaceKeepingLinks(mergeShells(await readTmuxShells(deps), shells))
  if (resume) {
    try {
      await deps.h.call(["pane", "run", pane, `claude --resume ${resume}`])
    } catch (err) {
      return { ok: false, error: `The terminal is open, but claude --resume didn't start: ${(err as Error).message}`, session }
    }
  }
  return { ok: true, session }
}

async function herdrLabels(h: Herdr, ms = 3_000): Promise<string[] | null> {
  try {
    const { workspaces } = await h.call(["workspace", "list"], ms)
    return Array.isArray(workspaces) ? (workspaces as Array<{ label?: string }>).map((w) => w.label ?? "") : null
  } catch {
    return null
  }
}

// Bumped by every store write but the poll's, so a poll that read before a
// spawn or a close can't write back what it read: a closed row, or a list
// missing the new shell.
let storeGen = 0

// A fresh read into the store. Links stand until the next poll re-checks them.
export function replaceKeepingLinks(sessions: ShellSession[]): void {
  storeGen++
  const linked = new Map(store.list().map((s) => [s.key, s.claudeKey]))
  store.replace(sessions.map((s) => ({ ...s, claudeKey: linked.get(s.key) ?? "" })))
}

export type CloseShellResult =
  | { ok: true; gone: boolean }
  | { ok: false; error: "unknown_shell" | "claude_running" | "kill_failed" | "herdr_unreadable" | "name_ambiguous" | "terminal_changed" | "name_reused" }

type CloseError = Extract<CloseShellResult, { ok: false }>["error"]

// What POST /api/shell/close answers for a refusal. The phone shows `error`
// (inside "Couldn't close the terminal (…)"), and has its own sentences for
// unknown_shell and claude_running.
const CLOSE_SENTENCES: Partial<Record<CloseError, string>> = {
  herdr_unreadable: "herdr didn't answer, nothing was closed. Try again",
  name_ambiguous: "Two terminals share this name, nothing was closed. Type exit in the one to close",
  terminal_changed: "This terminal restarted, nothing was closed. Close it again",
  name_reused: "This name was closed a moment ago and another terminal has it now. Type exit in it to close it",
  kill_failed: "The terminal didn't close. Try again",
}

export function closeRefusal(code: CloseError): Record<string, unknown> {
  const sentence = CLOSE_SENTENCES[code]
  return sentence ? { ok: false, error: sentence, code } : { ok: false, error: code }
}

// Every shell closed (or tried) here, either backend, by name and terminal
// ("" for tmux), recorded before anything is read again: a retry answers
// gone:true, never reaches another shell under the name, tmux or herdr, and
// spawn never reuses it.
// ponytail: in memory, last 50; a Companion restart forgets them.
const closedShells: Array<{ name: string; terminalId: string }> = []
const recordClose = (name: string, terminalId: string) => {
  closedShells.push({ name, terminalId })
  if (closedShells.length > 50) closedShells.shift()
}

// Close a row of the shell list (POST /api/shell/close). Only a name in the
// list can be closed, and the list holds only shells: a Claude session's pane,
// a dispatch-* worker, the brain or a human's workspace are never in it. A
// shell with a Claude running inside (linked, or on its pane right now) is
// refused. Two terminals under one name are refused, never guessed between.
export function closeShellSession(
  name: string,
  agents: AgentRef[],
  detach: (key: string) => void,
  deps: Pick<ShellDeps, "run" | "which" | "h"> = realShellDeps,
): Promise<CloseShellResult> {
  // The row as the phone saw it, taken before the turn: a Close queued behind
  // another one must not adopt the terminal that one wrote to the store.
  const seen = store.list().find((s) => s.name === name)
  return inTurn(() => closeShell(name, seen, agents, detach, deps))
}

// Worst case about 8 s, under the phone's 10 s timeout: the fresh read 4 s
// (tmux 1.5 s beside herdr's lists 2 s, then pid reads 2 s), the last read
// 1.5 s, the close 2.5 s.
async function closeShell(
  name: string,
  shell: ShellSession | undefined,
  agents: AgentRef[],
  detach: (key: string) => void,
  deps: Pick<ShellDeps, "run" | "which" | "h">,
): Promise<CloseShellResult> {
  const tomb = closedShells.findLast((c) => c.name === name)
  if (!shell) return tomb ? { ok: true, gone: true } : { ok: false, error: "unknown_shell" }
  // The one check across backends: a close under this name was of another
  // shell (a tmux one has no terminal).
  if (tomb && tomb.terminalId !== shell.terminalId) return { ok: false, error: "name_reused" }
  if (shell.claudeKey || agents.some((a) => inShellPane(a, shell))) return { ok: false, error: "claude_running" }
  if (!shell.herdrPane) return closeTmuxShell(shell, detach, deps)
  // The store can be 3 s old: only a fresh read says which terminal holds the name.
  const [tmux, herdr] = await Promise.all([readTmuxShells(deps), readHerdrShells(deps.h, store.list(), 2_000)])
  if (!herdr) return { ok: false, error: "herdr_unreadable" }
  replaceKeepingLinks(mergeShells(tmux, herdr))
  if (tmux.some((s) => s.name === name)) return { ok: false, error: "name_ambiguous" }
  // None: it exited, or a second marked pane shares the label (no row then).
  const fresh = herdr.find((s) => s.name === name)
  if (!fresh) return tomb ? { ok: true, gone: true } : { ok: false, error: "unknown_shell" }
  // A restore gives the same pane a new terminal. The store has it now, so a
  // new Close reaches it (never one already queued); after a close of this
  // name it is someone else.
  if (fresh.terminalId !== shell.terminalId) return { ok: false, error: tomb ? "name_reused" : "terminal_changed" }
  const verdict = await closeShellPane(fresh, deps.h)
  if (verdict === "agent") return { ok: false, error: "claude_running" }
  if (verdict === "unreadable") return { ok: false, error: "herdr_unreadable" }
  if (verdict === "refused") return { ok: false, error: "terminal_changed" }
  // Closed, gone by itself, or a close herdr didn't confirm: either way only
  // this terminal may be closed under the name from now on, and a retry
  // answers gone:true.
  recordClose(name, fresh.terminalId)
  if (verdict === "failed") return { ok: false, error: "kill_failed" }
  replaceKeepingLinks(store.list().filter((s) => s.terminalId !== fresh.terminalId))
  // After the close, so a refusal never ends an open terminal; the attach ends
  // with the pane either way.
  detach(shell.key)
  return { ok: true, gone: verdict === "gone" }
}

// The only herdr close in this module, and the only way anything here closes
// a shell. One read right before it: the pane must carry the mark, hold this
// terminal (a restore reissues pane ids) and have no agent on it (herdr sees a
// Claude no hook reported, a suspended one too). Anything else, or no answer,
// closes nothing. `pane close`, not `workspace close`: a split stays, and the
// last pane takes its workspace with it.
// ponytail: herdr has no conditional close, so an agent starting in the one
// round trip between the read and the close still loses its pane.
async function closeShellPane(ref: Pick<ShellSession, "herdrPane" | "terminalId">, h: Herdr): Promise<"closed" | "gone" | "agent" | "refused" | "unreadable" | "failed"> {
  let p: { label?: unknown; terminal_id?: unknown; agent?: unknown } | undefined
  try {
    p = (await h.call(["pane", "get", ref.herdrPane], 1_500)).pane as typeof p
  } catch (err) {
    return herdrErrorCode(err) === "pane_not_found" ? "gone" : "unreadable"
  }
  if (p?.label !== SHELL_PANE_MARK || p.terminal_id !== ref.terminalId) return "refused"
  if (p.agent) return "agent"
  try {
    await h.call(["pane", "close", ref.herdrPane], 2_500)
    return "closed"
  } catch {
    return "failed"
  }
}

// main's tmux Close, plus the shared record and a tmux-only success test.
// `kill-session -t =name` can only reach tmux, and the store holds one row per
// name (mergeShells). `detach` runs before the kill so open terminal sockets
// end cleanly rather than on the attach dying.
async function closeTmuxShell(shell: ShellSession, detach: (key: string) => void, deps: Pick<ShellDeps, "run" | "which" | "h">): Promise<CloseShellResult> {
  const name = shell.name
  detach(shell.key)
  const kill = await deps.run([...tmuxArgv(), ...spawnServerFlags(), "kill-session", "-t", `=${name}`])
  // Before the refresh, as on the herdr path: a herdr shell under the same
  // name shows once the tmux row is gone, and a retry must not reach it.
  recordClose(name, "")
  const after = await readShellSessions(deps)
  replaceKeepingLinks(after)
  // Judged by tmux alone: the herdr row that shows now is someone else.
  if (after.some((s) => s.name === name && s.tmuxPane)) return { ok: false, error: "kill_failed" }
  // kill-session failing on a name that is no longer listed: it exited first.
  return { ok: true, gone: kill.code !== 0 }
}

// One row per marked pane, named by its workspace's label. herdr keeps the mark
// through a restore and a split never inherits it, so a row needs no count or
// order logic. A key is a label, so a label with two marked panes gives no row
// until it is unique again, and so does none at all.
// null = herdr could not say, which is not "no shells" (a blip must not drop
// every row).
// `ms` bounds each list; the pid reads run side by side, so a read takes at
// most `ms` plus one pid read (2 s).
export async function readHerdrShells(h: Herdr, known: ShellSession[] = store.list(), ms = 3_000): Promise<ShellSession[] | null> {
  let workspaces: unknown, panes: unknown
  try {
    [workspaces, panes] = await Promise.all([
      h.call(["workspace", "list"], ms).then((r) => r.workspaces),
      h.call(["pane", "list"], ms).then((r) => r.panes),
    ])
  } catch {
    return null
  }
  if (!Array.isArray(workspaces) || !Array.isArray(panes)) return null
  const labels = new Map((workspaces as Array<{ workspace_id?: string; label?: string }>).map((w) => [w.workspace_id, w.label ?? ""]))
  const marked = (panes as Array<{ pane_id?: string; workspace_id?: string; terminal_id?: string; label?: string; cwd?: string; foreground_cwd?: string }>)
    .filter((p) => p.label === SHELL_PANE_MARK)
  const nameOf = (p: { workspace_id?: string }) => labels.get(p.workspace_id) ?? ""
  const rows = marked.filter((p) => nameOf(p) && p.pane_id && p.terminal_id && marked.filter((x) => nameOf(x) === nameOf(p)).length === 1)
  return Promise.all(rows.map(async (p): Promise<ShellSession> => {
    const name = nameOf(p)
    const was = known.find((s) => s.terminalId === p.terminal_id)
    return {
      key: `${SHELL_KEY_PREFIX}${name}`,
      name,
      cwd: p.foreground_cwd || p.cwd || "",
      herdrPane: p.pane_id!,
      terminalId: p.terminal_id!,
      tmuxPane: "",
      tmuxSocket: "",
      // herdr keeps no creation time: first seen by this server.
      createdAt: was?.createdAt ?? Date.now(),
      // 0 while something else is in front: re-read until the shell is seen.
      panePid: was?.panePid || await herdrPaneShellPid(p.pane_id!, h),
      claudeKey: "",
    }
  }))
}

// socket_path: the server's real socket, the same string a hook reports from
// $TMUX — so the phone can tell a Claude session running in this shell.
const LIST_FORMAT = ["#{session_name}", `#{${SHELL_OPTION}}`, "#{pane_id}", "#{pane_current_path}", "#{session_created}", "#{socket_path}", "#{pane_pid}"].join("\t")

// Every shell on this host: herdr's, plus tmux's tagged ones until Stage 5.
export async function readShellSessions(deps: Pick<ShellDeps, "run" | "which" | "h"> = realShellDeps): Promise<ShellSession[]> {
  const [tmux, herdr] = await Promise.all([readTmuxShells(deps), readHerdrShells(deps.h)])
  return mergeShells(tmux, herdr ?? store.list().filter((s) => s.herdrPane))
}

// A key is a name and attach looks a key up, so one name can't be two rows: a
// herdr workspace renamed onto a tmux shell's name gives no row until it moves.
function mergeShells(tmux: ShellSession[], herdr: ShellSession[]): ShellSession[] {
  const taken = new Set(tmux.map((s) => s.name))
  return [...tmux, ...herdr.filter((s) => !taken.has(s.name))].sort((a, b) => a.createdAt - b.createdAt)
}

// Every tagged shell on the spawn server. No tmux or no server running → [].
// ponytail: a tmux that answers code 1 for a real fault reads as no server too.
async function readTmuxShells(deps: Pick<ShellDeps, "run" | "which">): Promise<ShellSession[]> {
  if (!deps.which("tmux")) return []
  const r = await deps.run([...tmuxArgv(), ...spawnServerFlags(), "list-sessions", "-F", LIST_FORMAT])
  // -1: tmux never answered, which is not "no shells". Names stay taken, rows stay.
  if (r.code === -1) return store.list().filter((s) => s.tmuxPane)
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
      herdrPane: "",
      terminalId: "",
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
      && s.herdrPane === o.herdrPane && s.terminalId === o.terminalId && s.claudeKey === o.claudeKey && s.panePid === o.panePid
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
// order), then shells, then ended sessions still in their herdr pane
// (lib/ended-sessions.ts). Neither → the agent list itself, unchanged.
export function wireSessions<T>(agents: T[]): (T | Record<string, unknown>)[] {
  const shells = store.list()
  const ended = endedStore.list()
  return shells.length || ended.length ? [...agents, ...shells.map(shellWire), ...ended.map(endedWire)] : agents
}

// ── Which Claude runs inside a shell ─────────────────────────────────────
//
// Moshi ties a session to its pane by process ancestry, not by a reported
// string, and so does this. Fast path: a Claude session on the same pane as
// the shell (herdr, or tmux server + pane). When that session's pid and the process
// table are both known, the pid must also descend from the shell's pane
// process (herdr's shell pid, #{pane_pid}); a pane id reused after the shell died, or a stale
// hook record, then fails the check. No pid or no table → the pane match
// alone decides.

export type ProcTable = Map<number, number> // pid → ppid

export interface AgentRef { key: string; pid: string; tmuxPane: string; tmuxSocket?: string; herdrPane?: string }

export function inShellPane(a: AgentRef, s: ShellSession): boolean {
  return s.herdrPane ? herdrPaneOf(a) === s.herdrPane : a.tmuxPane === s.tmuxPane && (a.tmuxSocket ?? "") === s.tmuxSocket
}

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
      if (!inShellPane(a, s)) return false
      const pid = Number(a.pid)
      if (!pid || !table || !s.panePid) return true
      return descends(pid, s.panePid, table)
    })
    return { ...s, claudeKey: match?.key ?? "" }
  })
}

// One read every few seconds, so an `exit` (or a cd) reaches the phone, and a
// `claude` started in a shell gets linked to it. A host with no shells pays
// two herdr calls and one list-sessions per tick, and `ps` runs only when some
// agent sits in a shell's pane.
export const SHELL_POLL_MS = 3_000

export function startShellPoll(
  agents: () => AgentRef[],
  deps: ShellDeps = realShellDeps,
  everyMs = SHELL_POLL_MS,
): () => void {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const gen = storeGen
      const shells = await readShellSessions(deps)
      const list = agents()
      const inPane = list.some((a) => shells.some((s) => inShellPane(a, s)))
      const linked = linkClaude(shells, list, inPane ? await readProcTable(deps.run) : null)
      if (gen === storeGen) store.replace(linked)
    } finally { busy = false }
  }
  void tick()
  const timer = setInterval(() => void tick(), everyMs)
  return () => clearInterval(timer)
}
