// herdr bridge for the companion (Mac desk-cockpit trial, RES-RY7A).
//
// Parsing, the error codes and the version gate are not ours: they come from
// the shared client (~/.claude/tools/herdr-client.ts: parseCliResult,
// gateReason, pinnedFromEnv) that the dispatch herdr runner already uses. What
// differs is the transport. That client runs the CLI through spawnSync, which
// would freeze this server (every phone, every hook) for the length of an
// `agent start` (up to 20 s). Here the same CLI runs through Bun.spawn and its
// output goes to the same parseCliResult.
//
// A pane id from a hook ($HERDR_PANE_ID) is a valid target for every `agent`
// command (herdr resolves the agent hosted in that pane), so sessions
// addressed by pane need no agent name at all. The name is kept only for logs.

import type { KeyGate } from "./key-gate"

export interface ExecResult { status: number | null; stdout: string; stderr: string; error?: Error }

interface HerdrClientModule {
  gateReason(s: unknown, pinned?: string[]): string | null
  parseCliResult(r: ExecResult, what: string): Record<string, unknown>
  pinnedFromEnv(v: string | undefined): string[]
}

export const HERDR_CLIENT_PATH = process.env.COMPANION_HERDR_CLIENT
  || `${process.env.HOME}/.claude/tools/herdr-client.ts`

let clientMod: Promise<HerdrClientModule | null> | null = null
function loadClient(): Promise<HerdrClientModule | null> {
  return clientMod ??= import(HERDR_CLIENT_PATH).then((m) => m as HerdrClientModule, () => null)
}

// A herdr error as the shared client throws it (HerdrError has `.code`).
export function herdrErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "error"
}

class LocalHerdrError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

