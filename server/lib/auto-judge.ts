// Auto-judge routine operations — only escalate real decisions to phone.
//
// Allowlist is generous on purpose: this is a curated-interruption remote, not
// a security boundary. The phone is the second line of defense; the deny list
// here is reserved for genuinely irreversible/destructive shapes that no
// phone-tap should ever accidentally approve.

type Verdict = "allow" | "deny" | "ask"

// ── Safe Bash patterns — auto-approve ──
const SAFE_BASH: RegExp[] = [
  // Localhost / Companion API calls
  /^curl\s.*localhost/,
  /^curl\s.*127\.0\.0\.1/,
  /^curl\s+-s\s/,

  // Read-only file inspection
  /^(cat|head|tail|less|wc|file|stat)\s/,
  /^ls(\s|$)/,
  /^pwd$/,
  /^echo\s/,
  /^which\s/,
  /^type\s/,
  /^tree(\s|$)/,

  // Git read operations
  /^git\s+(status|log|diff|show|branch|remote|tag|stash list|blame|fetch|config\s+--get)/,
  /^git\s+rev-parse/,
  /^git\s+ls-files/,

  // Routine git writes (still gated on push-to-main below)
  /^git\s+add(\s|$)/,
  /^git\s+commit\s+-m\s/,
  /^git\s+commit\s+--amend(\s|$)/,
  /^git\s+stash(\s|$)/,
  /^git\s+checkout\s+-b\s/,
  /^git\s+switch(\s|$)/,
  /^git\s+merge\s+--no-ff/,
  /^git\s+restore\s+--staged/,

  // Package info + scripts
  /^(bun|npm|yarn|pnpm)\s+(list|ls|info|view|outdated|why)/,
  /^(bun|npm|yarn|pnpm)\s+run(\s|$)/,
  /^bun\s+(-e|--eval|x|run)\s/,
  /^bunx(\s|$)/,
  /^npx(\s|$)/,
  /^node\s+(-e|--eval|--version|-v)/,
  /^node\s+[^|;&]+\.(m?js|cjs|ts)(\s|$)/,
  /^python3?\s+(-c|-m|--version)/,
  /^python3?\s+[^|;&]+\.py(\s|$)/,

  // Build / typecheck / lint / format / test
  /^(tsc|bunx tsc)\s/,
  /^bunx\s+(shadcn|tailwindcss|vite|tsx|prisma|drizzle-kit)/,
  /^(prettier|eslint|biome|stylelint)\s/,
  /^(vitest|jest|playwright|cypress)\s/,

  // Database CLIs — read-shaped queries OR interactive shells
  /^(turso|sqlite3|psql|mysql)\s.*\b(show|list|describe|select|explain)\b/i,
  /^turso\s+db\s+(shell|list|show|tokens|locations|inspect|config)/,
  /^sqlite3\s+[^\s]+\s*$/,

  // Process / system inspection
  /^(ps|top|htop|lsof|pgrep|kill\s+-0)\s/,
  /^(df|du|free|uptime|date|whoami|id|env|printenv|hostname|sw_vers)/,
  /^(networkstat|netstat|ifconfig|ipconfig)/,

  // Search
  /^(grep|rg|find|fd|ag)\s/,
  /^jq\s/,

  // Misc safe utilities
  /^(open|pbcopy|pbpaste|say|afplay)\s/,
  /^osascript\s+-e\s/,
  /^tailscale\s+(status|ip|cert)/,
  /^(mkdir|cp|mv|ln|touch|chmod\s+\+x)\s/,
]

// ── Dangerous Bash patterns — auto-deny ──
// Keep this list short and high-confidence. Anything ambiguous goes to the
// phone, not denied outright.
const DANGEROUS_BASH: RegExp[] = [
  // rm -rf on roots
  /\brm\s+-rf?\s+\/(\s|$)/,
  /\brm\s+-rf?\s+~(\s|$)/,
  /\brm\s+-rf?\s+\$HOME(\s|$)/,
  /\brm\s+-rf?\s+\.\s*$/,
  /\brm\s+-rf?\s+\*\s*$/,

  // Force push / push to protected branches
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+.*-f\b/,
  /\bgit\s+push\s+\S+\s+(main|master)\b/,

  // History rewrites on shared branches
  /\bgit\s+reset\s+--hard\s+(origin\/)?(main|master)\b/,
  /\bgit\s+clean\s+-fd?x?\s+\/(\s|$)/,

  // System-level danger
  /\bsudo\s/,
  /\bchmod\s+-R\s+777\b/,
  /\bcurl\s.*\|\s*(sh|bash|zsh)\b/,
  /\bwget\s.*\|\s*(sh|bash|zsh)\b/,

  // SQL destructive ops — only when invoked through a CLI -c/-e/--command flag.
  // Matching arbitrary `DROP TABLE` text caused false-positives on inline JS
  // scripts that referenced these keywords as data or comments.
  /^(turso|sqlite3|psql|mysql)\s.*(-c|-e|--command|--execute)\s+["'][^"']*\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\S+\s*;?\s*$)/i,
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
  if (ALWAYS_SAFE_TOOLS.has(tool)) return "allow"

  if (tool === "Bash") {
    const cmd = ((input.command as string) ?? "").trim()

    for (const pattern of DANGEROUS_BASH) {
      if (pattern.test(cmd)) return "deny"
    }

    for (const pattern of SAFE_BASH) {
      if (pattern.test(cmd)) return "allow"
    }

    // Piped / chained commands — judge by the first segment.
    const firstCmd = cmd.split(/[|;&]/)[0]?.trim() ?? ""
    if (firstCmd && firstCmd !== cmd) {
      for (const pattern of SAFE_BASH) {
        if (pattern.test(firstCmd)) return "allow"
      }
    }

    return "ask"
  }

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    const filePath = (input.file_path as string) ?? ""

    if (/\.(env|pem|key|secret|credentials)(\b|\.)/.test(filePath)) return "ask"
    if (/settings\.json|settings\.local\.json/.test(filePath)) return "ask"
    if (/password|token|secret/i.test(filePath)) return "ask"

    return "allow"
  }

  return "ask"
}
