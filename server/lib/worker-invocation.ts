import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { redactSecrets } from "./secret-redact"

export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const REPO_NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/
export const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
export const ALLOWED_MODES = new Set(["acceptEdits", "auto", "default", "dontAsk", "plan"])
export type WorkerFamily = "claude" | "codex" | "gemini"
export const ALLOWED_FAMILIES = new Set<WorkerFamily>(["claude", "codex", "gemini"])
const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/

/** Footer on every worker brief: a turn ends on finished work, and a background-notification turn restates the report. */
export const WORKER_TURN_RULE = "Turn rule: end your turn only when the work you report is done. Never end a turn saying you are waiting on " +
  "background work (a background shell, a long render or run): wait for it in this turn, or stop it and report what you have. " +
  "If you are woken again after your report (a background-task notification, a resume), your reply must restate your full final " +
  "report (links, choices, QA) updated with what changed, never a short note in its place."

/** Footer on every worker brief: the worker ships its own code. No runner commits for a bin/worker task (a88c7bd9 left it all staged). */
export const WORKER_SHIP_RULE = "Ship rule: if this brief changes files in the repo, you commit them yourself on your current branch " +
  "(dispatch/<task id>), push it, open ONE pull request with gh pr create (never to main directly, never merge it) and put the PR link " +
  "in your final report. Nobody commits, pushes or opens the PR after you: a rule or skill saying \"the runner commits the diff and opens " +
  "the PR\" (headless DISPATCH_HEADLESS jobs) does not apply to this worker. Never end with staged or uncommitted changes. " +
  "If the brief changes no files, open no PR and say so."
/** Footer on every worker brief: the phone's progress bar is the worker's own plan (TodoWrite / write_todos / Codex plan). */
export const WORKER_PLAN_RULE = "Plan rule: before your first change, write your plan as a todo list of your 5 to 10 main steps (TodoWrite, " +
  "write_todos or your plan tool), and update it as you go: one step in progress at a time, each marked completed as soon as it is done. " +
  "Jeremie's phone shows that list as this task's progress bar."
export const WORKER_FOOTER = `${WORKER_PLAN_RULE}\n\n${WORKER_SHIP_RULE}\n\n${WORKER_TURN_RULE}`
/** The footer for a task on an existing PR's head (the conflict resolver): it updates that PR, never opens one. */
export function workerFooter(targetBranch?: string | null): string {
  if (!targetBranch) return WORKER_FOOTER
  const ship = "Ship rule: this task updates an existing pull request. Commit on your current branch and push it only with " +
    `\`git push origin HEAD:refs/heads/${targetBranch}\` (never force, never another branch). Never open a pull request, never merge one. ` +
    "Never end with staged or uncommitted changes: commit and push, or abort and report what blocks."
  return `${WORKER_PLAN_RULE}\n\n${ship}\n\n${WORKER_TURN_RULE}`
}
/** After a turn's `result` event, a worker still alive this long is idle on background work: it gets SIGTERM, the turn stays completed. */
export const DEFAULT_REAP_GRACE_MS = 10_000

export type WorkerTaskStatus = "running" | "completed" | "failed" | "interrupted"
/** A worker card's drawer status follows its task: only a running task reads as working. */
export function workerAgentStatus(status: WorkerTaskStatus): "busy" | "idle" {
  return status === "running" ? "busy" : "idle"
}
/** The agent's own plan, read off its todo / plan tool: `source` todos = Claude TodoWrite or Gemini write_todos, plan = Codex todo_list. */
export interface PlanProgress { done: number; total: number; label: string; source: "todos" | "plan" }
/** A worker task's progress bar (snapshot, `builder_jobs` item, brain card `ref.progress`). source none = no plan seen:
 *  done / total are 0 and label is the last step. elapsedMs = turn start → last update. */
