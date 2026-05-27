// Auto-judge routine operations — only escalate real decisions to phone.
//
// Allowlist is generous on purpose: this is a curated-interruption remote, not
// a security boundary. The phone is the second line of defense; the deny list
// here is reserved for genuinely irreversible/destructive shapes that no
// phone-tap should ever accidentally approve.
//
// Layered checks (first match wins):
//   1. Always-safe tool name → allow
//   2. Static DANGEROUS_BASH → deny
//   3. Static SAFE_BASH → allow
//   4. Learned-allow (phone said yes once before for this shape) → allow
//   5. Otherwise → ask

import { isLearned } from "./learned-allow"

type Verdict = "allow" | "deny" | "ask"

function isShellTool(tool: string): boolean {
  return tool === "Bash" || tool === "shell" || tool === "unified_exec" || tool === "exec_command"
}

function commandFromInput(input: Record<string, unknown>): string {
  return String(input.command ?? input.cmd ?? "").trim()
}

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
  /^git\s+commit\s+-F\s/,
  /^git\s+commit\s+--amend(\s|$)/,
  /^git\s+stash(\s|$)/,
  /^git\s+checkout\s+-b\s/,
  /^git\s+switch(\s|$)/,
  /^git\s+merge\s+--no-ff/,
  /^git\s+restore\s+--staged/,

  // git -C <path> <safe-verb> — same allowlist applied via the cwd flag.
  // Explicitly does NOT include push / reset / clean — those keep their
  // existing routing (push falls to branch-guard, reset/clean to
  // DANGEROUS_BASH for protected forms or "ask" otherwise).
  /^git\s+-C\s+\S+\s+(status|log|diff|show|branch|remote|tag|blame|fetch|rev-parse|ls-files|stash\s+list|config\s+--get|add|commit\s+-(m|F|-amend)|stash|checkout\s+-b|switch|merge\s+--no-ff|restore\s+--staged)\b/,

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

  // Force push — genuinely destructive (rewrites shared history)
  /\bgit\s+(-C\s+\S+\s+)?push\s+.*--force\b/,
  /\bgit\s+(-C\s+\S+\s+)?push\s+.*-f\b/,
  // Non-force `git push origin main` is a fast-forward — not destructive.
  // It should ask on the phone, not auto-deny. branch-guard already
  // auto-allows non-force pushes on feature branches.

  // History rewrites on shared branches
  /\bgit\s+(-C\s+\S+\s+)?reset\s+--hard\s+(origin\/)?(main|master)\b/,
  /\bgit\s+(-C\s+\S+\s+)?clean\s+-fd?x?\s+\/(\s|$)/,

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

  if (isShellTool(tool)) {
    const cmd = commandFromInput(input)

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

    // Learned-allow: check AFTER the static DANGEROUS list so a one-time
    // "yes" can never override the catastrophe denylist.
    if (isLearned(tool, input)) return "allow"

    return "ask"
  }

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    const filePath = (input.file_path as string) ?? ""

    if (/\.(env|pem|key|secret|credentials)(\b|\.)/.test(filePath)) return "ask"
    if (/settings\.json|settings\.local\.json/.test(filePath)) return "ask"
    if (/password|token|secret/i.test(filePath)) return "ask"

    return "allow"
  }

  // Other tools (e.g. Web*, MCP tools): consult the learned table before
  // bouncing to phone. Tools with no derivable pattern (see learned-allow.ts)
  // fall through to "ask".
  if (isLearned(tool, input)) return "allow"

  return "ask"
}
