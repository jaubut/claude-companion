import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"


export const REPO_NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/
export type WorkerFamily = "claude" | "codex" | "gemini"
export const ALLOWED_FAMILIES = new Set<WorkerFamily>(["claude", "codex", "gemini"])

export interface SpawnedWorkerHandle { pid: number; kill(sig: NodeJS.Signals): void }

export interface SpawnWorkerOpts {
  cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv
  onStdoutLine(line: string): void; onStderrLine(line: string): void; onExit(code: number | null, signal: NodeJS.Signals | null): void
}

export function defaultResolveRepoDir(repo: string, home = homedir()): string | null {
  if (!REPO_NAME_RE.test(repo)) return null
  const candidates = [repo === "claude-companion-ios" ? join(home, "apps", "claude companion") : "", join(home, repo), join(home, "lanes", repo), join(home, "Developer", repo), join(home, "apps", repo)].filter(Boolean)
  for (const c of candidates) if (existsSync(join(c, ".git"))) return c
  return null
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(-pid, 0); return true } catch { return false }
}

export function defaultKillPid(pid: number, sig: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  try { process.kill(-pid, sig) } catch { /* gone */ }
}

export function defaultGetPidIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    if (existsSync(`/proc/${pid}/stat`)) {
      const bootId = existsSync("/proc/sys/kernel/random/boot_id") ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : "linux"
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const rparen = stat.lastIndexOf(")")
      const startTime = rparen > 0 ? stat.slice(rparen + 2).trim().split(/\s+/)[19] ?? "" : ""
      if (startTime) return `${bootId}:${pid}:${startTime}`
    }
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000 })
    const out = (ps.stdout ?? "").trim()
    return ps.status === 0 && out ? `ps:${pid}:${out}` : null
  } catch { return null }
}

export function defaultSpawnWorker(opts: SpawnWorkerOpts): SpawnedWorkerHandle {
  const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  let outBuf = "", errBuf = ""
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    outBuf += chunk; const lines = outBuf.split("\n"); outBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStdoutLine(l)
  })
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    errBuf += chunk; const lines = errBuf.split("\n"); errBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStderrLine(l)
  })
  child.on("error", (err) => { opts.onStderrLine(err.message); opts.onExit(1, null) })
  child.on("close", (code, sig) => {
    if (outBuf.trim()) opts.onStdoutLine(outBuf)
    if (errBuf.trim()) opts.onStderrLine(errBuf)
    opts.onExit(code, sig)
  })
  return { pid: child.pid ?? 0, kill(sig: NodeJS.Signals) { if (child.pid) defaultKillPid(child.pid, sig) } }
}

/** Remove Companion control-plane bearer tokens from the worker's environment so a worker cannot invoke `/api/mcp/workers`. */
export function buildWorkerEnv(baseEnv: NodeJS.ProcessEnv, taskId: string, builder: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  delete env.COMPANION_AUTH_TOKEN; delete env.COMPANION_TOKEN
  for (const key of Object.keys(env)) if (/^COMPANION_(AUTH_|PEER_|TOKEN)/i.test(key)) delete env[key]
  env.DISPATCH_TASK_ID = taskId; env.DISPATCH_WORKER = "1"; env.DISPATCH_HEADLESS = "1"; env.COMPANION_TASK_ID = builder
  return env
}

/** Resolve the target agent family (`claude` | `codex` | `gemini`) from explicit `family`, `agent`, or `model`. */
export function resolveWorkerFamily(opts: { family?: string; agent?: string; model?: string }): WorkerFamily | null {
  const rawFamily = opts.family?.trim().toLowerCase()
  if (rawFamily) {
    return ALLOWED_FAMILIES.has(rawFamily as WorkerFamily) ? (rawFamily as WorkerFamily) : null
  }
  const rawAgent = opts.agent?.trim().toLowerCase()
  if (rawAgent === "codex") return "codex"
  if (rawAgent === "gemini") return "gemini"
  const rawModel = opts.model?.trim().toLowerCase() ?? ""
  if (/^(gpt-|o1\b|o3\b|o4\b|codex)/.test(rawModel)) return "codex"
  if (/^gemini-/.test(rawModel)) return "gemini"
  return "claude"
}

/** Build the headless `claude -p` argv with `--` before positional prompt so `-...` prompts are never parsed as flags. */
export function buildHeadlessClaudeArgs(opts: { prompt: string; sessionId: string; resume: boolean; mode: string; agent?: string; model?: string }): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", opts.mode, ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId])]
  if (opts.agent && !ALLOWED_FAMILIES.has(opts.agent as WorkerFamily)) args.push("--agent", opts.agent)
  if (opts.model) args.push("--model", opts.model)
  args.push("--", opts.prompt)
  return args
}

/** Build the headless `codex exec --json` argv for fresh or resumed turns. */
export function buildHeadlessCodexArgs(opts: { prompt: string; sessionId: string; resume: boolean; mode: string; model?: string }): string[] {
  if (opts.resume) {
    const args = ["exec", "resume", "--json", "--skip-git-repo-check"]
    if (opts.mode === "auto" || opts.mode === "dontAsk") args.push("--dangerously-bypass-approvals-and-sandbox")
    if (opts.model) args.push("-m", opts.model)
    args.push("--", opts.sessionId, opts.prompt)
    return args
  }
  const args = ["exec", "--json", "--skip-git-repo-check"]
  if (opts.mode === "plan") args.push("--sandbox", "read-only")
  else if (opts.mode === "auto" || opts.mode === "dontAsk") args.push("--dangerously-bypass-approvals-and-sandbox")
  else args.push("--approve-for-me")
  if (opts.model) args.push("-m", opts.model)
  args.push("--", opts.prompt)
  return args
}

/** Build the headless `gemini -p --output-format stream-json` argv for fresh or resumed turns. */
export function buildHeadlessGeminiArgs(opts: { prompt: string; sessionId: string; resume: boolean; mode: string; model?: string }): string[] {
  const approvalMode = opts.mode === "auto" || opts.mode === "dontAsk"
    ? "yolo"
    : opts.mode === "acceptEdits"
    ? "auto_edit"
    : opts.mode === "plan"
    ? "plan"
    : "default"
  const args = [
    "--output-format", "stream-json",
    "--approval-mode", approvalMode,
    ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
  ]
  if (opts.model) args.push("--model", opts.model)
  args.push("-p", opts.prompt)
  return args
}

/** Build the command + argv for any supported headless agent family (`claude`, `codex`, `gemini`). */
export function buildHeadlessWorkerInvocation(opts: { family: WorkerFamily; prompt: string; sessionId: string; resume: boolean; mode: string; agent?: string; model?: string }): { cmd: WorkerFamily; args: string[] } {
  if (opts.family === "codex") {
    return { cmd: "codex", args: buildHeadlessCodexArgs(opts) }
  }
  if (opts.family === "gemini") {
    return { cmd: "gemini", args: buildHeadlessGeminiArgs(opts) }
  }
  return { cmd: "claude", args: buildHeadlessClaudeArgs(opts) }
}
