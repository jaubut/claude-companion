// Side-effect-safe [event] turn preemption policy for the Brain supervisor.
// Only pure automated [event] turns (`trigger === "event"`) may be preempted when a real user
// message arrives in `brain_outbox`, and ONLY before any non-idempotent side effect has fired.
// Turns answering a user `[turn <id>]`, `[boot]`, `[rollover]`, or `[flush]` are never preempted.

export type BrainTurnTrigger = "user" | "event" | "boot" | "rollover" | "flush"

export interface ActiveBrainTurnState {
  gen: number
  trigger: BrainTurnTrigger
  turnIds: string[]
  draftTurnId: string
  sideEffectFired: boolean
  sideEffectReason: string | null
  preempted: boolean
  startedAt: number
}

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "ToolSearch",
  "read_file",
  "view_file",
  "grep_search",
  "search_file_content",
  "glob",
  "find_by_name",
  "list_dir",
  "search_web",
  "read_url_content",
  "list_resources",
  "read_resource",
  "update_steps",
  "TodoWrite",
  "write_todos",
  "load_skill",
])

const MUTATING_FILE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "write_file",
  "edit_file",
  "replace",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
])

const MUTATING_BIN_RE = /(?:^|[;&|]\s*|\s)(?:\.\/)?bin\/(ui|pr-merge|pr-close|pr-update-branch|pr-resolve-conflicts|deploy|propose|dispatch|task-cancel|todo|lead)\b/
const MUTATING_WORKER_BIN_RE = /(?:^|[;&|]\s*|\s)(?:\.\/)?bin\/worker\s+(dispatch|interrupt)\b/
const MUTATING_SESSIONS_BIN_RE = /(?:^|[;&|]\s*|\s)(?:\.\/)?bin\/sessions\s+(send|close|tell-brain)\b/
const MUTATING_GH_OR_MAIL_CMD_RE = /(?:^|[;&|]\s*|\s)(?:gh\s+pr\s+(?:merge|close|comment|edit|create|ready)|gmail\.py\s+(?:send|reply|draft))\b/
const READ_ONLY_SQL_RE = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i
const MUTATING_SQL_RE = /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE)\b/i

function classifySqlSideEffect(sql: unknown): string | null {
  if (typeof sql !== "string" || !sql.trim()) return "sql_write"
  if (READ_ONLY_SQL_RE.test(sql) && !MUTATING_SQL_RE.test(sql)) return null
  if (!MUTATING_SQL_RE.test(sql) && !/\b(note_create|note_update|send_email|task_create|task_update)\b/i.test(sql)) return null
  return "sql_write"
}

/**
 * Inspect a Brain tool call (`PreToolUse` or `stream-json` `step_update`) and return a non-null
 * reason string if the call performs a non-idempotent side effect, or `null` if it is a safe
 * idempotent read.
 */
export function isMutatingBrainToolCall(tool: string, input: Record<string, unknown>): string | null {
  const cleanTool = tool.trim()
  if (!cleanTool || READ_ONLY_TOOLS.has(cleanTool)) return null
  if (MUTATING_FILE_TOOLS.has(cleanTool)) return `file_write:${cleanTool}`

  if (cleanTool === "Bash" || cleanTool === "run_command" || cleanTool === "run_shell_command") {
    const rawCmd = typeof input.command === "string"
      ? input.command
      : typeof input.CommandLine === "string"
      ? input.CommandLine
      : ""
    const cmd = rawCmd.trim()
    if (!cmd) return null
    const binMatch = MUTATING_BIN_RE.exec(cmd)
    if (binMatch) return `bin/${binMatch[1]}`
    const workerMatch = MUTATING_WORKER_BIN_RE.exec(cmd)
    if (workerMatch) return `bin/worker:${workerMatch[1]}`
    const sessMatch = MUTATING_SESSIONS_BIN_RE.exec(cmd)
    if (sessMatch) return `bin/sessions:${sessMatch[1]}`
    if (MUTATING_GH_OR_MAIL_CMD_RE.test(cmd)) return "shell_mutation"
    return null
  }

  if (cleanTool === "call_mcp_tool") {
    const server = typeof input.ServerName === "string" ? input.ServerName.trim().toLowerCase() : ""
    const name = typeof input.ToolName === "string" ? input.ToolName.trim().toLowerCase() : ""
    const args = input.Arguments && typeof input.Arguments === "object" && !Array.isArray(input.Arguments)
      ? (input.Arguments as Record<string, unknown>)
      : {}
    if (name === "send_email" || name.includes("send_message") || name.includes("reply")) return "outbound_email"
    if (name === "note_create" || name === "note_update" || name === "board_write") return `mcp:${server || "tool"}:${name}`
    if (name === "execute") return classifySqlSideEffect(args.sql ?? args.query ?? args.code)
    return null
  }

  if (
    cleanTool === "mcp__tls__send_email"
    || cleanTool === "mcp__turso__send_email"
    || cleanTool.includes("Gmail__send_message")
    || cleanTool.includes("Gmail__reply")
    || /Gmail__(create|update)_draft/.test(cleanTool)
  ) {
    return "outbound_email"
  }

  if (
    cleanTool === "mcp__tls__note_create"
    || cleanTool === "mcp__tls__note_update"
    || cleanTool === "mcp__turso__note_create"
    || cleanTool === "mcp__turso__note_update"
    || cleanTool === "mcp__board__board_write"
  ) {
    return `mcp:${cleanTool}`
  }

  if (cleanTool === "mcp__tls__execute" || cleanTool === "mcp__turso__execute") {
    return classifySqlSideEffect(input.sql ?? input.query ?? input.code)
  }

  return null
}

/**
 * Only an active `trigger === "event"` turn that has not fired any non-idempotent side effect
 * may be preempted when a real user turn arrives.
 * Never preempts `user`, `boot`, `rollover`, or `flush` turns.
 */
export function canPreemptBrainTurn(active: ActiveBrainTurnState | null): boolean {
  if (!active || active.preempted) return false
  if (active.trigger !== "event") return false
  return !active.sideEffectFired
}
