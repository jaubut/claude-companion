// Live activity + event feed — fed by PostToolUse / UserPromptSubmit / Stop hooks.
//
// The goal: the phone UI should feel like watching the terminal. For that we
// need three streams of truth:
//
//   1. An event log   — one line per tool call, with verdict and duration.
//   2. Current activity — "Claude is Editing foo.ts · 12s · 4.2k tokens".
//   3. Assistant text — what Claude said between tool calls.
//
// All three are derived from the transcript file that Claude Code writes line
// by line. Hooks tell us *when* to read; the transcript tells us *what* to
// show.
//
// State is scoped PER TRANSCRIPT PATH (falling back to tty/sessionId/cwd when
// no transcript is known yet). Two Claude sessions running concurrently no
// longer trample each other's identity when emitting events — every event
// carries its originating tty + sessionId + cwd so the client can pin it to
// the right session even when sessions share a cwd.

import { verbFor, summarize, extractToolResult, clampLong } from "./tool-format"
import { appendFeedEvent, pruneFeedForSession, type Verdict } from "./feed"
import { getState, identityFor, activeStates, forgetStates, readTranscriptDelta, hashText, type SessionMeta, type PathState } from "./transcript"

export interface Activity {
  verb: string
  tool: string
  summary: string
  turnStartedAt: number
  lastBeatAt: number
  tokens: number
  cwd: string
  // Explicit session identity so the phone can match a precise session even
  // when two sessions share a cwd (e.g. two Claude windows in the same repo).
  // The client prefers `tty` for matching, falling back to `sessionId`, and
  // only uses `cwd` as a last resort.
  sessionId?: string
  tty?: string
}

// One activity pill is shown at a time (the most recently active session).
// Events, however, are always tagged with precise per-session identity.
let activity: Activity | null = null

type ActivityListener = (act: Activity | null) => void
const activityListeners = new Set<ActivityListener>()

// ── Live poll ────────────────────────────────────────────────────────────
// Hooks only fire at tool boundaries and turn end. For text-only turns the
// phone would otherwise sit empty for seconds while Claude is clearly
// responding in the terminal. Poll every active session's transcript every
// 1.5s while any session is still turning — cheap, since transcripts are
// local files.
const POLL_MS = 1500
let pollTimer: ReturnType<typeof setInterval> | null = null

function startPoll(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    for (const s of activeStates()) {
      if (s.transcriptPath) readTranscriptDelta(s)
    }
    // Heartbeat — keep the "Claude is … 12s" pill counting between tools.
    if (activity) {
      setActivity({ ...activity, lastBeatAt: Date.now() })
    }
  }, POLL_MS)
}

function stopPollIfIdle(): void {
  if (activity) return
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

export function onActivity(fn: ActivityListener): () => void {
  activityListeners.add(fn)
  return () => activityListeners.delete(fn)
}

export function getActivity(): Activity | null {
  return activity
}

function setActivity(next: Activity | null): void {
  activity = next
  for (const fn of activityListeners) {
    try { fn(next) } catch { /* ignore */ }
  }
}

function toolKey(tool: string, input: Record<string, unknown>): string {
  return `${tool}::${JSON.stringify(input)}`
}

export function recordToolStart(args: {
  tool: string
  input: Record<string, unknown>
  summary: string
  verdict: Verdict
  cwd: string
  sessionId?: string
  tty?: string
  transcriptPath?: string
}): void {
  const now = Date.now()
  const s = getState(args)
  if (!pollTimer) startPoll()
  s.toolStarts.set(toolKey(args.tool, args.input), now)

  appendFeedEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: "tool_start",
    tool: args.tool,
    summary: args.summary,
    verdict: args.verdict,
    ...identityFor(s),
  })

  setActivity({
    verb: verbFor(args.tool),
    tool: args.tool,
    summary: args.summary,
    turnStartedAt: s.turnStartedAt || now,
    lastBeatAt: now,
    tokens: s.lastTokens,
    cwd: s.cwd,
    sessionId: s.sessionId || undefined,
    tty: s.tty || undefined,
  })
}

export function recordToolEnd(args: {
  tool: string
  input: Record<string, unknown>
  toolResponse?: unknown
  transcriptPath?: string
  cwd: string
  sessionId?: string
  tty?: string
}): void {
  const now = Date.now()
  const s = getState(args)
  const key = toolKey(args.tool, args.input)
  const startedAt = s.toolStarts.get(key)
  s.toolStarts.delete(key)

  const result = extractToolResult(args.tool, args.toolResponse)

  appendFeedEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: "tool_end",
    tool: args.tool,
    summary: summarize(args.tool, args.input),
    durationMs: startedAt ? now - startedAt : undefined,
    outputExcerpt: result.excerpt,
    errored: result.errored,
    ...identityFor(s),
  })

  if (args.transcriptPath) readTranscriptDelta(s)

  // Keep the pill alive as a heartbeat — Claude is likely about to fire
  // another tool. Only update if the current pill is for *this* session, so
  // another active session's pill isn't clobbered by a tool_end in ours.
  if (activity && activityMatches(activity, s)) {
    setActivity({ ...activity, lastBeatAt: now, tokens: s.lastTokens })
  }
}

