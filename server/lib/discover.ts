// Discover live Claude Code processes and register them in the session
// picker on boot, so terminals that are running but idle show up without
// requiring the user to manually fire a tool call first.
//
// Rehydrate (transcript-based) only picks up sessions that wrote to a
// transcript in the last 30 min — an idle session misses that window.
// Process scanning catches those too.

import { readdir, stat } from "node:fs/promises"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import { recordSession } from "./sessions"

const PROJECTS_DIR = join(homedir(), ".claude", "projects")

interface DiscoveredClaude {
  pid: string
  tty: string
  cwd: string
}

async function run(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

async function listClaudePids(): Promise<DiscoveredClaude[]> {
  // `ps -axo pid=,tty=,command=` includes kernel/agent threads; filter for
  // `command` that is exactly "claude" (the CLI entrypoint), not child procs
  // like `node /path/to/claude-pipeline/...` or our own companion server.
  const raw = await run("ps", ["-axo", "pid=,tty=,command="])
  const out: DiscoveredClaude[] = []
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!m) continue
    const [, pid, tty, command] = m
    if (!pid || !tty || !command) continue
    // Real tty only — skip ?? (detached)
    if (tty === "??" || tty === "-") continue
    // Exact CLI match — `claude` or an absolute path ending in /claude
    const trimmed = command.trim()
    const cmdBase = trimmed.split(/\s+/)[0] ?? ""
    if (cmdBase !== "claude" && !/\/claude$/.test(cmdBase)) continue
    out.push({ pid, tty: `/dev/${tty}`, cwd: "" })
  }
  return out
}

async function findCwdForPid(pid: string): Promise<string> {
  // `lsof -p PID -a -d cwd -Fn` is stable across macOS versions. The `n` line
  // starts with "n" and contains the path.
  const raw = await run("lsof", ["-p", pid, "-a", "-d", "cwd", "-Fn"])
  for (const line of raw.split("\n")) {
    if (line.startsWith("n")) return line.slice(1).trim()
  }
  return ""
}

// Walk up the pid chain from a claude process to the root (ppid=1) to find
// the terminal app hosting the tty. Used to set termProgram so keyboard-inject
// targets only the app that actually owns the session — without this the
// fallback osascript references both iTerm and Terminal.app, and the mere
// mention of `tell application "iTerm"` launches iTerm and steals focus.
async function findTermProgramForPid(pid: string): Promise<string> {
  let current = pid
  for (let i = 0; i < 16; i++) {
    const raw = await run("ps", ["-p", current, "-o", "ppid=,command="])
    const line = raw.trim()
    if (!line) return ""
    const m = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!m) return ""
    const [, ppid, command] = m
    if (!ppid || !command) return ""
    if (/Terminal\.app\/Contents\/MacOS\/Terminal\b/i.test(command)) return "Apple_Terminal"
    if (/iTerm(?:2)?\.app\/Contents\/MacOS\/iTerm2?\b/i.test(command)) return "iTerm.app"
    if (/Ghostty\.app\/Contents\/MacOS\/ghostty\b/i.test(command)) return "ghostty"
    if (/Alacritty\.app\/Contents\/MacOS\/alacritty\b/i.test(command)) return "alacritty"
    if (/WezTerm\.app\/Contents\/MacOS\/wezterm-gui\b/i.test(command)) return "WezTerm"
    if (ppid === "1" || ppid === "0") return ""
    current = ppid
  }
  return ""
}

async function findSessionIdForCwd(cwd: string): Promise<string> {
  if (!cwd) return ""
  // Transcripts are grouped by cwd into dirs named after the cwd with `/`
  // replaced by `-`. Find the most recently modified jsonl in the matching
  // dir — that's our best guess for the live session id.
  const dirName = cwd.replace(/\//g, "-")
  const dir = join(PROJECTS_DIR, dirName)
  let files: string[]
  try { files = await readdir(dir) } catch { return "" }

  let bestFile = ""
  let bestMtime = 0
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue
    try {
      const st = await stat(join(dir, f))
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs
        bestFile = f
      }
    } catch { /* skip */ }
  }
  return bestFile ? basename(bestFile, ".jsonl") : ""
}

export async function discoverLiveClaudes(): Promise<{ registered: number }> {
  let registered = 0
  let pids: DiscoveredClaude[]
  try {
    pids = await listClaudePids()
  } catch { return { registered: 0 } }

  await Promise.all(pids.map(async (p) => {
    try {
      const [cwd, termProgram] = await Promise.all([
        findCwdForPid(p.pid),
        findTermProgramForPid(p.pid),
      ])
      if (!cwd) return
      const sessionId = await findSessionIdForCwd(cwd)
      recordSession({ cwd, sessionId, tty: p.tty, pid: p.pid, termProgram }, { provisional: true })
      registered++
    } catch { /* one bad pid doesn't fail the rest */ }
  }))

  return { registered }
}
