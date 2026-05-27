// Import Codex CLI activity into the companion feed.
//
// Claude Code gives us hook callbacks at tool/user/stop boundaries. Codex CLI
// already writes the same high-value stream locally as rollout JSONL files, so
// this monitor tails those files and emits the existing FeedEvent shape. That
// lets the phone watch a normal Mac Codex session even when the prompt was
// typed directly in Terminal.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import { appendFeedEvent, summarize, type FeedEvent } from "./activity"
import { listSessions } from "./sessions"

const CODEX_STATE_DB = join(homedir(), ".codex", "state_5.sqlite")
const POLL_MS = 1500
const THREAD_WINDOW_MS = 6 * 60 * 60 * 1000
const MAX_THREADS = 10
const INITIAL_EVENTS_PER_THREAD = 80

interface ThreadRow {
  id: string
  cwd: string
  title: string
  firstUserMessage: string
  rolloutPath: string
  updatedAtMs: number
}

interface ToolCallState {
  tool: string
  summary: string
  startedAt: number
}

const offsets = new Map<string, number>()
const lineCounts = new Map<string, number>()
const callsByThread = new Map<string, Map<string, ToolCallState>>()
let timer: ReturnType<typeof setInterval> | null = null

export function startCodexFeedMonitor(): { stop: () => void } {
  if (!timer) {
    void pollOnce()
    timer = setInterval(() => { void pollOnce() }, POLL_MS)
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref()
    }
  }
  return {
    stop: () => {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
  }
}

async function pollOnce(): Promise<void> {
  const threads = readRecentThreads()
  if (threads.length === 0) return

  const events: FeedEvent[] = []
  for (const thread of threads) {
    events.push(...readRolloutDelta(thread))
  }

  events.sort((a, b) => a.ts - b.ts)
  for (const ev of events) appendFeedEvent(ev)
}

function readRecentThreads(): ThreadRow[] {
  if (!existsSync(CODEX_STATE_DB)) return []
  const cutoff = Date.now() - THREAD_WINDOW_MS
  try {
    const db = new Database(CODEX_STATE_DB, { readonly: true })
    try {
      return db.query(`
        select
          id,
          cwd,
          title,
          first_user_message as firstUserMessage,
          rollout_path as rolloutPath,
          coalesce(updated_at_ms, updated_at * 1000) as updatedAtMs
        from threads
        where source = 'cli'
          and archived = 0
          and rollout_path != ''
          and coalesce(updated_at_ms, updated_at * 1000) >= ?
        order by coalesce(updated_at_ms, updated_at * 1000) desc
        limit ?
      `).all(cutoff, MAX_THREADS) as ThreadRow[]
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

function readRolloutDelta(thread: ThreadRow): FeedEvent[] {
  const path = thread.rolloutPath
  if (!path) return []

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }

  let start = offsets.get(path) ?? 0
  if (raw.length < start) {
    start = 0
    lineCounts.set(path, 0)
    callsByThread.delete(thread.id)
  }

  let end = raw.length
  if (!raw.endsWith("\n")) {
    const lastNewline = raw.lastIndexOf("\n")
    if (lastNewline < start) return []
    end = lastNewline + 1
  }
  if (end <= start) return []

  const firstRead = start === 0
  const chunk = raw.slice(start, end)
  offsets.set(path, end)

  const body = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk
  if (!body) return []

  const lines = body.split("\n")
  const baseLine = firstRead ? 0 : (lineCounts.get(path) ?? 0)
  lineCounts.set(path, baseLine + lines.length)

  const out: FeedEvent[] = []
  for (let i = 0; i < lines.length; i++) {
    const evs = parseRolloutLine(thread, lines[i]!, baseLine + i + 1)
    out.push(...evs)
  }

  return firstRead ? out.slice(-INITIAL_EVENTS_PER_THREAD) : out
}

function parseRolloutLine(thread: ThreadRow, line: string, lineNo: number): FeedEvent[] {
  let entry: {
    timestamp?: string
    type?: string
    payload?: Record<string, unknown>
  }
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }

  const payload = entry.payload
  if (!payload || entry.type !== "response_item") return []

  const ts = Date.parse(entry.timestamp ?? "") || Number(thread.updatedAtMs) || Date.now()
  const identity = identityForThread(thread)
  const idBase = `codex:${thread.id}:${lineNo}`

  if (payload.type === "message") {
    const role = typeof payload.role === "string" ? payload.role : ""
    if (role !== "user" && role !== "assistant") return []

    const text = textFromContent(payload.content).trim()
    if (!text) return []

    if (role === "user") {
      if (isInternalUserMessage(text)) return []
      return [{
        id: `${idBase}:user`,
        ts,
        kind: "user_prompt",
        text: clampLong(text, 16_000),
        ...identity,
      }]
    }

    return [{
      id: `${idBase}:assistant`,
      ts,
      kind: "assistant_text",
      text: clampLong(text, 64_000),
      ...identity,
    }]
  }

  if (payload.type === "function_call") {
    const tool = typeof payload.name === "string" ? payload.name : "tool"
    const args = objectFromJson(payload.arguments)
    const summary = redactSensitive(summarizeCodexTool(tool, args))
    const callId = typeof payload.call_id === "string" ? payload.call_id : ""
    if (callId) {
      callsFor(thread.id).set(callId, { tool, summary, startedAt: ts })
    }
    return [{
      id: `${idBase}:tool_start`,
      ts,
      kind: "tool_start",
      tool,
      summary,
      verdict: "auto-allow",
      ...identity,
    }]
  }

  if (payload.type === "function_call_output") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : ""
    const call = callId ? callsFor(thread.id).get(callId) : undefined
    if (callId) callsFor(thread.id).delete(callId)
    const output = typeof payload.output === "string" ? payload.output : ""
    const result = outputExcerpt(output)
    return [{
      id: `${idBase}:tool_end`,
      ts,
      kind: "tool_end",
      tool: call?.tool ?? "tool",
      summary: call?.summary ?? "",
      durationMs: call?.startedAt ? Math.max(0, ts - call.startedAt) : undefined,
      outputExcerpt: result.excerpt,
      errored: result.errored,
      ...identity,
    }]
  }

  return []
}

