import {
  DashboardKeyMissing, DashboardUnreachable, type DashReply, createNote, fetchInboxAudio, finalizeRecording,
  getInboxEntry, getNote, listInbox, listNotesLite, patchInbox, postRecordingChunk, startRecording, transcribeInbox,
} from "./dashboard-client"
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { companionDbPath } from "./db-path"
import { companionLog } from "./log"

// Voice memos in Quick Capture (Jeremie, 2026-10-05), store host side. Audio
// storage + Deepgram live in tls-dashboard-v2 (inbox_entries.audio_blob); a
// memo is an inbox row with type_hint "voice-memo", pending until Jeremie
// validates it on the phone → a meetings/ note, or discards it. The audio blob
// is never deleted. Never logged: transcripts, titles, audio, the key.

export const VOICE_HINT = "voice-memo"
export const CHUNK_MAX_BYTES = 512 * 1024
export const TRANSCRIPT_MAX = 50_000
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024
const TITLE_MAX = 200
const PROJECT_MAX = 200
const MIME_MAX = 100
const SEQ_MAX = 100_000
const PLACEHOLDER = /^\[voice note:[^\]]*\]\s*/
const REF_CODE = /^[A-Z]{2,5}-[A-Z0-9]{3,8}$/i
const POLL_MS = 1_000

export type VoiceStatus = "pending" | "validated" | "discarded"
export interface VoiceMemo { id: number; filename: string; created_at: string; transcript: string | null; status: VoiceStatus; note_id: string | null }
export interface ProjectRef { id: string; ref_code: string | null; title: string }
export type Outcome =
  | { ok: true; body: Record<string, unknown> & { ok: true } }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> }

interface Entry {
  id: number; raw_text: string; type_hint: string; processed: number; result_id: string
  created_at: string; audio_filename: string | null; audio_bytes: number | null
}

const fail = (status: number, error: string, extra?: Record<string, unknown>): Outcome => ({ ok: false, status, error, ...(extra ? { extra } : {}) })
const done = (body: Record<string, unknown>): Outcome => ({ ok: true, body: { ok: true, ...body } })

/** Dashboard key / reachability errors → the contract's 503 / 502. */
async function guarded(fn: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof DashboardKeyMissing) return fail(503, "dashboard_key_missing")
    if (e instanceof DashboardUnreachable) return fail(502, "dashboard_unreachable")
    throw e
  }
}

/** raw_text minus the `[voice note: …]` marker; null while untranscribed. */
export function transcriptOf(raw: string): string | null {
  const t = raw.replace(PLACEHOLDER, "").trim()
  return t ? t : null
}

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) → ISO 8601 `…Z`; anything else as-is. */
export function isoUtc(sqlite: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlite) ? `${sqlite.replace(" ", "T")}Z` : sqlite
}

function toEntry(v: Record<string, unknown>): Entry {
  const bytes = v.audio_bytes
  return {
    id: Number(v.id), raw_text: String(v.raw_text ?? ""), type_hint: String(v.type_hint ?? ""),
    processed: Number(v.processed ?? 0), result_id: String(v.result_id ?? ""), created_at: String(v.created_at ?? ""),
    audio_filename: typeof v.audio_filename === "string" && v.audio_filename ? v.audio_filename : null,
    audio_bytes: typeof bytes === "number" ? bytes : null,
  }
}

export function toMemo(e: Entry): VoiceMemo {
  const status: VoiceStatus = !e.processed ? "pending" : e.result_id === "discarded" ? "discarded" : "validated"
  return {
    id: e.id, filename: e.audio_filename ?? "", created_at: isoUtc(e.created_at),
    transcript: transcriptOf(e.raw_text), status, note_id: status === "validated" && e.result_id ? e.result_id : null,
  }
}

// ── On-device transcripts ──
// One-shot uploads carry the iPhone's own transcript. The dashboard has no way
// to store it (its finalize auto-runs Deepgram into raw_text), so it lives
// here, keyed by inbox id, and wins over raw_text when a memo is read.

let tdb: Database | null = null
function transcripts(): Database {
  if (tdb) return tdb
  const path = companionDbPath()
  mkdirSync(dirname(path), { recursive: true })
  tdb = new Database(path)
  tdb.exec("PRAGMA busy_timeout = 3000") // companion.db is shared with other stores
  tdb.exec("CREATE TABLE IF NOT EXISTS voice_memo_transcripts (inbox_id INTEGER PRIMARY KEY, transcript TEXT NOT NULL, created_at INTEGER NOT NULL)")
  return tdb
}

