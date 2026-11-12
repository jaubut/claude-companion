// Spawn a fresh Claude/Codex session from the companion (phone tap → a new
// herdr workspace cd'd into a directory, agent already started). The usual
// session hooks pick up the new session within a second or two, and the
// phone picker sees it automatically.
//
// Herdr-only (docs/herdr-only-migration.md, Stage 1): "auto" is herdr on macOS
// and Linux alike, a gate failure is an error (herdr_unavailable), and
// app "tmux" is refused (tmux_retired). The tmux spawn code below stays,
// unreachable from "auto"/"tmux", so a revert restores it; Stage 5 deletes it.
// Mac Terminal/iTerm were dropped for "ghostty" (2026-11-01): the same herdr
// spawn, plus a Ghostty window attached to herdr. They answer app_retired.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs"
import { spawnNewSessionFlags, spawnServerFlags, spawnSocketPath, tmuxArgv } from "./tmux-pane"
import { type Herdr, HERDR_VERSIONS_ENV, closableWorkspace, forgetHerdrAgent, herdrErrorCode, herdrOwnerFor, noteHerdrAgent, realHerdr } from "./herdr"
import { companionLog } from "./log"
import { applyMcpChoices } from "./claude-mcp-trust"
import { type DetachedDeps, type TmuxArgvRunner, createConfirmed, realDetachedDeps } from "./tmux-spawn-confirm"

// Claude Code blocks interactive startup at the "Do you trust the files in
// this folder?" dialog until the dir is accepted — and the SessionStart hook
// (how the companion learns a session exists) fires only AFTER trust. So a
// spawn into an untrusted dir just sits at the prompt forever and never
// registers: the phone shows nothing. Pre-seed trust for the target dir in
// ~/.claude.json so the spawned agent boots straight into the session. Once
// claude runs in a trusted dir it keeps the flag on exit, so this write is a
// one-time cost per dir.
//
// mcpFrom (takeover): the main checkout a worktree was cut from — see
// claude-mcp-trust.ts for how its MCP choices carry over.
export function ensureFolderTrusted(cwd: string, mcpFrom?: string, cfgPath = `${process.env.HOME ?? ""}/.claude.json`): void {
  if (!process.env.HOME) return
  let cfg: { projects?: Record<string, Record<string, unknown>> }
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")) } catch { return }
  const projects = cfg.projects ?? (cfg.projects = {})
  let root: string | undefined
  try { root = readFileSync(`${cwd}/.git`, "utf8").match(/^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/]+\s*$/m)?.[1] } catch { /* not a worktree */ }
  const entry = projects[cwd] ?? (projects[cwd] = {})
  let changed = false
  if (entry.hasTrustDialogAccepted !== true) { entry.hasTrustDialogAccepted = true; changed = true }
  if (root) {
    const rootEntry = projects[root] ?? (projects[root] = {})
    if (rootEntry.hasTrustDialogAccepted !== true) { rootEntry.hasTrustDialogAccepted = true; changed = true }
  }
  if (mcpFrom && applyMcpChoices(entry, projects, mcpFrom, cwd)) changed = true
  if (!changed) return
  try {
    const tmp = `${cfgPath}.companion-${process.pid}`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    renameSync(tmp, cfgPath)
  } catch { /* best-effort — worst case the trust dialog still appears */ }
}

/** For a caller nobody can rescue from the trust dialog: did the best-effort write above land? */
export function folderTrusted(cwd: string, cfgPath = `${process.env.HOME ?? ""}/.claude.json`): boolean {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> }
    return cfg.projects?.[cwd]?.hasTrustDialogAccepted === true
  } catch {
    return false
  }
}

export const TMUX_RETIRED = "tmux_retired"

export const APP_RETIRED = "app_retired"
const RETIRED_APPS = new Set(["terminal", "iterm"])
export const APP_RETIRED_HINT = 'Terminal/iTerm were dropped for Ghostty: use app "ghostty" or "auto"'

export type SpawnApp = "ghostty" | "tmux" | "herdr" | "auto"
export type SpawnAgent = "claude" | "codex" | "kimi"

// Kimi sessions are regular Claude Code pointed at Moonshot's Anthropic-
// compatible endpoint. All config (base URL, API key, model pins) lives in
// ~/.config/kimi/kimi.env so the token never appears in the tmux command
// line, ps output, or this repo. Everything downstream (hooks, injection,
// session feed) behaves exactly like a claude session.
const KIMI_ENV_FILE = `${process.env.HOME}/.config/kimi/kimi.env`