function identityForThread(thread: ThreadRow): Pick<FeedEvent, "key" | "cwd" | "sessionId"> {
  const session = listSessions().find((s) => s.agent === "codex" && s.sessionId === thread.id)
  return {
    key: session?.key,
    cwd: thread.cwd,
    sessionId: thread.id,
  }
}

function callsFor(threadId: string): Map<string, ToolCallState> {
  let calls = callsByThread.get(threadId)
  if (!calls) {
    calls = new Map()
    callsByThread.set(threadId, calls)
  }
  return calls
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const chunks: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    const text = block.text
    if (typeof text === "string") chunks.push(text)
  }
  return chunks.join("\n\n")
}

function isInternalUserMessage(text: string): boolean {
  const t = text.trim()
  return t.startsWith("<environment_context>") ||
    t.includes("========= MEMORY_SUMMARY BEGINS =========") ||
    t.startsWith("<permissions instructions>")
}

function objectFromJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== "string" || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return { input: raw }
  }
  return {}
}

function summarizeCodexTool(tool: string, input: Record<string, unknown>): string {
  const base = summarize(tool, input)
  if (base) return base

  if (tool === "apply_patch") return "apply patch"
  if (tool === "spawn_agent") {
    const message = typeof input.message === "string" ? input.message : ""
    return message.slice(0, 160)
  }
  if (tool === "multi_tool_use.parallel") {
    const uses = input.tool_uses
    if (Array.isArray(uses)) {
      return uses
        .map((use) => typeof (use as Record<string, unknown>).recipient_name === "string"
          ? (use as Record<string, unknown>).recipient_name
          : "")
        .filter(Boolean)
        .slice(0, 3)
        .join(", ")
    }
  }

  const compact = JSON.stringify(input)
  return compact === "{}" ? "" : compact.slice(0, 160)
}

function outputExcerpt(raw: string): { excerpt?: string; errored?: boolean } {
  const stripped = stripAnsi(raw)
  const code = stripped.match(/Process exited with code (-?\d+)/)
  const errored = code ? Number(code[1]) !== 0 : undefined

  const marker = "\nOutput:\n"
  const outputStart = stripped.indexOf(marker)
  const body = outputStart >= 0 ? stripped.slice(outputStart + marker.length) : stripped
  const lines = body
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) =>
      line.trim().length > 0 &&
      !line.startsWith("Chunk ID:") &&
      !line.startsWith("Wall time:") &&
      !line.startsWith("Process exited with code") &&
      !line.startsWith("Original token count:") &&
      line !== "Output:",
    )
    .slice(0, 3)

  if (lines.length === 0) return { errored }
  const excerpt = lines.join("\n")
  return {
    excerpt: redactSensitive(excerpt.length > 220 ? `${excerpt.slice(0, 220)}...` : excerpt),
    errored,
  }
}

function redactSensitive(s: string): string {
  return s
    .replace(/(Authorization:\s*Bearer\s+)[^\s'"]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "")
}

function clampLong(s: string, max: number): string {
  if (s.length <= max) return s
  const overflow = s.length - max
  return `${s.slice(0, max)}\n\n...[truncated +${overflow.toLocaleString()} chars on the Mac]`
}
