import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

// macOS launchd integration so the companion server auto-starts at login
// and restarts if it crashes.
//
// Subcommands:
//   bun cli.ts daemon install    Write LaunchAgent plist + load it
//   bun cli.ts daemon uninstall  Unload + remove plist
//   bun cli.ts daemon status     Show whether it's loaded + current PID
//   bun cli.ts daemon logs       Tail the log file
//
// LaunchAgent (per-user) rather than LaunchDaemon: the server needs the
// user's macOS Accessibility permission to inject keystrokes into Terminal,
// which only applies to processes running in the user's session.

const LABEL = "com.techlabstudio.claude-companion"
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
const LOG_PATH = join(homedir(), ".claude-companion", "companion.log")
const REPO_ROOT = resolve(import.meta.dir, "..")
const CLI_PATH = join(REPO_ROOT, "cli.ts")

const dim = "\x1b[2m"
const reset = "\x1b[0m"
const cyan = "\x1b[36m"
const green = "\x1b[32m"
const yellow = "\x1b[33m"
const red = "\x1b[31m"
const bold = "\x1b[1m"

export async function daemonInstall(): Promise<void> {
  console.log(`${bold}Claude Companion · daemon install${reset}\n`)

  // If port 4245 is already taken by something we don't manage, refuse —
  // otherwise launchd will spin in a restart loop and bury the real cause.
  const occupant = await whoOwnsPort(4245)
  if (occupant && !occupant.label?.startsWith(LABEL)) {
    console.error(`${red}! port 4245 is already bound by:${reset}`)
    console.error(`  pid ${occupant.pid}  ${dim}${occupant.command}${reset}`)
    console.error(`\nKill that process first (so launchd's instance can bind),`)
    console.error(`then re-run: ${cyan}bun cli.ts daemon install${reset}`)
    process.exit(1)
  }

  mkdirSync(dirname(PLIST_PATH), { recursive: true })
  mkdirSync(dirname(LOG_PATH), { recursive: true })

  const bun = process.execPath
  const plist = renderPlist({ bun, cliPath: CLI_PATH, workingDir: REPO_ROOT, logPath: LOG_PATH })
  writeFileSync(PLIST_PATH, plist)
  console.log(`${green}✓${reset} wrote ${dim}${PLIST_PATH}${reset}`)

  // Unload first in case a stale copy is loaded (idempotent).
  await runQuiet(["launchctl", "unload", PLIST_PATH])
  const loaded = await runOrFail(["launchctl", "load", PLIST_PATH])
  if (!loaded) {
    console.error(`${red}! launchctl load failed${reset}`)
    process.exit(1)
  }
  console.log(`${green}✓${reset} loaded as ${cyan}${LABEL}${reset}`)
  console.log(`${dim}  log: ${LOG_PATH}${reset}`)
  console.log(`\n${dim}check status anytime: ${cyan}bun cli.ts daemon status${reset}`)
}

export async function daemonUninstall(): Promise<void> {
  console.log(`${bold}Claude Companion · daemon uninstall${reset}\n`)
  if (!existsSync(PLIST_PATH)) {
    console.log(`${yellow}no LaunchAgent installed at ${PLIST_PATH}${reset}`)
    return
  }
  await runQuiet(["launchctl", "unload", PLIST_PATH])
  unlinkSync(PLIST_PATH)
  console.log(`${green}✓${reset} unloaded + removed ${dim}${PLIST_PATH}${reset}`)
  console.log(`${dim}note: ${LOG_PATH} is preserved.${reset}`)
}

export async function daemonStatus(): Promise<void> {
  if (!existsSync(PLIST_PATH)) {
    console.log(`${dim}LaunchAgent: ${reset}${yellow}not installed${reset}`)
    console.log(`${dim}install with: ${cyan}bun cli.ts daemon install${reset}`)
    return
  }
  console.log(`${dim}LaunchAgent: ${reset}${green}installed${reset} ${dim}(${PLIST_PATH})${reset}`)

  const proc = Bun.spawn({ cmd: ["launchctl", "list", LABEL], stdout: "pipe", stderr: "pipe" })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    console.log(`${dim}State: ${reset}${yellow}loaded but not running${reset}`)
    return
  }
  const pidMatch = /"PID"\s*=\s*(\d+)/.exec(text)
  const exitMatch = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(text)
  if (pidMatch) {
    console.log(`${dim}State: ${reset}${green}running${reset} ${dim}(pid ${pidMatch[1]})${reset}`)
  } else {
    const lastExit = exitMatch ? exitMatch[1] : "unknown"
    console.log(`${dim}State: ${reset}${yellow}not running${reset} ${dim}(last exit ${lastExit})${reset}`)
    console.log(`${dim}check log: ${cyan}bun cli.ts daemon logs${reset}`)
  }

  // Liveness probe — confirm the running process actually serves /health.
  const live = await fetchHealth()
  if (live) {
    console.log(`${dim}Health: ${reset}${green}ok${reset}`)
  } else {
    console.log(`${dim}Health: ${reset}${yellow}not reachable on :4245${reset}`)
  }
}

export async function daemonLogs(): Promise<void> {
  if (!existsSync(LOG_PATH)) {
    console.log(`${yellow}no log yet at ${LOG_PATH}${reset}`)
    console.log(`${dim}server hasn't run under launchd yet — install + wait for first start${reset}`)
    return
  }
  console.log(`${dim}tailing ${LOG_PATH} — Ctrl+C to stop${reset}\n`)
  const proc = Bun.spawn({
    cmd: ["tail", "-n", "50", "-f", LOG_PATH],
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
}

// MARK: - helpers

interface PlistContext {
  bun: string
  cliPath: string
  workingDir: string
  logPath: string
}

function renderPlist({ bun, cliPath, workingDir, logPath }: PlistContext): string {
  // PATH covers the typical install locations bun's child processes expect
  // (sh hooks, osascript, ps, lsof, etc.) — launchd does not inherit a login
  // shell PATH so we set it explicitly.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(bun)}</string>
        <string>${escapeXml(cliPath)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(workingDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${escapeXml(homedir())}</string>
    </dict>
</dict>
</plist>
`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

async function runQuiet(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" })
  await proc.exited
}

async function runOrFail(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn({ cmd, stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  return code === 0
}

async function fetchHealth(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1500)
    const r = await fetch("http://127.0.0.1:4245/health", { signal: ctrl.signal })
    clearTimeout(timer)
    return r.ok
  } catch {
    return false
  }
}

interface PortOwner { pid: string; command: string; label: string | null }

async function whoOwnsPort(port: number): Promise<PortOwner | null> {
  const proc = Bun.spawn({
    cmd: ["lsof", "-iTCP:" + port, "-sTCP:LISTEN", "-nP", "-Fpc"],
    stdout: "pipe",
    stderr: "ignore",
  })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0 || !text.trim()) return null
  // -F output: lines beginning p<pid> and c<command>
  const pidLine = text.match(/^p(\d+)/m)
  const cmdLine = text.match(/^c(.+)/m)
  if (!pidLine) return null
  return { pid: pidLine[1], command: cmdLine?.[1] ?? "?", label: null }
}
