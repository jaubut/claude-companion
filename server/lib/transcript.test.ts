import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import sharp from "sharp"
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getState, modelFromTranscript, readTranscriptDelta, hashText } from "./transcript"
import { onFeed, type FeedEvent } from "./feed"

// Pins the contract recordTurnEnd's retry depends on: the delta reader
// returns how many blocks it emitted, dedupes by hash, primes silently, and
// keeps the token high-water mark. Real files, real feed store.

const dir = mkdtempSync(join(tmpdir(), "cc-transcript-"))
const line = (o: unknown) => JSON.stringify(o) + "\n"
const assistant = (text: string, tokens = 0) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], usage: { output_tokens: tokens } } })

function capture(): { events: FeedEvent[]; off: () => void } {
  const events: FeedEvent[] = []
  const off = onFeed((ev) => { events.push(ev) })
  return { events, off }
}

test("returns the number of blocks emitted; a re-read emits nothing new", () => {
  const path = join(dir, "a.jsonl")
  writeFileSync(path, line({ type: "user", message: { role: "user", content: "hi" } }) + assistant("first") + assistant("second"))
  const s = getState({ transcriptPath: path, tty: "/dev/t1", cwd: "/x" })
  const { events, off } = capture()
  expect(readTranscriptDelta(s)).toBe(2)
  expect(events.map((e) => e.text)).toEqual(["first", "second"])
  expect(s.streamedThisTurn).toBe(true)
  expect(readTranscriptDelta(s)).toBe(0) // deduped by hash
  appendFileSync(path, assistant("third"))
  expect(readTranscriptDelta(s)).toBe(1) // the late-flushed block counts
  off()
})

test("silent read primes the seen set without emitting", () => {
  const path = join(dir, "b.jsonl")
  writeFileSync(path, assistant("already on screen"))
  const s = getState({ transcriptPath: path, tty: "/dev/t2", cwd: "/x" })
  const { events, off } = capture()
  expect(readTranscriptDelta(s, { silent: true })).toBe(0)
  expect(events).toHaveLength(0)
  expect(s.streamedThisTurn).toBe(false)
  expect(s.seenAssistantText.has(hashText("already on screen"))).toBe(true)
  expect(readTranscriptDelta(s)).toBe(0) // primed → never echoed later
  off()
})

test("token count is a high-water mark across entries", () => {
  const path = join(dir, "c.jsonl")
  writeFileSync(path, assistant("a", 500) + assistant("b", 200))
  const s = getState({ transcriptPath: path, tty: "/dev/t3", cwd: "/x" })
  readTranscriptDelta(s, { silent: true })
  expect(s.lastTokens).toBe(500)
})

test("getState migrates a weak-keyed record when the transcript path arrives", () => {
  const weak = getState({ tty: "/dev/t4", cwd: "/x" })
  weak.turnStartedAt = 42
  const strong = getState({ tty: "/dev/t4", cwd: "/x", transcriptPath: join(dir, "d.jsonl") })
  expect(strong).toBe(weak)
  expect(strong.transcriptPath).toBe(join(dir, "d.jsonl"))
  expect(strong.turnStartedAt).toBe(42)
})

