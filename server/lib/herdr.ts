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

async function herdrExec(args: string[], timeoutMs: number): Promise<ExecResult> {
  try {
    const p = Bun.spawn([process.env.HERDR_BIN || "herdr", ...args], { stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; p.kill() }, timeoutMs)
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    await p.exited
    clearTimeout(timer)
    return { status: timedOut ? null : p.exitCode, stdout, stderr }
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
  call(args: string[], timeoutMs?: number): Promise<Record<string, unknown>>
  // `pane read` (plain/ANSI text, not JSON); null when unreadable.
  read(pane: string): Promise<string | null>
  // null = herdr is usable; else the fallback reason.
  gate(): Promise<string | null>
}

export const realHerdr: Herdr = {
  async call(args, timeoutMs = 10_000) {
    const mod = await loadClient()
    if (!mod) throw new LocalHerdrError("herdr_client_missing", `herdr client not loadable: ${HERDR_CLIENT_PATH}`)
    const r = await herdrExec(args, timeoutMs)
    if (silentSuccess(r)) return {}
    return mod.parseCliResult(r, args.slice(0, 2).join(" "))
  },
  async read(pane) {
    const r = await herdrExec(["pane", "read", pane, "--source", "visible", "--format", "ansi"], 1_500)
    return r.status === 0 && !r.error ? herdrScreen(r.stdout) : null
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
export async function herdrPaneWidth(pane: string, h: Herdr = realHerdr): Promise<number | null> {
  try {
    const r = await h.call(["pane", "layout", "--pane", pane], 2_000)
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
// when it is plainly ours and idle: one pane, and that pane's foreground
// process group is its shell. Anything else (a human's command, a second
// pane, an unreadable answer) leaves it alone.
export async function herdrPaneAtShell(pane: string, h: Herdr = realHerdr): Promise<boolean> {
  try {
    const r = await h.call(["pane", "process-info", "--pane", pane], 2_000)
    const p = r.process_info as { shell_pid?: number; foreground_process_group_id?: number } | undefined
    return typeof p?.shell_pid === "number" && p.shell_pid > 0 && p.foreground_process_group_id === p.shell_pid
  } catch {
    return false
  }
}

export interface WorkspaceCloseOpts {
  h?: Herdr
  tries?: number
  intervalMs?: number
  // False once a new session sits in the pane (a forked background claude,
  // or someone started claude again): stop, the pane is in use.
  stillFree?: () => boolean
  sleep?: (ms: number) => Promise<void>
}

// SessionEnd fires while claude is still the foreground process, so the shell
// check is polled for a few seconds. It must hold on two checks in a row: a
// forked background claude ("Move to background and exit") registers a moment
// after its parent ends, and closing the workspace under it would hang it up.
// Returns the closed workspace id, or "".
export async function closeHerdrWorkspaceWhenIdle(pane: string, opts: WorkspaceCloseOpts = {}): Promise<string> {
  const h = opts.h ?? realHerdr
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const tries = opts.tries ?? 12
  let atShell = 0
  for (let i = 0; i < tries; i++) {
    await sleep(opts.intervalMs ?? 1_000)
    if (opts.stillFree && !opts.stillFree()) return ""
    atShell = (await herdrPaneAtShell(pane, h)) ? atShell + 1 : 0
    if (atShell < 2) continue
    try {
      const got = await h.call(["pane", "get", pane], 2_000)
      const ws = (got.pane as { workspace_id?: string } | undefined)?.workspace_id ?? ""
      if (!ws) return ""
      const info = await h.call(["workspace", "get", ws], 2_000)
      if ((info.workspace as { pane_count?: number } | undefined)?.pane_count !== 1) return ""
      if (opts.stillFree && !opts.stillFree()) return ""
      await h.call(["workspace", "close", ws], 5_000)
      return ws
    } catch {
      return ""
    }
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
export async function herdrSendKey(pane: string, key: string, h: Herdr = realHerdr): Promise<boolean> {
  if (!NAMED_KEY_RE.test(key)) return herdrSendText(pane, key, h)
  try {
    await h.call(["pane", "send-keys", pane, herdrKeyName(key)])
    return true
  } catch {
    return false
  }
}

export async function herdrSendText(pane: string, text: string, h: Herdr = realHerdr): Promise<boolean> {
  try {
    await h.call(["pane", "send-text", pane, text])
    return true
  } catch {
    return false
  }
}

// pane id → agent name for the panes this server spawned (logs / Session).
const spawnedAgents = new Map<string, string>()
export function noteHerdrAgent(pane: string, name: string): void {
  spawnedAgents.set(pane, name)
}
export function herdrAgentFor(pane: string): string {
  return spawnedAgents.get(pane) ?? ""
}
