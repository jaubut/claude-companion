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

import { readFileSync } from "node:fs"

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
  tool?: string
  summary?: string
  verdict?: Verdict
  durationMs?: number
  text?: string
  cwd?: string
}

export interface Activity {
  verb: string
  tool: string
  summary: string
  turnStartedAt: number
  lastBeatAt: number
  tokens: number
  cwd: string
}

const feed: FeedEvent[] = []
const FEED_CAP = 200

let activity: Activity | null = null
let turnStartedAt = 0
// The cwd of the current turn. Tool events carry their own cwd from the hook
// payload, but assistant_text / turn_end / user_prompt need a fallback so the
// phone can stamp every line with a session badge.
let currentCwd = ""
// Current turn's transcript path — used by the poll timer so we can stream
// assistant text in near-real-time for text-only turns where no PostToolUse
// hook ever fires.
let currentTranscriptPath = ""
let lastTokens = 0
// Per-tool start times, keyed by stringified input (tool calls don't carry
// a stable id across pre/post hooks, but input uniqueness is close enough
// within a single turn).
const toolStarts = new Map<string, number>()
// Track assistant text emitted so we don't replay it when the transcript
// grows between PostToolUse reads.
const seenAssistantText = new Set<string>()

// ── Live poll ────────────────────────────────────────────────────────────
// Hooks only fire at tool boundaries and turn end. For text-only turns the
// phone would otherwise sit empty for seconds while Claude is clearly
// responding in the terminal. Poll the transcript every 1.5s while a turn
// is active — cheap, since the transcript is a local file.
const POLL_MS = 1500
let pollTimer: ReturnType<typeof setInterval> | null = null

function startPoll(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (!currentTranscriptPath) return
    readTranscriptDelta(currentTranscriptPath)
    // Heartbeat — keep the "Claude is … 12s" pill counting even between tools.
    if (activity) {
      setActivity({ ...activity, lastBeatAt: Date.now(), tokens: lastTokens })
    }
  }, POLL_MS)
}

function stopPoll(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

type Listener = (ev: FeedEvent) => void
type ActivityListener = (act: Activity | null) => void
const feedListeners = new Set<Listener>()
const activityListeners = new Set<ActivityListener>()

export function onFeed(fn: Listener): () => void {
  feedListeners.add(fn)
  return () => feedListeners.delete(fn)
}

export function onActivity(fn: ActivityListener): () => void {
  activityListeners.add(fn)
  return () => activityListeners.delete(fn)
}

export function getFeed(): FeedEvent[] {
  return feed.slice()
}

export function getActivity(): Activity | null {
  return activity
}

function emit(ev: FeedEvent): void {
  feed.push(ev)
  if (feed.length > FEED_CAP) feed.splice(0, feed.length - FEED_CAP)
  for (const fn of feedListeners) {
    try { fn(ev) } catch { /* ignore */ }
  }
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
}): void {
  const now = Date.now()
  if (args.cwd) currentCwd = args.cwd
  // If we arrive here without a user_prompt first (e.g. companion started
  // mid-turn), still kick the poller on so we can stream incoming text.
  if (!pollTimer) startPoll()
  toolStarts.set(toolKey(args.tool, args.input), now)

  emit({
    id: crypto.randomUUID(),
    ts: now,
    kind: "tool_start",
    tool: args.tool,
    summary: args.summary,
    verdict: args.verdict,
    cwd: args.cwd,
  })

  // Live activity — "Claude is verbing…"
  setActivity({
    verb: verbFor(args.tool),
    tool: args.tool,
    summary: args.summary,
    turnStartedAt: turnStartedAt || now,
    lastBeatAt: now,
    tokens: lastTokens,
    cwd: currentCwd,
  })
}