describe("thinking in the feed (RES-L5NG step 4)", () => {
  const thinking = (text: string, ts?: string, extra: object[] = []) =>
    line({
      type: "assistant",
      ...(ts ? { timestamp: ts } : {}),
      message: { role: "assistant", content: [{ type: "thinking", thinking: text, signature: "sig" }, ...extra] },
    })
  const stamped = (text: string, ts: string) =>
    line({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } })

  test("one event, clamped, with durationMs to the next entry; uncounted; re-read emits nothing", () => {
    const path = join(dir, "think-a.jsonl")
    const long = "x".repeat(5000)
    writeFileSync(path, thinking(long, "2026-09-23T10:00:00.000Z") + stamped("answer", "2026-09-23T10:00:03.500Z"))
    const s = getState({ transcriptPath: path, tty: "/dev/think1", cwd: "/x" })
    const { events, off } = capture()
    expect(readTranscriptDelta(s)).toBe(1) // only the text block counts
    const th = events.filter((e) => e.kind === "assistant_thinking")
    expect(th).toHaveLength(1)
    expect(th[0]!.text!.startsWith("x".repeat(4000) + "\n\n…[truncated")).toBe(true)
    expect(th[0]!.durationMs).toBe(3500)
    expect(th[0]!.tty).toBe("/dev/think1")
    expect(s.seenAssistantText.has(`think:${hashText(long)}`)).toBe(true)
    expect(readTranscriptDelta(s)).toBe(0)
    expect(events.filter((e) => e.kind === "assistant_thinking")).toHaveLength(1)
    off()
  })

  test("does not set streamedThisTurn and is not counted", () => {
    const path = join(dir, "think-b.jsonl")
    writeFileSync(path, thinking("pondering", "2026-09-23T10:00:00.000Z"))
    const s = getState({ transcriptPath: path, tty: "/dev/think2", cwd: "/x" })
    const { events, off } = capture()
    expect(readTranscriptDelta(s)).toBe(0)
    expect(s.streamedThisTurn).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe("assistant_thinking")
    expect(events[0]!.durationMs).toBeUndefined() // no following entry
    expect("durationMs" in events[0]!).toBe(false)
    off()
  })

  test("silent read marks seen without emitting", () => {
    const path = join(dir, "think-c.jsonl")
    writeFileSync(path, thinking("quiet thought") + assistant("reply"))
    const s = getState({ transcriptPath: path, tty: "/dev/think3", cwd: "/x" })
    const { events, off } = capture()
    expect(readTranscriptDelta(s, { silent: true })).toBe(0)
    expect(events).toHaveLength(0)
    expect(s.seenAssistantText.has(`think:${hashText("quiet thought")}`)).toBe(true)
    expect(readTranscriptDelta(s)).toBe(0)
    expect(events).toHaveLength(0)
    off()
  })

  test("redacted_thinking and missing timestamps are tolerated", () => {
    const path = join(dir, "think-d.jsonl")
    writeFileSync(
      path,
      line({ type: "assistant", message: { content: [{ type: "redacted_thinking", data: "opaque" }] } }) +
        thinking("no clock") + assistant("after"),
    )
    const s = getState({ transcriptPath: path, tty: "/dev/think4", cwd: "/x" })
    const { events, off } = capture()
    expect(readTranscriptDelta(s)).toBe(1)
    expect(events.map((e) => e.kind)).toEqual(["assistant_thinking", "assistant_text"])
    expect(events[0]!.durationMs).toBeUndefined()
    off()
  })
})

describe("model capture (PRJ-OR1T Phase 14)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-model-"))

  function write(name: string, lines: object[]): string {
    const p = join(dir, name)
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    return p
  }

  test("reads the model off the newest assistant message", () => {
    const p = write("a.jsonl", [
      { type: "assistant", message: { model: "claude-sonnet-5", content: [] } },
      { type: "user", message: { content: [] } },
      { type: "assistant", message: { model: "claude-opus-5", content: [] } },
    ])
    expect(modelFromTranscript(p)).toBe("claude-opus-5")
  })

  test("skips Claude Code's <synthetic> marker — a limit notice is not a model", () => {
    const p = write("b.jsonl", [
      { type: "assistant", message: { model: "claude-fable-5-1", content: [] } },
      { type: "assistant", message: { model: "<synthetic>", content: [] } },
    ])
    expect(modelFromTranscript(p)).toBe("claude-fable-5-1")
  })

  test("a transcript with no assistant turn yields '' — never a guessed default", () => {
    const p = write("c.jsonl", [{ type: "user", message: { content: [] } }])
    expect(modelFromTranscript(p)).toBe("")
  })

  test("a missing file yields '' rather than throwing", () => {
    expect(modelFromTranscript(join(dir, "nope.jsonl"))).toBe("")
  })

  test("a truncated first line from the bounded tail read is skipped, not fatal", () => {
    const p = write("d.jsonl", [
      { type: "assistant", message: { model: "claude-haiku-4-5", content: [] } },
    ])
    // Tail smaller than the line forces a partial leading line.
    expect(modelFromTranscript(p, 20)).toBe("")
    expect(modelFromTranscript(p)).toBe("claude-haiku-4-5")
  })
})

