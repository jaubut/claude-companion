// Auto-judge routine operations — only escalate real decisions to phone

type Verdict = "allow" | "deny" | "ask"

// ── Safe Bash patterns — auto-approve ──
const SAFE_BASH: RegExp[] = [
  // API calls to localhost / known safe endpoints
  /^curl\s.*localhost/,
  /^curl\s.*127\.0\.0\.1/,
  /^curl\s+-s\s/,

  // Read-only commands
  /^(cat|head|tail|less|wc|file|stat)\s/,
  /^ls(\s|$)/,
  /^pwd$/,
  /^echo\s/,
  /^which\s/,
  /^type\s/,

  // Git read operations
  /^git\s+(status|log|diff|show|branch|remote|tag|stash list)/,
  /^git\s+rev-parse/,

  // Package info (no install)
  /^(bun|npm|yarn|pnpm)\s+(list|ls|info|view|outdated|why)/,
  /^(bun|npm)\s+run\s+(build|dev|lint|check|test|preview)/,

  // Development tools
  /^(tsc|bunx tsc)\s+--noEmit/,
  /^bunx\s+(shadcn|tailwindcss)/,
  /^(prettier|eslint)\s/,

  // Database CLIs (read-only)
  /^(turso|sqlite3|psql|mysql)\s.*(show|list|describe|select|explain)/i,

  // Process inspection
  /^(ps|top|lsof|pgrep)\s/,
  /^(df|du|free|uptime)/,

  // Grep/find (read-only)
  /^(grep|rg|find|fd|ag)\s/,
  /^(jq|python3?\s+-c)\s/,

  // Tailscale info
  /^tailscale\s+(status|ip)/,
]

// ── Dangerous Bash patterns — auto-deny ──
const DANGEROUS_BASH: RegExp[] = [
  // Destructive file operations
  /\brm\s+-rf\s+[\/~]/,
  /\brm\s+-rf\s+\.\s*$/,

  // Force push
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+-f\b/,

  // Reset hard
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f/,

  // Dangerous git on main
  /\bgit\s+push\s+.*\b(main|master)\b/,

  // System-level danger
  /\bsudo\s/,
  /\bchmod\s+-R\s+777\b/,
  /\bcurl\s.*\|\s*(sh|bash)\b/,

  // Drop/delete database operations
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bDELETE\s+FROM\b.*WHERE\s+1\s*=\s*1/i,
  /\bTRUNCATE\b/i,
]

// ── Safe tool names — auto-approve entirely ──
const ALWAYS_SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LSP",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
])

export function autoJudge(tool: string, input: Record<string, unknown>): Verdict {
  // Always-safe tools — no need to even look at input
  if (ALWAYS_SAFE_TOOLS.has(tool)) return "allow"

  // Bash commands — check patterns
  if (tool === "Bash") {
    const cmd = ((input.command as string) ?? "").trim()

    // Check dangerous first
    for (const pattern of DANGEROUS_BASH) {
      if (pattern.test(cmd)) return "deny"
    }

    // Check safe patterns
    for (const pattern of SAFE_BASH) {
      if (pattern.test(cmd)) return "allow"
    }

    // Piped commands with safe starts
    const firstCmd = cmd.split("|")[0]?.trim() ?? ""
    for (const pattern of SAFE_BASH) {
      if (pattern.test(firstCmd)) return "allow"
    }

    // Unknown bash — ask the human
    return "ask"
  }

  // Edit/Write — auto-approve unless it's a sensitive file
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    const filePath = (input.file_path as string) ?? ""

    // Sensitive files — ask
    if (/\.(env|pem|key|secret|credentials)/.test(filePath)) return "ask"
    if (/settings\.json|settings\.local\.json/.test(filePath)) return "ask"
    if (/password|token|secret/i.test(filePath)) return "ask"

    // Everything else — auto-approve
    return "allow"
  }

  // Unknown tools — ask
  return "ask"
}
