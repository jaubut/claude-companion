import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, join } from "node:path"
import { appendFeedEvent } from "./feed"
import { storeImageBase64, storeImageFile, type StoreResult } from "./media"
import { clampLong } from "./tool-format"
import type { Activity } from "./activity"

// Per-transcript state and the transcript reader. Each Claude session writes
// its own JSONL transcript; hooks tell activity.ts *when* to read, this
// module reads *what* changed: new assistant text blocks (emitted once, deduped
// by hash) and the token high-water mark. readTranscriptDelta returns how many
// blocks it emitted — recordTurnEnd's retry depends on that count and on
// streamedThisTurn being flipped here. It also queues tool_result images and
// `![alt](path)` refs into lib/media.ts and emits `image` events once encoded;
// those are never counted and never flip streamedThisTurn. Thinking blocks
// become `assistant_thinking` events under the same rule (RES-L5NG step 4).

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
  // The live pill for THIS session (PRJ-OR1T Phase 10). Written ONLY by
  // activity.ts (shape, setter, listeners, eviction); this module just carries
  // it so the pill rides the record getState() already migrates. The import is
  // type-only — activity.ts takes runtime values from here, never the reverse.
  activity: Activity | null
  // When the last REAL event landed (tool start, user prompt, tool end). The
  // 1.5s heartbeat refreshes activity.lastBeatAt and never this — the host
  // rollup orders on lastEventAt, so a beat must not re-sort the sessions.
  lastEventAt: number
  // The model id off the last assistant message ("claude-opus-5"). Claude Code
  // has no other cheap source: ~/.claude/sessions/<pid>.json carries no model
  // field, and the `/model` picker only speaks while it is open. Read from the
  // same `entry.message` this module already parses for usage, so it costs
  // nothing extra (PRJ-OR1T Phase 14).
  //
  // It is the model that ANSWERED, not the one currently selected: empty until
  // the first assistant turn, and stale between a switch and the next turn.
  // The picker is authoritative whenever it is open.
  lastModel: string
  // Images already queued for the feed (RES-L5NG step 3). Keys:
  // `tu:<tool_use_id>:<blockIdx>` for tool_result image blocks and
  // `md:<realpath>:<mtimeMs>` for `![alt](path)` refs in assistant text.
  // Marked synchronously BEFORE the async encode, so the turn-end retry loop
  // (up to 16 reads in 4 s) never queues the same image twice.
  seenImages: Set<string>
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
    activity: null,
    lastEventAt: 0,
    lastModel: "",
    seenImages: new Set(),
  }
  states.set(key, next)
  return next
}

// Claude Code writes "<synthetic>" as the model on messages it generated
// itself rather than the API — a usage-limit notice, an interrupted turn. It is
// a marker, not a model, and must never reach a client as one. Seen live
// 2026-09-13 on a session that had hit its Fable limit.
function isRealModel(model: unknown): model is string {
  return typeof model === "string" && model.length > 0 && !model.startsWith("<")
}

// The last-answered model for a session, matched the way the rest of this
// module matches: transcript path first, then sessionId, then tty, then cwd.
// Returns "" when nothing has answered yet — callers must render absence, not
// guess a default.
export function modelForIdentity(meta: { transcriptPath?: string; sessionId?: string; tty?: string; cwd?: string }): string {
  for (const key of [meta.transcriptPath, meta.sessionId, meta.tty, meta.cwd]) {
    if (!key) continue
    const hit = states.get(key)
    if (hit?.lastModel) return hit.lastModel
  }
  // Fall back to a scan: a state can be keyed by its transcript path while the
  // caller only knows the tty (the record migrates as identity strengthens).
  for (const st of states.values()) {
    if (!st.lastModel) continue
    if (meta.sessionId && st.sessionId === meta.sessionId) return st.lastModel
    if (meta.tty && st.tty === meta.tty) return st.lastModel
  }
  return ""
}

