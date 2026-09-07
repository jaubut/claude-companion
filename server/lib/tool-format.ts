import { isQuestionTool } from "./questions"

// Pure formatting for tool calls and their results — the verb for the pill,
// the one-line summary for feed rows and push titles, the phone-friendly
// excerpt of a tool response, ANSI stripping, and the wire-size clamp.
// No state, no timers. Shared by activity.ts, transcript.ts, codex-feed,
// the hook routes and the event wiring.

export function verbFor(tool: string): string {
  if (isQuestionTool(tool)) return "Asking"
  switch (tool) {
    case "Read": return "Reading"
    case "Write": return "Writing"
    case "Edit":
    case "MultiEdit": return "Editing"
    case "Bash": return "Running"
    case "shell":
    case "unified_exec":
    case "exec_command": return "Running"
    case "Grep": return "Searching"
    case "Glob": return "Finding"
    case "WebFetch": return "Fetching"
    case "WebSearch": return "Searching web"
    case "Task":
    case "Agent": return "Delegating"
    default: return "Working"
  }
}

export function isShellTool(tool: string): boolean {
  return tool === "Bash" || tool === "shell" || tool === "unified_exec" || tool === "exec_command"
}

export function summarize(tool: string, input: Record<string, unknown>): string {
  if (isQuestionTool(tool)) {
    // Show the first question's text so the feed row reads as
    // "request_user_input: Which framework?" instead of just the tool name.
    const qs = input.questions
    if (Array.isArray(qs) && qs.length > 0) {
      const first = qs[0] as Record<string, unknown> | undefined
      const q = typeof first?.question === "string" ? first.question : ""
      return q.slice(0, 160)
    }
    const q = typeof input.question === "string" ? input.question : ""
    return q.slice(0, 160)
  }
  switch (tool) {
    case "Bash":
    case "shell":
    case "unified_exec":
    case "exec_command": {
      const command = (input.command as string) ?? (input.cmd as string) ?? ""
      return command.slice(0, 120)
    }
    case "Edit":
    case "Read":
    case "Write":
    case "MultiEdit": {
      const p = (input.file_path as string) ?? ""
      return p.replace(/^\/Users\/[^/]+\//, "~/")
    }
    case "Grep":
      return `/${(input.pattern as string) ?? ""}/`
    case "Glob":
      return (input.pattern as string) ?? ""
    case "WebFetch":
      return (input.url as string) ?? ""
    case "WebSearch":
      return (input.query as string) ?? ""
    default:
      return ""
  }
}

// Pull a phone-friendly excerpt from a tool_response payload. We don't try
// to render the whole thing — for Bash that could be megabytes — just the
// first few lines so the feed row can show "what happened" at a glance.
//
// Returns no excerpt when:
//  - the tool isn't one whose output is interesting (Edit/Write/Read have
//    obvious effects already)
//  - the response is empty or non-string
export function extractToolResult(
  tool: string,
  raw: unknown,
): { excerpt?: string; errored?: boolean } {
  if (raw == null) return {}

  // Shell commands are the headline case — give back stdout (or stderr if
  // that's all we got) trimmed to the first 3 lines / 200 chars.
  if (isShellTool(tool)) {
    if (typeof raw === "object") {
      const r = raw as Record<string, unknown>
      const stdout = typeof r.stdout === "string" ? r.stdout : ""
      const stderr = typeof r.stderr === "string" ? r.stderr : ""
      const interrupted = r.interrupted === true
      const text = stripAnsi((stdout || stderr).trim())
      const errored = interrupted || (!stdout && stderr.trim().length > 0)
      if (!text) return { errored }
      const lines = text.split("\n").slice(0, 3).join("\n")
      return { excerpt: lines.length > 200 ? lines.slice(0, 200) + "…" : lines, errored }
    }
    if (typeof raw === "string") {
      const text = stripAnsi(raw.trim())
      const lines = text.split("\n").slice(0, 3).join("\n")
      return { excerpt: lines.length > 200 ? lines.slice(0, 200) + "…" : lines }
    }
  }

  // For other tools we don't surface output (Read's response is the file
  // content, Edit's is just confirmation noise — neither helps the user
  // judge the row in the feed).
  return {}
}

// Strip ANSI CSI sequences (colors, cursor moves) — we render the excerpt
// as plain monospaced text on iOS, so raw `\x1b[32m…` byte sequences would
// otherwise show up as visible noise.
export const ANSI_PATTERN = /\[[0-9;?]*[A-Za-z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "")
}

// Bound text-payload size on the wire — protects the WS frame and the iOS
// in-memory cache from a runaway 100KB reply, but with a *generous* cap so
// the previous 8000-char limit (which silently chopped real long replies)
// no longer bites. When we do truncate, we emit a visible marker so the
// user knows there's more on the Mac side.
export function clampLong(s: string, max: number): string {
  if (s.length <= max) return s
  const overflow = s.length - max
  return s.slice(0, max) + `\n\n…[truncated · +${overflow.toLocaleString()} more chars on the Mac]`
}
