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

import { readFileSync } from "node:fs"
import { isQuestionTool } from "./questions"

export type EventKind =
  | "user_prompt"
  | "assistant_text"
  | "tool_start"
  | "tool_end"
  | "turn_end"

export type Verdict = "auto-allow" | "auto-deny" | "approved" | "denied" | "pending"

export interface FeedEvent {
  id: string
  ts: number
  kind: EventKind
  // Optional public session key when a producer can resolve it exactly.
  // Hook-fed events usually carry tty/sessionId/cwd and let clients resolve
  // against the current sessions table; log-fed imports can often name the
  // final key directly.
  key?: string
  tool?: string
  summary?: string
  verdict?: Verdict
  durationMs?: number
  text?: string
  cwd?: string
  tty?: string
  sessionId?: string
  // Bash + similar — first non-empty lines of stdout/stderr after the
  // tool ran. Capped at ~200 chars so the feed message stays small.
  outputExcerpt?: string
  // True when the tool wrote to stderr (not necessarily a non-zero
  // exit, but a useful "something went sideways" signal for the badge).
  errored?: boolean
}

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

interface SessionMeta {
  transcriptPath?: string
  tty?: string
  sessionId?: string
  cwd?: string
}

// Per-session state. Each Claude session writes its own transcript file, so
// the transcript path is the strongest key. When the transcript isn't known
// yet (e.g. PreToolUse before any tool ran), we fall back to tty / sessionId
// / cwd. As stronger identity arrives on later hooks we update the record
// in place so the same session keeps one state entry.
interface PathState {
  cwd: string
  sessionId: string
  tty: string
  transcriptPath: string
  turnStartedAt: number
  lastTokens: number
  seenAssistantText: Set<string>
  toolStarts: Map<string, number>
  // True once any assistant_text event has been emitted this turn. Drives
  // turn_end's wrap-up policy: if streaming already happened, turn_end omits
  // its own text so iOS doesn't append a duplicate concat block. Reset on
  // each user prompt (turn boundary).
  streamedThisTurn: boolean
}

const feed: FeedEvent[] = []
const FEED_CAP = 200

// One activity pill is shown at a time (the most recently active session).
// Events, however, are always tagged with precise per-session identity.
let activity: Activity | null = null

const states = new Map<string, PathState>()

function keyFor(meta: SessionMeta): string {
  if (meta.transcriptPath) return `path:${meta.transcriptPath}`
  if (meta.tty) return `tty:${meta.tty}`
  if (meta.sessionId) return `sid:${meta.sessionId}`
  if (meta.cwd) return `cwd:${meta.cwd}`
  return "global"
}

