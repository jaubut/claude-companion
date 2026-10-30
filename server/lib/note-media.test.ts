import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import type { ReferencedNote } from "./canvas"
import { companionDbPath } from "./db-path"
import { storeImageBase64 } from "./media"
import { NOTE_MEDIA_MAX_IMAGES, noteContextBlocks } from "./note-media"
import { storeSentFile } from "./sent-files"
import type { QueryFn, Row } from "./turso"

// PRJ-FL49 Phase 2: a linked note's attachments as content blocks. Real stores: the media and
// sent-files stores in a tmp dir, and Turso's real `inbox_entries` CREATE TABLE (copied from
// sqlite_master on 2026-10-30) behind the QueryFn — no fake rows.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "note-media-db-")), "test.db")

let dir = ""
const prev = { media: process.env.COMPANION_MEDIA_DIR, files: process.env.COMPANION_SENT_FILES_DIR }

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "note-media-"))
  process.env.COMPANION_MEDIA_DIR = join(dir, "media")
  process.env.COMPANION_SENT_FILES_DIR = join(dir, "sent")
})

afterAll(() => {
  for (const [k, v] of [["COMPANION_MEDIA_DIR", prev.media], ["COMPANION_SENT_FILES_DIR", prev.files]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

function inbox(): { db: Database; query: QueryFn } {
  const db = new Database(":memory:")
  db.exec(`CREATE TABLE inbox_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, raw_text TEXT NOT NULL, type_hint TEXT DEFAULT '', processed INTEGER DEFAULT 0,
    result_id TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), processed_at TEXT DEFAULT '',
    client_slug TEXT, audio_filename TEXT, audio_blob BLOB, audio_mime TEXT DEFAULT 'audio/webm', tg_chat_id TEXT,
    origin TEXT NOT NULL DEFAULT 'unknown', quarantine TEXT)`)
  const query: QueryFn = async (sql, args) => db.query(sql).all(...(args as (string | number | null)[])) as Row[]
  return { db, query }
}

async function png(r: number): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g: 0, b: 0 } } }).png().toBuffer()
}

async function mediaId(r: number): Promise<string> {
  const ref = await storeImageBase64((await png(r)).toString("base64"))
  if (!ref || ref === "busy") throw new Error("media store refused the test image")
  return ref.mediaId
}

const note = (body: string): ReferencedNote => ({ nodeId: "n", ref: "RES-X", refCode: "RES-X", title: "T", body, source: "turso", updatedAt: "", truncated: false })

test("a note with no attachments is exactly its Phase 1 text", async () => {
  const { query } = inbox()
  const body = "Plain note, with a [link](https://example.com/a.png) and /home/x/secret.png that are never followed."
  expect(await noteContextBlocks(note(body), query)).toEqual({ content: [{ type: "text", text: body }], omitted: 0 })
})

test("one image → one image block (media store and a SendUserFile image)", async () => {
  const { query } = inbox()
  const id = await mediaId(10)
  const r = await noteContextBlocks(note(`Look: ![shot](/api/media/${id})`), query)
  expect(r.omitted).toBe(0)
  expect(r.content).toHaveLength(2)
  expect(r.content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } })
  const img = r.content[1]!
  expect(img.type === "image" && (await sharp(Buffer.from(img.source.data, "base64")).metadata()).format).toBe("jpeg")

  const p = join(dir, "photo.png")
  writeFileSync(p, await png(20))
  const sent = await storeSentFile(p)
  const zip = join(dir, "a.zip")
  writeFileSync(zip, "PK")
  const z = await storeSentFile(zip)
  const s = await noteContextBlocks(note(`[photo](/api/files/${sent!.id}/photo.png) and [zip](/api/files/${z!.id}/a.zip)`), query)
  expect(s.content.map((b) => b.type)).toEqual(["text", "image"]) // the zip is not context
})

test("an audio attachment → its transcript as a text block; untranscribed or already in the note → nothing", async () => {
  const { db, query } = inbox()
  db.query("INSERT INTO inbox_entries (raw_text, type_hint, audio_filename) VALUES (?, ?, ?)").run("[voice note: memo.m4a] call the client friday", "voice-memo", "memo.m4a")
  db.query("INSERT INTO inbox_entries (raw_text, type_hint, audio_filename) VALUES (?, ?, ?)").run("[voice note: raw.m4a]", "voice-memo", "raw.m4a")
  const r = await noteContextBlocks(note("Memo: [memo.m4a](/api/inbox/audio/memo.m4a) and [raw](/api/inbox/audio/raw.m4a)"), query)
  expect(r).toEqual({
    content: [
      { type: "text", text: "Memo: [memo.m4a](/api/inbox/audio/memo.m4a) and [raw](/api/inbox/audio/raw.m4a)" },
      { type: "text", text: "Voice memo memo.m4a transcript: «call the client friday»" },
    ],
    omitted: 0,
  })
  const validated = "call the client friday\n\n---\nAudio: [memo.m4a](/api/inbox/audio/memo.m4a)\n"
  expect((await noteContextBlocks(note(validated), query)).content).toHaveLength(1)
})

test("the iPhone's on-device transcript wins over Deepgram's", async () => {
  const { db, query } = inbox()
  const { lastInsertRowid } = db.query("INSERT INTO inbox_entries (raw_text, type_hint, audio_filename) VALUES (?, ?, ?)").run("deepgram text", "voice-memo", "dev.m4a")
  const local = new Database(companionDbPath())
  local.exec("CREATE TABLE IF NOT EXISTS voice_memo_transcripts (inbox_id INTEGER PRIMARY KEY, transcript TEXT NOT NULL, created_at INTEGER NOT NULL)")
  local.query("INSERT OR REPLACE INTO voice_memo_transcripts (inbox_id, transcript, created_at) VALUES (?, ?, ?)").run(Number(lastInsertRowid), "on-device text", 1)
  local.close()
  const r = await noteContextBlocks(note("[m](/api/inbox/audio/dev.m4a)"), query)
  expect(r.content[1]).toEqual({ type: "text", text: "Voice memo dev.m4a transcript: «on-device text»" })
})

test("an empty body gives no text block (the Messages API refuses empty ones); a dangling link is skipped", async () => {
  const { query } = inbox()
  expect(await noteContextBlocks(note(""), query)).toEqual({ content: [], omitted: 0 })
  const body = `![gone](/api/media/${"0".repeat(32)})`
  expect(await noteContextBlocks(note(body), query)).toEqual({ content: [{ type: "text", text: body }], omitted: 0 })
})

test("the per-note cap keeps the first images and records how many were dropped", async () => {
  const { query } = inbox()
  const ids = await Promise.all(Array.from({ length: NOTE_MEDIA_MAX_IMAGES + 2 }, (_, i) => mediaId(100 + i)))
  const body = ids.map((id) => `![](/api/media/${id})`).join("\n") + `\n![again](/api/media/${ids[0]})`
  const r = await noteContextBlocks(note(body), query)
  expect(r.omitted).toBe(2)
  expect(r.content.filter((b) => b.type === "image")).toHaveLength(NOTE_MEDIA_MAX_IMAGES)
  expect(r.content.at(-1)).toEqual({ type: "text", text: "2 attachments omitted (per-note cap: 4 images, 4 MB)." })
})