export interface WorkerProgress { done: number; total: number; label: string; source: PlanProgress["source"] | "none"; startedAt: number; elapsedMs: number }
/** The progress bar of a supervised task: its plan when it wrote one, else its last step. */
export function progressOf(t: { plan?: PlanProgress | null; step: string | null; turns?: ReadonlyArray<{ startedAt: number }>; startedAt: number; updatedAt: number; completedAt: number | null }): WorkerProgress {
  const turnStart = t.turns?.at(-1)?.startedAt ?? t.startedAt
  const time = { startedAt: turnStart, elapsedMs: Math.max(0, (t.completedAt ?? t.updatedAt) - turnStart) }
  return t.plan ? { ...t.plan, ...time } : { done: 0, total: 0, label: clipLabel(t.step ?? "Working"), source: "none", ...time }
}
/** Apply a stream event's plan / step to a task's progress: the worker's own plan beats tool labels (its current item is
 *  the step, pct = done / total). false = the event carries no progress. */
export function applyProgressEvent(t: { plan?: PlanProgress | null; step: string | null; pct: number | null; sessionStarted: boolean }, ev: StreamJsonEvent): boolean {
  if (ev.plan) t.plan = ev.plan
  if (!ev.step && !ev.plan) return false
  t.sessionStarted = true; t.step = t.plan?.label ?? ev.step ?? t.step
  t.pct = t.plan ? Math.round((t.plan.done / t.plan.total) * 100) : Math.min(90, Math.max(10, (t.pct ?? 5) + 8))
  return true
}
export interface StreamJsonEvent {
  sessionId?: string; step?: string; assistantText?: string; resultText?: string; isError?: boolean; prUrl?: string; done?: boolean; plan?: PlanProgress
}

/** Step labels stay short enough for a phone card. */
export const STEP_LABEL_MAX = 40
export const clipLabel = (s: string): string => (s.length > STEP_LABEL_MAX ? `${s.slice(0, STEP_LABEL_MAX - 1)}…` : s)
const SUBCOMMAND_TOOLS = new Set(["git", "gh", "bun", "npm", "pnpm", "yarn", "npx", "bunx", "cargo", "go", "docker", "turso", "herdr", "uv", "pip", "brew", "xcodebuild", "swift"])
const TEST_RE = /^(?:(?:bun|npm|pnpm|yarn|cargo|go|swift|deno)\s+(?:run\s+)?test|pytest|vitest|jest|python3?\s+-m\s+pytest|uv\s+run\s+pytest)\b/
const TYPECHECK_RE = /^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?)?(?:tsc|typecheck|type-check)\b/
const BUILD_RE = /^(?:(?:bun|npm|pnpm|yarn)\s+run\s+build|yarn\s+build|(?:astro|vite)\s+build)\b/
const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g
/** Commands that say nothing about what the worker is doing: skipped when picking the real command of a chain. */
const NOISE_COMMANDS = new Set(["cd", "pushd", "popd", "set", "true", "echo", "exit"])
/** Wrappers that run the next command; the flags that take a value are listed so the value isn't mistaken for the command. */
const WRAPPERS: Record<string, Set<string>> = {
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "--user", "--group"]),
  xargs: new Set(["-n", "-I", "-P", "-d", "-L", "-s", "-E", "-a"]),
  env: new Set(["-u", "-C", "-S"]),
  nohup: new Set(), time: new Set(), stdbuf: new Set(), npx: new Set(), bunx: new Set(), pnpx: new Set(),
}

