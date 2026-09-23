import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test"
import sharp from "sharp"
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MediaRef, type StoreResult, MAX_PENDING, enforceMediaCap, expireMedia, isMediaId, mediaPath, storeImageBase64, storeImageFile } from "./media"
import { appendFeedEvent, getFeed, pruneFeedForSession } from "./feed"

// A store result that must be a ref: narrows away null and "busy".
const mref = (r: StoreResult): MediaRef => {
  if (r === null || r === "busy") throw new Error(`expected a MediaRef, got ${String(r)}`)
  return r
}


// Real temp dir via COMPANION_MEDIA_DIR, real sharp encodes. media.ts reads the
// env on every call, so each test gets a fresh, empty dir.

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-media-"))
  process.env.COMPANION_MEDIA_DIR = dir
  delete process.env.COMPANION_MEDIA_MAX_BYTES
  delete process.env.COMPANION_MEDIA_MAX_AGE
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
afterAll(() => { delete process.env.COMPANION_MEDIA_MAX_BYTES; delete process.env.COMPANION_MEDIA_MAX_AGE })

async function png(width: number, height: number, color = "#ff0000"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

const jpegs = () => readdirSync(dir).filter((n) => n.endsWith(".jpg"))

describe("storeImageBase64", () => {
  test("a 3000x1500 PNG lands as a 1024x512 JPEG on disk", async () => {
    const ref = await storeImageBase64((await png(3000, 1500)).toString("base64"))
    expect(ref).not.toBeNull()
    expect(isMediaId(mref(ref).mediaId)).toBe(true)
    expect(mref(ref).width).toBe(1024)
    expect(mref(ref).height).toBe(512)
    const meta = await sharp(mediaPath(mref(ref).mediaId)).metadata()
    expect(meta.format).toBe("jpeg")
    expect([meta.width, meta.height]).toEqual([1024, 512])
  })

  test("a small image is never enlarged", async () => {
    const ref = await storeImageBase64((await png(40, 20)).toString("base64"))
    expect([mref(ref).width, mref(ref).height]).toEqual([40, 20])
  })

  test("the same bytes twice → one file, same id", async () => {
    const b64 = (await png(200, 100)).toString("base64")
    const [a, b] = await Promise.all([storeImageBase64(b64), storeImageBase64(b64)])
    const c = await storeImageBase64(b64) // file-exists shortcut
    expect(mref(a).mediaId).toBe(mref(b).mediaId)
    expect(c).toEqual(a)
    expect(jpegs()).toEqual([`${mref(a).mediaId}.jpg`])
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
    expect([mref(ref).width, mref(ref).height]).toEqual([1024, 512])
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
    utimesSync(mediaPath(mref(a).mediaId), now - 30, now - 30)
    utimesSync(mediaPath(mref(b).mediaId), now - 20, now - 20)
    utimesSync(mediaPath(mref(c).mediaId), now - 10, now - 10)
    const sizes = [a, b, c].map((r) => Bun.file(mediaPath(mref(r).mediaId)).size)
    // Room for the newest two only.
    const removed = enforceMediaCap(sizes[1]! + sizes[2]!)
    expect(removed).toEqual([mref(a).mediaId])
    expect(existsSync(mediaPath(mref(a).mediaId))).toBe(false)
    expect(existsSync(mediaPath(mref(b).mediaId))).toBe(true)
    expect(existsSync(mediaPath(mref(c).mediaId))).toBe(true)
  })

  test("the cap is enforced on write via COMPANION_MEDIA_MAX_BYTES", async () => {
    process.env.COMPANION_MEDIA_MAX_BYTES = "1"
    await storeImageBase64((await png(64, 64, "#0a0a0a")).toString("base64"))
    expect(jpegs()).toEqual([])
  })

  test("expireMedia unlinks only files older than the age cap", async () => {
    const old = await storeImageBase64((await png(32, 32, "#0b0b0b")).toString("base64"))
    const fresh = await storeImageBase64((await png(32, 32, "#0c0c0c")).toString("base64"))
    const now = Date.now() / 1000
    utimesSync(mediaPath(mref(old).mediaId), now - 3600, now - 3600)
    expect(expireMedia(60_000)).toEqual([mref(old).mediaId])
    expect(existsSync(mediaPath(mref(fresh).mediaId))).toBe(true)
  })

  test("the age cap is swept on write via COMPANION_MEDIA_MAX_AGE (seconds)", async () => {
    const old = await storeImageBase64((await png(32, 32, "#0d0d0d")).toString("base64"))
    const now = Date.now() / 1000
    utimesSync(mediaPath(mref(old).mediaId), now - 120, now - 120)
    process.env.COMPANION_MEDIA_MAX_AGE = "60"
    const fresh = await storeImageBase64((await png(32, 32, "#0e0e0e")).toString("base64"))
    expect(jpegs()).toEqual([`${mref(fresh).mediaId}.jpg`])
  })

  test("default age cap (7 days) keeps a day-old file", async () => {
    const ref = await storeImageBase64((await png(32, 32, "#0f0f0f")).toString("base64"))
    const now = Date.now() / 1000
    utimesSync(mediaPath(mref(ref).mediaId), now - 86_400, now - 86_400)
    expect(expireMedia()).toEqual([])
  })
})

describe("wiring/media — feed eviction never frees files", () => {
  test("images survive both the 200-cap trim and a session prune", async () => {
    const { startMediaSweeper, stopMediaSweeper } = await import("../wiring/media")
    startMediaSweeper() // after beforeEach: the startup sweep hits the temp dir
    stopMediaSweeper()
    const ref = await storeImageBase64((await png(50, 50, "#123456")).toString("base64"))
    const id = mref(ref).mediaId
    const base = { ts: Date.now(), kind: "image" as const, mediaId: id, width: 50, height: 50, caption: "x" }
    appendFeedEvent({ ...base, id: "img:wiring-a", tty: "/dev/wiring-a" })
    pruneFeedForSession({ tty: "/dev/wiring-a" })
    expect(getFeed().some((e) => e.id === "img:wiring-a")).toBe(false)
    expect(existsSync(mediaPath(id))).toBe(true)

    appendFeedEvent({ ...base, id: "img:wiring-b", tty: "/dev/wiring-b" })
    for (let i = 0; i < 200; i++) appendFeedEvent({ id: `wiring-fill-${i}`, ts: Date.now(), kind: "tool_start", tty: "/dev/wiring-fill" })
    expect(getFeed().some((e) => e.id === "img:wiring-b")).toBe(false)
    expect(existsSync(mediaPath(id))).toBe(true)
    pruneFeedForSession({ tty: "/dev/wiring-fill" })
  })
})


describe("wiring/media — sweeper start honours the configured age cap (Codex HIGH on PR #45)", () => {
  test("importing the module sweeps nothing; starting it after .env applies the configured cap", async () => {
    const { startMediaSweeper, stopMediaSweeper } = await import("../wiring/media")
    const ref = await storeImageBase64((await png(32, 32, "#0a0b0c")).toString("base64"))
    const id = mref(ref).mediaId
    const now = Date.now() / 1000
    utimesSync(mediaPath(id), now - 10 * 86_400, now - 10 * 86_400) // 10 days old
    expect(existsSync(mediaPath(id))).toBe(true) // the import above removed nothing
    process.env.COMPANION_MEDIA_MAX_AGE = String(30 * 86_400) // as a .env would set it
    try {
      expect(startMediaSweeper()).toEqual([])
      expect(existsSync(mediaPath(id))).toBe(true) // 10 d < 30 d: kept
      expect(startMediaSweeper()).toEqual([]) // idempotent: no second timer, no second sweep
    } finally {
      stopMediaSweeper()
    }
    delete process.env.COMPANION_MEDIA_MAX_AGE
    expect(startMediaSweeper()).toEqual([id]) // default 7 d: gone
    stopMediaSweeper()
  })
})

describe("bounded encode queue (Codex HIGH on PR #41)", () => {
  test("a burst beyond the wait queue is refused with busy, nothing is decoded early, and a retry succeeds", async () => {
    const total = 2 + MAX_PENDING + 3
    const sources: string[] = []
    for (let i = 0; i < total; i++) sources.push((await png(64 + i, 32)).toString("base64"))
    // Fired synchronously: admission is decided before any encode finishes.
    const results = await Promise.all(sources.map((b64) => storeImageBase64(b64)))
    const busy = results.filter((r) => r === "busy").length
    const refs = results.filter((r) => r !== "busy" && r !== null).length
    expect(busy).toBe(3)
    expect(refs).toBe(2 + MAX_PENDING)
    expect(jpegs().length).toBe(2 + MAX_PENDING)
    // Once the queue drained, the refused source stores fine.
    const retry = await storeImageBase64(sources[total - 1]!)
    expect(retry).not.toBe("busy")
    expect(retry).not.toBeNull()
    expect(jpegs().length).toBe(2 + MAX_PENDING + 1)
  })

  test("the same base64 twice shares one job and one file", async () => {
    const b64 = (await png(120, 60)).toString("base64")
    const [a, b] = await Promise.all([storeImageBase64(b64), storeImageBase64(b64)])
    expect(a).not.toBeNull(); expect(a).not.toBe("busy")
    expect(a).toEqual(b)
    expect(jpegs().length).toBe(1)
  })
})