function deviceTranscript(id: number): string | null {
  const row = transcripts().query("SELECT transcript FROM voice_memo_transcripts WHERE inbox_id = ?").get(id) as { transcript: string } | null
  return row?.transcript || null
}

// Best-effort: called after an irreversible dashboard step, so a local SQLite
// error must never turn a committed upload/validation into an error reply.
function saveTranscript(id: number, transcript: string): boolean {
  try {
    transcripts().query("INSERT OR REPLACE INTO voice_memo_transcripts (inbox_id, transcript, created_at) VALUES (?, ?, ?)").run(id, transcript, Date.now())
    return true
  } catch {
    companionLog(`voice #${id} transcript store failed`)
    return false
  }
}

function dropTranscript(id: number): void {
  try { transcripts().query("DELETE FROM voice_memo_transcripts WHERE inbox_id = ?").run(id) } catch { /* orphan row is harmless */ }
}

function withDeviceTranscript(m: VoiceMemo): VoiceMemo {
  let t: string | null = null
  try { t = deviceTranscript(m.id) } catch { companionLog(`voice #${m.id} transcript read failed`) }
  return t ? { ...m, transcript: t } : m
}

// ISO-BMFF major brands that hold audio. mp42/isom are generic (a voice
// memo may carry them); qt/heic/heix/mif1/msf1 (video, images) are refused.
const AUDIO_BRANDS = ["M4A ", "M4B ", "M4P ", "mp42", "isom"]

/** Container from the first bytes — the client's declared type is not trusted. */
export function sniffAudio(b: Uint8Array): string | null {
  const ascii = (at: number, s: string): boolean => [...s].every((c, i) => b[at + i] === c.charCodeAt(0))
  if (b.length < 12) return null
  if (ascii(4, "ftyp")) return AUDIO_BRANDS.some((brand) => ascii(8, brand)) ? "audio/mp4" : null
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav"
  if (ascii(0, "ID3")) return "audio/mpeg"
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return "audio/aac" // ADTS: layer bits 00
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return "audio/mpeg" // MPEG frame sync
  return null
}

/** GET /api/inbox/:id on the dashboard → the row, or the contract error. */
async function memoEntry(id: number): Promise<{ entry: Entry } | { error: Outcome }> {
  const r = await getInboxEntry(id)
  const raw = r.json?.entry
  if (r.status === 200 && raw && typeof raw === "object") {
    const entry = toEntry(raw as Record<string, unknown>)
    if (entry.type_hint !== VOICE_HINT) return { error: fail(400, "not_voice_memo") }
    return { entry }
  }
  if (r.status === 404 && r.json?.ok === false) return { error: fail(404, "not_found") }
  companionLog(`voice #${id} entry read refused (HTTP ${r.status})`)
  return { error: fail(502, "dashboard_error") }
}

/** Exact decoded size of base64 (optionally a data: URL); null = not base64. */
export function base64Size(raw: string): number | null {
  const b64 = raw.replace(/^data:[^;,]*;base64,/, "")
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  return (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0)
}

function waitMs(): number {
  const n = Number(process.env.COMPANION_VOICE_TRANSCRIPT_WAIT_MS)
  return Number.isFinite(n) && n >= 0 ? n : 20_000
}

