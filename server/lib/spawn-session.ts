// Spawn a fresh Claude/Codex session from the companion (phone tap → new
// Terminal/iTerm window on the Mac, cd'd into a directory, agent already
// launched inside a tmux session). The usual session hooks pick up the
// new session within a second or two, and the phone picker sees it
// automatically.
//
// Why tmux: phone-spawned sessions land in the focus-race-prone osascript
// inject path otherwise. Wrapping the launch in `tmux new-session -s
// cc-<basename>` makes $TMUX_PANE available to the hook, so subsequent
// phone messages route via tmux send-keys (pane-keyed, focus-independent).
// If a session with that name already exists, we suffix `-2`, `-3`, ... so
// a re-tap launches a *new* agent instance instead of opening a second
// terminal window mirroring the first (tmux mirrors any session attached
// from multiple clients in real time, which looked like a "copy" bug).
//
// macOS "auto" now prefers herdr (spawnInHerdr below) when its version gate
// passes; the tmux path above is the fallback. Linux is tmux only.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { spawnNewSessionFlags, spawnServerFlags, spawnSocketPath, tmuxArgv } from "./tmux-pane"
import { type Herdr, herdrErrorCode, noteHerdrAgent, realHerdr } from "./herdr"
import { companionLog } from "./log"

// Claude Code blocks interactive startup at the "Do you trust the files in
// this folder?" dialog until the dir is accepted — and the SessionStart hook
// (how the companion learns a session exists) fires only AFTER trust. So a
// spawn into an untrusted dir just sits at the prompt forever and never
// registers: the phone shows nothing. Pre-seed trust for the target dir in
// ~/.claude.json so the spawned agent boots straight into the session. Once
// claude runs in a trusted dir it keeps the flag on exit, so this write is a
// one-time cost per dir.
function ensureFolderTrusted(cwd: string): void {
  const home = process.env.HOME
  if (!home) return
  const cfgPath = `${home}/.claude.json`
  let cfg: { projects?: Record<string, Record<string, unknown>> }
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")) } catch { return }
  const projects = cfg.projects ?? (cfg.projects = {})
  const entry = projects[cwd] ?? (projects[cwd] = {})
  if (entry.hasTrustDialogAccepted === true) return
  entry.hasTrustDialogAccepted = true
  try {
    const tmp = `${cfgPath}.companion-${process.pid}`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    renameSync(tmp, cfgPath)
  } catch { /* best-effort — worst case the trust dialog still appears */ }
}

export type SpawnApp = "terminal" | "iterm" | "tmux" | "herdr" | "auto"
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
// (Terminal, iTerm, headless tmux) so they can't drift apart. The env prefix
// precedes the `cd`, and therefore also the kimi `. kimi.env` sourcing.
export function buildInner(cwd: string, agent: SpawnAgent, env?: Record<string, string>): string {
  return `${envPrefix(env)}cd '${escapeForShellSingleQuoted(cwd)}' && ${agentLaunchCommand(agent)}`
}

export interface SpawnResult {
  ok: boolean
  app?: "Terminal" | "iTerm" | "tmux" | "herdr"
  sessionName?: string
  // Socket path of the tmux server the session landed on ("" = the default
  // server). Same form discovery records from $TMUX, so `-S` reaches it.
  tmuxSocket?: string
  // herdr spawns: the workspace's root pane (what hooks report as $HERDR_PANE_ID).
  herdrPane?: string
  // Set when herdr was not even tried (version gate / server down): the
  // caller may fall back to tmux. A failure after the gate never sets it — a
  // workspace may exist by then, and a fallback would start a second agent.
  fallback?: string
  error?: string
}

