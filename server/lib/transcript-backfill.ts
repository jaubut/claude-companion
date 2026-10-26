import { existsSync } from "node:fs"
import { type FeedEvent, getFeed, sessionRetention } from "./feed"
import { SESSION_ID_RE } from "./recent-sessions"
import { findTranscript, transcriptPath } from "./session-titles"
import { clampLong, summarize } from "./tool-format"
import { THINKING_MAX } from "./transcript"
import { readTailLines } from "./transcript-cursor"

// A listed session's older rows, rebuilt from its Claude Code transcript for a
// phone whose chat for it is empty (GET /api/sessions/history). The feed is in
// memory: a server restart empties it, so an idle session had nothing to
// replay. Read-only and stateless: it never touches the live reader's cursors
// or seen sets (lib/transcript.ts), so the 1.5 s poll is unaffected.
//
// Rows are FeedEvents of the existing kinds, built the way the live producers
// build them (same summarize / clamp), with ids derived from the transcript
// line (`tx:<sessionId>:<uuid>:<block>`), so the same row has the same id on
// every request and every server. Only rows older than the session's oldest
// event still in the feed come back, minus any whose content that feed
// already holds: the feed replay covers the rest.

export const HISTORY_MAX = 40
const TAIL_BYTES = 2 * 1024 * 1024
// Feed `ts` is when the server emitted an event; a transcript line is stamped
// when Claude Code wrote it, up to a poll (1.5 s) earlier.
const BOUNDARY_SLACK_MS = 5_000

export interface HistorySession {
  key: string
  agent: string
  cwd: string
  sessionId: string
  tty: string
}

interface Entry {
  type?: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  isSidechain?: boolean
  message?: { content?: unknown }
}

// What a typed prompt looks like in the transcript: a string, or text blocks
// with no tool_result. Command wrappers, reminders and interrupt notices start
// with "<" or "[" and are not something the user typed.
function promptText(content: unknown): string | null {
  let text = ""
  if (typeof content === "string") text = content
  else if (Array.isArray(content)) {
    const blocks = content as Array<Record<string, unknown>>
    if (blocks.some((b) => b?.type === "tool_result")) return null
    text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n")
  }
  text = text.trim()
  if (!text || text.startsWith("<") || text.startsWith("[Request interrupted")) return null
  return text
}

// Every row a transcript tail holds, oldest first.
export function eventsFromTranscript(path: string, s: HistorySession, tailBytes = TAIL_BYTES): FeedEvent[] {
  const ident = { key: s.key, cwd: s.cwd, ...(s.tty ? { tty: s.tty } : {}), sessionId: s.sessionId }
  const out: FeedEvent[] = []
  for (const line of readTailLines(path, tailBytes)) {
    if (!line.trim()) continue
    let e: Entry
    try { e = JSON.parse(line) as Entry } catch { continue } // the cut first line
    if (!e.uuid || e.isMeta || e.isCompactSummary || e.isSidechain) continue
    const ts = Date.parse(e.timestamp ?? "")
    if (Number.isNaN(ts)) continue
    const id = (i: number) => `tx:${s.sessionId}:${e.uuid}:${i}`
    const content = e.message?.content
    if (e.type === "user") {
      const text = promptText(content)
      if (text) out.push({ id: id(0), ts, kind: "user_prompt", text: clampLong(text, 16_000), ...ident })
      continue
    }
    if (e.type !== "assistant" || !Array.isArray(content)) continue
    const blocks = content as Array<Record<string, unknown>>
    blocks.forEach((b, i) => {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ id: id(i), ts, kind: "assistant_text", text: clampLong(b.text.trim(), 64_000), ...ident })
      } else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        out.push({ id: id(i), ts, kind: "assistant_thinking", text: clampLong(b.thinking.trim(), THINKING_MAX), ...ident })
      } else if (b?.type === "tool_use" && typeof b.name === "string") {
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>
        out.push({ id: id(i), ts, kind: "tool_start", tool: b.name, summary: summarize(b.name, input), ...ident })
      }
    })
  }
  return out
}

const contentKey = (e: FeedEvent) => [e.kind, e.text ?? "", e.tool ?? "", e.summary ?? ""].join("\u001f")

// The newest HISTORY_MAX rows older than what the feed still holds for `s`.
export function historyRows(path: string, s: HistorySession, feed: FeedEvent[] = getFeed(), now = Date.now()): FeedEvent[] {
  const belongs = sessionRetention([s])
  const live = feed.filter((e) => belongs(e) !== null)
  const before = live.length ? Math.min(...live.map((e) => e.ts)) + BOUNDARY_SLACK_MS : now
  const known = new Set(live.map(contentKey))
  return eventsFromTranscript(path, s)
    .filter((e) => e.ts < before && !known.has(contentKey(e)))
    .slice(-HISTORY_MAX)
}

// The transcript file for a listed session: the cwd-derived path, else the
// one under another project dir (a session resumed elsewhere). Only the
// session record names it — a request never supplies a path. Codex sessions
// have no Claude transcript (codex-feed.ts reads their rollouts): none.
export async function historyFor(s: HistorySession, projectsDir?: string): Promise<FeedEvent[]> {
  if (s.agent !== "claude" || !SESSION_ID_RE.test(s.sessionId) || !s.cwd.startsWith("/")) return []
  const direct = transcriptPath(s.cwd, s.sessionId, projectsDir)
  const path = existsSync(direct) ? direct : await findTranscript(s.cwd, s.sessionId, projectsDir)
  return path ? historyRows(path, s) : []
}
