// Antigravity (agy) transcript.jsonl paths + step → FeedEvent parsing.
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { FeedEvent } from "./feed"
import { clampLong, summarize, extractToolResult } from "./tool-format"
import { isQuestionTool, parseQuestionInput, type QuestionAnswer, type QuestionItem } from "./questions"
import { THINKING_MAX } from "./transcript"
import { readTailLines } from "./transcript-cursor"
import type { HistorySession } from "./transcript-backfill"

const TAIL_BYTES = 2 * 1024 * 1024

export interface AgyTranscriptStep {
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

export function resolveTruncatedAgyStep(
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

export function normalizeAgyToolArgs(raw: Record<string, unknown> | undefined): Record<string, unknown> {
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

export function clearPendingAgyTools(): void {
  pendingToolsBySession.clear()
}

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

export function enforceMonotonicTimestamps(events: FeedEvent[]): FeedEvent[] {
  let lastTs = -Infinity
  for (const ev of events) {
    if (ev.ts <= lastTs) {
      ev.ts = lastTs + 1
    }
    lastTs = ev.ts
  }
  return events
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