// The model off the newest assistant message in a transcript on disk, read
// straight from the file. `lastModel` above only fills in once this process has
// read a delta for that session, so on a freshly started server — every deploy —
// an idle session would have no model until it next answered. This is the
// one-shot backfill for that case; the delta reader keeps it current after.
//
// Bounded tail read: transcripts run to megabytes and we only need the last
// assistant line. A truncated first line just fails JSON.parse and is skipped.
export function modelFromTranscript(path: string, tailBytes = 131_072): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - tailBytes)
    const len = size - start
    if (len <= 0) return ""
    const fd = openSync(path, "r")
    const buf = Buffer.alloc(len)
    try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
    const lines = buf.toString("utf8").split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line?.trim()) continue
      try {
        const entry = JSON.parse(line) as { message?: { model?: string } }
        const model = entry.message?.model
        if (isRealModel(model)) return model
      } catch { /* partial or non-JSON line */ }
    }
  } catch { /* no transcript on disk */ }
  return ""
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
// unbounded. Same match rule as the feed prune. Returns the records it
// dropped so activity.ts can tell whether any of them held a pill WITHOUT
// re-entering getState(), which creates on miss and would resurrect them.
export function forgetStates(meta: SessionMeta): PathState[] {
  const dropped: PathState[] = []
  for (const [k, s] of states) {
    const matches =
      (meta.transcriptPath && s.transcriptPath === meta.transcriptPath) ||
      (meta.tty && s.tty === meta.tty) ||
      (meta.sessionId && s.sessionId === meta.sessionId)
    if (matches) {
      states.delete(k)
      dropped.push(s)
    }
  }
  return dropped
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

  const entries = parseEntries(raw)
  // tool_use id → name/input, built in the same pass; a tool_result always
  // follows its tool_use in the file, so it is known by the time we need it.
  const toolUses: ToolUses = new Map()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Record<string, unknown>

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

    // Model id rides the same assistant message as usage above.
    const model = (entry.message as { model?: string } | undefined)?.model
    if (isRealModel(model)) s.lastModel = model

    const content = (entry.message as { content?: unknown })?.content
    if (!Array.isArray(content)) continue
    const blocks = content as Array<Record<string, unknown>>

    // Images ride tool_result blocks inside `user` entries. Not counted in the
    // return value and never set streamedThisTurn — the turn-end retry and
    // wrap-up policy stay text-only.
    if (entry.type === "user") {
      scanToolResultImages(s, blocks, toolUses, opts)
      continue
    }
    if (entry.type !== "assistant") continue

    for (const block of blocks) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        toolUses.set(block.id, { name: String(block.name ?? ""), input: block.input })
        continue
      }
      if (block.type === "thinking") {
        emitThinking(s, block, entry, entries[i + 1], opts)
        continue
      }
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
      scanMarkdownImages(s, text)
    }
  }
  return emitted
}

function parseEntries(raw: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (entry && typeof entry === "object") out.push(entry as Record<string, unknown>)
    } catch { /* skip malformed line */ }
  }
  return out
}

// ── Thinking in the feed (RES-L5NG step 4) ──

const THINKING_MAX = 4000

// One `assistant_thinking` event per distinct thinking block. Like images it
// is not counted and never sets streamedThisTurn — turn-end policy stays
// text-only. `redacted_thinking` blocks never reach here (type differs).
function emitThinking(
  s: PathState,
  block: Record<string, unknown>,
  entry: Record<string, unknown>,
  next: Record<string, unknown> | undefined,
  opts: { silent?: boolean },
): void {
  const text = typeof block.thinking === "string" ? block.thinking.trim() : ""
  if (!text) return
  const key = `think:${hashText(text)}`
  if (s.seenAssistantText.has(key)) return
  s.seenAssistantText.add(key)
  if (opts.silent) return
  const durationMs = gapMs(entry, next)
  appendFeedEvent({
    id: crypto.randomUUID(),
    ts: Date.now(),
    kind: "assistant_thinking",
    text: clampLong(text, THINKING_MAX),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...identityFor(s),
  })
}

// Gap between two transcript entries' ISO timestamps; undefined unless both
// parse and the gap is non-negative.
function gapMs(
  a: Record<string, unknown>,
  b: Record<string, unknown> | undefined,
): number | undefined {
  if (!b || typeof a.timestamp !== "string" || typeof b.timestamp !== "string") return undefined
  const from = Date.parse(a.timestamp)
  const to = Date.parse(b.timestamp)
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return undefined
  return to - from
}

// ── Images in the feed (RES-L5NG step 3) ──

