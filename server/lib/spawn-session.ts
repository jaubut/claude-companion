// Spawn a fresh Claude Code session from the companion (phone tap → new
// Terminal/iTerm window on the Mac, cd'd into a directory, claude already
// launched inside a tmux session). The usual session hooks pick up the
// new session within a second or two, and the phone picker sees it
// automatically.
//
// Why tmux: phone-spawned sessions land in the focus-race-prone osascript
// inject path otherwise. Wrapping the launch in `tmux new-session -s
// cc-<basename>` makes $TMUX_PANE available to the hook, so subsequent
// phone messages route via tmux send-keys (pane-keyed, focus-independent).
// If a session with that name already exists, we suffix `-2`, `-3`, … so
// a re-tap launches a *new* claude instance instead of opening a second
// terminal window mirroring the first (tmux mirrors any session attached
// from multiple clients in real time, which looked like a "copy" bug).

import { existsSync } from "node:fs"

export type SpawnApp = "terminal" | "iterm" | "auto"

export interface SpawnResult {
  ok: boolean
  app?: "Terminal" | "iTerm"
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

async function runOsa(script: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { ok: (proc.exitCode ?? 0) === 0, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function isAppRunning(appName: string): Promise<boolean> {
  const r = await runOsa(`tell application "System Events" to return (name of processes) contains "${appName}"`)
  return r.ok && r.stdout.toLowerCase() === "true"
}

// Build a tmux-wrapped invocation. The result is a single shell command
// suitable for AppleScript's `do script` / iTerm's `write text`. Layout:
//
//   tmux new-session -s '<sess>' 'cd '\''<cwd>'\'' && claude'
//
// All single-quote nesting goes through escapeForShellSingleQuoted so paths
// containing apostrophes survive intact. tmux runs the inner command via
// /bin/sh so standard POSIX quoting applies.
function buildTmuxLaunch(cwd: string, sessionName: string): string {
  const sessEscaped = escapeForShellSingleQuoted(sessionName)
  const cwdEscaped = escapeForShellSingleQuoted(cwd)
  const inner = `cd '${cwdEscaped}' && claude`
  const innerEscaped = escapeForShellSingleQuoted(inner)
  return `tmux new-session -s '${sessEscaped}' '${innerEscaped}'`
}

// tmux session names cannot contain ':' or '.', and whitespace is awkward
// for later `tmux attach -t` from a shell. Collapse to '-' and prefix with
// 'cc-' so these stand out from manually-created tmux sessions.
function tmuxSessionName(cwd: string): string {
  const base = cwd.split("/").filter(Boolean).pop() ?? "session"
  const safe = base.replace(/[:.]/g, "-").replace(/\s+/g, "-")
  return `cc-${safe}`
}

// `=name` forces an exact match — without it, tmux treats the target as a
// prefix and `cc-foo` would falsely report existing because `cc-foo-2` is.
async function tmuxSessionExists(name: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "has-session", "-t", `=${name}`], {
    stdout: "ignore",
    stderr: "ignore",
  })
  await proc.exited
  return (proc.exitCode ?? 1) === 0
}

async function uniqueTmuxSessionName(cwd: string): Promise<string> {
  const base = tmuxSessionName(cwd)
  if (!(await tmuxSessionExists(base))) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!(await tmuxSessionExists(candidate))) return candidate
  }
  return `${base}-${Date.now()}`
}

async function spawnInTerminal(cwd: string): Promise<SpawnResult> {
  const sessionName = await uniqueTmuxSessionName(cwd)
  const cmd = buildTmuxLaunch(cwd, sessionName)
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

async function spawnInIterm(cwd: string): Promise<SpawnResult> {
  const sessionName = await uniqueTmuxSessionName(cwd)
  const cmd = buildTmuxLaunch(cwd, sessionName)
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

export async function spawnClaudeSession(opts: { cwd: string; app?: SpawnApp }): Promise<SpawnResult> {
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
  if (app === "iterm") return spawnInIterm(resolved)
  if (app === "terminal") return spawnInTerminal(resolved)

  // Auto: prefer the app that's already running. If both, prefer Terminal
  // (that's what today's sessions show); if neither, launch Terminal.
  const [terminalRunning, itermRunning] = await Promise.all([
    isAppRunning("Terminal"),
    isAppRunning("iTerm2"),
  ])
  if (terminalRunning) return spawnInTerminal(resolved)
  if (itermRunning) return spawnInIterm(resolved)
  return spawnInTerminal(resolved)
}