describe("images in the feed (RES-L5NG step 3)", () => {
  const imgDir = mkdtempSync(join(tmpdir(), "cc-transcript-img-"))
  const mediaDir = mkdtempSync(join(tmpdir(), "cc-transcript-media-"))
  beforeAll(() => { process.env.COMPANION_MEDIA_DIR = mediaDir })
  afterAll(() => {
    rmSync(imgDir, { recursive: true, force: true })
    rmSync(mediaDir, { recursive: true, force: true })
  })

  const pngB64 = (color: string) =>
    sharp({ create: { width: 64, height: 32, channels: 3, background: color } }).png().toBuffer().then((b) => b.toString("base64"))
  const toolUse = (id: string, name: string, input: unknown) =>
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } })
  const toolResult = (id: string, content: unknown[]) =>
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } })
  const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } })

  // The encode is async; give it a bounded window, then report what landed.
  async function settle(events: FeedEvent[], want: number, ms = 3000): Promise<FeedEvent[]> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (events.filter((e) => e.kind === "image").length >= want) break
      await Bun.sleep(20)
    }
    await Bun.sleep(80) // room for any stray duplicate to show up
    return events.filter((e) => e.kind === "image")
  }

  test("Read + tool_result image → one image event; not counted; streamedThisTurn untouched", async () => {
    const path = join(imgDir, "read.jsonl")
    const data = await pngB64("#ff0000")
    writeFileSync(path, toolUse("toolu_r1", "Read", { file_path: "/tmp/shots/red.png" }) + toolResult("toolu_r1", [image(data)]))
    const s = getState({ transcriptPath: path, tty: "/dev/img1", cwd: "/x" })
    const { events, off } = capture()
    expect(readTranscriptDelta(s)).toBe(0)
    expect(s.streamedThisTurn).toBe(false)
    expect(s.seenImages.has("tu:toolu_r1:0")).toBe(true) // marked before the encode resolves
    const imgs = await settle(events, 1)
    off()
    expect(imgs).toHaveLength(1)
    const ev = imgs[0]!
    expect(ev.id).toBe("img:tu:toolu_r1:0")
    expect(ev.tool).toBe("Read")
    expect(ev.caption).toBe("red.png")
    expect([ev.width, ev.height]).toEqual([64, 32])
    expect(ev.mediaId).toMatch(/^[a-f0-9]{32}$/)
    expect(ev.tty).toBe("/dev/img1")
    expect(ev.key).toBeUndefined()
    expect(existsSync(join(mediaDir, `${ev.mediaId}.jpg`))).toBe(true)
  })

  test("re-reads (the turn-end retry loop) never emit a second event", async () => {
    const path = join(imgDir, "reread.jsonl")
    writeFileSync(path, toolUse("toolu_r2", "Read", { file_path: "/a/b.png" }) + toolResult("toolu_r2", [image(await pngB64("#00ff00"))]))
    const s = getState({ transcriptPath: path, tty: "/dev/img2", cwd: "/x" })
    const { events, off } = capture()
    for (let i = 0; i < 16; i++) readTranscriptDelta(s)
    const imgs = await settle(events, 1)
    readTranscriptDelta(s)
    await Bun.sleep(80)
    off()
    expect(imgs).toHaveLength(1)
    expect(events.filter((e) => e.kind === "image")).toHaveLength(1)
  })

  test("a silent read marks the image without emitting, and later reads stay quiet", async () => {
    const path = join(imgDir, "silent.jsonl")
    writeFileSync(path, toolUse("toolu_r3", "Read", { file_path: "/a/c.png" }) + toolResult("toolu_r3", [image(await pngB64("#0000ff"))]))
    const s = getState({ transcriptPath: path, tty: "/dev/img3", cwd: "/x" })
    const { events, off } = capture()
    readTranscriptDelta(s, { silent: true })
    expect(s.seenImages.has("tu:toolu_r3:0")).toBe(true)
    readTranscriptDelta(s)
    await Bun.sleep(150)
    off()
    expect(events.filter((e) => e.kind === "image")).toHaveLength(0)
  })

  test("an MCP screenshot captions from its sibling text, else the tool name", async () => {
    const path = join(imgDir, "mcp.jsonl")
    const [a, b] = await Promise.all([pngB64("#101010"), pngB64("#202020")])
    writeFileSync(
      path,
      toolUse("toolu_m1", "mcp__computer-use__screenshot", {}) +
        toolResult("toolu_m1", [{ type: "text", text: "Screenshot of the display" }, image(a)]) +
        toolUse("toolu_m2", "mcp__computer-use__screenshot", {}) +
        toolResult("toolu_m2", [image(b)]),
    )
    const s = getState({ transcriptPath: path, tty: "/dev/img4", cwd: "/x" })
    const { events, off } = capture()
    readTranscriptDelta(s)
    const imgs = await settle(events, 2)
    off()
    const byId = new Map(imgs.map((e) => [e.id, e]))
    expect(byId.get("img:tu:toolu_m1:1")?.caption).toBe("Screenshot of the display")
    expect(byId.get("img:tu:toolu_m2:0")?.caption).toBe("mcp__computer-use__screenshot")
    expect(byId.get("img:tu:toolu_m2:0")?.tool).toBe("mcp__computer-use__screenshot")
  })

  test("![alt](path) in assistant text → image event captioned by alt; the text still counts once", async () => {
    const png = join(imgDir, "chart.png")
    await sharp({ create: { width: 30, height: 30, channels: 3, background: "#abcdef" } }).png().toFile(png)
    const path = join(imgDir, "md.jsonl")
    writeFileSync(path, assistant("Here it is: ![the chart](chart.png) and ![gone](missing.png) and ![x](notes.txt)"))
    const s = getState({ transcriptPath: path, tty: "/dev/img5", cwd: imgDir })
    const { events, off } = capture()
    expect(readTranscriptDelta(s)).toBe(1) // the text block only
    const imgs = await settle(events, 1)
    off()
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.caption).toBe("the chart")
    expect(imgs[0]!.id.startsWith("img:md:")).toBe(true)
  })

  test("corrupt image data → no event, no throw", async () => {
    const path = join(imgDir, "corrupt.jsonl")
    writeFileSync(path, toolUse("toolu_c1", "Read", { file_path: "/a/bad.png" }) + toolResult("toolu_c1", [image(Buffer.from("nope").toString("base64"))]))
    const s = getState({ transcriptPath: path, tty: "/dev/img6", cwd: "/x" })
    const { events, off } = capture()
    expect(readTranscriptDelta(s)).toBe(0)
    await Bun.sleep(200)
    off()
    expect(events.filter((e) => e.kind === "image")).toHaveLength(0)
  })
})


import { queueImage } from "./transcript"
import { getFeed as feedNow } from "./feed"

describe("busy store retries next tick", () => {
  test("a busy result unmarks the seen key and appends nothing", async () => {
    const seen = new Set<string>(["tu:x:0"])
    const state = { seenImages: seen, cwd: "/tmp", tty: undefined, sessionId: undefined } as unknown as Parameters<typeof queueImage>[0]
    const before = feedNow().length
    queueImage(state, "tu:x:0", () => Promise.resolve("busy" as const), { tool: "Read", caption: "x.png" })
    await new Promise((r) => setTimeout(r, 10))
    expect(seen.has("tu:x:0")).toBe(false)
    expect(feedNow().length).toBe(before)
  })
})
