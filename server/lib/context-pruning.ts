import { BRAIN_THREAD, brainText, isBrainInternalEvent } from "./brain"
import type { ModelTurnPart } from "./brain-turn-harness"
import type { Turn } from "./orchestrator-chat"

export interface Message {
  id: number
  role: "user" | "assistant" | "tool"
  content: string
  toolCallId?: string
  toolName?: string
  /** Opaque Gemini 4 reasoning signature; preserved verbatim inside the Hot Window. */
  thoughtSignature?: string
  /** Optional structured model parts (e.g. functionCall + thoughtSignature); preserved verbatim inside the Hot Window. */
  parts?: ModelTurnPart[]
  /** Marks operational/internal events that must be excluded from interactive transcripts. */
  isOperationalEvent?: boolean
}

export interface PrunedContextResult {
  messages: Message[]
  coldMessages: Message[]
  coldSummaryMarkdown?: string
  coldSummarySystemBlock?: string
  estimatedTokens: number
}

export const HOT_WINDOW_TURNS = 6
export const WARM_WINDOW_END_TURNS = 15
export const WARM_TOOL_COMPACT_CHAR_THRESHOLD = 300
export const DEFAULT_CONTEXT_TOKEN_CEILING = 24_000

const OPERATIONAL_EVENT_LINE_RE =
  /^\s*(?:\[event(?:\s+[^\]]+)?\]|\[heartbeat\]|\[ci-webhook\]|\[internal-state\]|\[from\s+[^\]]+\]|(?:stuck|green PR|CI green)\s+\S+\/\S+#\d+|Auto-deploy\b)/i

const STACK_TRACE_LINE_RE =
  /^(?:\s+at\s+\S.*|\s*Traceback \(most recent call last\):|\s*File ".*", line \d+.*|\s*Caused by:\s+.*|\s*\.\.\.\s+\d+\s+more\s*)$/

/** Strip stack trace frames from Warm Window messages while retaining the primary message/error headline. */
export function stripStackTraces(text: string): string {
  if (!text.includes("\n")) return text
  const kept = text.split("\n").filter((line) => !STACK_TRACE_LINE_RE.test(line))
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** True when a raw text payload is an operational event log, CI webhook, heartbeat, or internal state check. */
export function isOperationalEventText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return OPERATIONAL_EVENT_LINE_RE.test(trimmed)
}

/**
 * Event Log Hygiene Directive:
 * Strip `[event]`, CI webhooks, heartbeat messages, and internal state checks so they never enter
 * the interactive message transcript array.
 */
export function filterInteractiveMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => {
    if (m.isOperationalEvent) return false
    if (m.role !== "tool" && isOperationalEventText(m.content)) return false
    return true
  })
}

/** Convert Companion `Turn[]` history into clean interactive `Message[]`, excluding internal/operational events. */
export function turnsToInteractiveMessages(turns: readonly Turn[]): Message[] {
  const out: Message[] = []
  let idx = 0
  for (const t of turns) {
    if (isBrainInternalEvent(t)) continue
    if (t.threadId === BRAIN_THREAD && t.role === "orchestrator" && isOperationalEventText(t.text)) continue
    if (t.role !== "user" && isOperationalEventText(t.text)) continue
    const content = brainText(t)
    out.push({
      id: idx++,
      role: t.role === "user" ? "user" : t.role === "worker" ? "tool" : "assistant",
      content,
      ...(t.role === "worker" && t.taskId ? { toolName: `worker:${t.taskId}` } : {}),
    })
  }
  return out
}

function approxTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function cloneHotMessageVerbatim(msg: Message): Message {
  const cloned: Message = { ...msg }
  if (Array.isArray(msg.parts)) {
    cloned.parts = msg.parts.map((part) => {
      const p: ModelTurnPart = { ...part }
      if ("thoughtSignature" in part) {
        p.thoughtSignature = part.thoughtSignature
      }
      return p
    })
  }
  if ("thoughtSignature" in msg) {
    cloned.thoughtSignature = msg.thoughtSignature
  }
  return cloned
}

function compactToolStub(msg: Message): Message {
  const lineCount = msg.content.split("\n").length
  return {
    ...msg,
    content: `[tool: ${msg.toolName || "unknown"} -> ${msg.content.length} bytes, ${lineCount} lines; compacted]`,
  }
}

/**
 * Partition `messages` into conversational turn start indices so an `assistant` `thoughtSignature` +
 * `functionCall` is never severed from its `tool` `functionResponse` across Cold/Warm/Hot boundaries.
 * Falls back to 1-message-per-turn when no `user` messages exist.
 */
