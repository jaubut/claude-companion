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
    return mod.parseCliResult(await herdrExec(args, timeoutMs), args.slice(0, 2).join(" "))
  },
  async read(pane) {
    const r = await herdrExec(["pane", "read", pane, "--source", "visible", "--format", "ansi"], 1_500)
    return r.status === 0 && !r.error ? r.stdout : null
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
