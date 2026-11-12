import { basename } from "node:path"
import { redactSecrets } from "./secret-redact"

export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const REPO_NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/
export const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
export const ALLOWED_MODES = new Set(["acceptEdits", "auto", "default", "dontAsk", "plan"])
export type WorkerFamily = "claude" | "codex" | "gemini"
export const ALLOWED_FAMILIES = new Set<WorkerFamily>(["claude", "codex", "gemini"])
const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/

export type WorkerTaskStatus = "running" | "completed" | "failed" | "interrupted"
export interface StreamJsonEvent {
  sessionId?: string; step?: string; assistantText?: string; resultText?: string; isError?: boolean; prUrl?: string; done?: boolean
}

function shortCmd(raw: unknown): string {
  const s = redactSecrets(typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim()
  return s ? `Running ${s.length > 60 ? `${s.slice(0, 59)}…` : s}` : "Running command"
}
function shortPath(raw: unknown, prefix: string): string {
  const base = typeof raw === "string" && raw.trim() ? basename(raw.trim()) : ""
  return base ? `${prefix} ${base}` : prefix
}
function toolStep(name: string, input: Record<string, unknown>): string {
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit" || name === "write_file" || name === "edit_file" || name === "replace") return shortPath(input.file_path ?? input.path, "Editing")
  if (name === "Read" || name === "read_file") return shortPath(input.file_path ?? input.path, "Reading")
  if (name === "Grep" || name === "search_file_content") return typeof input.pattern === "string" && input.pattern.trim() ? `Searching ${redactSecrets(input.pattern.trim()).slice(0, 48)}` : "Searching codebase"
  if (name === "Glob" || name === "glob") return typeof input.pattern === "string" && input.pattern.trim() ? `Listing ${input.pattern.trim().slice(0, 48)}` : "Listing files"
  if (name === "Bash" || name === "run_shell_command") return shortCmd(input.command)
  return `Tool: ${name.slice(0, 48)}`
}

/** Parse one NDJSON line from headless `claude`, `codex`, or `gemini`. Pure & never throws. */
export function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return null
  let obj: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
  } catch { return null }
  if (!obj) return null

  const out: StreamJsonEvent = {}
  if (typeof obj.session_id === "string" && obj.session_id.trim()) out.sessionId = obj.session_id.trim()
  if (typeof obj.thread_id === "string" && obj.thread_id.trim()) out.sessionId = obj.thread_id.trim()

  if (obj.type === "assistant") {
    const msg = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : null
    const content = Array.isArray(msg?.content) ? msg.content : []
    const texts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const b = block as Record<string, unknown>
      if (b.type === "tool_use" && typeof b.name === "string") {
        const input = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {}
        out.step = toolStep(b.name, input)
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        texts.push(b.text.trim())
      }
    }
    if (texts.length > 0) {
      out.assistantText = texts.join("\n")
      const pr = out.assistantText.match(PR_URL_RE)?.[0]
      if (pr) out.prUrl = pr
    }
    return Object.keys(out).length > 0 ? out : null
  }

  if (obj.type === "item.started" || obj.type === "item.completed") {
    const item = obj.item && typeof obj.item === "object" && !Array.isArray(obj.item) ? (obj.item as Record<string, unknown>) : null
    if (item) {
      if (item.type === "command_execution") out.step = shortCmd(item.command)
      else if (item.type === "file_change") out.step = "Editing files"
      else if (item.type === "mcp_tool_call") out.step = `Tool: ${String(item.tool ?? item.server ?? "mcp").slice(0, 48)}`
      else if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        out.assistantText = item.text.trim()
        const pr = out.assistantText.match(PR_URL_RE)?.[0]
        if (pr) out.prUrl = pr
      }
    }
    return Object.keys(out).length > 0 ? out : null
  }

  if (obj.type === "turn.completed") { out.done = true; out.isError = false; return out }
  if (obj.type === "turn.failed" || obj.type === "error") {
    out.done = true; out.isError = true
    const errObj = obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : null
    const msg = typeof errObj?.message === "string" ? errObj.message : typeof obj.message === "string" ? obj.message : ""
    if (msg.trim()) out.resultText = msg.trim()
    return out
  }

  if (obj.type === "tool_use") {
    const toolName = typeof obj.tool_name === "string" ? obj.tool_name : typeof obj.name === "string" ? obj.name : "tool"
    const params = (obj.parameters && typeof obj.parameters === "object" && !Array.isArray(obj.parameters))
      ? (obj.parameters as Record<string, unknown>)
      : (obj.input && typeof obj.input === "object" && !Array.isArray(obj.input))
      ? (obj.input as Record<string, unknown>)
      : {}
    out.step = toolStep(toolName, params)
    return out
  }

  if (obj.type === "message" && obj.role === "assistant" && typeof obj.content === "string" && obj.content.trim()) {
    out.assistantText = obj.content.trim()
    const pr = out.assistantText.match(PR_URL_RE)?.[0]
    if (pr) out.prUrl = pr
    return out
  }

  if (obj.type === "result") {
    out.done = true
    const errObj = obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : null
    out.isError = obj.is_error === true || obj.status === "error" || (typeof obj.subtype === "string" && obj.subtype.startsWith("error"))
    if (typeof obj.result === "string" && obj.result.trim()) {
      out.resultText = obj.result.trim()
      const pr = out.resultText.match(PR_URL_RE)?.[0]
      if (pr) out.prUrl = pr
    } else if (typeof errObj?.message === "string" && errObj.message.trim()) {
      out.resultText = errObj.message.trim()
    }
    return out
  }

  return Object.keys(out).length > 0 ? out : null
}

