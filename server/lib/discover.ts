// Discover live Claude/Codex processes and register them in the session
// picker on boot, so terminals that are running but idle show up without
// requiring the user to manually fire a tool call first.
//
// Rehydrate (transcript-based) only picks up sessions that wrote to a
// transcript in the last 30 min — an idle session misses that window.
// Process scanning catches those too.

import { readdir, stat } from "node:fs/promises"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import { recordSession } from "./sessions"

const PROJECTS_DIR = join(homedir(), ".claude", "projects")
const CODEX_STATE_DB = join(homedir(), ".codex", "state_5.sqlite")
const CODEX_START_MATCH_WINDOW_MS = 2 * 60 * 1000

interface DiscoveredAgent {
  agent: "claude" | "codex"
  pid: string
  tty: string
  cwd: string
  command: string
}

interface CodexThreadRef {
  id: string
  title: string
  first_user_message: string
  createdAtMs: number
}

async function run(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

async function listAgentPids(): Promise<DiscoveredAgent[]> {
  // `ps -axo pid=,tty=,command=` includes kernel/agent threads; filter for
  // exact CLI entrypoints, not child procs or our own companion server.
  const raw = await run("ps", ["-axo", "pid=,tty=,command="])
  const out: DiscoveredAgent[] = []
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!m) continue
    const [, pid, tty, command] = m
    if (!pid || !tty || !command) continue
    // Real tty only — skip ?? (detached)
    if (tty === "??" || tty === "-") continue
    // Exact CLI match — `claude`/`codex` or an absolute path ending in that
    // binary name.
    const trimmed = command.trim()
    const parts = trimmed.split(/\s+/)
    const cmdBase = parts[0] ?? ""
    const base = cmdBase.split("/").pop() ?? cmdBase
    if (base !== "claude" && base !== "codex") continue
    // `codex exec` workers are non-interactive job runners. They write useful
    // logs, but there is no terminal conversation for the phone to inject into,
    // so keep the live session picker focused on interactive Codex instances.
    if (base === "codex" && parts.slice(1).some((part) => part === "exec" || part === "app-server")) continue
    out.push({ agent: base, pid, tty: `/dev/${tty}`, cwd: "", command: trimmed })
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

async function findClaudeSessionIdForCwd(cwd: string): Promise<string> {
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

async function findProcessStartMs(pid: string): Promise<number> {
  const raw = await run("ps", ["-p", pid, "-o", "lstart="])
  const start = Date.parse(raw.trim())
  return Number.isFinite(start) ? start : 0
}

function resumedCodexThreadId(command: string): string {
  const m = command.match(/\bresume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
  return m?.[1] ?? ""
}

function codexThreadLabel(thread: CodexThreadRef, tty: string): string {
  const raw = (thread.title || thread.first_user_message || "Codex").replace(/\s+/g, " ").trim()
  const title = raw.length > 46 ? `${raw.slice(0, 45)}…` : raw
  const tag = tty.match(/ttys?(\d+)$/)?.[1]
  return tag ? `${title} · s${tag}` : title
}

async function findCodexThreadForPid(pid: string, cwd: string, command: string): Promise<CodexThreadRef | null> {
  if (!cwd) return null

  try {
    const db = new Database(CODEX_STATE_DB, { readonly: true })
    try {
      const resumedId = resumedCodexThreadId(command)
      if (resumedId) {
        const row = db.query(`
          select
            id,
            title,
            first_user_message,
            coalesce(created_at_ms, created_at * 1000) as createdAtMs
          from threads
          where id = ? and source = 'cli' and archived = 0
          limit 1
        `).get(resumedId) as CodexThreadRef | null
        if (row) return row
      }

      const startedAt = await findProcessStartMs(pid)
      if (!startedAt) return null

      return db.query(`
        select
          id,
          title,
          first_user_message,
          coalesce(created_at_ms, created_at * 1000) as createdAtMs
        from threads
        where source = 'cli'
          and archived = 0
          and cwd = ?
          and abs(coalesce(created_at_ms, created_at * 1000) - ?) <= ?
        order by abs(coalesce(created_at_ms, created_at * 1000) - ?) asc
        limit 1
      `).get(cwd, startedAt, CODEX_START_MATCH_WINDOW_MS, startedAt) as CodexThreadRef | null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export async function discoverLiveClaudes(): Promise<{ registered: number }> {
  let registered = 0
  let pids: DiscoveredAgent[]
  try {
    pids = await listAgentPids()
  } catch { return { registered: 0 } }

  await Promise.all(pids.map(async (p) => {
    try {
      const [cwd, termProgram] = await Promise.all([
        findCwdForPid(p.pid),
        findTermProgramForPid(p.pid),
      ])
      if (!cwd) return
      if (p.agent === "codex") {
        const thread = await findCodexThreadForPid(p.pid, cwd, p.command)
        recordSession({
          agent: p.agent,
          cwd,
          sessionId: thread?.id ?? "",
          tty: p.tty,
          pid: p.pid,
          termProgram,
          label: thread ? codexThreadLabel(thread, p.tty) : undefined,
        }, { provisional: true })
      } else {
        const sessionId = await findClaudeSessionIdForCwd(cwd)
        recordSession({ agent: p.agent, cwd, sessionId, tty: p.tty, pid: p.pid, termProgram }, { provisional: true })
      }
      registered++
    } catch { /* one bad pid doesn't fail the rest */ }
  }))

  return { registered }
}