function computeWindowBoundaries(messages: readonly Message[]): { warmStartIdx: number; hotStartIdx: number } {
  const userStarts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") userStarts.push(i)
  }

  if (userStarts.length === 0) {
    const total = messages.length
    return {
      hotStartIdx: Math.max(0, total - HOT_WINDOW_TURNS),
      warmStartIdx: Math.max(0, total - WARM_WINDOW_END_TURNS),
    }
  }

  const totalTurns = userStarts.length
  const hotTurnIdx = Math.max(0, totalTurns - HOT_WINDOW_TURNS)
  const warmTurnIdx = Math.max(0, totalTurns - WARM_WINDOW_END_TURNS)

  // Any leading non-user messages before the first user turn belong to the earliest turn.
  const hotStartIdx = hotTurnIdx === 0 ? 0 : userStarts[hotTurnIdx]!
  const warmStartIdx = warmTurnIdx === 0 ? 0 : userStarts[warmTurnIdx]!
  return { warmStartIdx, hotStartIdx }
}

/**
 * Phase 2 Tiered Context Compaction Pipeline:
 * - Cold Window (turns 16+): removed from active array and surfaced via `coldSummaryMarkdown`.
 * - Warm Window (turns 7-15): user/assistant text retained (stack traces stripped); tool outputs > 300 chars compacted.
 * - Hot Window (last 1-6 turns): verbatim text, full raw tool outputs, stack traces, and verbatim `thoughtSignature`s.
 * - Token Ceiling Guard: sheds warm tool outputs first, then older tool outputs (never the latest tool output or any
 *   user/assistant message or `thoughtSignature`) to stay strictly below `tokenCeiling`.
 */
export function pruneContext(
  allMessages: Message[],
  existingSummary?: string,
  tokenCeiling: number = DEFAULT_CONTEXT_TOKEN_CEILING,
): PrunedContextResult {
  const hygienicMessages = filterInteractiveMessages(allMessages)
  const { warmStartIdx, hotStartIdx } = computeWindowBoundaries(hygienicMessages)

  const coldMessages = hygienicMessages.slice(0, warmStartIdx)
  const warmMessages = hygienicMessages.slice(warmStartIdx, hotStartIdx)
  const hotMessages = hygienicMessages.slice(hotStartIdx).map(cloneHotMessageVerbatim)

  const processedWarm = warmMessages.map((msg) => {
    if (msg.role === "tool" || msg.toolName) {
      if (msg.content.length > WARM_TOOL_COMPACT_CHAR_THRESHOLD) {
        return compactToolStub(msg)
      }
      return { ...msg, content: stripStackTraces(msg.content) }
    }
    return {
      ...msg,
      content: stripStackTraces(msg.content),
    }
  })

  let estimatedTokens =
    processedWarm.reduce((sum, m) => sum + approxTokens(m.content), 0) +
    hotMessages.reduce((sum, m) => sum + approxTokens(m.content), 0)

  // Step 1: Shed Warm Window tool outputs when over tokenCeiling
  if (estimatedTokens >= tokenCeiling) {
    for (let i = 0; i < processedWarm.length && estimatedTokens >= tokenCeiling; i++) {
      const m = processedWarm[i]!
      if (m.role === "tool" || m.toolName) {
        estimatedTokens -= approxTokens(m.content)
        processedWarm[i] = { ...m, content: "[tool output shed due to token budget]" }
        estimatedTokens += approxTokens(processedWarm[i]!.content)
      }
    }
  }

  // Step 2: Last-resort overflow guard for multi-50KB payloads inside older Hot tool results.
  // Never touches the latest tool output, user/assistant prose, or any message carrying a `thoughtSignature`.
  let lastToolIdxInHot = -1
  for (let i = hotMessages.length - 1; i >= 0; i--) {
    if (hotMessages[i]!.role === "tool" || hotMessages[i]!.toolName) {
      lastToolIdxInHot = i
      break
    }
  }
  if (estimatedTokens >= tokenCeiling && lastToolIdxInHot > 0) {
    for (let i = 0; i < lastToolIdxInHot && estimatedTokens >= tokenCeiling; i++) {
      const m = hotMessages[i]!
      const hasSig = !!m.thoughtSignature || (Array.isArray(m.parts) && m.parts.some((p) => !!p.thoughtSignature))
      if ((m.role === "tool" || m.toolName) && !hasSig && m.content.length > WARM_TOOL_COMPACT_CHAR_THRESHOLD) {
        estimatedTokens -= approxTokens(m.content)
        hotMessages[i] = compactToolStub(m)
        estimatedTokens += approxTokens(hotMessages[i]!.content)
      }
    }
  }

  const activeMessages = [...processedWarm, ...hotMessages]
  const cleanSummary = existingSummary?.trim() || undefined
  const coldSummarySystemBlock = cleanSummary ? `### Cold Session Summary\n${cleanSummary}` : undefined

  return {
    messages: activeMessages,
    coldMessages,
    coldSummaryMarkdown: cleanSummary,
    coldSummarySystemBlock,
    estimatedTokens,
  }
}