/**
 * A headless agent's env (claude -p, codex exec, gemini, agy) without the DB credentials and the Companion / broker
 * tokens: no `/api/mcp/workers` calls, no direct `tasks` writes. CLAUDE_NO_AGENT_ENV=1 keeps the `claude` launch shim
 * (~/.bun/bin/claude) from loading the agent secrets back in. Disk reads of those secrets are not covered here.
 */
export function scrubAgentEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  for (const key of Object.keys(env)) {
    if (/^COMPANION_(AUTH_|PEER_|TOKEN)|^COMPANION_.*(TOKEN|SECRET|KEY)|^(TURSO|LIBSQL)_|^(DATABASE_URL|BROKER_TOKEN)$/i.test(key)) delete env[key]
  }
  env.CLAUDE_NO_AGENT_ENV = "1"
  return env
}

/** The worker's env: scrubbed (scrubAgentEnv) plus its dispatch identity. */
export function buildWorkerEnv(baseEnv: NodeJS.ProcessEnv, taskId: string, builder: string): NodeJS.ProcessEnv {
  const env = scrubAgentEnv(baseEnv)
  env.DISPATCH_TASK_ID = taskId; env.DISPATCH_WORKER = "1"; env.DISPATCH_HEADLESS = "1"; env.COMPANION_TASK_ID = builder
  return env
}

/** Resolve the target agent family (`claude` | `codex` | `gemini`) from explicit `family`, `agent`, or `model`. */
export function resolveWorkerFamily(opts: { family?: string; agent?: string; model?: string }): WorkerFamily | null {
  const rawFamily = opts.family?.trim().toLowerCase()
  if (rawFamily) return ALLOWED_FAMILIES.has(rawFamily as WorkerFamily) ? (rawFamily as WorkerFamily) : null
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
  const approvalMode = opts.mode === "auto" || opts.mode === "dontAsk" ? "yolo" : opts.mode === "acceptEdits" ? "auto_edit" : opts.mode === "plan" ? "plan" : "default"
  const args = ["--output-format", "stream-json", "--approval-mode", approvalMode, ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId])]
  if (opts.model) args.push("--model", opts.model)
  args.push("-p", opts.prompt)
  return args
}

/** Build the command + argv for any supported headless agent family (`claude`, `codex`, `gemini`). */
export function buildHeadlessWorkerInvocation(opts: { family: WorkerFamily; prompt: string; sessionId: string; resume: boolean; mode: string; agent?: string; model?: string }): { cmd: WorkerFamily; args: string[] } {
  if (opts.family === "codex") return { cmd: "codex", args: buildHeadlessCodexArgs(opts) }
  if (opts.family === "gemini") return { cmd: "gemini", args: buildHeadlessGeminiArgs(opts) }
  return { cmd: "claude", args: buildHeadlessClaudeArgs(opts) }
}
