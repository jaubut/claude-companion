import { readFileSync } from "node:fs"
import { appendFeedEvent } from "./feed"
import { clampLong } from "./tool-format"

// Per-transcript state and the transcript reader. Each Claude session writes
// its own JSONL transcript; hooks tell activity.ts *when* to read, this
// module reads *what* changed: new assistant text blocks (emitted once, deduped
// by hash) and the token high-water mark. readTranscriptDelta returns how many
// blocks it emitted — recordTurnEnd's retry depends on that count and on
// streamedThisTurn being flipped here.

export interface SessionMeta {
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
export interface PathState {
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

const states = new Map<string, PathState>()

function keyFor(meta: SessionMeta): string {
  if (meta.transcriptPath) return `path:${meta.transcriptPath}`
  if (meta.tty) return `tty:${meta.tty}`
  if (meta.sessionId) return `sid:${meta.sessionId}`
  if (meta.cwd) return `cwd:${meta.cwd}`
  return "global"
}

export function getState(meta: SessionMeta): PathState {
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

export function identityFor(s: PathState): { cwd: string; tty?: string; sessionId?: string } {
  return {
    cwd: s.cwd,
    tty: s.tty || undefined,
    sessionId: s.sessionId || undefined,
  }
}

// Every session with a transcript on disk — the 1.5s poll walks these.
export function activeStates(): Iterable<PathState> {
  return states.values()
}

// Drop a session's state when its terminal closed, so the map doesn't grow
// unbounded. Same match rule as the feed prune.
export function forgetStates(meta: SessionMeta): void {
  for (const [k, s] of states) {
    const matches =
      (meta.transcriptPath && s.transcriptPath === meta.transcriptPath) ||
      (meta.tty && s.tty === meta.tty) ||
      (meta.sessionId && s.sessionId === meta.sessionId)
    if (matches) states.delete(k)
  }
}

export function readTranscriptDelta(
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
      appendFeedEvent({
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

export function hashText(s: string): string {
  // Cheap stable key — we only need to dedupe within a single turn.
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return `${s.length}:${h}`
}
