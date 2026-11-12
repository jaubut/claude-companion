import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { appendFeedEvent, type FeedEvent } from "./feed"
import { syncExternalToolActivity, clearExternalSessionActivity } from "./activity"
import { listSessions, recordSession } from "./sessions"
import { clampLong, summarize, verbFor, extractToolResult } from "./tool-format"
import { THINKING_MAX } from "./transcript"
import { readTailLines } from "./transcript-cursor"
import type { HistorySession } from "./transcript-backfill"

const POLL_MS = 1_500
const THREAD_WINDOW_MS = 24 * 60 * 60 * 1_000
const MAX_CONVERSATIONS = 10
const INITIAL_EVENTS_PER_CONVERSATION = 60
const TAIL_BYTES = 2 * 1024 * 1024

export interface AgyConversationSummary {
  id: string
  title: string
  cwd: string
  status: "busy" | "idle"
  updatedAtMs: number
  stepCount: number
}

interface AgyTranscriptStep {
  step_index?: number
  source?: string
  type?: string
  status?: string
  created_at?: string
  content?: string
  thinking?: string
  tool_calls?: Array<{
    name?: string
    args?: Record<string, unknown>
  }>
}

export function agyRootDir(home = homedir()): string {
  return join(home, ".gemini", "antigravity-cli")
}

export function agySummariesDbPath(home = homedir()): string {
  return join(agyRootDir(home), "conversation_summaries.db")
}

export function agyTranscriptPath(sessionId: string, home = homedir()): string {
  return join(agyRootDir(home), "brain", sessionId, ".system_generated", "logs", "transcript.jsonl")
}

export function readAgyModel(home = homedir()): string {
  try {
    const raw = readFileSync(join(agyRootDir(home), "settings.json"), "utf8")
    const parsed = JSON.parse(raw) as { model?: unknown }
    if (typeof parsed.model === "string" && parsed.model.trim()) {
      return parsed.model.trim()
    }
  } catch { /* ignore */ }
  return "Gemini 4 Argon (Medium)"
}

export function extractAgyUserPrompt(rawContent: unknown): string | null {
  if (typeof rawContent !== "string") return null
  const m = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i)
  const text = (m ? m[1] ?? "" : rawContent).trim()
  if (!text || text.startsWith("<") || text.startsWith("[Request interrupted")) return null
  return text
}

function unquoteArgVal(v: unknown): unknown {
  if (typeof v !== "string") return v
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) } catch { return v.slice(1, -1) }
  }
  return v
}

function normalizeAgyToolArgs(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    out[k] = unquoteArgVal(v)
  }
  if (typeof out.Path === "string" && !out.file_path) out.file_path = out.Path
  if (typeof out.CommandLine === "string" && !out.command) out.command = out.CommandLine
  if (typeof out.toolSummary === "string" && !out.description) out.description = out.toolSummary
  return out
}

export function parseAgyTranscriptLine(
  line: string,
  ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId">,
  fallbackSessionId: string,
): FeedEvent[] {
  if (!line.trim()) return []
  let step: AgyTranscriptStep
  try {
    step = JSON.parse(line) as AgyTranscriptStep
  } catch {
    return []
  }
  const stepIdx = typeof step.step_index === "number" ? step.step_index : -1
  if (stepIdx < 0) return []
  const ts = Date.parse(step.created_at ?? "") || Date.now()
  const sid = ident.sessionId || fallbackSessionId
  const idBase = `agy:${sid}:${stepIdx}`

  if (step.type === "USER_INPUT") {
    const text = extractAgyUserPrompt(step.content)
    if (!text) return []
    return [{
      id: `${idBase}:user`,
      ts,
      kind: "user_prompt",
      text: clampLong(text, 16_000),
      ...ident,
    }]
  }

  if (step.type === "PLANNER_RESPONSE") {
    const out: FeedEvent[] = []
    if (typeof step.thinking === "string" && step.thinking.trim()) {
      out.push({
        id: `${idBase}:thinking`,
        ts,
        kind: "assistant_thinking",
        text: clampLong(step.thinking.trim(), THINKING_MAX),
        ...ident,
      })
    }
    if (Array.isArray(step.tool_calls)) {
      step.tool_calls.forEach((tc, idx) => {
        const rawName = typeof tc?.name === "string" && tc.name.trim() ? tc.name.trim() : "tool"
        const name = rawName.replace(/^default_api:/, "")
        const args = normalizeAgyToolArgs(tc?.args)
        const summary = summarize(name, args) || (typeof args.toolSummary === "string" ? args.toolSummary.trim() : "")
        out.push({
          id: `${idBase}:tool:${idx}`,
          ts,
          kind: "tool_start",
          tool: name,
          summary,
          verdict: "auto-allow",
          ...ident,
        })
      })
    }
    if (typeof step.content === "string" && step.content.trim()) {
      out.push({
        id: `${idBase}:text`,
        ts,
        kind: "assistant_text",
        text: clampLong(step.content.trim(), 64_000),
        ...ident,
      })
    }
    return out
  }

  if (step.type === "GENERIC" && typeof step.content === "string" && step.content.includes("Command output:")) {
    const outIdx = step.content.indexOf("Command output:")
    const rawOut = step.content.slice(outIdx + "Command output:".length).trim()
    const errored = /Command exited with code [1-9]/.test(step.content)
    const res = extractToolResult("run_command", rawOut)
    if (res.excerpt || errored) {
      return [{
        id: `${idBase}:tool_end`,
        ts,
        kind: "tool_end",
        tool: "run_command",
        summary: "",
        outputExcerpt: res.excerpt,
        errored: errored || res.errored,
        ...ident,
      }]
    }
  }

  return []
}

