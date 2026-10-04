import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Turn } from "./orchestrator-chat"
import { parseCliResult } from "./cli-json"

// Orchestrator brain (PRJ-OR1T). Decides whether to answer a user message inline
// (chat) or propose dispatching a worker Claude (proposal). Phase 3 tiers the
// work by cost:
//   gate+chat  (classify, and answer if chat)  → Haiku — cheap, runs on EVERY message
//   compose    (proposal cwd+prompt)           → Opus  — only when the gate says task
// Runs via `claude -p` headless (Max OAuth, no API key). Two notes that shape the
// design:
//  - `claude -p` is a full agent WITH tools, so every call is pinned
//    classifier/responder-only (work tools denied + system prompt) or it just
//    DOES the task instead of routing it.
//  - Each `claude -p` carries a ~11s process-startup floor (no API-key path on
//    Max to avoid it), so a separate Sonnet "chat" tier would be a pure latency
//    tax for marginal quality. Instead the Haiku gate ALSO writes the chat reply
//    in the same call; only a task escalates to a second (Opus) call. Brain calls
//    run in a bare cwd so they don't pay to load a project's MCP servers (~5s).

// A proposal files a Turso agent task (orchestrator-one-queue P2): noteId + agent
// are the brain's pick, validated server-side against /projects and the agent
// allowlist; cwd is only for a live tmux run ("" when none).
export type BrainDecision =
  | { kind: "chat"; text: string }
  | { kind: "proposal"; cwd: string; prompt: string; reasoning: string; noteId: string | null; agent: string | null; title: string | null }

/** What compose may pick from: active projects, dispatchable agents, the channel's own note. */
export interface ComposeTargets {
  projects: { noteId: string; ref: string | null; title: string }[]
  agents: string[]
  channelNoteId: string | null
}

const GATE_MODEL = process.env.COMPANION_GATE_MODEL || "claude-haiku-4-5"
const COMPOSE_MODEL = process.env.COMPANION_COMPOSE_MODEL || "claude-opus-4-8"
const CALL_TIMEOUT_MS = 90_000
const BRAIN_MAX_ATTEMPTS = 3
const BRAIN_RETRY_BACKOFF_MS = 1500

// Run brain calls here — a directory with no .mcp.json — so claude -p doesn't
// load project MCP servers on every classification. The companion data dir fits.
const BRAIN_CWD = join(homedir(), ".claude-companion")

const NO_TOOLS_SYSTEM =
  "You have NO tools and must NEVER attempt to run, read, edit, or search anything. " +
  "Do not perform the user's task. Follow the output format exactly, nothing else."
const DENY_TOOLS = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "Task", "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite"]

// The launchd service PATH excludes ~/.local/bin where claude installs, so the
// bare name won't resolve under the daemon. Resolve to an absolute path.
function resolveClaudeBin(): string {
  const candidates = [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
  return candidates.find((p) => existsSync(p)) ?? "claude"
}

function stripFence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
}

function history(turns: Turn[]): string {
  const h = turns.slice(-20).map((t) => `${t.role}: ${t.text}`).join("\n")
  return h || "(empty)"
}

// One headless model call, tools disabled. Returns the model's text (the wrapper
// `.result`), or null on any failure. Caller decides how to parse it.
async function runClaudeOnce(model: string, prompt: string): Promise<string | null> {
  const bin = resolveClaudeBin()
  const proc = Bun.spawn(
    [bin, "-p", prompt, "--append-system-prompt", NO_TOOLS_SYSTEM, "--disallowed-tools", ...DENY_TOOLS,
      "--model", model, "--output-format", "json"],
    { stdout: "pipe", stderr: "pipe", cwd: BRAIN_CWD },
  )
  const timer = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, CALL_TIMEOUT_MS)
  let out: string
  try {
    out = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
  // Field order and leading warnings vary across CLI versions — see cli-json.ts.
  return parseCliResult(out)
}

// Retry the headless call before giving up. The dominant failure in the wild was
// a transient non-zero exit (model 429/529, or OAuth token-refresh contention
// between the concurrent brain + worker `claude -p` calls that share one Max
// credential) on a message that was itself perfectly clear — the same text that
// "failed" succeeds on the next attempt. A null return now means the model was
// genuinely unreachable, not that the user was unclear.
async function runClaude(model: string, prompt: string): Promise<string | null> {
  for (let attempt = 0; attempt < BRAIN_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await Bun.sleep(BRAIN_RETRY_BACKOFF_MS * attempt)
    const out = await runClaudeOnce(model, prompt)
    if (out !== null) return out
  }
  return null
}

// Extra live context (e.g. the Body monitor digest, wiring/body.ts) placed
// before the thread. Empty when there is none, so prompts are unchanged.
export function contextLines(context: string | null): string[] {
  return context?.trim() ? ["Live system context (read-only; use it for health and work-queue questions):", context.trim(), ""] : []
}

// ---- tier 1: gate + chat (Haiku) ------------------------------------------

type Gate = { kind: "chat"; text: string } | { kind: "task" }

