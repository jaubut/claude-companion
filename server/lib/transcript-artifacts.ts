import { basename, isAbsolute, join } from "node:path"
import { appendFeedEvent, type FeedEvent } from "./feed"
import { artifactKey, detectArtifacts } from "./artifacts"
import { storeImageFile } from "./media"
import { storeSentFile } from "./sent-files"
import type { ToolUses } from "./transcript-cursor"

// ── Artifacts in the feed (Phase 19 step 3, RES-B9CL) ──
// Moved out of transcript.ts (600-line cap). transcript.ts passes the session
// identity in, so this module never imports it back.
//
// SendUserFile (t-server-filecards-1): the files a session sent are copied into
// lib/sent-files.ts and announced as file artifacts carrying `url`
// (`/api/files/<id>/<name>`) and, for images, `mediaId/width/height` — the
// fields iOS #188 renders as a thumbnail / Quick Look download. A refused file
// (secret, > 50 MB) keeps a path-only card.

export interface ArtifactState {
  cwd: string
  // `art:<kind>:<url|ref|path>` per announced artifact, `tr:<tool_use_id>` per
  // scanned tool_result. Marked synchronously, before any async copy.
  seenArtifacts: Set<string>
}

type Ident = Pick<FeedEvent, "cwd" | "tty" | "sessionId">

// Bash output can be megabytes; artifacts worth a card sit near the top.
const ARTIFACT_SCAN_MAX = 100_000
const THUMB_EXT = /\.(?:png|jpe?g|gif|webp|heic)$/i

// One `artifact` event per distinct artifact per session. Like images and
// thinking: never counted, never sets streamedThisTurn; a silent read marks
// the seen keys without emitting.
export function emitArtifacts(s: ArtifactState, ident: Ident, text: string, tool: string | undefined, opts: { silent?: boolean }): void {
  for (const a of detectArtifacts(text.slice(0, ARTIFACT_SCAN_MAX))) {
    const seenKey = artifactKey(a)
    if (s.seenArtifacts.has(seenKey)) continue
    s.seenArtifacts.add(seenKey)
    if (opts.silent) continue
    appendFeedEvent({
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind: "artifact",
      artifactKind: a.kind,
      title: a.title,
      ...(a.url ? { url: a.url } : {}),
      ...(a.path ? { path: a.path } : {}),
      ...(a.ref ? { ref: a.ref } : {}),
      ...(tool ? { tool } : {}),
      ...ident,
    })
  }
}

// tool_result content is a string or an array of blocks; only text counts.
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const item of content as Array<Record<string, unknown>>) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text)
  }
  return parts.join("\n")
}

export function scanToolResultArtifacts(
  s: ArtifactState,
  ident: Ident,
  blocks: Array<Record<string, unknown>>,
  toolUses: ToolUses,
  opts: { silent?: boolean },
): void {
  for (const block of blocks) {
    if (block.type !== "tool_result") continue
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : ""
    if (!toolUseId) continue
    const scannedKey = `tr:${toolUseId}`
    if (s.seenArtifacts.has(scannedKey)) continue
    s.seenArtifacts.add(scannedKey)
    const text = toolResultText(block.content)
    const tool = toolUses.get(toolUseId)
    if (tool?.name === "SendUserFile") {
      if (block.is_error !== true) emitSentFiles(s, ident, toolUseId, tool.input, text, opts)
      continue
    }
    if (!text) continue
    emitArtifacts(s, ident, text, tool?.name || undefined, opts)
  }
}

// The input files the result says were delivered — all of them when none of
// their paths appear (Claude Code changed its result format).
function deliveredFiles(s: ArtifactState, input: unknown, text: string): string[] {
  const raw = (input as { files?: unknown } | undefined)?.files
  const files = (Array.isArray(raw) ? raw : [])
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .map((f) => (isAbsolute(f) || !s.cwd ? f : join(s.cwd, f)))
  const named = files.filter((f) => text.includes(f))
  return named.length ? named : files
}

function emitSentFiles(s: ArtifactState, ident: Ident, toolUseId: string, input: unknown, text: string, opts: { silent?: boolean }): void {
  const ts = Date.now()
  const paths = deliveredFiles(s, input, text)
  for (const path of paths) s.seenArtifacts.add(`art:file:${path}`) // later text naming it adds no path-only card
  if (opts.silent) return
  // All stored first, then appended in the order they were sent.
  void Promise.all(paths.map(cardFor)).then((cards) => cards.forEach((extra, i) => appendFeedEvent({
    id: `sentfile:${toolUseId}:${i}`,
    ts,
    kind: "artifact",
    artifactKind: "file",
    title: basename(paths[i]!),
    path: paths[i]!,
    tool: "SendUserFile",
    ...extra,
    ...ident,
  })))
}

// url (+ thumbnail for images, built from the COPY). Never rejects: a refused
// or failed store is a path-only card, a busy encoder a card without thumbnail.
async function cardFor(path: string): Promise<Partial<FeedEvent>> {
  const stored = await storeSentFile(path)
  if (!stored) return {}
  const url = `/api/files/${stored.id}/${encodeURIComponent(stored.name)}`
  if (!THUMB_EXT.test(stored.name)) return { url }
  const ref = await storeImageFile(stored.path).catch(() => null)
  return ref && ref !== "busy" ? { url, mediaId: ref.mediaId, width: ref.width, height: ref.height } : { url }
}