export function recordUserPrompt(args: {
  text: string
  transcriptPath?: string
  cwd: string
  sessionId?: string
  tty?: string
}): void {
  const now = Date.now()
  const s = getState(args)
  s.turnStartedAt = now
  s.lastTokens = 0
  s.toolStarts.clear()
  s.seenAssistantText.clear()
  s.streamedThisTurn = false

  appendFeedEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: "user_prompt",
    text: clampLong(args.text, 16_000),
    ...identityFor(s),
  })

  setActivity({
    verb: "Thinking",
    tool: "",
    summary: "",
    turnStartedAt: now,
    lastBeatAt: now,
    tokens: 0,
    cwd: s.cwd,
    sessionId: s.sessionId || undefined,
    tty: s.tty || undefined,
  })

  // Transcript may already contain this prompt — prime the seen set so we
  // don't echo it back as assistant text.
  if (args.transcriptPath) readTranscriptDelta(s, { silent: true })

  startPoll()
}

export async function recordTurnEnd(args: {
  transcriptPath?: string
  finalText?: string
  cwd: string
  sessionId?: string
  tty?: string
}): Promise<void> {
  const now = Date.now()
  const s = getState(args)
  const trimmedFinal = args.finalText?.trim() ?? ""

  // Two paths for the wrap-up text, branching on whether anything streamed
  // during the turn:
  //
  // (A) Nothing streamed (single-block fast reply, polling never ticked):
  //     turn_end is the ONLY path the reply takes to the phone, so we send
  //     the whole finalText. Pre-mark its blocks so readTranscriptDelta
  //     doesn't also emit them as assistant_text after the fact.
  //
  // (B) Something streamed (typical multi-tool turn, or a slow single-block
  //     reply that polling caught): mid-turn assistant_text events already
  //     carried each block individually. Sending finalText here would make
  //     iOS append a duplicate concat block (its dedup is exact-match against
  //     the last assistant message, which is the FINAL block — not the
  //     concat). Skip pre-marking so readTranscriptDelta still catches a
  //     racy final block as a normal assistant_text, and emit turn_end
  //     WITHOUT text so the phone treats it as a structural marker only.
  const streamed = s.streamedThisTurn

  if (!streamed && trimmedFinal) {
    for (const block of trimmedFinal.split("\n\n")) {
      const t = block.trim()
      if (t) s.seenAssistantText.add(hashText(t))
    }
    s.seenAssistantText.add(hashText(trimmedFinal))
  }

  if (args.transcriptPath) {
    // On a long, tool-heavy turn the final assistant block is written to the
    // transcript AFTER the Stop hook fires — a single read here races the
    // flush and misses it, so the whole closing answer silently vanishes
    // (turn_end carries no text on the streamed path). Retry the delta read
    // with backoff until the final block lands. The first read short-circuits
    // the wait for fast turns; we only loop when nothing new appeared AND
    // something streamed earlier (i.e. a closing block is plausibly inflight).
    let got = readTranscriptDelta(s)
    if (got === 0 && streamed) {
      const deadline = now + 4_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250))
        got = readTranscriptDelta(s)
        if (got > 0) break
      }
    }
  }

  appendFeedEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: "turn_end",
    text: !streamed && trimmedFinal ? clampLong(trimmedFinal, 64_000) : undefined,
    ...identityFor(s),
  })

  s.streamedThisTurn = false

  // Only clear the live pill if it belonged to THIS session. Another session
  // may still be mid-turn — don't blank its activity just because we finished.
  if (activity && activityMatches(activity, s)) {
    setActivity(null)
  }
  stopPollIfIdle()
}

// Drop a session's state when its hook signals the terminal closed, so the
// states Map doesn't grow unbounded.
export function forgetSession(meta: SessionMeta): void {
  forgetStates(meta)
  if (activity) {
    const stale =
      (meta.tty && activity.tty === meta.tty) ||
      (meta.sessionId && activity.sessionId === meta.sessionId)
    if (stale) setActivity(null)
  }
  pruneFeedForSession(meta)
  stopPollIfIdle()
}

function activityMatches(a: Activity, s: PathState): boolean {
  if (a.tty && s.tty) return a.tty === s.tty
  if (a.sessionId && s.sessionId) return a.sessionId === s.sessionId
  return a.cwd === s.cwd
}
