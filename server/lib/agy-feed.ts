import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { appendFeedEvent, getFeed, type FeedEvent } from "./feed"
import { syncExternalToolActivity, clearExternalSessionActivity } from "./activity"
import { listSessions, recordSession } from "./sessions"
import { verbFor } from "./tool-format"
import { addQuestionRequest, cancelQuestionsFor, isQuestionTool, parseQuestionInput, type QuestionItem } from "./questions"
import { withPickerIO } from "./keyboard-inject"
import { driveQuestionPicker } from "./question-driver"
import { readTailLines } from "./transcript-cursor"
import { scrubAgentEnv } from "./worker-invocation"
import {
  agyRootDir,
  agyTranscriptPath,
  clearPendingAgyTools,
  enforceMonotonicTimestamps,
  formatAgyQuestionAnswers,
  normalizeAgyToolArgs,
  parseAgyTranscriptLine,
  resolveTruncatedAgyStep,
  type AgyTranscriptStep,
} from "./agy-transcript"

const POLL_MS = 1_500
const THREAD_WINDOW_MS = 24 * 60 * 60 * 1_000
const MAX_CONVERSATIONS = 10
const INITIAL_EVENTS_PER_CONVERSATION = 120
const FIRST_READ_TAIL_BYTES = 512 * 1024

export interface AgyConversationSummary {
  id: string
  title: string
  cwd: string
  status: "busy" | "idle"
  updatedAtMs: number
  stepCount: number
}

export function agySummariesDbPath(home = homedir()): string {
  return join(agyRootDir(home), "conversation_summaries.db")
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

    if (lastStep.type === "USER_INPUT" || lastStep.type === "GENERIC") {
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

export function resetAgyFeedStateForTests(): void {
  offsets.clear()
  clearPendingAgyTools()
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

function isDuplicateInjectedUserPrompt(
  ev: FeedEvent,
  convoId: string,
  ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId">,
): boolean {
  if (ev.kind !== "user_prompt") return false
  const text = (ev.text ?? "").trim()
  if (!text) return false
  const feed = getFeed()
  for (let i = feed.length - 1; i >= 0; i--) {
    const existing = feed[i]!
    if (existing.kind !== "user_prompt") continue
    if (existing.id.startsWith("agy:") || existing.id.startsWith("tx:")) continue
    const sameSession = existing.sessionId === convoId || (Boolean(ident.tty) && existing.tty === ident.tty)
    if (!sameSession) continue
    if ((existing.text ?? "").trim() !== text) continue
    if (Math.abs(existing.ts - ev.ts) > 120_000) continue
    if (!existing.sessionId) existing.sessionId = convoId
    if (ident.key && !existing.key) existing.key = ident.key
    return true
  }
  return false
}

export function readAgyTranscriptDelta(convo: AgyConversationSummary, home = homedir()): FeedEvent[] {
  const path = agyTranscriptPath(convo.id, home)
  if (!existsSync(path)) return []

  const session = listSessions().find((s) => s.sessionId === convo.id)
  const ident: Pick<FeedEvent, "key" | "cwd" | "tty" | "sessionId"> = {
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

  if (size <= start) {
    offsets.set(path, size)
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

  const readLen = size - start
  const buf = Buffer.allocUnsafe(readLen)
  let bytesRead = 0
  try {
    const fd = openSync(path, "r")
    try {
      bytesRead = readSync(fd, buf, 0, readLen, start)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
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

  const allLines = body.split("\n")
  const lines = firstRead ? allLines.slice(-250) : allLines
  const out: FeedEvent[] = []
  for (const line of lines) {
    const stepEvents = parseAgyTranscriptLine(line, ident, convo.id, undefined, { transcriptPath: path, home })
    for (const ev of stepEvents) {
      if (!firstRead && isDuplicateInjectedUserPrompt(ev, convo.id, ident)) {
        continue
      }
      out.push(ev)
    }
  }
  enforceMonotonicTimestamps(out)
  syncAgyOpenQuestion(lines, convo, ident, home)
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
  return firstRead ? selectInitialAgyEvents(out, INITIAL_EVENTS_PER_CONVERSATION) : out
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
      cwd: opts.cwd || homedir(), env: scrubAgentEnv(process.env),
      stdout: "ignore", stderr: "ignore",
    })
    proc.unref()
    return true
  } catch {
    return false
  }
}