function clean(s: string, max: number): string {
  return s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

function okReply(r: DashReply): boolean {
  return r.status === 200 && r.json?.ok === true
}

// ── Upload ──

export function voiceStart(body: Record<string, unknown>): Promise<Outcome> {
  const mime = typeof body.mime === "string" ? body.mime.trim().toLowerCase() : ""
  if (!mime.startsWith("audio/") || mime.length > MIME_MAX || !/^audio\/[a-z0-9.+-]+(;[ a-z0-9=.+-]*)?$/.test(mime)) return Promise.resolve(fail(400, "bad_mime"))
  return guarded(async () => {
    const r = await startRecording(mime, VOICE_HINT)
    const id = r.json?.id
    const filename = r.json?.filename
    if (!okReply(r) || typeof id !== "number" || typeof filename !== "string") {
      companionLog(`voice start refused (HTTP ${r.status})`)
      return fail(502, "dashboard_error")
    }
    companionLog(`voice start → #${id}`)
    return done({ id, filename })
  })
}

export function voiceChunk(id: number, body: Record<string, unknown>): Promise<Outcome> {
  const seq = body.seq
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > SEQ_MAX) return Promise.resolve(fail(400, "bad_seq"))
  const audio = typeof body.audio === "string" ? body.audio : ""
  if (!audio) return Promise.resolve(fail(400, "audio_required"))
  const size = base64Size(audio)
  if (size === null) return Promise.resolve(fail(400, "bad_base64"))
  if (size > CHUNK_MAX_BYTES) return Promise.resolve(fail(413, "chunk_too_large", { message: `max ${CHUNK_MAX_BYTES} bytes per chunk` }))
  if (size === 0) return Promise.resolve(fail(400, "audio_required"))
  return guarded(async () => {
    const got = await memoEntry(id)
    if ("error" in got) return got.error
    // A chunk landing after finalize would make a later finalize rebuild the
    // blob from that chunk alone — i.e. destroy the recording.
    if (got.entry.audio_bytes !== null) return fail(409, "already_finalized")
    const r = await postRecordingChunk(id, seq, audio)
    if (!okReply(r)) {
      companionLog(`voice #${id} chunk ${seq} refused (HTTP ${r.status})`)
      return fail(502, "dashboard_error")
    }
    return done({ seq, bytes: typeof r.json?.bytes === "number" ? r.json.bytes : size })
  })
}

/** Poll the row until the dashboard's own post-finalize Deepgram run lands (no second Deepgram call). */
async function awaitTranscript(id: number): Promise<string | null> {
  const deadline = Date.now() + waitMs()
  for (;;) {
    const got = await memoEntry(id).catch(() => null)
    if (got && "entry" in got) {
      const t = transcriptOf(got.entry.raw_text)
      if (t !== null) return t
    }
    if (Date.now() + POLL_MS > deadline) return null
    await Bun.sleep(POLL_MS)
  }
}

export function voiceFinalize(id: number): Promise<Outcome> {
  return guarded(async () => {
    const got = await memoEntry(id)
    if ("error" in got) return got.error
    const r = await finalizeRecording(id)
    if (r.status === 409) return fail(409, "missing_chunks", { have: Array.isArray(r.json?.have) ? r.json.have : [] })
    if (r.status === 400) return fail(400, "no_chunks")
    if (r.status === 404) return fail(404, "not_found")
    if (!okReply(r)) {
      companionLog(`voice #${id} finalize refused (HTTP ${r.status})`)
      return fail(502, "dashboard_error")
    }
    let bytes = typeof r.json?.bytes === "number" ? r.json.bytes : null
    if (bytes === null) { // already finalized: the reply carries no size
      const again = await memoEntry(id)
      bytes = "entry" in again ? again.entry.audio_bytes ?? 0 : 0
    }
    const transcript = await awaitTranscript(id)
    companionLog(`voice #${id} finalized (${bytes} B, transcript ${transcript === null ? "pending" : "ready"})`)
    return done({ bytes, transcript })
  })
}

export function voiceTranscribe(id: number): Promise<Outcome> {
  return guarded(async () => {
    const got = await memoEntry(id)
    if ("error" in got) return got.error
    let r: DashReply
    try {
      r = await transcribeInbox(id)
    } catch (e) {
      // The dashboard answers a Deepgram failure / empty transcript with a 5xx.
      if (e instanceof DashboardUnreachable && e.status >= 500) return fail(502, "transcribe_failed")
      throw e
    }
    if (r.status === 400) return fail(409, "not_finalized")
    if (r.status === 404) return fail(404, "not_found")
    const raw = r.json?.transcript
    if (!okReply(r) || typeof raw !== "string") {
      companionLog(`voice #${id} transcribe refused (HTTP ${r.status})`)
      return fail(502, "transcribe_failed")
    }
    const transcript = transcriptOf(raw)
    if (transcript !== null && !got.entry.processed) dropTranscript(id) // the fresh run wins over the stale on-device text; a validated memo keeps what was validated
    return done({ transcript })
  })
}

/**
 * One-shot upload: the whole file + the on-device transcript. Same dashboard
 * store as the chunked flow (start → 512 KB chunks → finalize), so the memo is
 * an ordinary pending voice-memo row afterwards.
 */
