import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { appendFeedEvent, type FeedEvent } from "./feed"
import { syncExternalToolActivity, clearExternalSessionActivity } from "./activity"
import { listSessions, recordSession } from "./sessions"
import { clampLong, summarize, verbFor, extractToolResult } from "./tool-format"
import { addQuestionRequest, cancelQuestionsFor, isQuestionTool, parseQuestionInput, type QuestionAnswer, type QuestionItem } from "./questions"
import { withPickerIO } from "./keyboard-inject"
import { driveQuestionPicker } from "./question-driver"
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
  if (
    (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
    || (v.length >= 2 && v.startsWith("[") && v.endsWith("]"))
    || (v.length >= 2 && v.startsWith("{") && v.endsWith("}"))
  ) {
    try { return JSON.parse(v) } catch {
      return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
    }
  }
  return v
}

export function formatAgyQuestionsMarkdown(questions: QuestionItem[]): string {
  return questions.map((q, idx) => {
    const prefix = questions.length > 1 ? `**Q${idx + 1}: ${q.question}**` : `**${q.question}**`
    const multi = q.multiSelect ? " *(Select all that apply)*" : ""
    const opts = q.options.map((o, oi) => `${oi + 1}. ${o.label}`).join("\n")
    return `${prefix}${multi}\n${opts}`
  }).join("\n\n")
}

export function formatAgyQuestionAnswers(questions: QuestionItem[], answers: QuestionAnswer[]): string {
  return questions.map((q, i) => {
    const a = answers[i] ?? { selected: [] }
    const custom = (a.otherText ?? "").trim()
    const parts = q.multiSelect ? [...a.selected] : a.selected.slice(0, 1)
    if (custom && (q.multiSelect || parts.length === 0)) parts.push(custom)
    const chosen = parts.join(", ") || "Skipped"
    return questions.length > 1 ? `A${i + 1}: ${chosen}` : chosen
  }).join("\n")
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

const pendingToolsBySession = new Map<string, string[]>()

function parseAgyToolDurationMs(content: string): number {
  const createdMatch = content.match(/Created At:\s*([^\n\r]+)/)
  const completedMatch = content.match(/Completed At:\s*([^\n\r]+)/)
  if (createdMatch?.[1] && completedMatch?.[1]) {
    const startMs = Date.parse(createdMatch[1].trim())
    const endMs = Date.parse(completedMatch[1].trim())
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      return Math.max(1, endMs - startMs)
    }
  }
  return 120
}