function escapeForShellSingleQuoted(s: string): string {
  // Wrapping in single quotes in the shell blocks interpolation; the only
  // escape we need is for embedded single quotes themselves.
  return s.replace(/'/g, `'\\''`)
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

async function runOsa(script: string, timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)
  await proc.exited
  if (timedOut) return { ok: false, stdout: stdout.trim(), stderr: "Terminal launch timed out" }
  return { ok: (proc.exitCode ?? 0) === 0, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function isAppRunning(appName: string): Promise<boolean> {
  // Avoid System Events here. AppleScript process-list checks can hang or
  // require extra automation permissions, which makes the phone-side spawn
  // request time out before Terminal is even opened.
  const proc = Bun.spawn(["pgrep", "-x", appName], { stdout: "ignore", stderr: "ignore" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, 1_000)
  const code = await proc.exited
  clearTimeout(timer)
  return !timedOut && code === 0
}

// Build a tmux-wrapped invocation. The result is a single shell command
// suitable for AppleScript's `do script` / iTerm's `write text`. Layout:
//
//   tmux new-session -s '<sess>' 'cd '\''<cwd>'\'' && claude' \; \
//     set-option -t '<sess>' detach-on-destroy on
//
// All single-quote nesting goes through escapeForShellSingleQuoted so paths
// containing apostrophes survive intact. tmux runs the inner command via
// /bin/sh so standard POSIX quoting applies.
//
// With COMPANION_TMUX_SOCKET set the line leads with `-L '<name>'` (and
// `-f '<conf>'`), so the window attaches to that server; the chained
// set-option rides the same client and so the same server. Unset → the exact
// pre-socket string.
//
// detach-on-destroy=on is forced per-session: when claude exits, the tmux
// client detaches cleanly and Terminal returns to its parent shell. Without
// this, a global `detach-on-destroy off` (Jeremie's setup) makes the client
// switch to a sibling tmux session — a stray `cc-…` from a cmd+W'd window
// or an unrelated long-lived session — which surfaces as "an emulation of
// another tmux terminal" appearing right when the user expected a clean exit.
export function buildTmuxLaunch(
  cwd: string,
  sessionName: string,
  agent: SpawnAgent,
  env?: Record<string, string>,
  serverEnv: Record<string, string | undefined> = process.env,
): string {
  const sessEscaped = escapeForShellSingleQuoted(sessionName)
  const innerEscaped = escapeForShellSingleQuoted(buildInner(cwd, agent, env))
  const server = spawnNewSessionFlags(serverEnv)
    .map((f) => (f.startsWith("-") ? f : `'${escapeForShellSingleQuoted(f)}'`))
    .map((f) => `${f} `)
    .join("")
  return (
    `tmux ${server}new-session -s '${sessEscaped}' '${innerEscaped}'`
    + ` \\; set-option -t '${sessEscaped}' detach-on-destroy on`
  )
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

function agentTmuxSessionName(cwd: string, agent: SpawnAgent): string {
  const prefix = agent === "codex" ? "cx" : agent === "kimi" ? "km" : "cc"
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

async function uniqueTmuxSessionName(cwd: string, agent: SpawnAgent): Promise<string> {
  const base = agentTmuxSessionName(cwd, agent)
  if (!(await tmuxSessionExists(base))) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!(await tmuxSessionExists(candidate))) return candidate
  }
  return `${base}-${Date.now()}`
}

async function spawnInTerminal(cwd: string, agent: SpawnAgent, env?: Record<string, string>): Promise<SpawnResult> {
  const sessionName = await uniqueTmuxSessionName(cwd, agent)
  const cmd = buildTmuxLaunch(cwd, sessionName, agent, env)
  const cmdEscaped = escapeForAppleScript(cmd)
  const r = await runOsa(`
    tell application "Terminal"
      activate
      do script "${cmdEscaped}"
    end tell
    return "OK"
  `)
  if (!r.ok) return { ok: false, app: "Terminal", error: r.stderr || "Terminal spawn failed" }
  return { ok: true, app: "Terminal", sessionName, tmuxSocket: spawnSocketPath() }
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
async function spawnInTmuxDetached(cwd: string, agent: SpawnAgent, env?: Record<string, string>): Promise<SpawnResult> {
  const sessionName = await uniqueTmuxSessionName(cwd, agent)
  const inner = buildInner(cwd, agent, env)
  // Create the session detached, at an explicit size (see
  // detachedNewSessionArgs — an 80x24 pane cripples every dialog we read).
  // Run the inner command via /bin/sh so the single-quote escaping works.
  // tmux passes through $TMUX/$TMUX_PANE so the session-start hook fires the
  // moment claude initializes.
  const create = Bun.spawn(
    detachedSpawnArgv(sessionName, inner),
    { stdout: "pipe", stderr: "pipe" },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    create.kill()
  }, 8_000)
  const stderr = await new Response(create.stderr).text()
  const code = await create.exited
  clearTimeout(timer)
  if (timedOut) return { ok: false, app: "tmux", error: "tmux new-session timed out" }
  if (code !== 0) return { ok: false, app: "tmux", error: stderr.trim() || `tmux exit ${code}` }

  // Force detach-on-destroy so a human attaching later (`tmux attach -t
  // cc-foo`) is dropped back to their shell when claude exits — instead of
  // tmux switching them to some unrelated sibling session. Best-effort:
  // failure here is non-fatal, the session still works.
  const opt = Bun.spawn(
    [...tmuxArgv(), ...spawnServerFlags(), "set-option", "-t", sessionName, "detach-on-destroy", "on"],
    { stdout: "ignore", stderr: "ignore" },
  )
  await opt.exited

  // Socket path resolved after the create: the server (and its dir) now exist.
  return { ok: true, app: "tmux", sessionName, tmuxSocket: spawnSocketPath() }
}

async function spawnInIterm(cwd: string, agent: SpawnAgent, env?: Record<string, string>): Promise<SpawnResult> {
  const sessionName = await uniqueTmuxSessionName(cwd, agent)
  const cmd = buildTmuxLaunch(cwd, sessionName, agent, env)
  const cmdEscaped = escapeForAppleScript(cmd)
  // iTerm's AppleScript dictionary: create window with default profile, then
  // write text into its current session.
  const r = await runOsa(`
    tell application "iTerm"
      activate
      set newWindow to (create window with default profile)
      tell current session of newWindow
        write text "${cmdEscaped}"
      end tell
    end tell
    return "OK"
  `)
  if (!r.ok) return { ok: false, app: "iTerm", error: r.stderr || "iTerm spawn failed" }
  return { ok: true, app: "iTerm", sessionName, tmuxSocket: spawnSocketPath() }
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

export async function spawnInHerdr(
  cwd: string,
  agent: SpawnAgent,
  env?: Record<string, string>,
  h: Herdr = realHerdr,
): Promise<SpawnResult> {
  const envArgs = checkEnv(env).flatMap(([k, v]) => ["--env", `${k}=${v}`])
  const gate = await h.gate()
  if (gate) return { ok: false, app: "herdr", error: gate, fallback: gate }

  const name = await uniqueHerdrAgentName(cwd, agent, h)
  let paneId = ""
  let workspaceId = ""
  try {
    const r = await h.call(["workspace", "create", "--cwd", cwd, "--label", name, ...envArgs, "--no-focus"])
    workspaceId = (r.workspace as { workspace_id?: string } | undefined)?.workspace_id ?? ""
    paneId = (r.root_pane as { pane_id?: string } | undefined)?.pane_id ?? ""
  } catch (err) {
    return { ok: false, app: "herdr", error: `herdr workspace create: ${(err as Error).message}` }
  }
  if (!paneId) return { ok: false, app: "herdr", error: "herdr workspace create: no root_pane.pane_id" }

  try {
    if (agent === "kimi") await h.call(["pane", "run", paneId, KIMI_SOURCE])
    await h.call(
      ["agent", "start", name, "--kind", agent === "codex" ? "codex" : "claude", "--pane", paneId, "--timeout", String(HERDR_START_TIMEOUT_MS)],
      HERDR_START_TIMEOUT_MS + 5_000,
    )
  } catch (err) {
    // Blocked during startup (a dialog): the agent runs and its hooks will
    // register it — the phone can answer from there.
    if (herdrErrorCode(err) !== "agent_not_ready") {
      if (workspaceId) await h.call(["workspace", "close", workspaceId]).catch(() => undefined)
      return { ok: false, app: "herdr", error: `herdr agent start: ${(err as Error).message}` }
    }
  }
  noteHerdrAgent(paneId, name)
  return { ok: true, app: "herdr", sessionName: name, herdrPane: paneId }
}

// macOS "auto": herdr when its gate passes, else today's Terminal/iTerm tmux
// path. Only a gate failure falls back (see SpawnResult.fallback).
export async function spawnMacAuto(
  cwd: string,
  agent: SpawnAgent,
  env: Record<string, string> | undefined,
  deps: {
    herdr: typeof spawnInHerdr
    legacy: (cwd: string, agent: SpawnAgent, env?: Record<string, string>) => Promise<SpawnResult>
    log: (line: string) => void
  } = { herdr: spawnInHerdr, legacy: spawnMacTerminalAuto, log: companionLog },
): Promise<SpawnResult> {
  const r = await deps.herdr(cwd, agent, env)
  if (r.ok || !r.fallback) return r
  deps.log(`spawn: herdr skipped (${r.fallback}) — falling back to tmux`)
  return deps.legacy(cwd, agent, env)
}

// The pre-herdr macOS auto: prefer the app that's already running. If both,
// prefer Terminal (that's what today's sessions show); if neither, launch
// Terminal.
async function spawnMacTerminalAuto(cwd: string, agent: SpawnAgent, env?: Record<string, string>): Promise<SpawnResult> {
  const [terminalRunning, itermRunning] = await Promise.all([
    isAppRunning("Terminal"),
    isAppRunning("iTerm2"),
  ])
  if (terminalRunning) return spawnInTerminal(cwd, agent, env)
  if (itermRunning) return spawnInIterm(cwd, agent, env)
  return spawnInTerminal(cwd, agent, env)
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

export async function spawnCompanionSession(opts: {
  cwd: string
  app?: SpawnApp
  agent?: SpawnAgent
  // Extra environment for the spawned agent, exported inside its tmux command
  // so hooks launched by that agent inherit it (PRJ-OR1T Phase 8).
  env?: Record<string, string>
}): Promise<SpawnResult> {
  const cwd = opts.cwd.trim()
  if (!cwd) return { ok: false, error: "cwd required" }
  if (!cwd.startsWith("/") && !cwd.startsWith("~")) {
    return { ok: false, error: "cwd must be absolute" }
  }
  // Expand ~ manually — osascript runs outside a shell so ~ isn't expanded.
  const expanded = cwd.startsWith("~")
    ? cwd.replace(/^~/, process.env.HOME ?? "")
    : cwd
  const resolved = homeSpawnCwd(expanded)
  if (resolved !== expanded) {
    try {
      mkdirSync(resolved, { recursive: true })
    } catch (err) {
      return { ok: false, error: `cannot create ${resolved}: ${(err as Error).message}` }
    }
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `cwd does not exist: ${resolved}` }
  }

  const app: SpawnApp = opts.app ?? "auto"
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
  if (agent !== "codex") ensureFolderTrusted(resolved)

  // Linux / headless server path. macOS-only apps don't apply, and there's
  // no GUI Terminal to open — every spawn just creates a detached tmux
  // session. The user can attach with `tmux attach` over SSH if they want
  // to interact directly; iOS routes via the tmux pane regardless.
  if (process.platform !== "darwin") {
    if (app === "terminal" || app === "iterm") {
      return { ok: false, error: `app="${app}" is macOS-only; use "tmux" or "auto" on this server` }
    }
    return spawnInTmuxDetached(resolved, agent, opts.env)
  }

  if (app === "tmux") return spawnInTmuxDetached(resolved, agent, opts.env)
  if (app === "iterm") return spawnInIterm(resolved, agent, opts.env)
  if (app === "terminal") return spawnInTerminal(resolved, agent, opts.env)
  if (app === "herdr") return spawnInHerdr(resolved, agent, opts.env)
  return spawnMacAuto(resolved, agent, opts.env)
}
