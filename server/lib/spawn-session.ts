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

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs"

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

export type SpawnApp = "terminal" | "iterm" | "tmux" | "auto"
export type SpawnAgent = "claude" | "codex"

export interface SpawnResult {
  ok: boolean
  app?: "Terminal" | "iTerm" | "tmux"
  sessionName?: string
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
// detach-on-destroy=on is forced per-session: when claude exits, the tmux
// client detaches cleanly and Terminal returns to its parent shell. Without
// this, a global `detach-on-destroy off` (Jeremie's setup) makes the client
// switch to a sibling tmux session — a stray `cc-…` from a cmd+W'd window
// or an unrelated long-lived session — which surfaces as "an emulation of
// another tmux terminal" appearing right when the user expected a clean exit.
function buildTmuxLaunch(cwd: string, sessionName: string, agent: SpawnAgent): string {
  const sessEscaped = escapeForShellSingleQuoted(sessionName)
  const cwdEscaped = escapeForShellSingleQuoted(cwd)
  const inner = `cd '${cwdEscaped}' && ${agent}`
  const innerEscaped = escapeForShellSingleQuoted(inner)
  return (
    `tmux new-session -s '${sessEscaped}' '${innerEscaped}'`
    + ` \\; set-option -t '${sessEscaped}' detach-on-destroy on`
  )
}

function agentTmuxSessionName(cwd: string, agent: SpawnAgent): string {
  const prefix = agent === "codex" ? "cx" : "cc"
  const base = cwd.split("/").filter(Boolean).pop() ?? "session"
  const safe = base.replace(/[:.]/g, "-").replace(/\s+/g, "-")
  return `${prefix}-${safe}`
}

// `=name` forces an exact match — without it, tmux treats the target as a
// prefix and `cc-foo` would falsely report existing because `cc-foo-2` is.
async function tmuxSessionExists(name: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "has-session", "-t", `=${name}`], {
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

async function spawnInTerminal(cwd: string, agent: SpawnAgent): Promise<SpawnResult> {
  const sessionName = await uniqueTmuxSessionName(cwd, agent)
  const cmd = buildTmuxLaunch(cwd, sessionName, agent)
  const cmdEscaped = escapeForAppleScript(cmd)
  const r = await runOsa(`
    tell application "Terminal"
      activate
      do script "${cmdEscaped}"
    end tell
    return "OK"
  `)
  if (!r.ok) return { ok: false, app: "Terminal", error: r.stderr || "Terminal spawn failed" }
  return { ok: true, app: "Terminal" }
}

// Headless tmux spawn — the Linux/server path. No GUI Terminal to open;
// we just create a detached tmux session running the agent at the given cwd.
// The session-start hook (~/.claude/hooks/companion-session-start.sh) picks
// it up via $TMUX_PANE the moment Claude initializes inside the pane, so
// subsequent phone messages route via tmux send-keys exactly like the Mac
// path.
//
// Attaching from a human shell (when you want to peek): ssh aubut@zettlab
// then `tmux attach -t cc-<name>`. detach-on-destroy=on so claude exiting
// cleanly drops you back to the shell instead of switching sessions.
async function spawnInTmuxDetached(cwd: string, agent: SpawnAgent): Promise<SpawnResult> {
  const sessionName = await uniqueTmuxSessionName(cwd, agent)
  const cwdEscaped = escapeForShellSingleQuoted(cwd)
  const inner = `cd '${cwdEscaped}' && ${agent}`
  // Create the session detached. Run the inner command via /bin/sh so the
  // single-quote escaping works. tmux passes through $TMUX/$TMUX_PANE so
  // the session-start hook fires the moment claude initializes.
  const create = Bun.spawn(
    ["tmux", "new-session", "-d", "-s", sessionName, "/bin/sh", "-c", inner],
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
    ["tmux", "set-option", "-t", sessionName, "detach-on-destroy", "on"],
    { stdout: "ignore", stderr: "ignore" },
  )
  await opt.exited

  return { ok: true, app: "tmux", sessionName }
}

async function spawnInIterm(cwd: string, agent: SpawnAgent): Promise<SpawnResult> {
  const sessionName = await uniqueTmuxSessionName(cwd, agent)
  const cmd = buildTmuxLaunch(cwd, sessionName, agent)
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
  return { ok: true, app: "iTerm" }
}

export async function spawnCompanionSession(opts: { cwd: string; app?: SpawnApp; agent?: SpawnAgent }): Promise<SpawnResult> {
  const cwd = opts.cwd.trim()
  if (!cwd) return { ok: false, error: "cwd required" }
  if (!cwd.startsWith("/") && !cwd.startsWith("~")) {
    return { ok: false, error: "cwd must be absolute" }
  }
  // Expand ~ manually — osascript runs outside a shell so ~ isn't expanded.
  const resolved = cwd.startsWith("~")
    ? cwd.replace(/^~/, process.env.HOME ?? "")
    : cwd
  if (!existsSync(resolved)) {
    return { ok: false, error: `cwd does not exist: ${resolved}` }
  }

  const app: SpawnApp = opts.app ?? "auto"
  const agent: SpawnAgent = opts.agent === "codex" ? "codex" : "claude"

  // Trust the target dir before launching so claude doesn't hang at the
  // folder-trust dialog (codex has no such gate, so skip it there).
  if (agent === "claude") ensureFolderTrusted(resolved)

  // Linux / headless server path. macOS-only apps don't apply, and there's
  // no GUI Terminal to open — every spawn just creates a detached tmux
  // session. The user can attach with `tmux attach` over SSH if they want
  // to interact directly; iOS routes via the tmux pane regardless.
  if (process.platform !== "darwin") {
    if (app === "terminal" || app === "iterm") {
      return { ok: false, error: `app="${app}" is macOS-only; use "tmux" or "auto" on this server` }
    }
    return spawnInTmuxDetached(resolved, agent)
  }

  if (app === "tmux") return spawnInTmuxDetached(resolved, agent)
  if (app === "iterm") return spawnInIterm(resolved, agent)
  if (app === "terminal") return spawnInTerminal(resolved, agent)

  // macOS Auto: prefer the app that's already running. If both, prefer
  // Terminal (that's what today's sessions show); if neither, launch Terminal.
  const [terminalRunning, itermRunning] = await Promise.all([
    isAppRunning("Terminal"),
    isAppRunning("iTerm2"),
  ])
  if (terminalRunning) return spawnInTerminal(resolved, agent)
  if (itermRunning) return spawnInIterm(resolved, agent)
  return spawnInTerminal(resolved, agent)
}

export async function spawnClaudeSession(opts: { cwd: string; app?: SpawnApp }): Promise<SpawnResult> {
  return spawnCompanionSession({ ...opts, agent: "claude" })
}
