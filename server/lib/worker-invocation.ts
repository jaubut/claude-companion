import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
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
  const path = input.file_path ?? input.path ?? input.Path ?? input.TargetFile ?? input.AbsolutePath
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit" || name === "write_file" || name === "edit_file" || name === "replace" || name === "write_to_file" || name === "replace_file_content" || name === "multi_replace_file_content") return shortPath(path, "Editing")
  if (name === "Read" || name === "read_file" || name === "view_file") return shortPath(path, "Reading")
  const pattern = input.pattern ?? input.Query ?? input.Pattern
  if (name === "Grep" || name === "search_file_content" || name === "grep_search") return typeof pattern === "string" && pattern.trim() ? `Searching ${redactSecrets(pattern.trim()).slice(0, 48)}` : "Searching codebase"
  if (name === "Glob" || name === "glob" || name === "find_by_name" || name === "list_dir") return typeof pattern === "string" && pattern.trim() ? `Listing ${pattern.trim().slice(0, 48)}` : "Listing files"
  if (name === "Bash" || name === "run_shell_command" || name === "run_command") return shortCmd(input.command ?? input.CommandLine)
  return `Tool: ${name.slice(0, 48)}`
}

/** Parse one NDJSON line from headless `claude`, `codex`, or `agy` (family gemini). Pure & never throws. */
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

  if (obj.event === "init" || obj.event === "step_update" || obj.event === "result" || obj.event === "error") {
    const body = [obj.init, obj.step_update, obj.result].find((v) => v && typeof v === "object" && !Array.isArray(v)) as Record<string, unknown> | undefined
    const cid = obj.conversation_id ?? body?.conversation_id
    if (typeof cid === "string" && cid.trim()) out.sessionId = cid.trim()
    if (obj.event === "step_update" && body?.step_type === "tool" && body.state === "ACTIVE") {
      const info = body.tool_info && typeof body.tool_info === "object" ? (body.tool_info as Record<string, unknown>) : {}
      const params = info.parameters && typeof info.parameters === "object" && !Array.isArray(info.parameters) ? (info.parameters as Record<string, unknown>) : {}
      out.step = toolStep(String(body.tool_name ?? info.name ?? "tool"), params)
    }
    if (obj.event === "result" || obj.event === "error") {
      out.done = true
      out.isError = obj.event === "error" || body?.status !== "SUCCESS"
      const errObj = (obj.error ?? body?.error) as unknown
      const msg = typeof body?.response === "string" && body.response.trim() ? body.response
        : typeof errObj === "string" ? errObj : errObj && typeof errObj === "object" && typeof (errObj as Record<string, unknown>).message === "string" ? String((errObj as Record<string, unknown>).message)
        : typeof obj.message === "string" ? obj.message : ""
      if (msg.trim()) {
        out.resultText = msg.trim()
        const pr = out.resultText.match(PR_URL_RE)?.[0]
        if (pr) out.prUrl = pr
      }
    }
    return Object.keys(out).length > 0 ? out : null
  }

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
    if (/^COMPANION_(AUTH_|PEER_|TOKEN)|^COMPANION_.*(TOKEN|SECRET|KEY)|^(TURSO|LIBSQL|PHASE)_|^(DATABASE_URL|BROKER_TOKEN|GITHUB_WEBHOOK_SECRET|OP_SERVICE_ACCOUNT_TOKEN)$/i.test(key)) delete env[key]
  }
  env.CLAUDE_NO_AGENT_ENV = "1"
  return env
}

/**
 * `export NAME=value` lines from `tls-agent-env` (tls-secrets.py env: shlex-quoted). Values in any other quoting
 * (the legacy bash %q fallback with spaces or escapes) are skipped, never guessed.
 */
export function parseAgentEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const m = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (!m) continue
    const raw = m[2]!
    if (/^'.*'$/s.test(raw) && raw.length >= 2) out[m[1]!] = raw.slice(1, -1).replaceAll(`'"'"'`, "'")
    else if (/^[\w@%+=:,./-]*$/.test(raw)) out[m[1]!] = raw
  }
  return out
}

/**
 * The worker's env: scrubbed (scrubAgentEnv) plus its dispatch identity. `secrets` (Claude workers: the agent
 * secrets from tls-agent-env) are merged BEFORE the scrub, so a Turso / Companion / Phase key in them never gets through.
 */
export function buildWorkerEnv(baseEnv: NodeJS.ProcessEnv, taskId: string, builder: string, secrets: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = scrubAgentEnv({ ...baseEnv, ...secrets })
  env.DISPATCH_TASK_ID = taskId; env.DISPATCH_WORKER = "1"; env.DISPATCH_HEADLESS = "1"; env.COMPANION_TASK_ID = builder
  return env
}

