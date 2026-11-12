import { basename } from "node:path"
import { redactSecrets } from "./secret-redact"

const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/

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

  // Claude stream-json assistant event
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

  // Codex JSONL events (`item.started` / `item.completed` / `turn.completed` / `turn.failed` / `error`)
  if (obj.type === "item.started" || obj.type === "item.completed") {
    const item = obj.item && typeof obj.item === "object" && !Array.isArray(obj.item) ? (obj.item as Record<string, unknown>) : null
    if (item) {
      if (item.type === "command_execution") {
        out.step = shortCmd(item.command)
      } else if (item.type === "file_change") {
        out.step = "Editing files"
      } else if (item.type === "mcp_tool_call") {
        out.step = `Tool: ${String(item.tool ?? item.server ?? "mcp").slice(0, 48)}`
      } else if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        out.assistantText = item.text.trim()
        const pr = out.assistantText.match(PR_URL_RE)?.[0]
        if (pr) out.prUrl = pr
      }
    }
    return Object.keys(out).length > 0 ? out : null
  }

  if (obj.type === "turn.completed") {
    out.done = true
    out.isError = false
    return out
  }

  if (obj.type === "turn.failed" || obj.type === "error") {
    out.done = true
    out.isError = true
    const errObj = obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : null
    const msg = typeof errObj?.message === "string" ? errObj.message : typeof obj.message === "string" ? obj.message : ""
    if (msg.trim()) out.resultText = msg.trim()
    return out
  }

  // Gemini stream-json events (`tool_use`, `message`, `result`)
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
