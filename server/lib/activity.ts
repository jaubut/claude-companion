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
//
// The pill is a property of that same per-session record (PRJ-OR1T Phase 10):
// every hook writes ONLY the PathState it was handed, and the host-wide
// `activity` the shipped clients read is DERIVED at read time as the most
// recently active session's pill. Nothing in here is a host singleton.

import { verbFor, summarize, extractToolResult, clampLong } from "./tool-format"
import { appendFeedEvent, pruneFeedForSession, type Verdict } from "./feed"
import { getState, identityFor, activeStates, forgetStates, readTranscriptDelta, hashText, type SessionMeta, type PathState } from "./transcript"
import type { Session } from "./sessions"

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
  // The owning Session.key ("claude:tty:/dev/ttys004"), issued by the route
  // that already holds the Session — never inferred here. "" when the hook
  // carried no cwd, so no Session was ever registered for it.
  key: string
}

type ActivityListener = (rollup: Activity | null, activities: Activity[], key: string) => void
const activityListeners = new Set<ActivityListener>()

// How stale a pill must be before the liveness reconcile drops it. The window
// covers one race only: recordSession's collapse rewrites a session's key
// after the `sessions` emit, so a pill written by an earlier hook can name the
// pre-collapse key for the few ms before this session's next event refreshes it.
const LIVENESS_GRACE_MS = 5_000

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
    const now = Date.now()
    let beat = false
    for (const s of activeStates()) {
      if (s.transcriptPath) readTranscriptDelta(s)
      // Heartbeat — keep every live "Claude is … 12s" pill counting between
      // tools. lastBeatAt ONLY: bumping lastEventAt would re-sort the rollup
      // on every tick and flip the shipped clients' pill between sessions.
      if (s.activity) {
        s.activity = { ...s.activity, lastBeatAt: now }
        beat = true
      }
    }
    // One frame per tick, never one per session — WS volume stays at today's
    // rate whatever N is.
    if (beat) emitActivity("")
  }, POLL_MS)
  // Don't keep the event loop alive just for the heartbeat.
  if (typeof (pollTimer as unknown as { unref?: () => void }).unref === "function") {
    (pollTimer as unknown as { unref: () => void }).unref()
  }
}

function stopPollIfIdle(): void {
  if (!pollTimer) return
  for (const s of activeStates()) if (s.activity) return
  clearInterval(pollTimer)
  pollTimer = null
}

export function onActivity(fn: ActivityListener): () => void {
  activityListeners.add(fn)
  return () => activityListeners.delete(fn)
}

// Every live pill, most-recent-EVENT first. Ordering on lastEventAt (not on
// the 1.5s beat) is what keeps the rollup pinned to one session for a whole turn.
export function listActivities(): Activity[] {
  const rows: Array<{ at: number; activity: Activity }> = []
  for (const s of activeStates()) {
    if (s.activity) rows.push({ at: s.lastEventAt, activity: s.activity })
  }
  rows.sort((a, b) => b.at - a.at)
  return rows.map(r => r.activity)
}

// The host rollup every shipped client still reads: the session that did
// something most recently. Same rule that used to pick the singleton, derived.
export function getActivity(): Activity | null {
  return listActivities()[0] ?? null
}

function emitActivity(key: string): void {
  const activities = listActivities()
  const rollup = activities[0] ?? null
  for (const fn of activityListeners) {
    try { fn(rollup, activities, key) } catch { /* ignore */ }
  }
}

// Write THIS session's pill and announce it. Real events (tool start, prompt,
// tool end) bump lastEventAt, the rollup's ordering key; the heartbeat above
// never routes through here.
function setActivity(s: PathState, next: Omit<Activity, "key">, sessionKey: string): void {
  s.activity = { ...next, key: sessionKey }
  s.lastEventAt = Date.now()
  emitActivity(sessionKey)
}

function clearActivity(s: PathState, sessionKey: string): void {
  if (!s.activity) return
  s.activity = null
  emitActivity(sessionKey)
}

// A SIGKILLed terminal fires no session-end hook, so its pill would sit on the
// phone forever. Ride the existing `sessions` emit — all 11 of its call sites
// are change-gated, so this runs on real transitions, never periodically — and
// drop any pill whose session left the live set.
//
// Two keyspaces, easy to mix up: compare the pill's own Session.key
// ("claude:tty:…") against the live sessions' keys, NEVER against the states
// map's key (path:/tty:/sid:/cwd:).
export function reconcileActivityLiveness(sessions: Session[]): void {
  const now = Date.now()
  let live: Set<string> | null = null
  let cleared = false
  for (const s of activeStates()) {
    const pill = s.activity
    // No key = a hook with no cwd, so no Session exists to judge it against.
    // It clears on that session's turn-end or session-end, exactly as before.
    if (!pill || !pill.key) continue
    if (!live) {
      live = new Set<string>()
      for (const sess of sessions) live.add(sess.key)
    }
    if (live.has(pill.key)) continue
    if (now - s.lastEventAt <= LIVENESS_GRACE_MS) continue
    s.activity = null
    cleared = true
  }
  // Emit only on a real clear, or this would broadcast at the dialog-poll rate.
  if (cleared) {
    emitActivity("")
    stopPollIfIdle()
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
  sessionKey: string
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

  setActivity(s, {
    verb: verbFor(args.tool),
    tool: args.tool,
    summary: args.summary,
    turnStartedAt: s.turnStartedAt || now,
    lastBeatAt: now,
    tokens: s.lastTokens,
    cwd: s.cwd,
    sessionId: s.sessionId || undefined,
    tty: s.tty || undefined,
  }, args.sessionKey)
}

export function recordToolEnd(args: {
  tool: string
  input: Record<string, unknown>
  toolResponse?: unknown
  transcriptPath?: string
  cwd: string
  sessionId?: string
  tty?: string
  sessionKey: string
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
  // another tool. Only THIS session's record is touched, which is why the old
  // anti-clobber guard is gone rather than moved.
  if (s.activity) {
    setActivity(s, { ...s.activity, lastBeatAt: now, tokens: s.lastTokens }, args.sessionKey)
  }
}

export function recordUserPrompt(args: {
  text: string
  transcriptPath?: string
  cwd: string
  sessionId?: string
  tty?: string
  sessionKey: string
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

  setActivity(s, {
    verb: "Thinking",
    tool: "",
    summary: "",
    turnStartedAt: now,
    lastBeatAt: now,
    tokens: 0,
    cwd: s.cwd,
    sessionId: s.sessionId || undefined,
    tty: s.tty || undefined,
  }, args.sessionKey)

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
  sessionKey: string
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

  // Clear THIS session's pill only. Another session may still be mid-turn —
  // its pill stays up and the host rollup hands back to it.
  clearActivity(s, args.sessionKey)
  stopPollIfIdle()
}

// Drop a session's state when its hook signals the terminal closed, so the
// states Map doesn't grow unbounded. The record and its pill go together.
export function forgetSession(meta: SessionMeta): void {
  // forgetStates hands back what it deleted — never call getState(meta) after
  // it, since getState creates on miss and would resurrect the record.
  const dropped = forgetStates(meta)
  if (dropped.some(s => s.activity)) emitActivity("")
  pruneFeedForSession(meta)
  stopPollIfIdle()
}