type ToolUses = Map<string, { name: string; input: unknown }>

const CAPTION_MAX = 140
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g
const MD_IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
const MD_MAX_BYTES = 20 * 1024 * 1024

// Queue one image: the seen key is already marked, `ts` is the detection time
// (the event sorts by when the tool returned, not when the encode finished),
// and the id `img:<seenKey>` makes a re-append an idempotent no-op.
export function queueImage(
  s: PathState,
  seenKey: string,
  store: () => Promise<StoreResult>,
  fields: { tool?: string; caption: string },
): void {
  const ts = Date.now()
  const ident = identityFor(s)
  void store()
    .then((ref) => {
      // Saturated encode queue: forget the mark so the next tick re-detects
      // and retries the image instead of losing it.
      if (ref === "busy") { s.seenImages.delete(seenKey); return }
      if (!ref) return
      appendFeedEvent({
        id: `img:${seenKey}`,
        ts,
        kind: "image",
        mediaId: ref.mediaId,
        width: ref.width,
        height: ref.height,
        ...(fields.tool ? { tool: fields.tool } : {}),
        caption: fields.caption,
        ...ident,
      })
    })
    .catch(() => { /* store logs its own failures */ })
}

function clampCaption(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= CAPTION_MAX ? flat : flat.slice(0, CAPTION_MAX - 1) + "…"
}

// Caption: the Read input's basename, else the first sibling text block,
// else the tool name.
function captionFor(tool: { name: string; input: unknown } | undefined, siblings: Array<Record<string, unknown>>): string {
  const filePath = (tool?.input as { file_path?: unknown } | undefined)?.file_path
  if (tool?.name === "Read" && typeof filePath === "string" && filePath) return basename(filePath)
  for (const b of siblings) {
    const text = b.type === "text" && typeof b.text === "string" ? b.text.trim() : ""
    if (text) return clampCaption(text)
  }
  return tool?.name || "image"
}

function scanToolResultImages(
  s: PathState,
  blocks: Array<Record<string, unknown>>,
  toolUses: ToolUses,
  opts: { silent?: boolean },
): void {
  for (const block of blocks) {
    if (block.type !== "tool_result" || !Array.isArray(block.content)) continue
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : ""
    if (!toolUseId) continue
    const inner = block.content as Array<Record<string, unknown>>
    inner.forEach((item, idx) => {
      const source = item?.type === "image" ? (item.source as Record<string, unknown> | undefined) : undefined
      if (source?.type !== "base64" || typeof source.data !== "string") return
      const seenKey = `tu:${toolUseId}:${idx}`
      if (s.seenImages.has(seenKey)) return
      s.seenImages.add(seenKey)
      if (opts.silent) return
      const tool = toolUses.get(toolUseId)
      const data = source.data
      queueImage(s, seenKey, () => storeImageBase64(data), {
        tool: tool?.name || undefined,
        caption: captionFor(tool, inner),
      })
    })
  }
}

// `![alt](path)` in a freshly emitted assistant text block. Absolute or
// cwd-relative, image extensions only, must exist, 20 MB max.
function scanMarkdownImages(s: PathState, text: string): void {
  if (!text.includes("![")) return
  for (const m of text.matchAll(MD_IMAGE)) {
    const alt = (m[1] ?? "").trim()
    const ref = m[2] ?? ""
    if (!MD_IMAGE_EXT.test(ref) || ref.includes("://")) continue
    if (!isAbsolute(ref) && !s.cwd) continue
    let real: string
    let mtimeMs: number
    try {
      real = realpathSync(isAbsolute(ref) ? ref : join(s.cwd, ref))
      const st = statSync(real)
      if (!st.isFile() || st.size > MD_MAX_BYTES) continue
      mtimeMs = st.mtimeMs
    } catch { continue }
    const seenKey = `md:${real}:${mtimeMs}`
    if (s.seenImages.has(seenKey)) continue
    s.seenImages.add(seenKey)
    queueImage(s, seenKey, () => storeImageFile(real), {
      caption: clampCaption(alt || basename(real)),
    })
  }
}

export function hashText(s: string): string {
  // Cheap stable key — we only need to dedupe within a single turn.
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return `${s.length}:${h}`
}
