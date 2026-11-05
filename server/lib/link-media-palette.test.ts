import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { vttText } from "./link-media"
import { palette } from "./link-media-palette"

const dir = mkdtempSync(join(tmpdir(), "link-media-palette-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 100x100: left 3/4 red, right 1/4 blue. */
async function twoColour(): Promise<string> {
  const path = join(dir, "test.png")
  const blue = await sharp({ create: { width: 25, height: 100, channels: 3, background: "#0000ff" } }).png().toBuffer()
  await sharp({ create: { width: 100, height: 100, channels: 3, background: "#ff0000" } }).composite([{ input: blue, left: 75, top: 0 }]).png().toFile(path)
  return path
}

describe("bin/media palette", () => {
  test("finds the two colours of a generated image with their shares", async () => {
    const p = await palette([await twoColour()])
    expect(p[0]!.hex).toBe("#ff0000")
    expect(p[0]!.share).toBeCloseTo(0.75, 1)
    expect(p[1]!.hex).toBe("#0000ff")
    expect(p[1]!.share).toBeCloseTo(0.25, 1)
    expect(p.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 2)
  })

  test("returns at most 6 swatches on a busy image", async () => {
    const path = join(dir, "noise.png")
    const raw = Buffer.alloc(64 * 64 * 3)
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 256
    await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toFile(path)
    const p = await palette([path])
    expect(p.length).toBeLessThanOrEqual(6)
    expect(p.every((s) => /^#[0-9a-f]{6}$/.test(s.hex))).toBe(true)
  })
})

describe("bin/media transcript", () => {
  test("vtt cues are stripped and deduped", () => {
    const vtt = "WEBVTT\nKind: captions\n\n1\n00:00:00.000 --> 00:00:02.000\nhello <c>world</c>\n\n00:00:02.000 --> 00:00:04.000\nhello world\nnext line\n"
    expect(vttText(vtt)).toBe("hello world\nnext line")
  })
})