export function voiceUpload(bytes: Uint8Array, transcriptRaw: string): Promise<Outcome> {
  if (bytes.byteLength === 0) return Promise.resolve(fail(400, "audio_required"))
  if (bytes.byteLength > UPLOAD_MAX_BYTES) return Promise.resolve(fail(400, "audio_too_large", { message: `max ${UPLOAD_MAX_BYTES} bytes` }))
  const mime = sniffAudio(bytes)
  if (!mime) return Promise.resolve(fail(400, "bad_audio_type", { message: "m4a, aac, wav or mp3" }))
  const transcript = transcriptRaw.trim()
  if (transcript.length > TRANSCRIPT_MAX) return Promise.resolve(fail(400, "transcript_too_long", { message: `max ${TRANSCRIPT_MAX} characters` }))
  return guarded(async () => {
    const s = await startRecording(mime, VOICE_HINT)
    const id = s.json?.id
    const filename = s.json?.filename
    if (!okReply(s) || typeof id !== "number" || typeof filename !== "string") {
      companionLog(`voice upload start refused (HTTP ${s.status})`)
      return fail(502, "dashboard_error")
    }
    // Any failure past start → discard the row, so no audio-less memo sits pending.
    const abandon = async (): Promise<void> => { await patchInbox(id, "discarded").catch(() => null) }
    try {
      for (let seq = 0, off = 0; off < bytes.byteLength; seq++, off += CHUNK_MAX_BYTES) {
        const c = await postRecordingChunk(id, seq, Buffer.from(bytes.subarray(off, off + CHUNK_MAX_BYTES)).toString("base64"))
        if (!okReply(c)) throw new DashboardUnreachable(c.status, `chunk ${seq}`)
      }
      const f = await finalizeRecording(id)
      if (!okReply(f)) throw new DashboardUnreachable(f.status, "finalize")
    } catch (e) {
      companionLog(`voice upload #${id} refused mid-way, discarded`)
      await abandon()
      throw e
    }
    const stored = transcript ? saveTranscript(id, transcript) : true
    companionLog(`voice upload → #${id} (${bytes.byteLength} B, ${mime})`)
    return done({ id, filename, bytes: bytes.byteLength, status: "pending", transcript: transcript && stored ? transcript : null })
  })
}

// ── Review ──

export function voiceList(status: string): Promise<Outcome> {
  if (status !== "pending") return Promise.resolve(fail(400, "bad_status"))
  return guarded(async () => {
    const r = await listInbox()
    if (r.status !== 200 || !Array.isArray(r.value)) return fail(502, "dashboard_error")
    const items = (r.value as unknown[])
      .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
      .map(toEntry)
      .filter((e) => e.type_hint === VOICE_HINT && !e.processed)
      .map((e) => withDeviceTranscript(toMemo(e)))
    return done({ items })
  })
}

export function voiceGet(id: number): Promise<Outcome> {
  return guarded(async () => {
    const got = await memoEntry(id)
    return "error" in got ? got.error : done({ item: withDeviceTranscript(toMemo(got.entry)) })
  })
}

export type AudioOutcome = { ok: true; bytes: Uint8Array; mime: string } | { ok: false; status: number; error: string }

export async function voiceAudio(id: number): Promise<AudioOutcome> {
  let filename: string | null = null
  const out = await guarded(async () => {
    const got = await memoEntry(id)
    if ("error" in got) return got.error
    if (!got.entry.audio_filename) return fail(404, "not_found")
    filename = got.entry.audio_filename
    return done({})
  })
  if (!out.ok) return out
  try {
    const got = await fetchInboxAudio(filename!)
    return got ? { ok: true, ...got } : { ok: false, status: 404, error: "not_found" }
  } catch (e) {
    if (e instanceof DashboardKeyMissing) return { ok: false, status: 503, error: "dashboard_key_missing" }
    if (e instanceof DashboardUnreachable) return { ok: false, status: 502, error: "dashboard_unreachable" }
    throw e
  }
}