export function recordToolEnd(args: {
  tool: string
  input: Record<string, unknown>
  transcriptPath?: string
  cwd: string
}): void {
  const now = Date.now()
  if (args.cwd) currentCwd = args.cwd
  if (args.transcriptPath) currentTranscriptPath = args.transcriptPath
  const key = toolKey(args.tool, args.input)
  const startedAt = toolStarts.get(key)
  toolStarts.delete(key)

  emit({
    id: crypto.randomUUID(),
    ts: now,
    kind: "tool_end",
    tool: args.tool,
    summary: summarize(args.tool, args.input),
    durationMs: startedAt ? now - startedAt : undefined,
    cwd: args.cwd,
  })

  // Pull any new assistant text + token count from the transcript.
  if (args.transcriptPath) readTranscriptDelta(args.transcriptPath)

  // Keep activity alive as a heartbeat even though this tool is done —
  // Claude is likely about to fire another one.
  if (activity) {
    setActivity({ ...activity, lastBeatAt: now, tokens: lastTokens })
  }
}

export function recordUserPrompt(text: string, transcriptPath: string | undefined, cwd: string): void {
  const now = Date.now()
  turnStartedAt = now
  lastTokens = 0
  toolStarts.clear()
  seenAssistantText.clear()
  if (cwd) currentCwd = cwd
  currentTranscriptPath = transcriptPath ?? ""

  emit({
    id: crypto.randomUUID(),
    ts: now,
    kind: "user_prompt",
    text: text.slice(0, 500),
    cwd: currentCwd,
  })

  setActivity({
    verb: "Thinking",
    tool: "",
    summary: "",
    turnStartedAt: now,
    lastBeatAt: now,
    tokens: 0,
    cwd: currentCwd,
  })

  // Transcript may already contain this prompt — prime the seen set so we
  // don't echo it back as assistant text.
  if (transcriptPath) readTranscriptDelta(transcriptPath, { silent: true })

  startPoll()
}

export function recordTurnEnd(transcriptPath?: string, finalText?: string): void {
  const now = Date.now()
  const trimmedFinal = finalText?.trim() ?? ""

  // Pre-mark the final text so readTranscriptDelta won't also emit it as an
  // assistant_text event — we want it to appear only inside the turn_end card.
  if (trimmedFinal) {
    for (const block of trimmedFinal.split("\n\n")) {
      const t = block.trim()
      if (t) seenAssistantText.add(hashText(t))
    }
    seenAssistantText.add(hashText(trimmedFinal))
  }

  if (transcriptPath) {
    currentTranscriptPath = transcriptPath
    readTranscriptDelta(transcriptPath)
  }

  emit({
    id: crypto.randomUUID(),
    ts: now,
    kind: "turn_end",
    cwd: currentCwd,
    text: trimmedFinal ? trimmedFinal.slice(-2000) : undefined,
  })

  setActivity(null)
  stopPoll()
}

function readTranscriptDelta(
  path: string,
  opts: { silent?: boolean } = {},
): void {
  let raw: string
  try { raw = readFileSync(path, "utf8") } catch { return }

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
      if (total > lastTokens) lastTokens = total
    }

    if (entry.type !== "assistant") continue
    const content = (entry.message as { content?: unknown })?.content
    if (!Array.isArray(content)) continue

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "text") continue
      const text = (block.text as string | undefined)?.trim()
      if (!text) continue
      const key = hashText(text)
      if (seenAssistantText.has(key)) continue
      seenAssistantText.add(key)
      if (opts.silent) continue
      emit({
        id: crypto.randomUUID(),
        ts: Date.now(),
        kind: "assistant_text",
        text: text.slice(0, 1200),
        cwd: currentCwd,
      })
    }
  }
}

function hashText(s: string): string {
  // Cheap stable key — we only need to dedupe within a single turn.
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return `${s.length}:${h}`
}

function verbFor(tool: string): string {
  switch (tool) {
    case "Read": return "Reading"
    case "Write": return "Writing"
    case "Edit":
    case "MultiEdit": return "Editing"
    case "Bash": return "Running"
    case "Grep": return "Searching"
    case "Glob": return "Finding"
    case "WebFetch": return "Fetching"
    case "WebSearch": return "Searching web"
    case "Task":
    case "Agent": return "Delegating"
    default: return "Working"
  }
}

export function summarize(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Bash":
      return ((input.command as string) ?? "").slice(0, 120)
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
