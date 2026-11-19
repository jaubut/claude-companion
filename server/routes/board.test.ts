import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { InMemorySyncStorage, TLSocketRoom } from "@tldraw/sync-core"
import type { TLRecord } from "@tldraw/tlschema"
import { type BoardRoom, boardRecords } from "../lib/board-room"
import { boardSchema } from "../lib/board-schema"
import { boardCors, createBoardRoute } from "./board"

// routes/board.ts: CORS preflight (A2), assets, import, auth and the
// brain-host-only gate (canvas-board-sync Verify 4).

process.env.COMPANION_AUTH_TOKEN ||= "board-test-token-0123456789abcdef"
const TOKEN = getAuthToken()
const savedHome = process.env.HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "cc-board-home-"))
afterAll(() => { process.env.HOME = savedHome })

const room: BoardRoom = new TLSocketRoom<TLRecord, void>({ schema: boardSchema, storage: new InMemorySyncStorage<TLRecord>() })
let enabled = true
const route = createBoardRoute({ enabled: () => enabled, room: () => room })
const call = (path: string, init: RequestInit = {}, auth = true) => {
  const url = new URL(`http://127.0.0.1${path}`)
  const headers = new Headers(init.headers)
  if (auth) headers.set("Authorization", `Bearer ${TOKEN}`)
  return route(new Request(url.href, { ...init, headers }), url)
}
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")

describe("board CORS preflight", () => {
  const preflight = (path: string, origin: string) => {
    const url = new URL(`http://127.0.0.1${path}`)
    return boardCors(new Request(url.href, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } }), url)
  }
  test("the Canvas origin, no token → 204 with allow headers echoing it", () => {
    const res = preflight("/api/board/assets", "companion-sketch://app")!
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("companion-sketch://app")
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS")
    expect(res.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type")
    expect(res.headers.get("access-control-max-age")).toBe("600")
    expect(res.headers.get("vary")).toBe("Origin")
    expect(res.headers.get("access-control-allow-credentials")).toBeNull()
  })
  test("another origin (or null) → no Access-Control-Allow-Origin", () => {
    expect(preflight("/api/board/assets", "https://evil.example")!.headers.get("access-control-allow-origin")).toBeNull()
    expect(preflight("/api/board/assets", "null")!.headers.get("access-control-allow-origin")).toBeNull()
  })
  test("outside /api/board/* → not handled (no CORS on /api/mcp/board or /api/orchestrator/send)", () => {
    expect(preflight("/api/mcp/board", "companion-sketch://app")).toBeNull()
    expect(preflight("/api/orchestrator/send", "companion-sketch://app")).toBeNull()
  })
  test("an actual response carries the allow-origin for the Canvas origin", async () => {
    const res = (await call("/api/board/assets", { method: "POST", body: PNG, headers: { "Content-Type": "image/png", Origin: "companion-sketch://app" } }))!
    expect(res.headers.get("access-control-allow-origin")).toBe("companion-sketch://app")
  })
})

describe("board assets", () => {
  test("PNG upload → {src, path}; GET returns the same bytes; svg 415; mismatched bytes 415; no token 401", async () => {
    const res = (await call("/api/board/assets", { method: "POST", body: PNG, headers: { "Content-Type": "image/png" } }))!
    expect(res.status).toBe(200)
    const out = await res.json() as { ok: boolean; src: string; path: string }
    expect(out.src).toMatch(/^\/api\/board\/assets\/[a-f0-9]{32}\.png$/)
    expect(Buffer.compare(readFileSync(out.path), PNG)).toBe(0)
    const got = (await call(out.src))!
    expect(got.headers.get("content-type")).toBe("image/png")
    expect(Buffer.compare(Buffer.from(await got.arrayBuffer()), PNG)).toBe(0)
    expect((await call("/api/board/assets", { method: "POST", body: "<svg/>", headers: { "Content-Type": "image/svg+xml" } }))!.status).toBe(415)
    expect((await call("/api/board/assets", { method: "POST", body: "GIF89a-not-a-png", headers: { "Content-Type": "image/png" } }))!.status).toBe(415)
    expect((await call("/api/board/assets", { method: "POST", body: PNG, headers: { "Content-Type": "image/png" } }, false))!.status).toBe(401)
    expect((await call(out.src, {}, false))!.status).toBe(401)
    expect((await call("/api/board/assets/..%2f..%2fauth.token"))!.status).toBe(404)
    // Refused from Content-Length before the body is buffered.
    const big = (await call("/api/board/assets", { method: "POST", body: PNG, headers: { "Content-Type": "image/png", "Content-Length": String(26 * 1024 * 1024) } }))!
    expect(big.status).toBe(413)
  })
})

describe("board import", () => {
  test("data: images become asset files; a second import is 409", async () => {
    const schema = boardSchema.serialize()
    const asset = { id: "asset:a1", typeName: "asset", type: "image", props: { name: "x.png", src: `data:image/png;base64,${PNG.toString("base64")}`, w: 1, h: 1, mimeType: "image/png", isAnimated: false }, meta: {} }
    const page = { id: "page:p", typeName: "page", name: "P", index: "a1", meta: {} }
    const doc = { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} }
    const image = { id: "shape:img", typeName: "shape", type: "image", parentId: "page:p", index: "a1", x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 1, h: 1, playing: true, url: "", assetId: "asset:a1", crop: null, flipX: false, flipY: false, altText: "" } }
    const body = JSON.stringify({ document: { store: { [asset.id]: asset, [page.id]: page, [doc.id]: doc, [image.id]: image }, schema } })
    const res = (await call("/api/board/import", { method: "POST", body, headers: { "Content-Type": "application/json" } }))!
    expect(await res.json()).toEqual({ ok: true, imported: 1 })
    const stored = boardRecords(room).find((r) => r.id === "asset:a1") as { props: { src: string } } | undefined
    expect(stored?.props.src).toMatch(/^\/api\/board\/assets\/[a-f0-9]{32}\.png$/)
    // A refused import writes no asset files.
    const assetDir = dirname((await (await call("/api/board/assets", { method: "POST", body: PNG, headers: { "Content-Type": "image/png" } }))!.json() as { path: string }).path)
    const before = readdirSync(assetDir).length
    const other = Buffer.from(PNG); other.writeUInt8(other.readUInt8(other.length - 1) ^ 1, other.length - 1)
    const body2 = body.replace(PNG.toString("base64"), other.toString("base64"))
    expect((await call("/api/board/import", { method: "POST", body: body2, headers: { "Content-Type": "application/json" } }))!.status).toBe(409)
    expect(readdirSync(assetDir).length).toBe(before)
    expect((await call("/api/board/import", { method: "POST", body, headers: { "Content-Type": "application/json" } }))!.status).toBe(409)
  })
})

describe("board disabled (not the brain host)", () => {
  test("every board path → 404 board_disabled", async () => {
    enabled = false
    for (const [path, method] of [["/api/board/import", "POST"], ["/api/board/assets", "POST"], ["/api/board/assets/x.png", "GET"], ["/api/mcp/board", "POST"]] as const) {
      const res = (await call(path, { method, body: method === "POST" ? "{}" : undefined }))!
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ ok: false, error: "board_disabled" })
    }
    enabled = true
  })
  test("paths outside the board are not handled", async () => {
    expect(await call("/api/orchestrator/send", { method: "POST", body: "{}" })).toBeNull()
  })
})
