import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { storeSentFile, type SentFile } from "../lib/sent-files"
import { getAuthToken } from "../lib/auth"

// The handler against a temp store, plus the 401 through the real server's
// /api/* gate.

const src = mkdtempSync(join(tmpdir(), "cc-files-src-"))
const store = mkdtempSync(join(tmpdir(), "cc-files-store-"))
const bytes = Buffer.from([0x50, 0x4b, 3, 4, 9, 9])
let zip: SentFile
let spaced: SentFile
let handle: typeof import("./files").handleFilesRoute
let server: { port: number; stop(force?: boolean): void }

const get = (path: string, init: RequestInit = {}) => {
  const req = new Request(`http://localhost/api/files/${path}`, init)
  return handle(req, new URL(req.url))
}

beforeAll(async () => {
  process.env.COMPANION_SENT_FILES_DIR = store
  writeFileSync(join(src, "out.zip"), bytes)
  writeFileSync(join(src, "my report é.csv"), "a,b\n")
  zip = (await storeSentFile(join(src, "out.zip")))!
  spaced = (await storeSentFile(join(src, "my report é.csv")))!
  handle = (await import("./files")).handleFilesRoute
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
})

afterAll(() => {
  server.stop(true)
  delete process.env.COMPANION_SENT_FILES_DIR
  rmSync(src, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
})

test("200: the bytes, its type, attachment, nosniff, immutable cache", async () => {
  const res = (await get(`${zip.id}/out.zip`))!
  expect(res.status).toBe(200)
  expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
  expect(res.headers.get("content-type")).toBe("application/zip")
  expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''out.zip")
  expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  expect(res.headers.get("etag")).toBe(`"${zip.id}"`)
})

test("a percent-encoded name with spaces and accents resolves", async () => {
  const res = (await get(`${spaced.id}/${encodeURIComponent("my report é.csv")}`))!
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("a,b\n")
})

test("matching If-None-Match → 304", async () => {
  expect((await get(`${zip.id}/out.zip`, { headers: { "If-None-Match": `"${zip.id}"` } }))!.status).toBe(304)
})

test("404: bad id, unknown id, wrong name, traversal, extra segments", async () => {
  for (const p of ["nothex/out.zip", `${"0".repeat(32)}/out.zip`, `${zip.id}/other.zip`, `${zip.id}/..%2F..%2Fauth.token`, `${zip.id}/out.zip/x`, zip.id]) {
    expect((await get(p))!.status).toBe(404)
  }
})

test("other paths and methods fall through", async () => {
  expect(await handle(new Request("http://localhost/api/media/x"), new URL("http://localhost/api/media/x"))).toBeNull()
  expect(await get(`${zip.id}/out.zip`, { method: "POST" })).toBeNull()
})

test("through the server: no bearer → 401, bearer → 200", async () => {
  const url = `http://127.0.0.1:${server.port}/api/files/${zip.id}/out.zip`
  expect((await fetch(url)).status).toBe(401)
  const ok = await fetch(url, { headers: { Authorization: `Bearer ${getAuthToken()}` } })
  expect(ok.status).toBe(200)
})