/**
 * What an interactive `claude` gets from the launch shim, read by the supervisor instead: the shim stays off
 * (CLAUDE_NO_AGENT_ENV=1) so buildWorkerEnv can scrub the result. No TLS_AGENT_PATHS → never the scripts-only keys
 * (ANTHROPIC_API_KEY would switch the worker to API billing). stdout is only parsed, never logged.
 */
export function defaultLoadAgentSecrets(home = homedir()): Promise<Record<string, string>> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.TLS_AGENT_PATHS; delete env.TLS_AGENT_SCRIPTS
  return new Promise((resolve) => {
    execFile(join(home, ".local", "bin", "tls-agent-env"), [], { env, timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[worker] tls-agent-env failed (${(err as NodeJS.ErrnoException).code ?? "error"}): Claude worker starts without agent secrets`); resolve({}); return }
      resolve(parseAgentEnv(String(stdout)))
    })
  })
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
  if (/^(gemini[- ]|orchestrator)/.test(rawModel)) return "gemini"
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

export function normalizeAgyCliModelFlag(raw: string): string {
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  const map: Record<string, string> = {
    "orchestrator (carbon)": "gemini-pro-orchestrator",
    "orchestrator": "gemini-pro-orchestrator",
    "gemini-pro-orchestrator": "gemini-pro-orchestrator",
    "orchestrator (argon)": "gemini-pro-orchestrator-argon",
    "gemini-pro-orchestrator-argon": "gemini-pro-orchestrator-argon",
    "gemini 4 hydrogen (high)": "gemini-4-hydrogen-high",
    "gemini 4 hydrogen (xhigh)": "gemini-4-hydrogen-xhigh",
    "gemini 4 hydrogen (medium)": "gemini-4-hydrogen-medium",
    "gemini 4 hydrogen (low)": "gemini-4-hydrogen-low",
    "gemini 4 carbon (high)": "gemini-4-carbon-high",
    "gemini 4 carbon (medium)": "gemini-4-carbon-medium",
    "gemini 4 carbon (low)": "gemini-4-carbon-low",
    "gemini 4 argon (high)": "gemini-4-argon-high",
    "gemini 4 argon (medium)": "gemini-4-argon-medium",
    "gemini 4 argon (low)": "gemini-4-argon-low",
    "gemini 3.8 flash (high)": "gemini-3.8-flash-high",
    "gemini 3.8 flash (medium)": "gemini-3.8-flash-medium",
    "gemini 3.8 flash (low)": "gemini-3.8-flash-low",
  }
  return map[lower] ?? trimmed
}

/** Antigravity CLI. Absolute path first: the server's launchd/systemd PATH has no ~/.local/bin. */
export function agyBin(home = homedir()): string {
  const bin = join(home, ".local/bin/agy")
  return existsSync(bin) ? bin : "agy"
}

/** Build the headless `agy -p --output-format stream-json` argv; agy mints the conversation id, so resume only. */
export function buildHeadlessGeminiArgs(opts: { prompt: string; sessionId: string; resume: boolean; mode: string; model?: string }): string[] {
  const args = [`--print=${opts.prompt}`, "--output-format", "stream-json"]
  if (opts.resume) args.push("--conversation", opts.sessionId)
  if (opts.model?.trim()) args.push("--model", normalizeAgyCliModelFlag(opts.model))
  if (opts.mode === "plan") args.push("--mode", "plan")
  else if (opts.mode === "acceptEdits") args.push("--mode", "accept-edits")
  else args.push("--dangerously-skip-permissions")
  return args
}

/** Hosts a Claude worker's sandboxed Bash may reach on top of ~/.claude/settings.json: GCP (Cloud Run, Artifact Registry, Gmail API), Cloudflare Workers, Resend, Brevo. */
export const WORKER_SANDBOX_HOSTS: readonly string[] = ["*.googleapis.com", "*.pkg.dev", "*.run.app", "*.workers.dev", "api.resend.com", "api.brevo.com"]

/** Build the command + argv for any supported headless agent family (`claude`, `codex`, `gemini` → agy). */
export function buildHeadlessWorkerInvocation(opts: { family: WorkerFamily; prompt: string; sessionId: string; resume: boolean; mode: string; agent?: string; model?: string }): { cmd: string; args: string[] } {
  if (opts.family === "codex") return { cmd: "codex", args: buildHeadlessCodexArgs(opts) }
  if (opts.family === "gemini") return { cmd: agyBin(), args: buildHeadlessGeminiArgs(opts) }
  // Worker-only sandbox network additions (lists merge with the user settings): the production jobs Codex already does.
  return { cmd: "claude", args: ["--settings", JSON.stringify({ sandbox: { network: { allowedDomains: WORKER_SANDBOX_HOSTS } } }), ...buildHeadlessClaudeArgs(opts)] }
}