/** Split a script on && || ; & and newlines outside quotes (2>&1 and &> are redirects); a pipeline keeps only its first command. */
function chainSegments(s: string): string[] {
  const out: string[] = []
  let cur = "", quote = "", piped = false
  const add = (x: string): void => { if (!piped) cur += x }
  const flush = (): void => { out.push(cur); cur = ""; piped = false }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === "\\" && quote !== "'") { add(c + (s[++i] ?? "")); continue }
    if (quote) { if (c === quote) quote = ""; add(c); continue }
    if (c === "'" || c === '"') { quote = c; add(c); continue }
    if (c === "|") { if (s[i + 1] === "|") { flush(); i++ } else piped = true; continue }
    if (c === ";" || c === "\n" || (c === "&" && !"<>".includes(s[i - 1] ?? "x") && s[i + 1] !== ">")) { flush(); continue }
    add(c)
  }
  out.push(cur)
  return out
}
const shellWords = (seg: string): string[] =>
  (seg.match(/(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"?|'[^']*'?)+/gs) ?? []).map((w) => w.replace(/\\(.)|"((?:[^"\\]|\\.)*)"?|'([^']*)'?/gs, (_, e, d, q) => e ?? d ?? q))

/** Drop leading `VAR=x`, `export`, `timeout 600`, `nice -n 5`, `sudo -u x`, `nohup`, `npx` … until the real command. */
function stripWrappers(words: string[]): string[] {
  const w = [...words]
  for (;;) {
    const head = w[0] ? basename(w[0]) : ""
    if (head === "export" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] ?? "")) { w.shift(); continue }
    if (!Object.hasOwn(WRAPPERS, head)) return w
    const valueFlags = WRAPPERS[head]!
    w.shift()
    while (w[0]?.startsWith("-")) if (valueFlags.has(w.shift()!)) w.shift()
    if (head === "timeout" && /^\d/.test(w[0] ?? "")) w.shift()
  }
}

/** The last meaningful command of a script, as words: `cd x && timeout 5 bash -c 'gh pr checks'` → [gh, pr, checks]. */
function lastCommand(script: string): string[] | null {
  let found: string[] | null = null
  for (const seg of chainSegments(script.replace(HEREDOC_RE, ""))) {
    let w = stripWrappers(shellWords(seg))
    if (/^(?:ba|z|da)?sh$/.test(w[0] ? basename(w[0]) : "")) {
      // Only the shell's own options: stop at `--` or the first non-option word (a script file and its arguments).
      let c = 1
      for (; /^[-+]./.test(w[c] ?? "") && w[c] !== "--" && !/^-[a-z]*c[a-z]*$/.test(w[c]!); c++) {
        if (/^(?:[-+][oO]|--rcfile|--init-file)$/.test(w[c]!)) c++
      }
      if (/^-[a-z]*c[a-z]*$/.test(w[c] ?? "")) w = (w[c + 1] !== undefined ? lastCommand(w[c + 1]!) : null) ?? []
    }
    if (w.length && !NOISE_COMMANDS.has(basename(w[0]!))) found = w
  }
  return found
}

/** A known command as a phrase, null = no phrase (the caller labels it "Running: <command>"). Matches on the command word and
 *  its leading words only, never on argument text. */
function commandPhrase(head: string, w: string[]): string | null {
  const [a, b] = [w[1], w[2]]
  const rest = w.slice(1)
  if (head === "gh") {
    if (rest.includes("--watch") || (a === "pr" && b === "checks") || (a === "run" && b === "watch")) return "Waiting for CI"
    if (a === "pr" && b === "create") return "Opening PR"
    if (a === "pr" && (b === "view" || b === "list")) return "Checking PR"
    return null
  }
  if (head === "git") return a === "push" ? "Pushing" : a === "commit" ? "Committing" : null
  if (head === "curl") return "Calling an API"
  if (head === "sleep") return "Waiting"
  if (head === "docker") return a === "build" ? "Building image" : null
  if (head === "wrangler") return a === "deploy" ? (rest.some((x) => /^(?:--env=?)?staging$/.test(x) || x === "--env=staging") ? "Deploying (staging)" : "Deploying") : null
  if (head === "gcloud") return a === "run" && b === "deploy" ? "Deploying to Cloud Run" : null
  if (head === "xcodebuild") return rest.includes("test") ? "Running tests" : null
  const lead = w.slice(0, 4).join(" ")
  return TEST_RE.test(lead) ? "Running tests" : TYPECHECK_RE.test(lead) ? "Type-checking" : BUILD_RE.test(lead) ? "Building" : null
}

/**
 * A shell command as a human label: "Waiting for CI", "Running tests", or "Running: <command word>" (plus its subcommand
 * for git / gh / bun …). The real command only: env assignments, `timeout 600`, `nohup`, `sudo`, `bash -c '…'`, `cd … &&`
 * and `export …;` are looked through. Never the pipeline, never an argument: no token or file content reaches the label.
 */
export function commandLabel(raw: unknown): string {
  const s = typeof raw === "string" ? raw
    : Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string").map((a) => (/[\s'"\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ") : ""
  const w = lastCommand(s)
  if (!w) return "Running command"
  const head = basename(w[0]!)
  const phrase = commandPhrase(head, w)
  if (phrase) return phrase
  if (!/^[A-Za-z0-9._+-]{1,32}$/.test(head)) return "Running command"
  const word = (x: string | undefined): boolean => !!x && /^[a-z][a-z0-9:-]{0,20}$/.test(x)
  const sub = SUBCOMMAND_TOOLS.has(head) && word(w[1]) ? ` ${w[1]}${w[1] === "run" && word(w[2]) ? ` ${w[2]}` : ""}` : ""
  return clipLabel(`Running: ${head}${sub}`)
}
function shortPath(raw: unknown, prefix: string): string {
  const base = typeof raw === "string" && raw.trim() ? basename(raw.trim()) : ""
  return clipLabel(base ? `${prefix} ${base}` : prefix)
}

/** A full todo list (TodoWrite `todos[{content, status, activeForm}]`, write_todos `todos[{description, status}]`,
 *  Codex `items[{text, completed}]`) → done / total and the current item. null = not a usable list. */
export function planProgress(items: unknown, source: PlanProgress["source"]): PlanProgress | null {
  if (!Array.isArray(items)) return null
  const list = items.filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => ({
      text: [i.activeForm, i.content, i.description, i.text, i.step].find((v): v is string => typeof v === "string" && !!v.trim()) ?? "",
      todo: [i.content, i.description, i.text, i.step].find((v): v is string => typeof v === "string" && !!v.trim()) ?? "",
      status: i.completed === true ? "completed" : typeof i.status === "string" ? i.status : "pending",
    }))
    .filter((i) => i.status !== "cancelled")
  if (!list.length) return null
  const done = list.filter((i) => i.status === "completed").length
  const current = list.find((i) => i.status === "in_progress") ?? list.find((i) => i.status !== "completed")
  const label = current ? (current.status === "in_progress" ? current.text : current.todo) : "Wrapping up"
  return { done, total: list.length, label: clipLabel(redactSecrets(label).replace(/\s+/g, " ").trim() || "Working"), source }
}

function setPlan(out: StreamJsonEvent, items: unknown, source: PlanProgress["source"]): void {
  const plan = planProgress(items, source)
  if (plan) out.plan = plan
}

function toolStep(name: string, input: Record<string, unknown>): string {
  const path = input.file_path ?? input.path ?? input.Path ?? input.TargetFile ?? input.AbsolutePath
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit" || name === "write_file" || name === "edit_file" || name === "replace" || name === "write_to_file" || name === "replace_file_content" || name === "multi_replace_file_content") return shortPath(path, "Editing")
  if (name === "Read" || name === "read_file" || name === "view_file") return shortPath(path, "Reading")
  const pattern = input.pattern ?? input.Query ?? input.Pattern
  if (name === "Grep" || name === "search_file_content" || name === "grep_search") return typeof pattern === "string" && pattern.trim() ? clipLabel(`Searching ${redactSecrets(pattern.trim())}`) : "Searching codebase"
  if (name === "Glob" || name === "glob" || name === "find_by_name" || name === "list_dir") return typeof pattern === "string" && pattern.trim() ? clipLabel(`Listing ${pattern.trim()}`) : "Listing files"
  if (name === "Bash" || name === "run_shell_command" || name === "run_command") {
    // The agent's own description of the call beats a derived label.
    const said = typeof input.description === "string" ? redactSecrets(input.description).replace(/\s+/g, " ").trim() : ""
    return said ? clipLabel(said) : commandLabel(input.command ?? input.CommandLine)
  }
  if (name === "TodoWrite" || name === "write_todos") return "Updating plan"
  return clipLabel(`Tool: ${name.split("__").at(-1)}`)
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
      if (body.tool_name === "write_todos" || info.name === "write_todos") setPlan(out, params.todos, "todos")
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
        if (b.name === "TodoWrite") setPlan(out, input.todos, "todos")
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

  if (obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") {
    const item = obj.item && typeof obj.item === "object" && !Array.isArray(obj.item) ? (obj.item as Record<string, unknown>) : null
    if (item) {
      if (item.type === "todo_list") setPlan(out, item.items, "plan")
      else if (obj.type === "item.updated") { /* only a plan's updates matter */ }
      else if (item.type === "command_execution") out.step = commandLabel(item.command)
      else if (item.type === "file_change") out.step = "Editing files"
      else if (item.type === "mcp_tool_call") out.step = clipLabel(`Tool: ${String(item.tool ?? item.server ?? "mcp")}`)
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
    if (toolName === "write_todos") setPlan(out, params.todos, "todos")
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
 * secrets from tls-agent-env) are merged BEFORE the scrub, so a notes DB / Companion / Phase key in them never gets through.
 */
export function buildWorkerEnv(baseEnv: NodeJS.ProcessEnv, taskId: string, builder: string, secrets: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = scrubAgentEnv({ ...baseEnv, ...secrets })
  env.DISPATCH_TASK_ID = taskId; env.DISPATCH_WORKER = "1"; env.DISPATCH_HEADLESS = "1"; env.COMPANION_TASK_ID = builder
  env.COMPANION_HEADLESS = "1"; env.COMPANION_ORIGIN = "worker"
  // Nobody answers a prompt in a headless worker: an API-enable [y/N] from gcloud hung a gemini worker's background task for the whole turn.
  env.CLOUDSDK_CORE_DISABLE_PROMPTS = "1"
  // Headless claude 2.1.x ships TaskCreate/TaskUpdate (incremental, ids in tool results); 0 brings back TodoWrite, whose
  // every call carries the full list, so the progress bar reads done / total off one event.
  env.CLAUDE_CODE_ENABLE_TASKS = "0"
  // The server's systemd invocation, not the worker's: a Companion test the worker runs must not take itself for the service.
  delete env.INVOCATION_ID
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
  if (rawAgent === "claude") return "claude"
  if (rawAgent === "codex") return "codex"
  if (rawAgent === "gemini") return "gemini"
  const rawModel = opts.model?.trim().toLowerCase() ?? ""
  if (/^(claude-|opus|sonnet|haiku|fable)/.test(rawModel)) return "claude"
  if (/^(gpt-|o1\b|o3\b|o4\b|codex)/.test(rawModel)) return "codex"
  if (/^(gemini[- ]|orchestrator)/.test(rawModel)) return "gemini"
  if (rawAgent) return "claude"
  return "gemini"
}

/** False when `model` names another family's model (a `claude-*` id handed to codex/agy or a codex id handed to agy). */
export function modelFitsFamily(model: string, family: WorkerFamily): boolean {
  const m = model.trim().toLowerCase()
  const implied = /^(claude-|opus|sonnet|haiku|fable)/.test(m) ? "claude"
    : /^(gpt-|o1\b|o3\b|o4\b|codex)/.test(m) ? "codex"
    : /^(gemini|orchestrator)/.test(m) ? "gemini" : null
  return implied === null || implied === family
}

/** Build the headless `claude -p` argv with `--` before positional prompt so `-...` prompts are never parsed as flags. */
export function buildHeadlessClaudeArgs(opts: { prompt: string; sessionId: string; resume: boolean; mode: string; agent?: string; model?: string; mcpConfig?: string }): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", opts.mode, ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId])]
  if (opts.agent && !ALLOWED_FAMILIES.has(opts.agent as WorkerFamily)) args.push("--agent", opts.agent)
  if (opts.model) args.push("--model", opts.model)
  if (opts.mcpConfig) args.push("--mcp-config", opts.mcpConfig)
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

export const DEFAULT_GEMINI_WORKER_MODEL = "gemini-4-argon-high"
/** Below Linux MAX_ARG_STRLEN (131,072 bytes): prompts larger than this go via a 0600 temp file + --add-dir. */
export const GEMINI_INLINE_PROMPT_MAX = 90_000

/** Hardened `--settings` JSON for headless `agy` workers: deny unscrubbed user MCPs and host secret roots. */
export function agyWorkerSettings(home = homedir()): string {
  const secretRoots = [
    join(home, ".claude-companion"),
    join(home, ".config", "tls-agent"),
    join(home, ".config", "gh"),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".claude", ".credentials.json"),
    join(home, ".codex"),
    "/proc",
  ].map((p) => `read_file(${p})`)
  return JSON.stringify({ permissions: { deny: ["mcp(*)", ...secretRoots] } })
}

/** Build the headless `agy -p --output-format stream-json` argv; agy mints the conversation id, so resume only. */
export function buildHeadlessGeminiArgs(opts: {
  prompt: string; sessionId: string; resume: boolean; mode: string; model?: string
  promptDir?: string; onTempDir?: (dir: string) => void
}): string[] {
  let printPrompt = opts.prompt
  let addDir: string | null = null
  if (Buffer.byteLength(opts.prompt, "utf8") > GEMINI_INLINE_PROMPT_MAX) {
    const dir = opts.promptDir ?? mkdtempSync(join(tmpdir(), "cc-agy-prompt-"))
    if (opts.promptDir) mkdirSync(dir, { recursive: true, mode: 0o700 })
    else opts.onTempDir?.(dir)
    chmodSync(dir, 0o700)
    const promptFile = join(dir, "prompt.txt")
    writeFileSync(promptFile, opts.prompt, { mode: 0o600 })
    chmodSync(promptFile, 0o600)
    addDir = dir
    printPrompt = `Read the full task brief from ${promptFile} using read_file and follow it strictly.`
  }
  const args = [`--print=${printPrompt}`, "--output-format", "stream-json"]
  if (addDir) args.push("--add-dir", addDir)
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
export function buildHeadlessWorkerInvocation(opts: { family: WorkerFamily; prompt: string; sessionId: string; resume: boolean; mode: string; agent?: string; model?: string; home?: string }): { cmd: string; args: string[]; cleanup?: () => void } {
  if (opts.family === "codex") return { cmd: "codex", args: buildHeadlessCodexArgs(opts) }
  if (opts.family === "gemini") {
    let tempDir: string | null = null
    const args = [...buildHeadlessGeminiArgs({ ...opts, onTempDir: (d) => { tempDir = d } }), "--settings", agyWorkerSettings(opts.home)]
    return {
      cmd: agyBin(),
      args,
      ...(tempDir ? { cleanup: () => { try { rmSync(tempDir!, { recursive: true, force: true }) } catch { /* best-effort */ } } } : {}),
    }
  }
  // Worker-only sandbox network additions (lists merge with the user settings): the production jobs Codex already does.
  return { cmd: "claude", args: ["--settings", JSON.stringify({ sandbox: { network: { allowedDomains: WORKER_SANDBOX_HOSTS } } }), ...buildHeadlessClaudeArgs(opts)] }
}
