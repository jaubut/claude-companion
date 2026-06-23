import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Turn } from "./orchestrator-chat"

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

export type BrainDecision =
  | { kind: "chat"; text: string }
  | { kind: "proposal"; cwd: string; prompt: string; reasoning: string }

const GATE_MODEL = process.env.COMPANION_GATE_MODEL || "claude-haiku-4-5"
const COMPOSE_MODEL = process.env.COMPANION_COMPOSE_MODEL || "claude-opus-4-8"
const CALL_TIMEOUT_MS = 90_000

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
async function runClaude(model: string, prompt: string): Promise<string | null> {
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
  // The CLI may print a warning before the JSON wrapper, so parse from the result
  // object, not byte 0.
  const jsonStart = out.indexOf('{"type"')
  if (jsonStart < 0) return null
  try {
    const w = JSON.parse(out.slice(jsonStart)) as { result?: string }
    return typeof w.result === "string" ? w.result : null
  } catch {
    return null
  }
}

// ---- tier 1: gate + chat (Haiku) ------------------------------------------

type Gate = { kind: "chat"; text: string } | { kind: "task" }

// One cheap call that classifies AND, when it's chat, writes the reply — so the
// common case costs a single Haiku call. A task returns just the marker; Opus
// composes the dispatch in tier 2.
async function gateAndChat(turns: Turn[], userMessage: string): Promise<Gate | null> {
  const prompt = [
    "You are the orchestrator for Jeremie — one always-open chat that can dispatch work to worker Claude sessions.",
    "Classify the latest user message and respond accordingly. Return ONLY minified JSON, one of:",
    '{"kind":"chat","text":"<your concise direct reply>"}',
    '{"kind":"task"}',
    "",
    "CHAT = you can answer now: a question, a fact, planning, chit-chat, or anything ambiguous/underspecified. Put your reply in text.",
    "TASK = real work to dispatch to a worker in a project directory (run/build/edit/test something concrete). A stronger model will compose the dispatch — return just the marker, no text.",
    "",
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
  if (
    o.kind === "proposal" &&
    typeof o.cwd === "string" && o.cwd.startsWith("/") &&
    typeof o.prompt === "string" && o.prompt.trim() &&
    typeof o.reasoning === "string"
  ) {
    return { kind: "proposal", cwd: o.cwd, prompt: o.prompt.trim(), reasoning: o.reasoning.trim() }
  }
  return null
}

async function composeProposal(turns: Turn[], userMessage: string, candidateCwds: string[]): Promise<BrainDecision | null> {
  const dirs = candidateCwds.length ? candidateCwds.map((d) => `  - ${d}`).join("\n") : "  (none currently active)"
  const prompt = [
    "You are the orchestrator brain. The user wants real work done — compose a dispatch proposal for a worker Claude.",
    "Return ONLY minified JSON. No prose, no markdown fences. One of:",
    '{"kind":"proposal","cwd":"<absolute project dir>","prompt":"<full self-contained task prompt for the worker>","reasoning":"<one sentence: why this worker, why now>"}',
    '{"kind":"chat","text":"<a clarifying question>"}   ← use this if you cannot determine the project or the task',
    "",
    "Rules:",
    "- cwd MUST be an absolute path. Candidate project directories (pick the best fit; if none fit, ask which):",
    dirs,
    "- The worker prompt must be self-contained — the worker has NO memory of this conversation.",
    "- If it's ambiguous which project or what to do, return the chat form with a clarifying question instead of guessing.",
    "",
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
// Same return contract as before, so the server is unchanged. Returns null only
// if the gate call fails outright (caller falls back to a soft note).
export async function decide(turns: Turn[], userMessage: string, candidateCwds: string[]): Promise<BrainDecision | null> {
  const g = await gateAndChat(turns, userMessage)
  if (!g) return null
  if (g.kind === "chat") return g
  // task → Opus composes the dispatch (and may downgrade to a clarifying chat).
  const proposal = await composeProposal(turns, userMessage, candidateCwds)
  if (proposal) return proposal
  return { kind: "chat", text: "Looks like a task, but I couldn't pin down the project — which directory?" }
}
