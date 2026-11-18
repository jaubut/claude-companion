import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { appendFeedEvent, getFeed, type FeedEvent } from "./feed"
import { syncExternalToolActivity, clearExternalSessionActivity } from "./activity"
import { type Session, getSessionByKey, isHeadlessSession, listSessions, recordSession } from "./sessions"
import { clampLong, summarize, verbFor, extractToolResult } from "./tool-format"
import { addQuestionRequest, cancelQuestionsFor, isQuestionTool, parseQuestionInput, type QuestionAnswer, type QuestionItem } from "./questions"
import { withPickerIO } from "./keyboard-inject"
import { driveQuestionPicker } from "./question-driver"
import { THINKING_MAX } from "./transcript"
import { readTailLines } from "./transcript-cursor"
import type { HistorySession } from "./transcript-backfill"
import { withActiveDesignStatePrompt } from "./design-state"
import { normalizeAgyCliModelFlag, scrubAgentEnv } from "./worker-invocation"
export { normalizeAgyCliModelFlag }

export const AGY_BRAIN_KEY = "gemini:brain"
export const AGY_BRAIN_PANE = "headless:agy-brain"
export const AGY_BRAIN_TASK_ID = "agy-brain"
export const DEFAULT_AGY_BRAIN_MODEL = "gemini-pro-orchestrator"

export interface AgyBrainState {
  sessionId: string
  model: string
  boost: boolean
  cwd: string
  title: string
  updatedAt: number
}

const POLL_MS = 1_500
const THREAD_WINDOW_MS = 24 * 60 * 60 * 1_000
const MAX_CONVERSATIONS = 10
const INITIAL_EVENTS_PER_CONVERSATION = 120
const FIRST_READ_TAIL_BYTES = 512 * 1024
const TAIL_BYTES = 2 * 1024 * 1024

export interface AgyConversationSummary {
  id: string
  title: string
  cwd: string
  status: "busy" | "idle"
  updatedAtMs: number
  stepCount: number
  // Started by `agy -p` (headless workers, weft programs, pr-shepherd reviews): agy records no
  // user input step for a print-mode prompt (last_user_input_step_index stays -1).
  headless?: boolean
}

interface AgyTranscriptStep {
  step_index?: number
  source?: string
  type?: string
  status?: string
  created_at?: string
  content?: string
  thinking?: string
  truncated_fields?: string[]
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

export function agyFullTranscriptPath(sessionId: string, home = homedir()): string {
  return join(agyRootDir(home), "brain", sessionId, ".system_generated", "logs", "transcript_full.jsonl")
}

function deriveFullTranscriptPath(transcriptPath: string | undefined, sessionId: string, home = homedir()): string {
  if (transcriptPath) {
    if (transcriptPath.endsWith("/transcript.jsonl")) {
      return join(dirname(transcriptPath), "transcript_full.jsonl")
    }
    const sibling = transcriptPath.replace(/\.jsonl$/, "_full.jsonl")
    if (sibling !== transcriptPath && existsSync(sibling)) return sibling
    const dirFull = join(dirname(transcriptPath), "transcript_full.jsonl")
    if (existsSync(dirFull)) return dirFull
  }
  return agyFullTranscriptPath(sessionId, home)
}

function resolveTruncatedAgyStep(
  step: AgyTranscriptStep,
  sessionId: string,
  transcriptPath?: string,
  home = homedir(),
): AgyTranscriptStep {
  const hasTruncatedFields = Array.isArray(step.truncated_fields) && step.truncated_fields.length > 0
  const hasInlineTruncation = typeof step.content === "string" && step.content.includes("<truncated ")
  if (!hasTruncatedFields && !hasInlineTruncation) return step
  if (typeof step.step_index !== "number") return step

  const fullPath = deriveFullTranscriptPath(transcriptPath, sessionId, home)
  if (!existsSync(fullPath)) return step

  const needle = `"step_index":${step.step_index},`
  const tailLines = readTailLines(fullPath, TAIL_BYTES)
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i]
    if (!line || !line.includes(needle)) continue
    try {
      const fullStep = JSON.parse(line) as AgyTranscriptStep
      if (fullStep.step_index === step.step_index) {
        return fullStep
      }
    } catch { /* ignore */ }
  }
  return step
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

export function agyBrainStatePath(home = homedir()): string {
  return join(home, ".claude", "state", "agy-brain.json")
}