// One cheap call that classifies AND, when it's chat, writes the reply — so the
// common case costs a single Haiku call. A task returns just the marker; Opus
// composes the dispatch in tier 2.
async function gateAndChat(turns: Turn[], userMessage: string, context: string | null = null): Promise<Gate | null> {
  const prompt = [
    "You are the orchestrator for Jeremie — one always-open chat that can dispatch work to worker Claude sessions.",
    "Classify the latest user message and respond accordingly. Return ONLY minified JSON, one of:",
    '{"kind":"chat","text":"<your concise direct reply>"}',
    '{"kind":"task"}',
    "",
    "CHAT = you can answer now: a question, a fact, planning, chit-chat, or anything ambiguous/underspecified. Put your reply in text.",
    "TASK = real work to dispatch to a worker in a project directory (run/build/edit/test something concrete). A stronger model will compose the dispatch — return just the marker, no text.",
    "",
    ...contextLines(context),
    "Recent thread:",
    history(turns),
    "",
    "Latest user message:",
    userMessage,
  ].join("\n")
  const raw = await runClaude(GATE_MODEL, prompt)
  if (!raw) return null
  try {
    const o = JSON.parse(stripFence(raw)) as { kind?: string; text?: string }
    if (o.kind === "task") return { kind: "task" }
    if (o.kind === "chat" && typeof o.text === "string" && o.text.trim()) return { kind: "chat", text: o.text.trim() }
    return null
  } catch {
    return null
  }
}

// ---- tier 2: compose proposal (Opus) --------------------------------------

function parseProposal(raw: string): BrainDecision | null {
  let obj: unknown
  try {
    obj = JSON.parse(stripFence(raw))
  } catch {
    return null
  }
  if (typeof obj !== "object" || obj === null) return null
  const o = obj as Record<string, unknown>
  if (o.kind === "chat" && typeof o.text === "string" && o.text.trim()) {
    return { kind: "chat", text: o.text.trim() }
  }
  if (o.kind === "proposal" && typeof o.prompt === "string" && o.prompt.trim() && typeof o.reasoning === "string") {
    const cwd = typeof o.cwd === "string" && o.cwd.startsWith("/") ? o.cwd : ""
    const noteId = typeof o.noteId === "string" && o.noteId.trim() ? o.noteId.trim() : null
    if (!cwd && !noteId) return null
    const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
    return { kind: "proposal", cwd, prompt: o.prompt.trim(), reasoning: o.reasoning.trim(), noteId, agent: opt(o.agent), title: opt(o.title) }
  }
  return null
}

function targetLines(t: ComposeTargets | null): string[] {
  if (!t) return []
  const projects = t.projects.slice(0, 40).map((p) => `  - ${p.noteId}${p.ref ? ` (${p.ref})` : ""}: ${p.title}`)
  return [
    "- noteId = the project this task belongs to. Pick from these active projects:",
    ...(projects.length ? projects : ["  (none listed)"]),
    ...(t.channelNoteId ? [`- This channel is the project ${t.channelNoteId} — use it unless the user explicitly names another project.`] : []),
    `- agent = who runs it, one of: ${t.agents.slice(0, 60).join(", ") || "builder"} (code changes → builder).`,
    "- title = a short task title (≤ 80 chars).",
  ]
}

async function composeProposal(
  turns: Turn[], userMessage: string, candidateCwds: string[], channelCwd: string | null, context: string | null = null,
  targets: ComposeTargets | null = null,
): Promise<BrainDecision | null> {
  const dirs = candidateCwds.length ? candidateCwds.map((d) => `  - ${d}`).join("\n") : "  (none currently active)"
  const channelLine = channelCwd
    ? `- This conversation is the channel for the project at ${channelCwd} — dispatch there unless the user explicitly names another project.`
    : null
  const prompt = [
    "You are the orchestrator brain. The user wants real work done — compose a dispatch proposal for a worker Claude.",
    "Return ONLY minified JSON. No prose, no markdown fences. One of:",
    '{"kind":"proposal","noteId":"<project note id>","agent":"<agent slug>","title":"<short title>","cwd":"<absolute project dir, optional>","prompt":"<full self-contained task prompt for the worker>","reasoning":"<one sentence: why this worker, why now>"}',
    '{"kind":"chat","text":"<a clarifying question>"}   ← use this if you cannot determine the project or the task',
    "",
    "Rules:",
    ...targetLines(targets),
    "- cwd (optional) MUST be an absolute path. Candidate project directories:",
    dirs,
    ...(channelLine ? [channelLine] : []),
    "- The worker prompt must be self-contained — the worker has NO memory of this conversation.",
    "- If it's ambiguous which project or what to do, return the chat form with a clarifying question instead of guessing.",
    "",
    ...contextLines(context),
    "Recent thread:",
    history(turns),
    "",
    "Latest user message:",
    userMessage,
  ].join("\n")
  const raw = await runClaude(COMPOSE_MODEL, prompt)
  return raw ? parseProposal(raw) : null
}

// ---- orchestration --------------------------------------------------------

// Tiered decide: Haiku gates-and-chats; only a task escalates to Opus compose.
// channelCwd (Phase 6) anchors compose to the project channel the message came
// from, so "fix the payload" sent in #tls-dashboard needs no project spelled out.
// Returns null only if the gate call fails outright (caller falls back to a soft note).
export async function decide(
  turns: Turn[],
  userMessage: string,
  candidateCwds: string[],
  channelCwd: string | null = null,
  context: string | null = null,
  targets: ComposeTargets | null = null,
): Promise<BrainDecision | null> {
  const g = await gateAndChat(turns, userMessage, context)
  if (!g) return null
  if (g.kind === "chat") return g
  // task → Opus composes the dispatch (and may downgrade to a clarifying chat).
  const proposal = await composeProposal(turns, userMessage, candidateCwds, channelCwd, context, targets)
  if (proposal) return proposal
  return { kind: "chat", text: "Looks like a task, but I couldn't pin down the project — which one?" }
}
