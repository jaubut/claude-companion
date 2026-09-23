import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import sharp from "sharp"
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enforceMediaCap, isMediaId, mediaPath, releaseMedia, storeImageBase64, storeImageFile } from "./media"
import { appendFeedEvent, getFeed, pruneFeedForSession } from "./feed"
import "../wiring/media"

// Real temp dir via COMPANION_MEDIA_DIR, real sharp encodes. media.ts reads the
// env on every call, so each test gets a fresh, empty dir.

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-media-"))
  process.env.COMPANION_MEDIA_DIR = dir
  delete process.env.COMPANION_MEDIA_MAX_BYTES
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
afterAll(() => { delete process.env.COMPANION_MEDIA_MAX_BYTES })

async function png(width: number, height: number, color = "#ff0000"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

const jpegs = () => readdirSync(dir).filter((n) => n.endsWith(".jpg"))

describe("storeImageBase64", () => {
  test("a 3000x1500 PNG lands as a 1024x512 JPEG on disk", async () => {
    const ref = await storeImageBase64((await png(3000, 1500)).toString("base64"))
    expect(ref).not.toBeNull()
    expect(isMediaId(ref!.mediaId)).toBe(true)
    expect(ref!.width).toBe(1024)
    expect(ref!.height).toBe(512)
    const meta = await sharp(mediaPath(ref!.mediaId)).metadata()
    expect(meta.format).toBe("jpeg")
    expect([meta.width, meta.height]).toEqual([1024, 512])
  })

  test("a small image is never enlarged", async () => {
    const ref = await storeImageBase64((await png(40, 20)).toString("base64"))
    expect([ref!.width, ref!.height]).toEqual([40, 20])
  })

  test("the same bytes twice → one file, same id", async () => {
    const b64 = (await png(200, 100)).toString("base64")
    const [a, b] = await Promise.all([storeImageBase64(b64), storeImageBase64(b64)])
    const c = await storeImageBase64(b64) // file-exists shortcut
    expect(a!.mediaId).toBe(b!.mediaId)
    expect(c).toEqual(a)
    expect(jpegs()).toEqual([`${a!.mediaId}.jpg`])
  })

  test("corrupt base64 → null and no file", async () => {
    expect(await storeImageBase64(Buffer.from("definitely not an image").toString("base64"))).toBeNull()
    expect(await storeImageBase64("")).toBeNull()
    expect(jpegs()).toEqual([])
  })

  test("a burst of encodes all complete through the 2-slot queue", async () => {
    const colors = ["#100000", "#200000", "#300000", "#400000", "#500000", "#600000"]
    const refs = await Promise.all(colors.map(async (c) => storeImageBase64((await png(300, 300, c)).toString("base64"))))
    expect(refs.every((r) => r !== null)).toBe(true)
    expect(jpegs()).toHaveLength(colors.length)
  })
})

describe("storeImageFile", () => {
  test("encodes a local file; a missing file → null", async () => {
    const src = join(dir, "shot.png")
    await sharp(await png(2048, 1024)).toFile(src)
    const ref = await storeImageFile(src)
    expect([ref!.width, ref!.height]).toEqual([1024, 512])
    expect(await storeImageFile(join(dir, "nope.png"))).toBeNull()
  })
})

describe("byte cap + release", () => {
  test("a tiny COMPANION_MEDIA_MAX_BYTES unlinks oldest first", async () => {
    const a = await storeImageBase64((await png(64, 64, "#010101")).toString("base64"))
    const b = await storeImageBase64((await png(64, 64, "#020202")).toString("base64"))
    const c = await storeImageBase64((await png(64, 64, "#030303")).toString("base64"))
    // Pin mtimes so "oldest" is unambiguous: a < b < c.
    const now = Date.now() / 1000
    utimesSync(mediaPath(a!.mediaId), now - 30, now - 30)
    utimesSync(mediaPath(b!.mediaId), now - 20, now - 20)
    utimesSync(mediaPath(c!.mediaId), now - 10, now - 10)
    const sizes = [a, b, c].map((r) => Bun.file(mediaPath(r!.mediaId)).size)
    // Room for the newest two only.
    const removed = enforceMediaCap(sizes[1]! + sizes[2]!)
    expect(removed).toEqual([a!.mediaId])
    expect(existsSync(mediaPath(a!.mediaId))).toBe(false)
    expect(existsSync(mediaPath(b!.mediaId))).toBe(true)
    expect(existsSync(mediaPath(c!.mediaId))).toBe(true)
  })

  test("the cap is enforced on write via COMPANION_MEDIA_MAX_BYTES", async () => {
    process.env.COMPANION_MEDIA_MAX_BYTES = "1"
    await storeImageBase64((await png(64, 64, "#0a0a0a")).toString("base64"))
    expect(jpegs()).toEqual([])
  })

  test("releaseMedia unlinks valid ids, ignores junk, never throws", async () => {
    const ref = await storeImageBase64((await png(32, 32)).toString("base64"))
    expect(() => releaseMedia(["../auth.token", "0".repeat(32), ref!.mediaId])).not.toThrow()
    expect(existsSync(mediaPath(ref!.mediaId))).toBe(false)
  })
})

describe("wiring/media — feed eviction frees files", () => {
  test("an evicted image whose mediaId is still in the feed is not unlinked", async () => {
    const ref = await storeImageBase64((await png(50, 50, "#123456")).toString("base64"))
    const id = ref!.mediaId
    const base = { ts: Date.now(), kind: "image" as const, mediaId: id, width: 50, height: 50, caption: "x" }
    appendFeedEvent({ ...base, id: "img:wiring-a", tty: "/dev/wiring-a" })
    appendFeedEvent({ ...base, id: "img:wiring-b", tty: "/dev/wiring-b" })

    pruneFeedForSession({ tty: "/dev/wiring-a" })
    expect(getFeed().some((e) => e.id === "img:wiring-b")).toBe(true)
    expect(existsSync(mediaPath(id))).toBe(true) // still referenced by b

    pruneFeedForSession({ tty: "/dev/wiring-b" })
    expect(existsSync(mediaPath(id))).toBe(false) // last reference gone
  })
})