const KIMI_SOURCE = `. "$HOME/.config/kimi/kimi.env"`

function agentLaunchCommand(agent: SpawnAgent): string {
  if (agent === "kimi") return `${KIMI_SOURCE} && claude`
  return agent
}

// Env the spawned agent (and every hook it spawns) inherits — today just the
// orchestrator's COMPANION_TASK_ID, so a worker's hooks can name the task they
// belong to (PRJ-OR1T Phase 8).
//
// Keys and values must be plain tokens. The charset excludes every shell
// metacharacter, so the assignment needs no quoting and can't be escaped out of;
// anything else throws rather than shipping an injectable command line.
const ENV_TOKEN = /^[A-Za-z0-9_-]+$/

function checkEnv(env?: Record<string, string>): [string, string][] {
  const entries = Object.entries(env ?? {})
  for (const [key, value] of entries) {
    if (!ENV_TOKEN.test(key)) throw new Error(`spawn env: unsafe key ${JSON.stringify(key)}`)
    if (!ENV_TOKEN.test(value)) throw new Error(`spawn env: unsafe value for ${key}: ${JSON.stringify(value)}`)
  }
  return entries
}

// The form is load-bearing: `export K=V; cd '<cwd>' && <agent>`, export FIRST,
// joined with `;`. The obvious `K=V cd … && claude` prefix is a *command*
// assignment in POSIX sh — it scopes to `cd` alone and never reaches claude,
// let alone the hook children that need to read it.
function envPrefix(env?: Record<string, string>): string {
  const entries = checkEnv(env)
  if (entries.length === 0) return ""
  return `${entries.map(([key, value]) => `export ${key}=${value}`).join("; ")}; `
}

// The command tmux runs inside the new session, shared by every spawn path
// (headless tmux, shells) so they can't drift apart. The env prefix
// precedes the `cd`, and therefore also the kimi `. kimi.env` sourcing.
export function buildInner(cwd: string, agent: SpawnAgent, env?: Record<string, string>, args?: string[]): string {
  const extra = args?.length ? ` ${args.join(" ")}` : ""
  return `${envPrefix(env)}cd '${escapeForShellSingleQuoted(cwd)}' && ${agentLaunchCommand(agent)}${extra}`
}

export interface SpawnResult {
  ok: boolean
  app?: "Ghostty" | "tmux" | "herdr"
  sessionName?: string
  // Socket path of the tmux server the session landed on ("" = the default
  // server). Same form discovery records from $TMUX, so `-S` reaches it.
  tmuxSocket?: string
  // herdr spawns: the workspace's root pane (what hooks report as $HERDR_PANE_ID).
  herdrPane?: string
  // Set when herdr was not even tried (version gate / server down); `error`
  // is then `herdr_unavailable: <reason>`. A failure after the gate never
  // sets it. Since Stage 1 nothing falls back to tmux on it.
  fallback?: string
  error?: string
  // With error app_retired: what to send instead.
  hint?: string
}