export function eventsFromAgyTranscript(path: string, s: HistorySession, tailBytes = TAIL_BYTES): FeedEvent[] {
  if (!existsSync(path)) return []
  const ident = {
    key: s.key,
    cwd: s.cwd,
    ...(s.tty ? { tty: s.tty } : {}),
    sessionId: s.sessionId,
  }
  const out: FeedEvent[] = []
  for (const line of readTailLines(path, tailBytes)) {
    out.push(...parseAgyTranscriptLine(line, ident, s.sessionId))
  }
  return out
}

function firstWorkspacePath(workspaceUrisJson: string): string {
  try {
    const arr = JSON.parse(workspaceUrisJson) as unknown
    if (Array.isArray(arr) && typeof arr[0] === "string") {
      const uri = arr[0]
      if (uri.startsWith("file://")) {
        return decodeURIComponent(uri.slice("file://".length))
      }
      if (uri.startsWith("/")) return uri
    }
  } catch { /* ignore */ }
  return homedir()
}

function parseAgyTimestamp(raw: string): number {
  if (!raw) return 0
  const iso = raw.trim().replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T").replace(/(\.\d{3})\d+/, "$1")
  return Date.parse(iso) || 0
}

let cachedRecentAgyConversations: AgyConversationSummary[] = []

function isEphemeralSubagentTranscript(sessionId: string, home: string): boolean {
  const path = agyTranscriptPath(sessionId, home)
  if (!existsSync(path)) return false
  try {
    const raw = readFileSync(path, "utf8")
    const head = raw.slice(0, 8192)
    if (head.includes('"type":"USER_INPUT"')) return false
    if (head.includes("<SYSTEM_MESSAGE>") && head.includes("sender=")) return true
  } catch { /* ignore */ }
  return false
}

export function readRecentAgyConversations(home = homedir(), windowMs = THREAD_WINDOW_MS): AgyConversationSummary[] {
  const dbPath = agySummariesDbPath(home)
  if (!existsSync(dbPath)) return []
  const cutoff = Date.now() - windowMs
  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      db.exec("PRAGMA busy_timeout = 2500;")
      const rows = db.query(`
        SELECT
          conversation_id AS id,
          title,
          step_count AS stepCount,
          last_modified_time AS lastModifiedTime,
          workspace_uris AS workspaceUris,
          status,
          not_fully_idle AS notFullyIdle
        FROM conversation_summaries
        WHERE killed = 0
          AND step_count > 0
        ORDER BY last_modified_time DESC
        LIMIT ?
      `).all(MAX_CONVERSATIONS) as Array<{
        id: string
        title: string
        stepCount: number
        lastModifiedTime: string
        workspaceUris: string
        status: string
        notFullyIdle: number
      }>
      const out: AgyConversationSummary[] = []
      for (const r of rows) {
        if (!r.id) continue
        const updatedAtMs = parseAgyTimestamp(r.lastModifiedTime)
        if (updatedAtMs < cutoff) continue
        const trimmedTitle = (r.title || "").trim()
        if (!trimmedTitle && isEphemeralSubagentTranscript(r.id, home)) continue
        const busy = Boolean(r.notFullyIdle) || r.status === "CASCADE_RUN_STATUS_RUNNING"
        out.push({
          id: r.id,
          title: trimmedTitle || "Antigravity Session",
          cwd: firstWorkspacePath(r.workspaceUris),
          status: busy ? "busy" : "idle",
          updatedAtMs,
          stepCount: Number(r.stepCount) || 0,
        })
      }
      if (home === homedir()) cachedRecentAgyConversations = out
      return out
    } finally {
      db.close()
    }
  } catch {
    if (home === homedir() && cachedRecentAgyConversations.length > 0) {
      return cachedRecentAgyConversations.filter((c) => c.updatedAtMs >= cutoff)
    }
    return []
  }
}

const offsets = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | null = null

