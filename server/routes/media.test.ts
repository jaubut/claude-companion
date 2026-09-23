import { test, expect, beforeAll, afterAll } from "bun:test"
import sharp from "sharp"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { storeImageBase64 } from "../lib/media"
import { handleMediaRoute } from "./media"

// Calls the handler directly against a temp COMPANION_MEDIA_DIR. The 401 lives
// in the server's /api/* gate and is verified by curl, not here — booting
// createCompanionServer would pull in every wiring side effect.

let dir = ""
let id = ""
const base = "http://localhost/api/media/"

async function get(path: string, init: RequestInit = {}): Promise<Response | null> {
  const req = new Request(base + path, init)
  return handleMediaRoute(req, new URL(req.url))
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cc-media-route-"))
  process.env.COMPANION_MEDIA_DIR = dir
  const png = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#00ff00" } }).png().toBuffer()
  id = (await storeImageBase64(png.toString("base64")))!.mediaId
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("200 with the JPEG and immutable cache headers", async () => {
  const res = (await get(id))!
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("image/jpeg")
  expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
  expect(res.headers.get("etag")).toBe(`"${id}"`)
  const bytes = Buffer.from(await res.arrayBuffer())
  expect((await sharp(bytes).metadata()).format).toBe("jpeg")
})

test("matching If-None-Match → 304, no body", async () => {
  const res = (await get(id, { headers: { "If-None-Match": `"${id}"` } }))!
  expect(res.status).toBe(304)
  expect(res.headers.get("etag")).toBe(`"${id}"`)
  expect(await res.text()).toBe("")
  const weak = (await get(id, { headers: { "If-None-Match": `"nope", W/"${id}"` } }))!
  expect(weak.status).toBe(304)
  const miss = (await get(id, { headers: { "If-None-Match": `"${"0".repeat(32)}"` } }))!
  expect(miss.status).toBe(200)
})

test("unknown well-formed id → 404", async () => {
  expect((await get("f".repeat(32)))!.status).toBe(404)
})

test("traversal and malformed ids → 404", async () => {
  for (const bad of ["..%2Fauth.token", "..%2F..%2Fauth.token", id.toUpperCase(), id.slice(1), `${id}0`, `${id}.jpg`, "g".repeat(32), ""]) {
    const res = await get(bad)
    expect(res?.status).toBe(404)
  }
})

test("non-GET → null (not this route)", async () => {
  expect(await get(id, { method: "POST" })).toBeNull()
  expect(await get(id, { method: "DELETE" })).toBeNull()
})

test("other paths → null", async () => {
  const req = new Request("http://localhost/api/feed")
  expect(await handleMediaRoute(req, new URL(req.url))).toBeNull()
})