function escapeForShellSingleQuoted(s: string): string {
  // Wrapping in single quotes in the shell blocks interpolation; the only
  // escape we need is for embedded single quotes themselves.
  return s.replace(/'/g, `'\\''`)
}

// A detached tmux session has no client, so tmux sizes it from `default-size`
// — 80x24 unless the host's tmux.conf says otherwise. That is not a cosmetic
// detail: Claude Code sizes its dialogs to the pane, so at 24 rows `/help`
// renders ~5 command rows per page instead of ~17, and the companion's own
// /help scrape (routes/command.ts) pays ~7x the round trips for the same list
// — measured on the Linux host as "208 in 111.5s" (truncated) vs "356 in
// 42.4s" once the pane was 220x60. Pass the size explicitly at creation so
// this does not depend on a host's ~/.tmux.conf.
//
// `-x/-y` are honoured only while no client is attached, which is exactly the
// detached case; a human attaching later resizes the pane to their terminal
// as usual.
export const DETACHED_COLS = 220
export const DETACHED_ROWS = 60

// Exported for the test: the argv of the headless spawn, size included.
// `printFormat` adds `-P -F <fmt>` so the caller learns the new pane's id/tty
// from the same call (the hidden /help enumeration needs it before claude
// boots — lib/command-offpane.ts).
export function detachedNewSessionArgs(sessionName: string, inner: string, printFormat?: string): string[] {
  return [
    "new-session", "-d",
    ...(printFormat ? ["-P", "-F", printFormat] : []),
    "-x", String(DETACHED_COLS),
    "-y", String(DETACHED_ROWS),
    "-s", sessionName,
    "/bin/sh", "-c", inner,
  ]
}

// The full argv of the headless spawn: the spawn server's flags (incl. -f) and
// the sized new-session. Exported for the test.
export function detachedSpawnArgv(
  sessionName: string,
  inner: string,
  serverEnv: Record<string, string | undefined> = process.env,
): string[] {
  return [...tmuxArgv(), ...spawnNewSessionFlags(serverEnv), ...detachedNewSessionArgs(sessionName, inner)]
}

function agentTmuxSessionName(cwd: string, agent: SpawnAgent | "shell"): string {
  const prefix = agent === "codex" ? "cx" : agent === "kimi" ? "km" : agent === "shell" ? "sh" : "cc"
  const base = cwd.split("/").filter(Boolean).pop() ?? "session"
  const safe = base.replace(/[:.]/g, "-").replace(/\s+/g, "-")
  return `${prefix}-${safe}`
}

// `=name` forces an exact match — without it, tmux treats the target as a
// prefix and `cc-foo` would falsely report existing because `cc-foo-2` is.
// Probed on the spawn server: that is where the new session will land.
async function tmuxSessionExists(name: string): Promise<boolean> {
  const proc = Bun.spawn([...tmuxArgv(), ...spawnServerFlags(), "has-session", "-t", `=${name}`], {
    stdout: "ignore",
    stderr: "ignore",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, 1_500)
  const code = await proc.exited
  clearTimeout(timer)
  return !timedOut && code === 0
}

export async function uniqueTmuxSessionName(cwd: string, agent: SpawnAgent | "shell", exists = tmuxSessionExists): Promise<string> {
  const base = agentTmuxSessionName(cwd, agent)
  if (!(await exists(base))) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!(await exists(candidate))) return candidate
  }
  return `${base}-${Date.now()}`
}

// Headless tmux spawn — the Linux/server path. No GUI Terminal to open;
// we just create a detached tmux session running the agent at the given cwd.
// The session-start hook (~/.claude/hooks/companion-session-start.sh) picks
// it up via $TMUX_PANE the moment Claude initializes inside the pane, so
// subsequent phone messages route via tmux send-keys exactly like the Mac
// path.
//
// Attaching from a human shell (when you want to peek): ssh aubut@<linux-host>
// then `tmux attach -t cc-<name>` (`tmux -L <COMPANION_TMUX_SOCKET> attach …`
// when a spawn server is configured). detach-on-destroy=on so claude exiting
// cleanly drops you back to the shell instead of switching sessions.
export async function spawnInTmuxDetached(
  cwd: string,
  agent: SpawnAgent,
  env?: Record<string, string>,
  deps: DetachedDeps = realDetachedDeps,
  opts?: HerdrSpawnOpts,
): Promise<SpawnResult> {
  // tmux new-session -d exits 0 even when the agent dies at once (2026-10-21:
  // a launchd PATH without ~/.local/bin → `claude: not found`, the server quit,
  // the phone waited for a card that never came) — check before and after.
  const agentArgs = opts?.args ?? []
  const badArg = agentArgs.find((a) => !AGENT_ARG.test(a))
  if (badArg !== undefined) return { ok: false, app: "tmux", error: `spawn args: unsafe value ${JSON.stringify(badArg)}` }
  const bin = agent === "codex" ? "codex" : "claude"
  if (!deps.which(bin)) return { ok: false, app: "tmux", error: `agent_not_found: ${bin} not on PATH (${process.env.PATH ?? ""})` }
  const has = async (n: string) => (await deps.run([...tmuxArgv(), ...spawnServerFlags(), "has-session", "-t", `=${n}`])).code === 0
  if (opts?.name && await has(opts.name)) return { ok: false, app: "tmux", error: `name_taken: ${opts.name}` }
  const sessionName = opts?.name ?? await uniqueTmuxSessionName(cwd, agent, has)
  // Sized create (see detachedNewSessionArgs — an 80x24 pane cripples every
  // dialog we read); the inner command runs via /bin/sh.
  const error = await createConfirmed(sessionName, detachedSpawnArgv(sessionName, buildInner(cwd, agent, env, agentArgs)), deps)
  if (error) return { ok: false, app: "tmux", error }
  // Socket path resolved after the create: the server (and its dir) now exist.
  return { ok: true, app: "tmux", sessionName, tmuxSocket: spawnSocketPath() }
}

// ── herdr (Mac, desk-cockpit trial — RES-RY7A) ─────────────────────────────
//
// A new herdr workspace rooted at the cwd, the agent started in its root pane
// with `agent start` (returns once the agent is ready). Every pane exports
// $HERDR_PANE_ID, which the hooks forward, so phone messages go through
// `herdr agent prompt` / `pane send-keys` — pane-addressed, no focus race,
// same as tmux. No shell command line is built: env rides `--env` (still held
// to ENV_TOKEN), kimi sources the same kimi.env in the pane's shell first.

// herdr agent names: [a-z][a-z0-9_-]{0,31}, unique among live agents.
export function herdrAgentBaseName(cwd: string, agent: SpawnAgent): string {
  return agentTmuxSessionName(cwd, agent).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 28)
}

async function herdrNameTaken(name: string, h: Herdr): Promise<boolean> {
  try {
    await h.call(["agent", "get", name])
    return true
  } catch {
    return false // agent_not_found (anything else surfaces at agent start)
  }
}

async function uniqueHerdrAgentName(cwd: string, agent: SpawnAgent, h: Herdr): Promise<string> {
  const base = herdrAgentBaseName(cwd, agent)
  if (!(await herdrNameTaken(base, h))) return base
  for (let i = 2; i < 100; i++) {
    if (!(await herdrNameTaken(`${base}-${i}`, h))) return `${base}-${i}`
  }
  return `${base}-${Date.now() % 1000}`
}

// Bounded below the phone's patience; claude is normally ready in 2-5 s.
export const HERDR_START_TIMEOUT_MS = 20_000

/** A fixed agent name (an identity token: taken = error, never suffixed) and plain-token agent args after `--`. */
export interface HerdrSpawnOpts { name: string; args?: string[] }

const AGENT_ARG = /^[A-Za-z0-9_.=-]+$/

export async function spawnInHerdr(
  cwd: string,
  agent: SpawnAgent,
  env?: Record<string, string>,
  h: Herdr = realHerdr,
  opts?: HerdrSpawnOpts,
): Promise<SpawnResult> {
  const envArgs = checkEnv(env).flatMap(([k, v]) => ["--env", `${k}=${v}`])
  const agentArgs = opts?.args ?? []
  const badArg = agentArgs.find((a) => !AGENT_ARG.test(a))
  if (badArg !== undefined) return { ok: false, app: "herdr", error: `spawn args: unsafe value ${JSON.stringify(badArg)}` }
  const gate = await h.gate()
  if (gate) return { ok: false, app: "herdr", error: `herdr_unavailable: ${gate}`, fallback: gate }

  if (opts && await herdrNameTaken(opts.name, h)) return { ok: false, app: "herdr", error: `name_taken: ${opts.name}` }
  const name = opts?.name ?? await uniqueHerdrAgentName(cwd, agent, h)
  let paneId = ""
  let workspaceId = ""
  let terminalId = ""
  try {
    const r = await h.call(["workspace", "create", "--cwd", cwd, "--label", name, ...envArgs, "--no-focus"])
    workspaceId = (r.workspace as { workspace_id?: string } | undefined)?.workspace_id ?? ""
    const root = r.root_pane as { pane_id?: string; terminal_id?: string } | undefined
    paneId = root?.pane_id ?? ""
    terminalId = typeof root?.terminal_id === "string" ? root.terminal_id : ""
  } catch (err) {
    return { ok: false, app: "herdr", error: `herdr workspace create: ${(err as Error).message}` }
  }
  if (!paneId) return { ok: false, app: "herdr", error: "herdr workspace create: no root_pane.pane_id" }
  // Ours from here: claude's SessionStart hook can arrive before `agent start`
  // returns, and the workspace close on exit looks this record up.
  noteHerdrAgent(paneId, name, { workspaceId, terminalId })

  try {
    if (agent === "kimi") await h.call(["pane", "run", paneId, KIMI_SOURCE])
    await h.call(
      ["agent", "start", name, "--kind", agent === "codex" ? "codex" : "claude", "--pane", paneId, "--timeout", String(HERDR_START_TIMEOUT_MS),
        ...(agentArgs.length ? ["--", ...agentArgs] : [])],
      HERDR_START_TIMEOUT_MS + 5_000,
    )
  } catch (err) {
    // Blocked during startup (a dialog): the agent runs and its hooks will
    // register it — the phone can answer from there.
    if (herdrErrorCode(err) !== "agent_not_ready") {
      forgetHerdrAgent(paneId)
      // Only the workspace this create made, still alone and still ours (label,
      // ids, no shell mark): a restore can reissue the id to someone else's.
      const ws = await closableWorkspace(paneId, h, { name, workspaceId, terminalId }).catch(() => "")
      if (ws) await h.call(["workspace", "close", ws]).catch(() => undefined)
      return { ok: false, app: "herdr", error: `herdr agent start: ${(err as Error).message}` }
    }
  }
  return { ok: true, app: "herdr", sessionName: name, herdrPane: paneId }
}

// What Ghostty runs: plain `herdr` attaches to the persistent session (there
// is no per-workspace attach; `workspace focus` picks what it shows). The
// absolute path because Ghostty's login shell may not have the server's PATH.
// `open -na Ghostty.app --args -e <cmd>`: Ghostty's macOS CLI can't open a
// window itself; -e sets initial-command, the new instance's first window.
export function ghosttyOpenArgv(herdrBin = process.env.HERDR_BIN || Bun.which("herdr") || "herdr"): string[] {
  return ["open", "-na", "Ghostty.app", "--args", "-e", herdrBin]
}

// "ghostty": the "auto" herdr spawn, then its workspace focused and a Ghostty
// window attached. The agent already runs, so a failed open is logged and the
// spawn still succeeds (app "herdr": the phone sees it, no desk window).
export async function spawnInGhostty(
  cwd: string,
  agent: SpawnAgent,
  env: Record<string, string> | undefined,
  deps: {
    herdr: typeof spawnInHerdr
    h: Herdr
    run: TmuxArgvRunner
    log: (line: string) => void
  } = { herdr: spawnInHerdr, h: realHerdr, run: realDetachedDeps.run, log: companionLog },
): Promise<SpawnResult> {
  const r = await spawnMacAuto(cwd, agent, env, deps)
  if (!r.ok || !r.herdrPane) return r
  const ws = herdrOwnerFor(r.herdrPane)?.workspaceId
  if (ws) await deps.h.call(["workspace", "focus", ws]).catch((err) => deps.log(`spawn: herdr workspace focus ${ws}: ${(err as Error).message}`))
  const open = await deps.run(ghosttyOpenArgv(), 10_000)
  if (open.code !== 0) {
    deps.log(`spawn: Ghostty open failed (${open.stderr.trim() || `exit ${open.code}`}); ${r.sessionName} runs in herdr`)
    return r
  }
  return { ...r, app: "Ghostty" }
}

// "auto": herdr only (Stage 1). A gate failure comes back as herdr_unavailable
// and is logged; it never falls back to tmux.
export async function spawnMacAuto(
  cwd: string,
  agent: SpawnAgent,
  env: Record<string, string> | undefined,
  deps: {
    herdr: typeof spawnInHerdr
    log: (line: string) => void
  } = { herdr: spawnInHerdr, log: companionLog },
): Promise<SpawnResult> {
  const { fallback, ...r } = await deps.herdr(cwd, agent, env)
  if (fallback) deps.log(`spawn: herdr unavailable (${fallback}), no tmux fallback (herdr-only); fix herdr or ${HERDR_VERSIONS_ENV}`)
  return r
}

// Linux / headless server path (Zettlab). No GUI Terminal: "auto" is a herdr
// workspace on the host's herdr server (scripts/herdr-zettlab-setup.sh; panes
// sized by its headless_cols/rows = 220x60), nothing else: app "tmux" is
// refused upstream (spawnCompanionSession). Attach over SSH with
// `herdr --remote` / the Mac's `herdr machine`.
export function spawnLinux(
  cwd: string,
  app: SpawnApp,
  agent: SpawnAgent,
  env: Record<string, string> | undefined,
  deps: {
    herdr: typeof spawnInHerdr
    log: (line: string) => void
  } = { herdr: spawnInHerdr, log: companionLog },
): Promise<SpawnResult> {
  if (app === "ghostty") {
    return Promise.resolve({ ok: false, error: `app="${app}" is macOS-only; use "herdr" or "auto" on this server` })
  }
  if (app === "herdr") return deps.herdr(cwd, agent, env)
  return spawnMacAuto(cwd, agent, env, deps)
}

// A spawn in the bare home dir moves to ~/work on Linux. Claude Code's Linux
// sandbox (bwrap) masks .git/config, .git/hooks and .git/info/exclude of the cwd
// even when it isn't a repo, so every session started in ~ built a fake ~/.git
// full of 0-byte read-only stubs and appended its 19-line exclude block again
// (83 copies on Zettlab by 2026-09-29). Tools that walk up to the nearest .git
// then took ~ for a project root. macOS's sandbox doesn't do this, so the Mac
// keeps ~. Override with COMPANION_HOME_SPAWN_DIR.
export function homeSpawnCwd(
  resolved: string,
  env: { platform: string; home?: string; override?: string } = {
    platform: process.platform,
    home: process.env.HOME,
    override: process.env.COMPANION_HOME_SPAWN_DIR,
  },
): string {
  if (env.platform === "darwin" || !env.home) return resolved
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p)
  if (strip(resolved) !== strip(env.home)) return resolved
  const target = env.override?.trim() || `${strip(env.home)}/work`
  return target.startsWith("~") ? target.replace(/^~/, strip(env.home)) : target
}

// The phone's cwd → the directory a spawn starts in: absolute or ~-relative,
// ~ expanded (osascript runs outside a shell, and a shell spawn passes it as
// an argv entry), the Linux home remap applied, and an existing directory.
export function resolveSpawnCwd(raw: string): { dir: string } | { error: string } {
  const cwd = raw.trim()
  if (!cwd) return { error: "cwd required" }
  if (!cwd.startsWith("/") && !cwd.startsWith("~")) return { error: "cwd must be absolute" }
  const expanded = cwd.startsWith("~") ? cwd.replace(/^~/, process.env.HOME ?? "") : cwd
  const resolved = homeSpawnCwd(expanded)
  if (resolved !== expanded) {
    try {
      mkdirSync(resolved, { recursive: true })
    } catch (err) {
      return { error: `cannot create ${resolved}: ${(err as Error).message}` }
    }
  }
  if (!existsSync(resolved)) return { error: `cwd does not exist: ${resolved}` }
  if (!statSync(resolved).isDirectory()) return { error: `cwd is not a directory: ${resolved}` }
  return { dir: resolved }
}

export async function spawnCompanionSession(opts: {
  cwd: string
  // Untrusted from the route: retired names are refused below.
  app?: SpawnApp | string
  agent?: SpawnAgent
  // Extra environment for the spawned agent, exported inside its tmux command
  // so hooks launched by that agent inherit it (PRJ-OR1T Phase 8).
  env?: Record<string, string>
  // herdr only (takeover): a fixed agent name and claude args; a gate failure is
  // an error here, never a tmux fallback.
  herdr?: HerdrSpawnOpts
  // Takeover: the main checkout whose MCP-server choices the worktree inherits.
  mcpFrom?: string
}): Promise<SpawnResult> {
  // Stage 1: no new tmux sessions. Refused before the cwd is resolved or
  // trusted, so the request has no side effect. Existing tmux sessions keep
  // working: inject, mirror and dialogs resolve their pane as before.
  if (opts.app === "tmux") return { ok: false, error: TMUX_RETIRED }
  if (opts.app !== undefined && RETIRED_APPS.has(opts.app)) return { ok: false, error: APP_RETIRED, hint: APP_RETIRED_HINT }
  const cwd = resolveSpawnCwd(opts.cwd)
  if ("error" in cwd) return { ok: false, error: cwd.error }
  const resolved = cwd.dir

  const app = (opts.app ?? "auto") as SpawnApp
  const agent: SpawnAgent =
    opts.agent === "codex" || opts.agent === "kimi" ? opts.agent : "claude"

  // A kimi spawn with no env file would die inside /bin/sh before claude
  // starts — the tmux session vanishes and the phone never sees an error.
  // Fail the spawn request instead.
  if (agent === "kimi" && !existsSync(KIMI_ENV_FILE)) {
    return { ok: false, error: `kimi env file missing: ${KIMI_ENV_FILE}` }
  }

  // Trust the target dir before launching so claude doesn't hang at the
  // folder-trust dialog (codex has no such gate, so skip it there).
  if (agent !== "codex") ensureFolderTrusted(resolved, opts.mcpFrom)

  if (opts.herdr) {
    return spawnInTmuxDetached(resolved, agent, opts.env, realDetachedDeps, opts.herdr)
  }
  return spawnInTmuxDetached(resolved, agent, opts.env)
}