export function readAgyBrainState(home = homedir()): AgyBrainState {
  const path = agyBrainStatePath(home)
  const fallback: AgyBrainState = {
    sessionId: "",
    model: DEFAULT_AGY_BRAIN_MODEL,
    boost: false,
    cwd: home,
    title: "⚡ Brain · Boost",
    updatedAt: 0,
  }
  if (!existsSync(path)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgyBrainState>
    return {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "",
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_AGY_BRAIN_MODEL,
      boost: typeof parsed.boost === "boolean" ? parsed.boost : false,
      cwd: typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : home,
      title: "⚡ Brain · Boost",
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    }
  } catch {
    return fallback
  }
}

export function writeAgyBrainState(patch: Partial<AgyBrainState>, home = homedir()): AgyBrainState {
  const current = readAgyBrainState(home)
  const next: AgyBrainState = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  }
  const path = agyBrainStatePath(home)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2))
  } catch { /* best-effort */ }
  return next
}

export function getAgyBrainModel(home = homedir()): string {
  return readAgyBrainState(home).model
}

export function setAgyBrainModel(model: string, home = homedir()): void {
  const trimmed = model.trim()
  if (!trimmed) return
  writeAgyBrainState({ model: trimmed }, home)
}

export function getAgyBrainBoost(home = homedir()): boolean {
  return readAgyBrainState(home).boost
}

export function setAgyBrainBoost(boost: boolean, home = homedir()): void {
  writeAgyBrainState({ boost }, home)
}

export function extractAgyUserPrompt(rawContent: unknown): string | null {
  if (typeof rawContent !== "string") return null
  const m = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i)
  let text = (m ? m[1] ?? "" : rawContent).replace(/\n*\[Active Design State\][^\n]*$/i, "").trim()
  if (!text || text.startsWith("<") || text.startsWith("[Request interrupted")) return null
  if (/^\/boost\s+\S/i.test(text)) text = text.replace(/^\/boost\s+/i, "").trim()
  return text || null
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

interface PendingAgyTool {
  name: string
  summary: string
}

const pendingToolsBySession = new Map<string, PendingAgyTool[]>()

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
  pendingTools?: PendingAgyTool[],
  opts?: { transcriptPath?: string; home?: string },
): FeedEvent[] {
  if (!line.trim()) return []
  let rawStep: AgyTranscriptStep
  try {
    rawStep = JSON.parse(line) as AgyTranscriptStep
  } catch {
    return []
  }
  const stepIdx = typeof rawStep.step_index === "number" ? rawStep.step_index : -1
  if (stepIdx < 0) return []
  const sid = ident.sessionId || fallbackSessionId
  const step = resolveTruncatedAgyStep(rawStep, sid, opts?.transcriptPath, opts?.home)
  const ts = Date.parse(step.created_at ?? "") || Date.now()
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
    const toolCount = Array.isArray(step.tool_calls) ? step.tool_calls.length : 0
    if (Array.isArray(step.tool_calls)) {
      step.tool_calls.forEach((tc, idx) => {
        const rawName = typeof tc?.name === "string" && tc.name.trim() ? tc.name.trim() : "tool"
        const name = rawName.replace(/^default_api:/, "")
        const args = normalizeAgyToolArgs(tc?.args)
        const summary = summarize(name, args) || (typeof args.toolSummary === "string" ? args.toolSummary.trim() : "")
        if (isQuestionTool(name)) {
          const qs = parseQuestionInput(args)
          if (qs) askedQuestions.push(...qs)
        } else {
          toolQueue.push({ name, summary })
        }
        out.push({
          id: `${idBase}:tool:${idx}`,
          ts: ts + 1 + idx,
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
        ts: ts + 2 + toolCount,
        kind: "assistant_text",
        text: clampLong(combinedText, 64_000),
        ...ident,
      })
    }
    return out
  }

  if (step.type === "GENERIC" && typeof step.content === "string") {
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
    const isBackgroundTask = step.content.includes("Tool is running as a background task")
    const isToolOutput = isBackgroundTask || step.content.startsWith("Created At:") || step.content.includes("Command output:")
    if (isToolOutput) {
      const shifted = toolQueue.shift()
      const toolName = shifted?.name ?? ((isBackgroundTask || step.content.includes("Command output:")) ? "run_command" : "tool")
      const toolSummary = shifted?.summary ?? ""
      const durationMs = parseAgyToolDurationMs(step.content)
      if (isBackgroundTask || step.status === "RUNNING") {
        return [{
          id: `${idBase}:tool_end`,
          ts,
          kind: "tool_end",
          tool: toolName,
          summary: toolSummary,
          durationMs,
          outputExcerpt: "Running in background",
          errored: false,
          ...ident,
        }]
      }
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
          summary: toolSummary,
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
        summary: toolSummary,
        durationMs,
        errored: step.status === "ERROR",
        ...ident,
      }]
    }
  }

  return []
}

