import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Turn } from "./orchestrator-chat"

// Orchestrator brain (PRJ-OR1T Phase 2). Given the thread + the latest user
// message, decide whether to answer inline (chat) or propose dispatching a worker
// Claude (proposal). Runs the model via `claude -p` headless — Max OAuth, no API
// key, same path the eval harness uses. Phase 3 will split this into a Haiku gate
// + Opus compose; Phase 2 uses one capable model for both.

export type BrainDecision =
  | { kind: "chat"; text: string }
  | { kind: "proposal"; cwd: string; prompt: string; reasoning: string }

const DEFAULT_MODEL = "claude-opus-4-8"
const CALL_TIMEOUT_MS = 90_000

// `claude -p` is a full agent WITH tools — left unconstrained it will actually
// DO the task ("run the typecheck") instead of classifying it. Deny the work
// tools and pin classifier-only behavior so it can only emit the JSON decision.
const SYSTEM_PROMPT =
  "You are a routing classifier, NOT an executor. You have NO tools and must NEVER attempt to run, read, edit, or search anything. " +
  "Do not perform the user's task — only classify it. Your entire output is ONE line of minified JSON, nothing else."
const DENY_TOOLS = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "Task", "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite"]

// The launchd service PATH excludes ~/.local/bin where claude installs, so the
// bare name won't resolve under the daemon. Resolve to an absolute path.
function resolveClaudeBin(): string {
  const candidates = [
    join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]
  return candidates.find((p) => existsSync(p)) ?? "claude"
}

function buildPrompt(turns: Turn[], userMessage: string, candidateCwds: string[]): string {
  const history = turns
    .slice(-20)
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n")
  const dirs = candidateCwds.length ? candidateCwds.map((d) => `  - ${d}`).join("\n") : "  (none currently active)"
  return [
    "You are the orchestrator brain for Jeremie's Claude Companion — one always-open chat that dispatches work to worker Claude sessions.",
    "You receive the recent thread and the latest user message. Decide EXACTLY ONE:",
    '- "chat": answer directly — a question, a fact, planning, or when you lack the info to dispatch safely.',
    '- "proposal": the user wants real work done in a specific project; propose dispatching a worker.',
    "",
    "Return ONLY minified JSON. No prose, no markdown fences. One of:",
    '{"kind":"chat","text":"<reply>"}',
    '{"kind":"proposal","cwd":"<absolute project dir>","prompt":"<full self-contained task prompt for the worker>","reasoning":"<one sentence: why this worker, why now>"}',
    "",
    "Rules:",
    "- cwd MUST be an absolute path. Candidate project directories (pick the best fit; if none fit, return chat asking which):",
    dirs,
    "- The worker prompt must be self-contained — the worker has NO memory of this conversation.",
    "- If it's ambiguous which project or what to do, return chat with a clarifying question instead of guessing.",
    "- Prefer chat for anything conversational or that you can answer now.",
    "",
    "Recent thread:",
    history || "(empty)",
    "",
    "Latest user message:",
    userMessage,
  ].join("\n")
}

function stripFence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
}

function parseDecision(raw: string): BrainDecision | null {
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

// Run the model. Returns the decision, or null on any failure (caller falls back
// to treating the message as plain chat so the thread never wedges).
export async function decide(turns: Turn[], userMessage: string, candidateCwds: string[]): Promise<BrainDecision | null> {
  const bin = resolveClaudeBin()
  const model = process.env.COMPANION_BRAIN_MODEL || DEFAULT_MODEL
  const prompt = buildPrompt(turns, userMessage, candidateCwds)

  const proc = Bun.spawn(
    [bin, "-p", prompt, "--append-system-prompt", SYSTEM_PROMPT, "--disallowed-tools", ...DENY_TOOLS,
      "--model", model, "--output-format", "json"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => { try { proc.kill() } catch { /* already gone */ } }, CALL_TIMEOUT_MS)
  let out: string
  try {
    out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }

  // The CLI may print a warning line (e.g. an unknown deny-rule) before the JSON
  // wrapper, so start parsing from the result object, not byte 0.
  const jsonStart = out.indexOf('{"type"')
  if (jsonStart < 0) return null
  let wrapper: { result?: string }
  try {
    wrapper = JSON.parse(out.slice(jsonStart)) as { result?: string }
  } catch {
    return null
  }
  if (typeof wrapper.result !== "string") return null
  return parseDecision(wrapper.result)
}