function getState(meta: SessionMeta): PathState {
  const key = keyFor(meta)
  const existing = states.get(key)
  if (existing) {
    // Fill in fields that arrived on a later hook (e.g. transcript_path shows
    // up at PostToolUse but not at PreToolUse).
    if (meta.cwd) existing.cwd = meta.cwd
    if (meta.sessionId) existing.sessionId = meta.sessionId
    if (meta.tty) existing.tty = meta.tty
    if (meta.transcriptPath) existing.transcriptPath = meta.transcriptPath
    return existing
  }
  // Also check under weaker keys — if we previously recorded by cwd and now
  // have a transcript path, migrate the state rather than orphaning it.
  for (const weakKey of [
    meta.tty ? `tty:${meta.tty}` : null,
    meta.sessionId ? `sid:${meta.sessionId}` : null,
    meta.cwd ? `cwd:${meta.cwd}` : null,
  ]) {
    if (!weakKey || weakKey === key) continue
    const weak = states.get(weakKey)
    if (weak) {
      if (meta.cwd) weak.cwd = meta.cwd
      if (meta.sessionId) weak.sessionId = meta.sessionId
      if (meta.tty) weak.tty = meta.tty
      if (meta.transcriptPath) weak.transcriptPath = meta.transcriptPath
      states.delete(weakKey)
      states.set(key, weak)
      return weak
    }
  }
  const next: PathState = {
    cwd: meta.cwd ?? "",
    sessionId: meta.sessionId ?? "",
    tty: meta.tty ?? "",
    transcriptPath: meta.transcriptPath ?? "",
    turnStartedAt: 0,
    lastTokens: 0,
    seenAssistantText: new Set(),
    toolStarts: new Map(),
    streamedThisTurn: false,
  }
  states.set(key, next)
  return next
}

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
    for (const s of states.values()) {
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

type Listener = (ev: FeedEvent) => void
type ActivityListener = (act: Activity | null) => void
type FeedResetListener = (removedIds: string[]) => void
const feedListeners = new Set<Listener>()
const activityListeners = new Set<ActivityListener>()
const feedResetListeners = new Set<FeedResetListener>()

export function onFeed(fn: Listener): () => void {
  feedListeners.add(fn)
  return () => feedListeners.delete(fn)
}

export function onActivity(fn: ActivityListener): () => void {
  activityListeners.add(fn)
  return () => activityListeners.delete(fn)
}

export function onFeedReset(fn: FeedResetListener): () => void {
  feedResetListeners.add(fn)
  return () => feedResetListeners.delete(fn)
}

export function getFeed(): FeedEvent[] {
  return feed.slice()
}

export function getActivity(): Activity | null {
  return activity
}

function emit(ev: FeedEvent): void {
  if (feed.some((existing) => existing.id === ev.id)) return
  feed.push(ev)
  if (feed.length > FEED_CAP) feed.splice(0, feed.length - FEED_CAP)
  for (const fn of feedListeners) {
    try { fn(ev) } catch { /* ignore */ }
  }
}

export function appendFeedEvent(ev: FeedEvent): void {
  emit(ev)
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

function identityFor(s: PathState): { cwd: string; tty?: string; sessionId?: string } {
  return {
    cwd: s.cwd,
    tty: s.tty || undefined,
    sessionId: s.sessionId || undefined,
  }
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

  emit({
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

  emit({
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

  emit({
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

  emit({
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
  for (const [k, s] of states) {
    const matches =
      (meta.transcriptPath && s.transcriptPath === meta.transcriptPath) ||
      (meta.tty && s.tty === meta.tty) ||
      (meta.sessionId && s.sessionId === meta.sessionId)
    if (matches) states.delete(k)
  }
  if (activity) {
    const stale =
      (meta.tty && activity.tty === meta.tty) ||
      (meta.sessionId && activity.sessionId === meta.sessionId)
    if (stale) setActivity(null)
  }
  // Prune feed events that originated from this session — otherwise the
  // phone replays a dead conversation when the user spawns a fresh chat.
  // Match on tty / sessionId only; cwd alone is too weak (two windows can
  // share a cwd, dropping events for the wrong session).
  if (meta.tty || meta.sessionId) {
    const removed: string[] = []
    for (let i = feed.length - 1; i >= 0; i--) {
      const ev = feed[i]
      if (!ev) continue
      const hit =
        (meta.tty && ev.tty === meta.tty) ||
        (meta.sessionId && ev.sessionId === meta.sessionId)
      if (hit) {
        removed.push(ev.id)
        feed.splice(i, 1)
      }
    }
    if (removed.length > 0) {
      for (const fn of feedResetListeners) {
        try { fn(removed) } catch { /* ignore */ }
      }
    }
  }
  stopPollIfIdle()
}

function activityMatches(a: Activity, s: PathState): boolean {
  if (a.tty && s.tty) return a.tty === s.tty
  if (a.sessionId && s.sessionId) return a.sessionId === s.sessionId
  return a.cwd === s.cwd
}

function readTranscriptDelta(
  s: PathState,
  opts: { silent?: boolean } = {},
): number {
  let emitted = 0
  const path = s.transcriptPath
  if (!path) return emitted
  let raw: string
  try { raw = readFileSync(path, "utf8") } catch { return emitted }

  const lines = raw.split("\n")
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) } catch { continue }

    // Token accounting — pull usage from the latest assistant message.
    const usage = (entry.message as { usage?: Record<string, number> } | undefined)?.usage
    if (usage) {
      const total =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0)
      if (total > s.lastTokens) s.lastTokens = total
    }

    if (entry.type !== "assistant") continue
    const content = (entry.message as { content?: unknown })?.content
    if (!Array.isArray(content)) continue

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "text") continue
      const text = (block.text as string | undefined)?.trim()
      if (!text) continue
      const key = hashText(text)
      if (s.seenAssistantText.has(key)) continue
      s.seenAssistantText.add(key)
      if (opts.silent) continue
      emit({
        id: crypto.randomUUID(),
        ts: Date.now(),
        kind: "assistant_text",
        text: clampLong(text, 64_000),
        ...identityFor(s),
      })
      s.streamedThisTurn = true
      emitted++
    }
  }
  return emitted
}

function hashText(s: string): string {
  // Cheap stable key — we only need to dedupe within a single turn.
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return `${s.length}:${h}`
}

function verbFor(tool: string): string {
  if (isQuestionTool(tool)) return "Asking"
  switch (tool) {
    case "Read": return "Reading"
    case "Write": return "Writing"
    case "Edit":
    case "MultiEdit": return "Editing"
    case "Bash": return "Running"
    case "shell":
    case "unified_exec":
    case "exec_command": return "Running"
    case "Grep": return "Searching"
    case "Glob": return "Finding"
    case "WebFetch": return "Fetching"
    case "WebSearch": return "Searching web"
    case "Task":
    case "Agent": return "Delegating"
    default: return "Working"
  }
}

function isShellTool(tool: string): boolean {
  return tool === "Bash" || tool === "shell" || tool === "unified_exec" || tool === "exec_command"
}

export function summarize(tool: string, input: Record<string, unknown>): string {
  if (isQuestionTool(tool)) {
    // Show the first question's text so the feed row reads as
    // "request_user_input: Which framework?" instead of just the tool name.
    const qs = input.questions
    if (Array.isArray(qs) && qs.length > 0) {
      const first = qs[0] as Record<string, unknown> | undefined
      const q = typeof first?.question === "string" ? first.question : ""
      return q.slice(0, 160)
    }
    const q = typeof input.question === "string" ? input.question : ""
    return q.slice(0, 160)
  }
  switch (tool) {
    case "Bash":
    case "shell":
    case "unified_exec":
    case "exec_command": {
      const command = (input.command as string) ?? (input.cmd as string) ?? ""
      return command.slice(0, 120)
    }
    case "Edit":
    case "Read":
    case "Write":
    case "MultiEdit": {
      const p = (input.file_path as string) ?? ""
      return p.replace(/^\/Users\/[^/]+\//, "~/")
    }
    case "Grep":
      return `/${(input.pattern as string) ?? ""}/`
    case "Glob":
      return (input.pattern as string) ?? ""
    case "WebFetch":
      return (input.url as string) ?? ""
    case "WebSearch":
      return (input.query as string) ?? ""
    default:
      return ""
  }
}

// Pull a phone-friendly excerpt from a tool_response payload. We don't try
// to render the whole thing — for Bash that could be megabytes — just the
// first few lines so the feed row can show "what happened" at a glance.
//
// Returns no excerpt when:
//  - the tool isn't one whose output is interesting (Edit/Write/Read have
//    obvious effects already)
//  - the response is empty or non-string
function extractToolResult(
  tool: string,
  raw: unknown,
): { excerpt?: string; errored?: boolean } {
  if (raw == null) return {}

  // Shell commands are the headline case — give back stdout (or stderr if
  // that's all we got) trimmed to the first 3 lines / 200 chars.
  if (isShellTool(tool)) {
    if (typeof raw === "object") {
      const r = raw as Record<string, unknown>
      const stdout = typeof r.stdout === "string" ? r.stdout : ""
      const stderr = typeof r.stderr === "string" ? r.stderr : ""
      const interrupted = r.interrupted === true
      const text = stripAnsi((stdout || stderr).trim())
      const errored = interrupted || (!stdout && stderr.trim().length > 0)
      if (!text) return { errored }
      const lines = text.split("\n").slice(0, 3).join("\n")
      return { excerpt: lines.length > 200 ? lines.slice(0, 200) + "…" : lines, errored }
    }
    if (typeof raw === "string") {
      const text = stripAnsi(raw.trim())
      const lines = text.split("\n").slice(0, 3).join("\n")
      return { excerpt: lines.length > 200 ? lines.slice(0, 200) + "…" : lines }
    }
  }

  // For other tools we don't surface output (Read's response is the file
  // content, Edit's is just confirmation noise — neither helps the user
  // judge the row in the feed).
  return {}
}

// Strip ANSI CSI sequences (colors, cursor moves) — we render the excerpt
// as plain monospaced text on iOS, so raw `\x1b[32m…` byte sequences would
// otherwise show up as visible noise.
const ANSI_PATTERN = /\[[0-9;?]*[A-Za-z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "")
}

// Bound text-payload size on the wire — protects the WS frame and the iOS
// in-memory cache from a runaway 100KB reply, but with a *generous* cap so
// the previous 8000-char limit (which silently chopped real long replies)
// no longer bites. When we do truncate, we emit a visible marker so the
// user knows there's more on the Mac side.
function clampLong(s: string, max: number): string {
  if (s.length <= max) return s
  const overflow = s.length - max
  return s.slice(0, max) + `\n\n…[truncated · +${overflow.toLocaleString()} more chars on the Mac]`
}