function enforceMonotonicTimestamps(events: FeedEvent[]): FeedEvent[] {
  let lastTs = -Infinity
  for (const ev of events) {
    if (ev.ts <= lastTs) {
      ev.ts = lastTs + 1
    }
    lastTs = ev.ts
  }
  return events
}

function selectInitialAgyEvents(events: FeedEvent[], maxEvents = INITIAL_EVENTS_PER_CONVERSATION): FeedEvent[] {
  if (events.length <= maxEvents) return events
  const conversationalIndices = new Set<number>()
  for (let i = events.length - 1; i >= 0 && conversationalIndices.size < 40; i--) {
    const kind = events[i]?.kind
    if (kind === "user_prompt" || kind === "assistant_text") {
      conversationalIndices.add(i)
    }
  }
  const keepIndices = new Set<number>(conversationalIndices)
  for (let i = events.length - 1; i >= 0 && keepIndices.size < maxEvents; i--) {
    keepIndices.add(i)
  }
  return events.filter((_, idx) => keepIndices.has(idx))
}

export function eventsFromAgyTranscript(path: string, s: HistorySession, tailBytes = TAIL_BYTES): FeedEvent[] {
  if (!existsSync(path)) return []
  const ident = {
    key: s.key,
    cwd: s.cwd,
    ...(s.tty ? { tty: s.tty } : {}),
    sessionId: s.sessionId,
  }
  const pendingTools: PendingAgyTool[] = []
  const out: FeedEvent[] = []
  for (const line of readTailLines(path, tailBytes)) {
    out.push(...parseAgyTranscriptLine(line, ident, s.sessionId, pendingTools, { transcriptPath: path }))
  }
  return enforceMonotonicTimestamps(out)
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

export function inferAgyTranscriptStatus(sessionId: string, home = homedir(), dbBusy = false): "busy" | "idle" {
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
    const lastStep = resolveTruncatedAgyStep(steps[steps.length - 1]!, sessionId, path, home)
    const lastTs = Date.parse(lastStep.created_at ?? "") || 0
    const isRecent = lastTs === 0 || Date.now() - lastTs <= 90_000

    // If the last step is a completed PLANNER_RESPONSE:
    // - with no non-question tool_calls, the turn is finished/idle (even if earlier backgrounded tools in the turn had status:"RUNNING")
    // - with non-question tool_calls, those tools are currently executing if recent
    if (lastStep.type === "PLANNER_RESPONSE" && lastStep.status === "DONE") {
      const nonQuestionTools = (lastStep.tool_calls ?? []).filter((tc) => {
        const name = (typeof tc?.name === "string" ? tc.name : "").replace(/^default_api:/, "")
        return name.length > 0 && !isQuestionTool(name)
      })
      if (nonQuestionTools.length === 0) {
        return "idle"
      }
      return isRecent ? "busy" : "idle"
    }

    if (!isRecent) {
      return "idle"
    }

    if (lastStep.status === "RUNNING") {
      const isBackgroundTask = lastStep.type === "GENERIC"
        && typeof lastStep.content === "string"
        && lastStep.content.includes("Tool is running as a background task")
      if (!isBackgroundTask) {
        return "busy"
      }
    }

    if (lastStep.type === "USER_INPUT" || lastStep.type === "GENERIC" || lastStep.type === "SYSTEM_MESSAGE") {
      return "busy"
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
               workspace_uris AS workspaceUris, status, not_fully_idle AS notFullyIdle,
               last_user_input_step_index AS lastUserInputStep
        FROM conversation_summaries WHERE killed = 0 AND step_count > 0
        ORDER BY last_modified_time DESC LIMIT ?
      `).all(MAX_CONVERSATIONS) as Array<{
        id: string; title: string; stepCount: number; lastModifiedTime: string
        workspaceUris: string; status: string; notFullyIdle: number; lastUserInputStep: number
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
          headless: Number(r.lastUserInputStep) < 0,
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

export function resetAgyFeedStateForTests(): void {
  offsets.clear()
  pendingToolsBySession.clear()
  raisedAgyQuestions.clear()
}

export function syncAgyOpenQuestion(
  lines: string[],
  convo: AgyConversationSummary,
  ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId">,
  home = homedir(),
): void {
  let lastStep: AgyTranscriptStep | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]?.trim()
    if (!l) continue
    try {
      const parsed = JSON.parse(l) as AgyTranscriptStep
      if (typeof parsed.step_index === "number") {
        lastStep = resolveTruncatedAgyStep(parsed, convo.id, agyTranscriptPath(convo.id, home), home)
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
    const exactSession = listSessions().find((s) => s.sessionId === convo.id)
    const isExplicitHeadless = exactSession?.herdrPane?.startsWith("headless:") === true
    const ttySession = isExplicitHeadless
      ? undefined
      : (listSessions().find((s) => s.sessionId === convo.id && (s.tty || s.tmuxPane))
        ?? listSessions().find((s) => s.agent === "gemini" && (s.tty || s.tmuxPane)))
    if (ttySession) {
      await withPickerIO(
        { tty: ttySession.tty, tmuxPane: ttySession.tmuxPane, tmuxSocket: ttySession.tmuxSocket, termProgram: ttySession.termProgram, iTermSessionId: ttySession.iTermSessionId },
        (io) => driveQuestionPicker(io, questions, answers),
      )
    } else if (exactSession?.taskId === AGY_BRAIN_TASK_ID || exactSession?.herdrPane === AGY_BRAIN_PANE) {
      deliverHeadlessAgyBrainTurn({
        prompt: formatAgyQuestionAnswers(questions, answers),
        cwd,
        boost: false,
        skipDesignContext: true,
        home,
      })
    } else {
      deliverHeadlessAgyTurn({
        sessionId: convo.id,
        cwd,
        prompt: formatAgyQuestionAnswers(questions, answers),
        model: exactSession?.model,
        skipDesignContext: true,
        home,
      })
    }
  })
}

const activeAgyProcs = new Set<string>()

// Script-owned agy runs, by where they run or how their prompt starts: pr-shepherd and PR-review tmp worktrees, the weft
// calendar agent (its tmp dir and prompt prefix). Hidden even if agy one day records a user-input step for them.
const SCRIPTED_AGY_CWD = /^\/tmp\/(pr-shepherd-|cal-agy-|gemini-diff-)/
const SCRIPTED_AGY_TITLE = "IMPORTANT: Ignore any files under ~/"
function isScriptedAgy(c: { cwd?: string; title?: string }): boolean {
  return SCRIPTED_AGY_CWD.test(c.cwd ?? "") || (c.title ?? "").startsWith(SCRIPTED_AGY_TITLE)
}

/**
 * May this conversation create or update a `headless:agy:` drawer row? Never one a worker card owns (the card
 * follows its task, not agy's status), and a print-mode one only once the phone has opened it as a thread.
 */
export function agyThreadVisible(c: Pick<AgyConversationSummary, "id" | "headless"> & Partial<Pick<AgyConversationSummary, "cwd" | "title">>, existing: Pick<Session, "herdrPane"> | undefined): boolean {
  if (existing?.herdrPane?.startsWith("headless:worker:") || isHeadlessSession(c.id) || isScriptedAgy(c)) return false
  return !c.headless || !!existing?.herdrPane?.startsWith("headless:agy:")
}

export function isAgyBrainRunning(): boolean {
  return activeAgyProcs.has(AGY_BRAIN_KEY)
}

export function ensureAgyBrainSession(home = homedir()) {
  if (!existsSync(agyRootDir(home))) return null
  const state = readAgyBrainState(home)
  const existing = getSessionByKey(AGY_BRAIN_KEY)
  const sid = state.sessionId || existing?.sessionId || AGY_BRAIN_TASK_ID
  const running = activeAgyProcs.has(AGY_BRAIN_KEY)
  const inferredStatus = running
    ? "busy"
    : (sid !== AGY_BRAIN_TASK_ID ? inferAgyTranscriptStatus(sid, home, false) : "idle")
  return recordSession({
    agent: "gemini",
    cwd: state.cwd || home,
    sessionId: sid,
    herdrPane: AGY_BRAIN_PANE,
    taskId: AGY_BRAIN_TASK_ID,
    title: "⚡ Brain · Boost",
    label: "⚡ Brain · Boost",
    firstSeenAt: existing?.firstSeenAt ?? (state.updatedAt || undefined),
    agentStatus: inferredStatus,
    model: state.model || DEFAULT_AGY_BRAIN_MODEL,
    pid: String(process.pid),
  }, { provisional: true, sessionIdConfirmed: true })
}

export function startAgyFeedMonitor(home = homedir()): { stop: () => void } {
  if (!timer) {
    ensureAgyBrainSession(home)
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
  const brainSession = ensureAgyBrainSession(home)
  const brainState = readAgyBrainState(home)
  const convos = readRecentAgyConversations(home)

  const agyModel = readAgyModel(home)
  const currentSessions = listSessions()
  for (const c of convos.slice(0, 5)) {
    if (brainState.sessionId && c.id === brainState.sessionId) {
      if (brainSession) {
        const nextStatus = activeAgyProcs.has(AGY_BRAIN_KEY) ? "busy" : c.status
        const nextTitle = "⚡ Brain · Boost"
        if (brainSession.agentStatus !== nextStatus || brainSession.title !== nextTitle) {
          recordSession({
            ...brainSession,
            sessionId: c.id,
            title: nextTitle,
            label: "⚡ Brain · Boost",
            agentStatus: nextStatus,
            model: brainState.model || DEFAULT_AGY_BRAIN_MODEL,
          }, { provisional: true, sessionIdConfirmed: true })
        }
      }
      continue
    }
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
    if (!agyThreadVisible(c, existing)) continue
    if (!existing || existing.agentStatus !== c.status || existing.title !== c.title) {
      recordSession({
        agent: "gemini",
        cwd: c.cwd,
        sessionId: c.id,
        herdrPane: `headless:agy:${c.id}`,
        title: c.title,
        label: c.title,
        firstSeenAt: existing?.firstSeenAt ?? (c.updatedAtMs || undefined),
        lastActiveAt: c.updatedAtMs || undefined,
        agentStatus: c.status,
        model: existing?.model || agyModel,
        pid: String(process.pid),
      }, { provisional: true, sessionIdConfirmed: true })
    }
  }

  const events: FeedEvent[] = []
  const polledIds = new Set<string>()
  for (const c of convos) {
    polledIds.add(c.id)
    if (brainState.sessionId && c.id === brainState.sessionId && activeAgyProcs.has(AGY_BRAIN_KEY)) c.status = "busy"
    events.push(...readAgyTranscriptDelta(c, home))
  }
  if (brainState.sessionId && !polledIds.has(brainState.sessionId) && existsSync(agyTranscriptPath(brainState.sessionId, home))) {
    const status = activeAgyProcs.has(AGY_BRAIN_KEY) ? "busy" : inferAgyTranscriptStatus(brainState.sessionId, home, false)
    events.push(...readAgyTranscriptDelta({
      id: brainState.sessionId,
      title: "⚡ Brain · Boost",
      cwd: brainState.cwd || home,
      status,
      updatedAtMs: Date.now(),
      stepCount: 1,
    }, home))
  }
  if (brainState.sessionId && existsSync(agyTranscriptPath(brainState.sessionId, home))) {
    const childIds = discoverChildSubagentIds(brainState.sessionId, home)
    for (const childId of childIds) {
      const childEvents = readAgyTranscriptDelta(
        {
          id: childId,
          title: "⚡ Brain · Boost",
          cwd: brainState.cwd || home,
          status: activeAgyProcs.has(AGY_BRAIN_KEY) ? "busy" : inferAgyTranscriptStatus(childId, home, false),
          updatedAtMs: Date.now(),
          stepCount: 1,
        },
        home,
        { key: AGY_BRAIN_KEY, cwd: brainState.cwd || home, sessionId: brainState.sessionId },
      )
      for (const ev of childEvents) {
        if (ev.kind === "tool_start" || ev.kind === "tool_end" || ev.kind === "assistant_thinking") {
          events.push(ev)
        }
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts)
  for (const ev of events) appendFeedEvent(ev)
}

export function discoverChildSubagentIds(rootConvoId: string, home = homedir()): string[] {
  const found: string[] = []
  const visited = new Set<string>([rootConvoId])
  const queue: Array<{ id: string; depth: number }> = [{ id: rootConvoId, depth: 0 }]
  while (queue.length > 0) {
    const item = queue.shift()!
    if (item.depth >= 2) continue
    const path = agyTranscriptPath(item.id, home)
    if (!existsSync(path)) continue
    try {
      const raw = readTailLines(path, 32 * 1024).join("\n")
      const matches = raw.matchAll(/\\"conversationId\\":\s*\\"([0-9a-fA-F-]{36})\\"/g)
      for (const m of matches) {
        const cid = m[1]
        if (cid && !visited.has(cid) && existsSync(agyTranscriptPath(cid, home))) {
          visited.add(cid)
          found.push(cid)
          queue.push({ id: cid, depth: item.depth + 1 })
        }
      }
    } catch { /* ignore */ }
  }
  return found
}

function isDuplicateInjectedUserPrompt(
  ev: FeedEvent,
  convoId: string,
  ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId">,
): boolean {
  if (ev.kind !== "user_prompt") return false
  const text = (ev.text ?? "").trim().replace(/^\/boost\s+/i, "").trim()
  if (!text) return false
  const feed = getFeed()
  for (let i = feed.length - 1; i >= 0; i--) {
    const existing = feed[i]!
    if (existing.kind !== "user_prompt") continue
    if (existing.id.startsWith("agy:") || existing.id.startsWith("tx:")) continue
    const sameSession =
      existing.sessionId === convoId ||
      (Boolean(ident.key) && existing.key === ident.key) ||
      (Boolean(ident.tty) && existing.tty === ident.tty)
    if (!sameSession) continue
    const existingClean = (existing.text ?? "").trim().replace(/^\/boost\s+/i, "").trim()
    if (existingClean !== text) continue
    if (Math.abs(existing.ts - ev.ts) > 120_000) continue
    if (!existing.sessionId || existing.sessionId === AGY_BRAIN_TASK_ID) existing.sessionId = convoId
    if (ident.key && !existing.key) existing.key = ident.key
    return true
  }
  return false
}

export function readAgyTranscriptDelta(
  convo: AgyConversationSummary,
  home = homedir(),
  identOverride?: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId">,
): FeedEvent[] {
  const path = agyTranscriptPath(convo.id, home)
  if (!existsSync(path)) return []

  const session = listSessions().find((s) => s.sessionId === convo.id)
    ?? (readAgyBrainState(home).sessionId === convo.id ? getSessionByKey(AGY_BRAIN_KEY) : undefined)
  const ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId"> = identOverride ?? {
    key: session?.key,
    cwd: session?.cwd || convo.cwd,
    ...(session?.tty ? { tty: session.tty } : {}),
    sessionId: convo.id,
  }

  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return []
  }

  const firstRead = !offsets.has(path)
  let start = offsets.get(path) ?? Math.max(0, size - FIRST_READ_TAIL_BYTES)
  if (size < start) {
    start = Math.max(0, size - FIRST_READ_TAIL_BYTES)
  }

  const clearKey = !identOverride && !(ident.key === AGY_BRAIN_KEY && activeAgyProcs.has(AGY_BRAIN_KEY)) ? ident.key : undefined
  if (size <= start) {
    offsets.set(path, size)
    if (convo.status === "idle" && clearKey) {
      clearExternalSessionActivity({ cwd: ident.cwd ?? "", sessionId: ident.sessionId, tty: ident.tty, transcriptPath: path, sessionKey: clearKey })
    }
    return []
  }

  const readLen = size - start
  const buf = Buffer.allocUnsafe(readLen)
  let bytesRead = 0
  try {
    const fd = openSync(path, "r")
    try { bytesRead = readSync(fd, buf, 0, readLen, start) } finally { closeSync(fd) }
  } catch { return [] }
  if (bytesRead <= 0) return []

  const slice = buf.subarray(0, bytesRead)
  const lastNl = slice.lastIndexOf(0x0a)
  if (lastNl < 0) return []

  const effectiveEnd = start + lastNl + 1
  offsets.set(path, effectiveEnd)

  let bodySlice = slice.subarray(0, lastNl)
  if (firstRead && start > 0) {
    const firstNl = bodySlice.indexOf(0x0a)
    if (firstNl < 0) return []
    bodySlice = bodySlice.subarray(firstNl + 1)
  }

  const body = bodySlice.toString("utf8")
  if (!body.trim()) {
    if (convo.status === "idle" && clearKey) {
      clearExternalSessionActivity({ cwd: ident.cwd ?? "", sessionId: ident.sessionId, tty: ident.tty, transcriptPath: path, sessionKey: clearKey })
    }
    return []
  }

  const allLines = body.split("\n")
  const lines = firstRead ? allLines.slice(-250) : allLines
  const out: FeedEvent[] = []
  for (const line of lines) {
    const stepEvents = parseAgyTranscriptLine(line, ident, convo.id, undefined, { transcriptPath: path, home })
    for (const ev of stepEvents) {
      if (!firstRead && isDuplicateInjectedUserPrompt(ev, convo.id, ident)) continue
      out.push(ev)
    }
  }
  enforceMonotonicTimestamps(out)
  syncAgyOpenQuestion(lines, convo, ident, home)
  if (ident.key) {
    const lastStatusEvent = [...out].reverse().find(
      (e) => e.kind === "tool_start" || e.kind === "tool_end" || e.kind === "assistant_text" || e.kind === "assistant_thinking" || e.kind === "user_prompt",
    )
    if ((convo.status === "idle" || lastStatusEvent?.kind === "assistant_text") && clearKey) {
      clearExternalSessionActivity({ cwd: ident.cwd ?? "", sessionId: ident.sessionId, tty: ident.tty, transcriptPath: path, sessionKey: clearKey })
    } else if (!firstRead && convo.status === "busy" && lastStatusEvent) {
      const isTool = lastStatusEvent.kind === "tool_start"
      syncExternalToolActivity({
        verb: isTool ? verbFor(lastStatusEvent.tool ?? "tool") : "Thinking",
        tool: isTool ? (lastStatusEvent.tool ?? "tool") : "gemini",
        summary: isTool ? (lastStatusEvent.summary ?? "") : (lastStatusEvent.text?.slice(0, 80) ?? "Orchestrator"),
        cwd: ident.cwd ?? "",
        sessionId: ident.sessionId,
        tty: ident.tty,
        transcriptPath: path,
        sessionKey: ident.key,
      })
    }
  }
  return firstRead ? selectInitialAgyEvents(out, INITIAL_EVENTS_PER_CONVERSATION) : out
}

export function ensureHeadlessAgySession(lookup: string, fallbackCwd?: string, home = homedir()) {
  if (lookup === AGY_BRAIN_KEY || lookup === AGY_BRAIN_TASK_ID || lookup === AGY_BRAIN_PANE) {
    return ensureAgyBrainSession(home)
  }
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

export function buildHeadlessAgyArgs(opts: {
  prompt: string
  sessionId?: string
  model?: string
  boost?: boolean
  hasExistingTranscript?: boolean
}): string[] {
  const trimmed = opts.prompt.trim()
  const effectivePrompt = opts.boost && !trimmed.startsWith("/")
    ? `/boost ${trimmed}`
    : trimmed
  const args = ["-p", effectivePrompt]
  if (opts.sessionId && opts.sessionId !== AGY_BRAIN_TASK_ID && (opts.hasExistingTranscript ?? true)) {
    args.push("--conversation", opts.sessionId)
  }
  if (opts.model && opts.model.trim()) {
    args.push("--model", normalizeAgyCliModelFlag(opts.model))
  }
  args.push("--output-format", "stream-json", "--dangerously-skip-permissions")
  return args
}

export function deliverHeadlessAgyBrainTurn(opts: {
  prompt: string
  cwd?: string
  model?: string
  boost?: boolean
  skipDesignContext?: boolean
  home?: string
}): boolean {
  const home = opts.home ?? homedir()
  const state = readAgyBrainState(home)
  const trimmed = opts.prompt.trim()
  if (!trimmed) return false

  if (/^\/(clear|new|reset)\b/i.test(trimmed)) {
    writeAgyBrainState({ sessionId: "", title: "⚡ Brain · Boost" }, home)
    ensureAgyBrainSession(home)
    appendFeedEvent({
      id: `agy-brain:reset:${Date.now()}`,
      ts: Date.now(),
      kind: "assistant_text",
      text: "Started a fresh Gemini Orchestrator + `/boost` session.",
      key: AGY_BRAIN_KEY,
      cwd: state.cwd || home,
      sessionId: AGY_BRAIN_TASK_ID,
    })
    return true
  }

  if (/^\/boost\s+(on|off)\s*$/i.test(trimmed)) {
    const enable = /^\/boost\s+on\s*$/i.test(trimmed)
    setAgyBrainBoost(enable, home)
    ensureAgyBrainSession(home)
    return true
  }

  const effectiveModel = opts.model || state.model || DEFAULT_AGY_BRAIN_MODEL
  const effectiveBoost = opts.boost ?? state.boost
  const effectiveCwd = opts.cwd || state.cwd || home

  return deliverHeadlessAgyTurn({
    sessionId: state.sessionId,
    cwd: effectiveCwd,
    prompt: trimmed,
    model: effectiveModel,
    boost: effectiveBoost,
    isBrain: true,
    sessionKey: AGY_BRAIN_KEY,
    skipDesignContext: opts.skipDesignContext,
    home,
  })
}

export function deliverHeadlessAgyTurn(opts: {
  sessionId: string
  cwd: string
  prompt: string
  model?: string
  boost?: boolean
  isBrain?: boolean
  sessionKey?: string
  skipDesignContext?: boolean
  home?: string
}): boolean {
  const home = opts.home ?? homedir()
  const hasExistingTranscript = Boolean(
    opts.sessionId &&
    opts.sessionId !== AGY_BRAIN_TASK_ID &&
    existsSync(agyTranscriptPath(opts.sessionId, home)),
  )
  const promptWithDesign = opts.skipDesignContext ? opts.prompt : withActiveDesignStatePrompt(opts.prompt)
  const args = buildHeadlessAgyArgs({
    prompt: promptWithDesign,
    sessionId: opts.sessionId,
    model: opts.model,
    boost: opts.boost,
    hasExistingTranscript,
  })
  const sessionKey = opts.sessionKey || (opts.isBrain ? AGY_BRAIN_KEY : `gemini:sid:${opts.sessionId}`)
  const cwd = opts.cwd || home

  try {
    const proc = Bun.spawn(["agy", ...args], {
      cwd,
      // A headless agy worker turn gets the scrubbed env (no notes DB/db/Companion tokens); the Brain · Boost
      // orchestrator keeps the server env like the claude brain (wiring/brain-headless.ts).
      ...(opts.isBrain ? {} : { env: scrubAgentEnv(process.env) }),
      stdout: "pipe",
      stderr: "ignore",
    })
    activeAgyProcs.add(sessionKey)
    let activeSid = hasExistingTranscript ? opts.sessionId : (opts.sessionId || AGY_BRAIN_TASK_ID)

    if (opts.isBrain) {
      const state = readAgyBrainState(home)
      recordSession({
        agent: "gemini",
        cwd,
        sessionId: activeSid,
        herdrPane: AGY_BRAIN_PANE,
        taskId: AGY_BRAIN_TASK_ID,
        title: state.title || "Brain · Boost",
        label: "Brain · Boost",
        agentStatus: "busy",
        model: opts.model || state.model || DEFAULT_AGY_BRAIN_MODEL,
        pid: String(process.pid),
      }, { provisional: true, sessionIdConfirmed: true })
    }

    syncExternalToolActivity({
      verb: opts.boost ? "Orchestrating" : "Thinking",
      tool: opts.boost ? "boost" : "gemini",
      summary: opts.boost ? "Gemini Orchestrator · /boost" : (opts.model || "Antigravity"),
      cwd,
      sessionId: activeSid,
      sessionKey,
    })

    if (proc.stdout && typeof proc.stdout !== "number") {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      void (async () => {
        let buf = ""
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split("\n")
            buf = lines.pop() ?? ""
            for (const line of lines) {
              const trimmedLine = line.trim()
              if (!trimmedLine.startsWith("{")) continue
              try {
                const ev = JSON.parse(trimmedLine) as {
                  event?: string
                  conversation_id?: string
                  step_update?: { conversation_id?: string; step_type?: string }
                }
                const cid = ev.conversation_id || ev.step_update?.conversation_id
                if (cid && cid !== activeSid) {
                  activeSid = cid
                  if (opts.isBrain) {
                    writeAgyBrainState({ sessionId: cid, title: "⚡ Brain · Boost", model: opts.model || DEFAULT_AGY_BRAIN_MODEL, cwd }, home)
                    recordSession({
                      agent: "gemini",
                      cwd,
                      sessionId: cid,
                      herdrPane: AGY_BRAIN_PANE,
                      taskId: AGY_BRAIN_TASK_ID,
                      title: "⚡ Brain · Boost",
                      label: "⚡ Brain · Boost",
                      agentStatus: "busy",
                      model: opts.model || DEFAULT_AGY_BRAIN_MODEL,
                      pid: String(process.pid),
                    }, { provisional: true, sessionIdConfirmed: true })
                  }
                }
                if (ev.event === "step_update" || ev.event === "result") {
                  void pollAgyOnce(home)
                }
              } catch { /* ignore malformed line */ }
            }
          }
        } catch { /* stream closed */ } finally {
          activeAgyProcs.delete(sessionKey)
          void pollAgyOnce(home)
          clearExternalSessionActivity({
            cwd,
            sessionId: activeSid,
            transcriptPath: agyTranscriptPath(activeSid, home),
            sessionKey,
          })
          if (opts.isBrain) {
            ensureAgyBrainSession(home)
          }
        }
      })()
    } else {
      activeAgyProcs.delete(sessionKey)
    }

    proc.unref()
    return true
  } catch {
    activeAgyProcs.delete(sessionKey)
    return false
  }
}