export function startAgyFeedMonitor(home = homedir()): { stop: () => void } {
  if (!timer) {
    void pollAgyOnce(home)
    timer = setInterval(() => { void pollAgyOnce(home) }, POLL_MS)
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

async function pollAgyOnce(home = homedir()): Promise<void> {
  const convos = readRecentAgyConversations(home)
  if (convos.length === 0) return

  const agyModel = readAgyModel(home)
  const currentSessions = listSessions()
  for (const c of convos.slice(0, 5)) {
    const ttyOwner = currentSessions.find((s) => s.sessionId === c.id && !!s.tty)
    if (ttyOwner) {
      if (ttyOwner.agentStatus !== c.status || (c.title && ttyOwner.title !== c.title)) {
        recordSession({
          ...ttyOwner,
          title: c.title || ttyOwner.title,
          agentStatus: c.status,
          model: ttyOwner.model || agyModel,
        }, { provisional: true, sessionIdConfirmed: true })
      }
      continue
    }
    const existing = currentSessions.find((s) => s.sessionId === c.id)
    if (!existing || existing.agentStatus !== c.status || existing.title !== c.title) {
      recordSession({
        agent: "gemini",
        cwd: c.cwd,
        sessionId: c.id,
        herdrPane: `headless:agy:${c.id}`,
        title: c.title,
        label: c.title,
        firstSeenAt: existing?.firstSeenAt ?? (c.updatedAtMs || undefined),
        agentStatus: c.status,
        model: existing?.model || agyModel,
        pid: String(process.pid),
      }, { provisional: true, sessionIdConfirmed: true })
    }
  }

  const events: FeedEvent[] = []
  for (const c of convos) {
    events.push(...readAgyTranscriptDelta(c, home))
  }
  events.sort((a, b) => a.ts - b.ts)
  for (const ev of events) appendFeedEvent(ev)
}

function readAgyTranscriptDelta(convo: AgyConversationSummary, home = homedir()): FeedEvent[] {
  const path = agyTranscriptPath(convo.id, home)
  if (!existsSync(path)) return []

  const session = listSessions().find((s) => s.sessionId === convo.id)
  const ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId"> = {
    key: session?.key,
    cwd: session?.cwd || convo.cwd,
    ...(session?.tty ? { tty: session.tty } : {}),
    sessionId: convo.id,
  }

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }

  let start = offsets.get(path) ?? 0
  if (raw.length < start) start = 0

  let end = raw.length
  if (!raw.endsWith("\n")) {
    const lastNewline = raw.lastIndexOf("\n")
    if (lastNewline < start) return []
    end = lastNewline + 1
  }
  if (end <= start) {
    if (convo.status === "idle" && ident.key) {
      clearExternalSessionActivity({
        cwd: ident.cwd ?? "",
        sessionId: ident.sessionId,
        tty: ident.tty,
        transcriptPath: path,
        sessionKey: ident.key,
      })
    }
    return []
  }

  const firstRead = start === 0
  const chunk = raw.slice(start, end)
  offsets.set(path, end)

  const body = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk
  if (!body) return []

  const lines = firstRead ? body.split("\n").slice(-120) : body.split("\n")
  const out: FeedEvent[] = []
  for (const line of lines) {
    out.push(...parseAgyTranscriptLine(line, ident, convo.id))
  }
  if (!firstRead && ident.key) {
    const lastTool = [...out].reverse().find((e) => e.kind === "tool_start")
    const hasFinalReply = out.some((e) => e.kind === "assistant_text") && !lastTool
    if (lastTool && convo.status === "busy") {
      syncExternalToolActivity({
        verb: verbFor(lastTool.tool ?? "tool"),
        tool: lastTool.tool ?? "tool",
        summary: lastTool.summary ?? "",
        cwd: ident.cwd ?? "",
        sessionId: ident.sessionId,
        tty: ident.tty,
        transcriptPath: path,
        sessionKey: ident.key,
      })
    } else if (convo.status === "idle" || hasFinalReply) {
      clearExternalSessionActivity({
        cwd: ident.cwd ?? "",
        sessionId: ident.sessionId,
        tty: ident.tty,
        transcriptPath: path,
        sessionKey: ident.key,
      })
    }
  }
  return firstRead ? out.slice(-INITIAL_EVENTS_PER_CONVERSATION) : out
}

export function ensureHeadlessAgySession(lookup: string, fallbackCwd?: string, home = homedir()) {
  if (!lookup.startsWith("gemini:sid:")) return null
  const sid = lookup.slice("gemini:sid:".length).trim()
  if (!sid || !existsSync(agyTranscriptPath(sid, home))) return null
  const convo = readRecentAgyConversations(home).find((c) => c.id === sid)
  return recordSession({
    agent: "gemini",
    cwd: convo?.cwd || fallbackCwd || home,
    sessionId: sid,
    herdrPane: `headless:agy:${sid}`,
    title: convo?.title || "Antigravity Session",
    label: convo?.title || "Antigravity Session",
    agentStatus: convo?.status ?? "idle",
    model: readAgyModel(home),
    pid: String(process.pid),
  }, { provisional: true, sessionIdConfirmed: true })
}

export function deliverHeadlessAgyTurn(opts: {
  sessionId: string
  cwd: string
  prompt: string
}): boolean {
  try {
    const proc = Bun.spawn([
      "agy",
      "-p",
      opts.prompt,
      "--conversation",
      opts.sessionId,
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ], {
      cwd: opts.cwd || homedir(),
      stdout: "ignore",
      stderr: "ignore",
    })
    proc.unref()
    return true
  } catch {
    return false
  }
}