export function parseAgyTranscriptLine(
  line: string,
  ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId">,
  fallbackSessionId: string,
  pendingTools?: string[],
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
  const toolQueue = pendingTools ?? (() => {
    let q = pendingToolsBySession.get(sid)
    if (!q) {
      q = []
      pendingToolsBySession.set(sid, q)
    }
    return q
  })()

  if (step.type === "USER_INPUT") {
    toolQueue.length = 0
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
    toolQueue.length = 0
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
    const askedQuestions: QuestionItem[] = []
    if (Array.isArray(step.tool_calls)) {
      step.tool_calls.forEach((tc, idx) => {
        const rawName = typeof tc?.name === "string" && tc.name.trim() ? tc.name.trim() : "tool"
        const name = rawName.replace(/^default_api:/, "")
        const args = normalizeAgyToolArgs(tc?.args)
        if (isQuestionTool(name)) {
          const qs = parseQuestionInput(args)
          if (qs) askedQuestions.push(...qs)
        } else {
          toolQueue.push(name)
        }
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
    const rawProse = typeof step.content === "string" ? step.content.trim() : ""
    const questionMd = askedQuestions.length > 0 && (!rawProse || !rawProse.includes(askedQuestions[0]!.question))
      ? formatAgyQuestionsMarkdown(askedQuestions)
      : ""
    const combinedText = [rawProse, questionMd].filter(Boolean).join("\n\n")
    if (combinedText) {
      out.push({
        id: `${idBase}:text`,
        ts,
        kind: "assistant_text",
        text: clampLong(combinedText, 64_000),
        ...ident,
      })
    }
    return out
  }

  if (step.type === "GENERIC" && typeof step.content === "string") {
    if (step.status === "RUNNING") {
      return []
    }
    const answerLines = step.content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^A\d+:\s+.+/.test(l))
    if (answerLines.length > 0) {
      return [{
        id: `${idBase}:answer`,
        ts,
        kind: "user_prompt",
        text: clampLong(answerLines.join("\n"), 8_000),
        ...ident,
      }]
    }
    const isToolOutput = step.content.startsWith("Created At:") || step.content.includes("Command output:")
    if (isToolOutput) {
      const toolName = toolQueue.shift() ?? (step.content.includes("Command output:") ? "run_command" : "tool")
      const durationMs = parseAgyToolDurationMs(step.content)
      if (step.content.includes("Command output:")) {
        const outIdx = step.content.indexOf("Command output:")
        const rawOut = step.content.slice(outIdx + "Command output:".length).trim()
        const errored = /Command exited with code [1-9]/.test(step.content)
        const res = extractToolResult("run_command", rawOut)
        return [{
          id: `${idBase}:tool_end`,
          ts,
          kind: "tool_end",
          tool: toolName,
          summary: "",
          durationMs,
          outputExcerpt: res.excerpt,
          errored: errored || res.errored,
          ...ident,
        }]
      }
      return [{
        id: `${idBase}:tool_end`,
        ts,
        kind: "tool_end",
        tool: toolName,
        summary: "",
        durationMs,
        errored: step.status === "ERROR",
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
  const pendingTools: string[] = []
  const out: FeedEvent[] = []
  for (const line of readTailLines(path, tailBytes)) {
    out.push(...parseAgyTranscriptLine(line, ident, s.sessionId, pendingTools))
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

function inferAgyTranscriptStatus(sessionId: string, home: string, dbBusy: boolean): "busy" | "idle" {
  const path = agyTranscriptPath(sessionId, home)
  if (!existsSync(path)) return dbBusy ? "busy" : "idle"
  try {
    const tail = readTailLines(path, 32 * 1024)
    const steps: AgyTranscriptStep[] = []
    for (let i = Math.max(0, tail.length - 16); i < tail.length; i++) {
      const l = tail[i]?.trim()
      if (!l) continue
      try {
        const s = JSON.parse(l) as AgyTranscriptStep
        if (typeof s.step_index === "number") steps.push(s)
      } catch { /* ignore */ }
    }
    if (steps.length === 0) return dbBusy ? "busy" : "idle"
    const lastStep = steps[steps.length - 1]!
    // Check if any step in the current turn (since the last USER_INPUT/SYSTEM_MESSAGE) is actively RUNNING
    let turnStartIdx = 0
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]?.type === "USER_INPUT" || steps[i]?.type === "SYSTEM_MESSAGE") {
        turnStartIdx = i
        break
      }
    }
    const turnSteps = steps.slice(turnStartIdx)
    if (turnSteps.some((s) => s.status === "RUNNING")) {
      return "busy"
    }
    // If the last step is a completed PLANNER_RESPONSE with no non-question tool_calls, the turn is done/idle
    if (lastStep.type === "PLANNER_RESPONSE" && lastStep.status === "DONE") {
      const nonQuestionTools = (lastStep.tool_calls ?? []).filter((tc) => {
        const name = (typeof tc?.name === "string" ? tc.name : "").replace(/^default_api:/, "")
        return name.length > 0 && !isQuestionTool(name)
      })
      if (nonQuestionTools.length === 0) {
        return "idle"
      }
    }
    const lastTs = Date.parse(lastStep.created_at ?? "") || 0
    if (lastTs > 0 && Date.now() - lastTs > 90_000) {
      return "idle"
    }
    return dbBusy ? "busy" : "idle"
  } catch {
    return dbBusy ? "busy" : "idle"
  }
}

function openAgySummariesDb(dbPath: string): Database {
  try {
    return new Database(dbPath)
  } catch {
    return new Database(dbPath, { readonly: true })
  }
}

export function readRecentAgyConversations(home = homedir(), windowMs = THREAD_WINDOW_MS): AgyConversationSummary[] {
  const dbPath = agySummariesDbPath(home)
  if (!existsSync(dbPath)) return []
  const cutoff = Date.now() - windowMs
  try {
    const db = openAgySummariesDb(dbPath)
    try {
      db.exec("PRAGMA busy_timeout = 2500;")
      const rows = db.query(`
        SELECT conversation_id AS id, title, step_count AS stepCount, last_modified_time AS lastModifiedTime,
               workspace_uris AS workspaceUris, status, not_fully_idle AS notFullyIdle
        FROM conversation_summaries WHERE killed = 0 AND step_count > 0
        ORDER BY last_modified_time DESC LIMIT ?
      `).all(MAX_CONVERSATIONS) as Array<{
        id: string; title: string; stepCount: number; lastModifiedTime: string
        workspaceUris: string; status: string; notFullyIdle: number
      }>
      const out: AgyConversationSummary[] = []
      for (const r of rows) {
        if (!r.id) continue
        const updatedAtMs = parseAgyTimestamp(r.lastModifiedTime)
        if (updatedAtMs < cutoff) continue
        const trimmedTitle = (r.title || "").trim()
        if (!trimmedTitle && isEphemeralSubagentTranscript(r.id, home)) continue
        const dbBusy = Boolean(r.notFullyIdle) || r.status === "CASCADE_RUN_STATUS_RUNNING"
        const status = inferAgyTranscriptStatus(r.id, home, dbBusy)
        out.push({
          id: r.id,
          title: trimmedTitle || "Antigravity Session",
          cwd: firstWorkspacePath(r.workspaceUris),
          status,
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
const raisedAgyQuestions = new Map<string, string>()
let timer: ReturnType<typeof setInterval> | null = null

export function syncAgyOpenQuestion(
  lines: string[],
  convo: AgyConversationSummary,
  ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId">,
): void {
  let lastStep: AgyTranscriptStep | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]?.trim()
    if (!l) continue
    try {
      const parsed = JSON.parse(l) as AgyTranscriptStep
      if (typeof parsed.step_index === "number") {
        lastStep = parsed
        break
      }
    } catch { /* ignore */ }
  }
  const sessionKey = ident.key || `gemini:sid:${convo.id}`
  let openQuestions: QuestionItem[] | null = null
  if (lastStep?.type === "PLANNER_RESPONSE" && Array.isArray(lastStep.tool_calls)) {
    for (const tc of lastStep.tool_calls) {
      const name = (typeof tc?.name === "string" ? tc.name : "").replace(/^default_api:/, "")
      if (isQuestionTool(name)) {
        const qs = parseQuestionInput(normalizeAgyToolArgs(tc?.args))
        if (qs && qs.length > 0) openQuestions = [...(openQuestions ?? []), ...qs]
      }
    }
  }
  if (!openQuestions || typeof lastStep?.step_index !== "number") {
    if (raisedAgyQuestions.has(convo.id)) {
      raisedAgyQuestions.delete(convo.id)
      cancelQuestionsFor({ sessionId: convo.id, sessionKey }, "answered", "agy transcript advanced")
    }
    return
  }
  const qId = `agy-q:${convo.id}:${lastStep.step_index}`
  if (raisedAgyQuestions.get(convo.id) === qId) return
  if (raisedAgyQuestions.has(convo.id)) {
    cancelQuestionsFor({ sessionId: convo.id, sessionKey }, "answered", "superseded")
  }
  raisedAgyQuestions.set(convo.id, qId)
  const questions = openQuestions
  const cwd = ident.cwd || convo.cwd
  void addQuestionRequest(
    { agent: "gemini", sessionId: convo.id, cwd, questions, sessionKey },
    { id: qId, expiryMs: THREAD_WINDOW_MS },
  ).then(async (answers) => {
    if (raisedAgyQuestions.get(convo.id) === qId) raisedAgyQuestions.delete(convo.id)
    if (answers.length === 0) return
    const ttySession = listSessions().find((s) => s.sessionId === convo.id && (s.tty || s.tmuxPane))
      ?? listSessions().find((s) => s.agent === "gemini" && (s.tty || s.tmuxPane))
    if (ttySession) {
      await withPickerIO(
        { tty: ttySession.tty, tmuxPane: ttySession.tmuxPane, tmuxSocket: ttySession.tmuxSocket, termProgram: ttySession.termProgram, iTermSessionId: ttySession.iTermSessionId },
        (io) => driveQuestionPicker(io, questions, answers),
      )
    } else {
      deliverHeadlessAgyTurn({ sessionId: convo.id, cwd, prompt: formatAgyQuestionAnswers(questions, answers) })
    }
  })
}

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
  let effectiveEnd = end
  const rawChunk = raw.slice(start, end)
  // If a trailing line in the delta is still status:"RUNNING", hold offset before
  // that line so when Antigravity rewrites it in-place to status:"DONE" with output,
  // the next poll reads the completed step and emits tool_end.
  if (!firstRead && rawChunk.includes('"status":"RUNNING"')) {
    const runningIdx = rawChunk.indexOf('"status":"RUNNING"')
    const lineStartInChunk = rawChunk.lastIndexOf("\n", runningIdx)
    const holdOffset = start + (lineStartInChunk >= 0 ? lineStartInChunk + 1 : 0)
    if (holdOffset >= start) {
      effectiveEnd = holdOffset
    }
  }
  const chunk = raw.slice(start, effectiveEnd)
  offsets.set(path, effectiveEnd)

  const body = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk
  if (!body) {
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

  const lines = firstRead ? body.split("\n").slice(-120) : body.split("\n")
  const out: FeedEvent[] = []
  for (const line of lines) {
    out.push(...parseAgyTranscriptLine(line, ident, convo.id))
  }
  syncAgyOpenQuestion(lines, convo, ident)
  if (ident.key) {
    const lastStatusEvent = [...out].reverse().find(
      (e) => e.kind === "tool_start" || e.kind === "tool_end" || e.kind === "assistant_text",
    )
    if (convo.status === "idle" || lastStatusEvent?.kind === "assistant_text") {
      clearExternalSessionActivity({
        cwd: ident.cwd ?? "",
        sessionId: ident.sessionId,
        tty: ident.tty,
        transcriptPath: path,
        sessionKey: ident.key,
      })
    } else if (!firstRead && convo.status === "busy" && lastStatusEvent?.kind === "tool_start") {
      syncExternalToolActivity({
        verb: verbFor(lastStatusEvent.tool ?? "tool"),
        tool: lastStatusEvent.tool ?? "tool",
        summary: lastStatusEvent.summary ?? "",
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
