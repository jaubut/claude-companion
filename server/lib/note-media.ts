import { readFileSync } from "node:fs"
import type { ReferencedNote } from "./canvas"
import { isMediaId, mediaPath, storeImageFile } from "./media"
import { sentFilePath } from "./sent-files"
import type { QueryFn } from "./turso"
import { deviceTranscript, transcriptOf, VOICE_HINT } from "./voice-memo"

// Rich notes as context (PRJ-FL49 Phase 2): a linked note's attachments, resolved at read time
// next to its Phase 1 text. A note has no attachment schema: an attachment is a link in the
// note's text to a store this server owns —
//   /api/media/<id>          → the media store's JPEG (≤1024px)               → image block
//   /api/files/<id>/<name>   → a SendUserFile copy, image extensions only,
//                              downscaled through the media store              → image block
//   /api/inbox/audio/<file>  → a voice memo; its Deepgram transcript (Turso
//                              inbox_entries.raw_text, written by the dashboard) → text block
// Any other path or URL is never followed: no file read outside the stores.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }

export const NOTE_MEDIA_MAX_IMAGES = 4
/** Total bytes of base64 image data + transcript text per note. */
export const NOTE_MEDIA_MAX_BYTES = 4 * 1024 * 1024

const LINK = /\/api\/(?:media\/([a-f0-9]{32})|files\/([a-f0-9]{32})\/[^\s)"'<>\]]+|inbox\/audio\/([^\s)"'<>\]]+))/g
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic)$/i

type Attachment = { image: string } | { file: string } | { audio: string }

function attachments(text: string): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const m of text.matchAll(LINK)) {
    const key = m[0]
    if (seen.has(key)) continue
    seen.add(key)
    if (m[1]) out.push({ image: m[1] })
    else if (m[2]) out.push({ file: m[2] })
    else if (m[3]) {
      let file = ""
      try { file = decodeURIComponent(m[3]) } catch { continue }
      out.push({ audio: file })
    }
  }
  return out
}

// null = dangling or unreadable (skipped); "busy" = the media encode queue is full (counted as omitted).
async function imageData(a: { image: string } | { file: string }): Promise<string | null | "busy"> {
  let id = "image" in a ? a.image : ""
  if ("file" in a) {
    const f = sentFilePath(a.file)
    // ponytail: a non-image sent file (zip, pdf, audio) is not context; transcribe sent audio if one needs it.
    if (!f || !IMAGE_NAME.test(f.name)) return null
    const ref = await storeImageFile(f.path)
    if (!ref || ref === "busy") return ref
    id = ref.mediaId
  }
  if (!isMediaId(id)) return null
  try { return readFileSync(mediaPath(id)).toString("base64") } catch { return null }
}

// The iPhone's on-device transcript wins over the dashboard's Deepgram one, as in voice-memo.ts.
// ponytail: a memo with neither (Deepgram still running or failed) is skipped; this read never
// starts a transcription — POST /api/capture/voice/:id/transcribe does.
async function transcript(file: string, query: QueryFn): Promise<string | null> {
  const [row] = await query("SELECT id, raw_text FROM inbox_entries WHERE audio_filename = ? AND type_hint = ? ORDER BY id DESC LIMIT 1", [file, VOICE_HINT])
  if (!row) return null
  let device: string | null = null
  try { device = deviceTranscript(Number(row.id)) } catch { /* companion.db busy: fall back to Deepgram's */ }
  return device ?? (typeof row.raw_text === "string" ? transcriptOf(row.raw_text) : null)
}

/**
 * The note's context as content blocks: its Phase 1 text first, then each attachment in the
 * order it appears, up to the per-note cap. Over the cap, the rest are counted in `omitted` and
 * named in a last text block. A note with no attachments is exactly `[{ text: body }]` (no block
 * for an empty body: the Messages API refuses empty text blocks).
 * ponytail: links are read from the body readReferences returns, clipped at 32k; a link past the clip is not seen.
 */
export async function noteContextBlocks(note: ReferencedNote, query: QueryFn): Promise<{ content: ContentBlock[]; omitted: number }> {
  const content: ContentBlock[] = note.body ? [{ type: "text", text: note.body }] : []
  let images = 0
  let bytes = 0
  let omitted = 0
  for (const a of attachments(note.body)) {
    if ("audio" in a) {
      const t = await transcript(a.audio, query)
      if (!t || note.body.includes(t.slice(0, 200))) continue // untranscribed, or already in the note (a validated voice memo)
      const text = `Voice memo ${a.audio} transcript: «${t.replace(/[«»]/g, '"')}»`
      if (bytes + text.length > NOTE_MEDIA_MAX_BYTES) { omitted++; continue }
      bytes += text.length
      content.push({ type: "text", text })
      continue
    }
    if (images >= NOTE_MEDIA_MAX_IMAGES) { omitted++; continue }
    const data = await imageData(a)
    if (data === "busy") { omitted++; continue }
    if (!data) continue
    if (bytes + data.length > NOTE_MEDIA_MAX_BYTES) { omitted++; continue }
    images++
    bytes += data.length
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })
  }
  if (omitted) content.push({ type: "text", text: `${omitted} attachment${omitted === 1 ? "" : "s"} omitted (per-note cap: ${NOTE_MEDIA_MAX_IMAGES} images, ${NOTE_MEDIA_MAX_BYTES / 1024 / 1024} MB).` })
  return { content, omitted }
}
