import { test, expect, beforeAll, afterAll } from "bun:test"
import sharp from "sharp"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getState, readTranscriptDelta } from "./transcript"
import { onFeed, type FeedEvent } from "./feed"

// SendUserFile → file artifacts with a download url (and a thumbnail for
// images), read through the real transcript reader, real media + file stores.

const dir = mkdtempSync(join(tmpdir(), "cc-sendfile-"))
const line = (o: unknown) => JSON.stringify(o) + "\n"
let png = ""
let zip = ""
let env = ""

const send = (id: string, files: string[]) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "SendUserFile", input: { files, caption: "here", status: "normal" } }] } })
const result = (id: string, files: string[], isError = false) =>
  line({ type: "user", message: { role: "user", content: [{
    type: "tool_result", tool_use_id: id, ...(isError ? { is_error: true } : {}),
    content: isError ? "File not found" : `${files.length} files delivered to user.\n${files.map((f) => `  ${f} → file_uuid: 4f9b85dc-cfec-40ec-a7c3-35f92a4dd6ca`).join("\n")}`,
  }] } })

function capture(): { events: FeedEvent[]; off: () => void } {
  const events: FeedEvent[] = []
  const off = onFeed((ev) => { if (ev.kind === "artifact") events.push(ev) })
  return { events, off }
}

async function settle(events: FeedEvent[], n: number): Promise<void> {
  for (let i = 0; i < 100 && events.length < n; i++) await Bun.sleep(20)
  await Bun.sleep(50) // and nothing more arrives
}

beforeAll(async () => {
  process.env.COMPANION_MEDIA_DIR = join(dir, "media")
  process.env.COMPANION_SENT_FILES_DIR = join(dir, "sent")
  png = join(dir, "shot.png")
  writeFileSync(png, await sharp({ create: { width: 64, height: 32, channels: 3, background: "#ff0000" } }).png().toBuffer())
  zip = join(dir, "bundle.zip")
  writeFileSync(zip, Buffer.from([0x50, 0x4b, 3, 4]))
  env = join(dir, ".env")
  writeFileSync(env, "TOKEN=x")
})

afterAll(() => {
  delete process.env.COMPANION_MEDIA_DIR
  delete process.env.COMPANION_SENT_FILES_DIR
  rmSync(dir, { recursive: true, force: true })
})

test("png + zip → two file cards with urls; the png has a thumbnail; re-read and later text add nothing", async () => {
  const path = join(dir, "a.jsonl")
  const { events, off } = capture()
  writeFileSync(path, send("tu1", [png, zip]) + result("tu1", [png, zip]))
  const s = getState({ transcriptPath: path, tty: "/dev/sf1", cwd: dir })
  readTranscriptDelta(s)
  await settle(events, 2)
  expect(events.map((e) => e.id)).toEqual(["sentfile:tu1:0", "sentfile:tu1:1"])
  const [p, z] = events as [FeedEvent, FeedEvent]
  expect(p).toMatchObject({ artifactKind: "file", title: "shot.png", path: png, tool: "SendUserFile", width: 64, height: 32 })
  expect(p.url).toMatch(/^\/api\/files\/[a-f0-9]{32}\/shot\.png$/)
  expect(p.mediaId).toMatch(/^[a-f0-9]{32}$/)
  expect(z).toMatchObject({ artifactKind: "file", title: "bundle.zip" })
  expect(z.url).toMatch(/^\/api\/files\/[a-f0-9]{32}\/bundle\.zip$/)
  expect(z.mediaId).toBeUndefined()

  appendFileSync(path, line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Sent ${png} and ${zip}.` }] } }))
  readTranscriptDelta(s)
  readTranscriptDelta(s)
  await settle(events, 3)
  expect(events).toHaveLength(2)
  off()
})

test("only the files the result names; a secret keeps a path-only card", async () => {
  const path = join(dir, "b.jsonl")
  const { events, off } = capture()
  writeFileSync(path, send("tu2", [zip, env, join(dir, "never.csv")]) + result("tu2", [zip, env]))
  readTranscriptDelta(getState({ transcriptPath: path, tty: "/dev/sf2", cwd: dir }))
  await settle(events, 2)
  expect(events.map((e) => e.title)).toEqual(["bundle.zip", ".env"])
  expect(events[1]!.url).toBeUndefined()
  expect(events[1]!.path).toBe(env)
  off()
})

test("is_error and a silent read emit nothing", async () => {
  const { events, off } = capture()
  const a = join(dir, "c.jsonl")
  writeFileSync(a, send("tu3", [zip]) + result("tu3", [zip], true))
  readTranscriptDelta(getState({ transcriptPath: a, tty: "/dev/sf3", cwd: dir }))
  const b = join(dir, "d.jsonl")
  writeFileSync(b, send("tu4", [png]) + result("tu4", [png]))
  const s = getState({ transcriptPath: b, tty: "/dev/sf4", cwd: dir })
  readTranscriptDelta(s, { silent: true })
  readTranscriptDelta(s)
  await settle(events, 1)
  expect(events).toHaveLength(0)
  off()
})

test("a result in an unknown format still cards every input file", async () => {
  const path = join(dir, "e.jsonl")
  const { events, off } = capture()
  writeFileSync(path, send("tu5", [zip]) + line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu5", content: "ok" }] } }))
  readTranscriptDelta(getState({ transcriptPath: path, tty: "/dev/sf5", cwd: dir }))
  await settle(events, 1)
  expect(events.map((e) => e.title)).toEqual(["bundle.zip"])
  off()
})
