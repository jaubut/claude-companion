import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "./auth"
import { InMemorySyncStorage, TLSocketRoom } from "@tldraw/sync-core"
import type { TLRecord } from "@tldraw/tlschema"
import { createBoardRoute } from "../routes/board"
import { saveBoardAsset } from "./board-assets"
import type { BoardRoom } from "./board-room"
import { boardSchema } from "./board-schema"

// The board MCP over its route (A1): initialize, tools/list, each tool, isError.

process.env.COMPANION_AUTH_TOKEN ||= "board-test-token-0123456789abcdef"
const TOKEN = getAuthToken()
const savedHome = process.env.HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "cc-board-mcp-home-"))
afterAll(() => { process.env.HOME = savedHome })

const room: BoardRoom = new TLSocketRoom<TLRecord, void>({ schema: boardSchema, storage: new InMemorySyncStorage<TLRecord>() })
const route = createBoardRoute({ enabled: () => true, room: () => room })
async function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const url = new URL("http://127.0.0.1/api/mcp/board")
  const res = (await route(new Request(url.href, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) }), url))!
  return { status: res.status, body: res.status === 202 ? {} : await res.json() as Record<string, unknown>, headers: res.headers }
}
const result = (r: { body: Record<string, unknown> }) => r.body.result as { structuredContent?: Record<string, unknown>; content: Array<Record<string, unknown>>; isError?: boolean }

describe("board MCP", () => {
  test("initialize hands a session id; tools/list has the 3 tools; notifications → 202; GET → 405", async () => {
    const init = await rpc("initialize", { clientInfo: { name: "claude-code" } })
    expect((init.body.result as { serverInfo: { name: string } }).serverInfo.name).toBe("companion-board")
    expect(init.headers.get("mcp-session-id")).toBeTruthy()
    const list = await rpc("tools/list")
    expect((list.body.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["board_read", "board_write", "board_asset"])
    expect((await rpc("notifications/initialized")).status).toBe(202)
    const url = new URL("http://127.0.0.1/api/mcp/board")
    expect((await route(new Request(url.href, { headers: { Authorization: `Bearer ${TOKEN}` } }), url))!.status).toBe(405)
  })

  test("board_write → meta.by from X-Board-Caller, else the session's clientInfo.name; board_read sees it", async () => {
    const w = await rpc("tools/call", { name: "board_write", arguments: { ops: [{ op: "create", type: "note", id: "shape:m1", text: "hello" }] } }, { "X-Board-Caller": "mac:desk-1" })
    expect(result(w).structuredContent).toEqual({ ok: true, ids: ["shape:m1"] })
    const init = await rpc("initialize", { clientInfo: { name: "some-agent" } })
    const sid = init.headers.get("mcp-session-id")!
    await rpc("tools/call", { name: "board_write", arguments: { ops: [{ op: "create", type: "text", id: "shape:m2", text: "t" }] } }, { "Mcp-Session-Id": sid })
    await rpc("tools/call", { name: "board_write", arguments: { ops: [{ op: "create", type: "text", id: "shape:m3", text: "u" }] } })
    const shapes = result(await rpc("tools/call", { name: "board_read", arguments: {} })).structuredContent!.shapes as Array<{ id: string; text: string; by: string }>
    expect(shapes.map((s) => [s.id, s.text, s.by])).toEqual([["shape:m1", "hello", "mac:desk-1"], ["shape:m2", "t", "some-agent"], ["shape:m3", "u", "agent"]])
  })

  test("a bad op → isError with its index, nothing applied", async () => {
    const r = result(await rpc("tools/call", { name: "board_write", arguments: { ops: [{ op: "create", type: "note", id: "shape:m9" }, { op: "nope" }] } }))
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ ok: false, at: 1 })
    const shapes = result(await rpc("tools/call", { name: "board_read", arguments: { ids: ["shape:m9"] } })).structuredContent!.shapes as unknown[]
    expect(shapes).toEqual([])
  })

  test("invalid auto-layout-frame props (schema check on put) → isError with the op index, nothing applied", async () => {
    const r = result(await rpc("tools/call", { name: "board_write", arguments: { ops: [{ op: "create", type: "auto-layout-frame", id: "shape:fr1" }, { op: "create", type: "ui-block", parentId: "shape:fr1", props: { slug: "algarve-hero-1", sizingH: "stretch" } }] } }))
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ ok: false, at: 1 })
    expect(String(r.structuredContent!.error)).toContain("sizingH")
    expect(result(await rpc("tools/call", { name: "board_read", arguments: { ids: ["shape:fr1"] } })).structuredContent!.shapes).toEqual([])
  })

  test("board_asset → an MCP image block; an unknown file → isError", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")
    const saved = saveBoardAsset(png, "image/png")
    if (!saved.ok) throw new Error("save failed")
    const r = result(await rpc("tools/call", { name: "board_asset", arguments: { file: saved.file } }))
    expect(r.content[0]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" })
    expect(result(await rpc("tools/call", { name: "board_asset", arguments: { file: "../auth.token" } })).isError).toBe(true)
  })

  test("an unknown tool → JSON-RPC error", async () => {
    expect((await rpc("tools/call", { name: "nope" })).body.error).toMatchObject({ code: -32601 })
  })
})