/** Local calendar date + HH:MM of the memo (the dashboard stamps UTC). */
function localStamp(createdAt: string): { date: string; time: string } {
  const d = new Date(isoUtc(createdAt))
  const at = Number.isNaN(d.getTime()) ? new Date() : d
  const pad = (n: number): string => String(n).padStart(2, "0")
  return { date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}` }
}

async function resolveProject(raw: string): Promise<string | null> {
  const r = await getNote(REF_CODE.test(raw) ? { ref: raw.toUpperCase() } : { id: raw })
  const id = r.json?.id
  if (r.status !== 200 || typeof id !== "string") return null
  const ref = r.json?.ref_code
  return typeof ref === "string" && ref ? ref : id
}

export function voiceValidate(id: number, body: Record<string, unknown>): Promise<Outcome> {
  if (typeof body.transcript !== "string" || !body.transcript.trim()) return Promise.resolve(fail(400, "transcript_required"))
  const transcript = body.transcript.trim()
  if (transcript.length > TRANSCRIPT_MAX) return Promise.resolve(fail(413, "transcript_too_long", { message: `max ${TRANSCRIPT_MAX} characters` }))
  if (body.title !== undefined && body.title !== null && typeof body.title !== "string") return Promise.resolve(fail(400, "bad_title"))
  if (body.project !== undefined && body.project !== null && typeof body.project !== "string") return Promise.resolve(fail(400, "bad_project"))
  const title = clean(typeof body.title === "string" ? body.title : "", TITLE_MAX)
  const project = clean(typeof body.project === "string" ? body.project : "", PROJECT_MAX)
  if (project.includes("..")) return Promise.resolve(fail(400, "bad_project"))
  return guarded(async () => {
    const got = await memoEntry(id)
    if ("error" in got) return got.error
    const e = got.entry
    if (e.processed) {
      if (e.result_id === "discarded") return fail(409, "already_discarded")
      // A retry only re-stores a write lost after the first commit — never overwrites what was validated.
      let stored: string | null = null
      try { stored = deviceTranscript(id) } catch { /* treat as missing */ }
      if (stored === null) saveTranscript(id, transcript)
      return done({ note_id: e.result_id })
    }
    if (e.audio_bytes === null || !e.audio_filename) return fail(409, "not_finalized")
    const projectRef = project ? await resolveProject(project) : null
    if (project && !projectRef) return fail(400, "unknown_project")

    const at = localStamp(e.created_at)
    const audioUrl = `/api/inbox/audio/${encodeURIComponent(e.audio_filename)}`
    const lines = [...(projectRef ? [`Projet: ${projectRef}`, ""] : []), transcript, "", "---", `Audio: [${e.audio_filename}](${audioUrl})`]
    const r = await createNote({
      folder: "meetings",
      title: title || `Voice memo ${at.time}`,
      date: at.date,
      tags: ["voice-memo", "meeting", ...(projectRef ? [projectRef] : [])],
      body: `${lines.join("\n")}\n`,
      meta: {
        source: "companion-voice-memo", inbox_id: id, audio_filename: e.audio_filename, audio_url: audioUrl,
        ...(projectRef ? { project: projectRef } : {}),
      },
    })
    const noteId = r.json?.id
    if (!okReply(r) || typeof noteId !== "string") {
      companionLog(`voice #${id} note create refused (HTTP ${r.status})`)
      return fail(502, "dashboard_error")
    }
    // The note exists from here on: a failed mark must say which note, so a
    // retry doesn't look like nothing happened.
    const marked = await patchInbox(id, noteId).catch(() => null)
    if (!marked || !okReply(marked)) {
      companionLog(`voice #${id} → ${noteId} but inbox mark failed`)
      return fail(502, "mark_failed", { note_id: noteId })
    }
    saveTranscript(id, transcript) // GET /:id shows what was validated, not the first draft
    companionLog(`voice #${id} validated → ${noteId}`)
    return done({ note_id: noteId })
  })
}

export function voiceDiscard(id: number): Promise<Outcome> {
  return guarded(async () => {
    const got = await memoEntry(id)
    if ("error" in got) return got.error
    if (got.entry.processed) return got.entry.result_id === "discarded" ? done({}) : fail(409, "already_validated")
    const r = await patchInbox(id, "discarded")
    if (!okReply(r)) return fail(502, "dashboard_error")
    dropTranscript(id)
    companionLog(`voice #${id} discarded (audio kept)`)
    return done({})
  })
}

// ── Project picker ──

export function voiceProjects(): Promise<Outcome> {
  return guarded(async () => {
    const r = await listNotesLite()
    if (r.status !== 200 || !Array.isArray(r.value)) return fail(502, "dashboard_error")
    const items: ProjectRef[] = (r.value as unknown[])
      .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
      .filter((n) => n.folder === "projects" && n.status === "active" && typeof n.id === "string")
      .map((n) => ({ id: String(n.id), ref_code: typeof n.ref_code === "string" && n.ref_code ? n.ref_code : null, title: String(n.title ?? n.id) }))
      .sort((a, b) => a.title.localeCompare(b.title, "fr"))
    return done({ items })
  })
}