// `signal`: an aborted caller (key-gate timeout) kills the subprocess, and an
// already-aborted one never starts it.
async function herdrExec(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
  if (signal?.aborted) return { status: null, stdout: "", stderr: "", error: new Error("aborted") }
  try {
    const p = Bun.spawn([process.env.HERDR_BIN || "herdr", ...args], { stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const kill = () => { timedOut = true; p.kill() }
    const timer = setTimeout(kill, timeoutMs)
    signal?.addEventListener("abort", kill, { once: true })
    try {
      const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      await p.exited
      return { status: timedOut ? null : p.exitCode, stdout, stderr }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", kill)
    }
  } catch (err) {
    return { status: null, stdout: "", stderr: "", error: err as Error }
  }
}

// `pane send-keys` / `pane send-text` succeed silently on herdr 0.9.3: exit 0,
// no stdout. parseCliResult calls that bad_output, which failed every phone
// Esc and dialog key to a herdr pane.
export function silentSuccess(r: { status: number | null; stdout: string; error?: Error }): boolean {
  return r.status === 0 && !r.error && !r.stdout.trim()
}

// The seam every herdr caller here goes through (tests pass a fake).
export interface Herdr {
  // A JSON command: its `result`, or throws an error carrying `.code`.
  // An aborted `signal` kills the subprocess (or never starts it).
  call(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<Record<string, unknown>>
  // `pane read` (plain/ANSI text, not JSON); null when unreadable.
  read(pane: string, signal?: AbortSignal): Promise<string | null>
  // null = herdr is usable; else the fallback reason.
  gate(): Promise<string | null>
}

export const realHerdr: Herdr = {
  async call(args, timeoutMs = 10_000, signal) {
    const mod = await loadClient()
    if (!mod) throw new LocalHerdrError("herdr_client_missing", `herdr client not loadable: ${HERDR_CLIENT_PATH}`)
    if (signal?.aborted) throw new LocalHerdrError("aborted", `herdr ${args.slice(0, 2).join(" ")}: aborted`)
    const r = await herdrExec(args, timeoutMs, signal)
    if (signal?.aborted) throw new LocalHerdrError("aborted", `herdr ${args.slice(0, 2).join(" ")}: aborted`)
    if (silentSuccess(r)) return {}
    return mod.parseCliResult(r, args.slice(0, 2).join(" "))
  },
  async read(pane, signal) {
    const r = await herdrExec(["pane", "read", pane, "--source", "visible", "--format", "ansi"], 1_500, signal)
    return r.status === 0 && !r.error && !signal?.aborted ? herdrScreen(r.stdout) : null
  },
  async gate() {
    const mod = await loadClient()
    if (!mod) return `herdr-client-missing (${HERDR_CLIENT_PATH})`
    try {
      const status = await realHerdr.call(["status", "server", "--json"], 5_000)
      return mod.gateReason(status, mod.pinnedFromEnv(process.env.DISPATCH_HERDR_VERSIONS))
    } catch (err) {
      return `herdr-down: ${(err as Error).message.slice(0, 120)}`
    }
  },
}

// `pane read --format ansi` → the shape `tmux capture-pane -e` hands the
// screen parsers (dialogs, inputLine, command menu): herdr ends rows with CRLF
// and keeps the trailing blanks tmux drops.
export function herdrScreen(raw: string): string {
  return raw.replace(/\r/g, "").replace(/[ \t]+$/gm, "")
}

// The pane's width in columns (`pane layout`); null when herdr can't say —
// callers treat that as unknown, not as narrow (same as tmuxPaneWidth).
export async function herdrPaneWidth(pane: string, h: Herdr = realHerdr, signal?: AbortSignal): Promise<number | null> {
  try {
    const r = await h.call(["pane", "layout", "--pane", pane], 2_000, signal)
    const panes = (r.layout as { panes?: Array<{ pane_id?: string; rect?: { width?: number } }> } | undefined)?.panes ?? []
    const w = panes.find((p) => p.pane_id === pane)?.rect?.width
    return typeof w === "number" && Number.isInteger(w) && w > 0 ? w : null
  } catch {
    return null
  }
}

// ── Closing a spawned session's workspace ────────────────────────────────
//
// A phone spawn runs `agent start` in a shell pane, so after /exit the pane
// drops back to bash and the `cc-<dir>` workspace stays open. Closed only
// when it is plainly ours and idle: still the workspace we created (id,
// label = agent name, terminal id), one pane, and that pane's foreground
// process group is its shell. Anything else (a human's command, a second
// pane, a renamed or different workspace, an unreadable answer) leaves it
// alone.

// The pane's shell pid when the shell is in front, else 0 (busy/unreadable).
export async function herdrPaneShellPid(pane: string, h: Herdr = realHerdr): Promise<number> {
  try {
    const r = await h.call(["pane", "process-info", "--pane", pane], 2_000)
    const p = r.process_info as { shell_pid?: number; foreground_process_group_id?: number } | undefined
    const ok = typeof p?.shell_pid === "number" && p.shell_pid > 0 && p.foreground_process_group_id === p.shell_pid
    return ok ? p!.shell_pid! : 0
  } catch {
    return 0
  }
}

export async function herdrPaneAtShell(pane: string, h: Herdr = realHerdr): Promise<boolean> {
  return (await herdrPaneShellPid(pane, h)) > 0
}

// What this server created at spawn: the workspace, its label (the agent
// name) and the pane's terminal id. herdr reuses pane and workspace ids
// ("w6:p1"), so the id alone never proves ownership; the label and terminal
// id are checked against herdr right before closing.
export interface HerdrOwner {
  name: string
  workspaceId?: string
  terminalId?: string
}

export interface WorkspaceCloseOpts {
  h?: Herdr
  tries?: number
  intervalMs?: number
  // False once a new session sits in the pane (a forked background claude,
  // or someone started claude again): stop, the pane is in use.
  stillFree?: () => boolean
  // When set, the workspace must still be this one (label, ids) to close.
  owner?: HerdrOwner
  sleep?: (ms: number) => Promise<void>
}

const HERDR_WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

// The workspace to close, or "" when it is not (or no longer) ours, is split,
// or herdr can't say.
async function closableWorkspace(pane: string, h: Herdr, owner: HerdrOwner | undefined): Promise<string> {
  const got = await h.call(["pane", "get", pane], 2_000)
  const p = got.pane as { workspace_id?: string; terminal_id?: string } | undefined
  const ws = p?.workspace_id ?? ""
  if (!HERDR_WORKSPACE_RE.test(ws)) return ""
  // A label alone never proves ownership: an owner must carry an id to match.
  if (owner && !owner.workspaceId && !owner.terminalId) return ""
  if (owner?.workspaceId && owner.workspaceId !== ws) return ""
  if (owner?.terminalId && owner.terminalId !== p?.terminal_id) return ""
  const info = await h.call(["workspace", "get", ws], 2_000)
  const w = info.workspace as { pane_count?: number; label?: string } | undefined
  if (w?.pane_count !== 1) return ""
  if (owner && w.label !== owner.name) return ""
  return ws
}

// SessionEnd fires while claude is still the foreground process, so the shell
// check is polled for a few seconds. It must hold on two checks in a row: a
// forked background claude ("Move to background and exit") registers a moment
// after its parent ends, and closing the workspace under it would hang it up.
//
// herdr has no conditional close, so the order keeps the window as small as
// the CLI allows: the workspace metadata is read first, then the shell check,
// and `workspace close` follows that check with nothing awaited in between.
// A command started after that last check (one subprocess round trip) can
// still lose its pane; nothing here can close that gap.
// Returns the closed workspace id, or "".
export async function closeHerdrWorkspaceWhenIdle(pane: string, opts: WorkspaceCloseOpts = {}): Promise<string> {
  const h = opts.h ?? realHerdr
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const tries = opts.tries ?? 12
  let lastShell = 0
  try {
    for (let i = 0; i < tries; i++) {
      await sleep(opts.intervalMs ?? 1_000)
      if (opts.stillFree && !opts.stillFree()) return ""
      // The previous check saw the shell: this one may close, so read the
      // workspace first and keep the shell check last.
      const ws = lastShell ? await closableWorkspace(pane, h, opts.owner) : ""
      if (lastShell && !ws) return ""
      const shell = await herdrPaneShellPid(pane, h)
      // Same shell in front on both checks; anything else starts over.
      if (!shell || shell !== lastShell || !ws) {
        lastShell = shell
        continue
      }
      if (opts.stillFree && !opts.stillFree()) return ""
      // Known race: herdr 0.9.3 has no atomic conditional close, so a pane
      // split opened (or a command started) after the check above is closed
      // with the workspace. Codex reproduced a split being destroyed, which is
      // why the caller only gets here with COMPANION_HERDR_AUTOCLOSE=1
      // (herdr-workspace.ts herdrAutocloseEnabled; off by default).
      await h.call(["workspace", "close", ws], 5_000)
      return ws
    }
  } catch {
    return ""
  }
  return ""
}

// $HERDR_PANE_ID as hooks report it (e.g. "w1:p1"). It ends up in an argv, so
// anything that could read as a flag or carry junk is dropped.
const HERDR_PANE_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/
export function validHerdrPane(pane: string | undefined | null): string {
  const p = (pane ?? "").trim()
  return HERDR_PANE_RE.test(p) ? p : ""
}

// A session we address through herdr: a herdr pane and NO tmux pane (tmux run
// inside a herdr pane keeps the tmux path, which is the more precise address).
export function herdrPaneOf(t: { herdrPane?: string; tmuxPane?: string } | null | undefined): string {
  if (!t || t.tmuxPane?.trim()) return ""
  return validHerdrPane(t.herdrPane)
}

// Key-gate identity, distinct from any tmux pane key.
export function herdrGateKey(pane: string): string {
  return `herdr|${pane}`
}

// tmux key names (what routes and the picker driver speak) → herdr's logical
// key names. herdr validates every key before writing any byte.
export function herdrKeyName(key: string): string {
  if (key === "Escape" || key === "C-[") return "esc"
  const ctrl = key.match(/^C-(.)$/)
  if (ctrl) return `ctrl+${ctrl[1]!.toLowerCase()}`
  return key.toLowerCase()
}

const NAMED_KEY_RE = /^(Enter|Escape|Up|Down|Left|Right|Tab|Space|BSpace|C-.)$/

// One named key, or else one literal character (a digit picking a row).
export async function herdrSendKey(pane: string, key: string, h: Herdr = realHerdr, signal?: AbortSignal): Promise<boolean> {
  if (!NAMED_KEY_RE.test(key)) return herdrSendText(pane, key, h, signal)
  if (signal?.aborted) return false
  try {
    await h.call(["pane", "send-keys", pane, herdrKeyName(key)], undefined, signal)
    return true
  } catch {
    return false
  }
}

export async function herdrSendText(pane: string, text: string, h: Herdr = realHerdr, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  try {
    await h.call(["pane", "send-text", pane, text], undefined, signal)
    return true
  } catch {
    return false
  }
}

// One herdr key / text in the pane's key-gate turn. The turn's AbortSignal
// goes down to the subprocess: once the gate times out and lets the next turn
// type, this send is killed (or never started) instead of landing late.
// False on any failure or timeout.
type GateSend = Pick<KeyGate, "send">
export function herdrGatedKey(gate: GateSend, pane: string, key: string, h: Herdr = realHerdr): Promise<boolean> {
  return gate.send(herdrGateKey(pane), key, (signal) => herdrSendKey(pane, key, h, signal)).catch(() => false)
}
export function herdrGatedText(gate: GateSend, pane: string, text: string, h: Herdr = realHerdr): Promise<boolean> {
  return gate.send(herdrGateKey(pane), text, (signal) => herdrSendText(pane, text, h, signal)).catch(() => false)
}

// pane id → what this server spawned in it. Recorded right after `workspace
// create` (before `agent start`, so a SessionStart hook that beats the spawn
// reply still finds it at release), dropped once the session is released.
const spawnedAgents = new Map<string, HerdrOwner>()
export function noteHerdrAgent(pane: string, name: string, ids: { workspaceId?: string; terminalId?: string } = {}): void {
  spawnedAgents.set(pane, { name, ...ids })
}
export function herdrAgentFor(pane: string): string {
  return spawnedAgents.get(pane)?.name ?? ""
}
export function herdrOwnerFor(pane: string): HerdrOwner | undefined {
  return spawnedAgents.get(pane)
}
export function forgetHerdrAgent(pane: string): void {
  spawnedAgents.delete(pane)
}
