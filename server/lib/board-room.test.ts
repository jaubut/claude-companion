import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The board room end to end on real sqlite (canvas-board-sync Verify 1 + 2):
// a scripted sync client (scripts/board-probe.ts) on an ephemeral port, the
// board MCP over HTTP, boardWrite, and a close/reopen on the same db.

const dir = mkdtempSync(join(tmpdir(), "cc-board-room-"))
process.env.COMPANION_DB_PATH = join(dir, "companion.db")
process.env.COMPANION_AUTH_TOKEN ||= "board-test-token-0123456789abcdef"

const { checkBearer, getAuthToken } = await import("./auth")
const { boardPresence, boardRecords, boardRoom, closeBoardRoom, importBoard } = await import("./board-room")
const { boardRead, boardWrite } = await import("./board-tools")
const { createBoardRoute } = await import("../routes/board")
const { boardClose, boardMessage, boardOpen } = await import("../wiring/board")
const { connectBoardProbe } = await import("../../scripts/board-probe")
type WsData = import("../state").WsData

// The cached token: another test file may have read the env first.
const TOKEN = getAuthToken()
const route = createBoardRoute({ enabled: () => true })
const server = Bun.serve<WsData>({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (!checkBearer(req)) return new Response("unauthorized", { status: 401 })
    if (url.pathname === "/api/board/sync") {
      const sessionId = url.searchParams.get("sessionId") ?? ""
      return srv.upgrade(req, { data: { id: sessionId, board: { sessionId } } }) ? undefined : new Response("no", { status: 500 })
    }
    return (await route(req, url)) ?? new Response("nf", { status: 404 })
  },
  websocket: { open: boardOpen, message: boardMessage, close: boardClose },
})
const base = `http://127.0.0.1:${server.port}`
afterAll(() => { server.stop(true); closeBoardRoom() })

async function mcp(method: string, params: Record<string, unknown>, caller = "test:mcp"): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/mcp/board`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Board-Caller": caller },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  })
  return await res.json() as Record<string, unknown>
}
const structured = (r: Record<string, unknown>) => (r.result as { structuredContent: Record<string, unknown> }).structuredContent

describe("board room realtime (probe ↔ MCP / boardWrite)", () => {
  const timings: Record<string, number> = {}
  let probe: Awaited<ReturnType<typeof connectBoardProbe>>
  let a = ""

  test("(a) a probe note is visible to board_read over MCP within 1 s", async () => {
    probe = await connectBoardProbe({ url: base, token: TOKEN, user: "Jeremie · Probe" })
    const t0 = performance.now()
    a = probe.note("probe-A", 100, 100)
    for (;;) {
      const shapes = structured(await mcp("tools/call", { name: "board_read", arguments: {} })).shapes as Array<{ id: string; text?: string }>
      if (shapes.some((s) => s.id === a && s.text === "probe-A")) break
      if (performance.now() - t0 > 1000) throw new Error("probe-A not read within 1 s")
      await Bun.sleep(10)
    }
    timings.a = performance.now() - t0
    expect(timings.a).toBeLessThanOrEqual(1000)
  })

  test("(b) boardWrite note + arrow reaches the probe (shape, arrow, 2 bindings) within 1 s", async () => {
    const t0 = performance.now()
    const out = await boardWrite([{ op: "create", type: "note", id: "shape:brainB", text: "brain-B", x: 400, y: 100 }, { op: "create", type: "arrow", from: a, to: "shape:brainB" }], "zettlab:brain")
    expect(out.ids).toHaveLength(4)
    timings.b = await probe.waitFor((recs) => recs.some((r) => r.id === "shape:brainB" && (r.meta as { by?: string }).by === "zettlab:brain")
      && recs.filter((r) => r.typeName === "binding").length === 2 && recs.some((r) => r.typeName === "shape" && r.type === "arrow"))
    timings.b = performance.now() - t0
    expect(timings.b).toBeLessThanOrEqual(1000)
  })

  test("(c) a live-frame write with html reaches the probe's props.html", async () => {
    const t0 = performance.now()
    await mcp("tools/call", { name: "board_write", arguments: { ops: [{ op: "create", type: "live-frame", id: "shape:frame1", html: "<p>hi</p>", title: "Hi", x: 0, y: 600 }] } })
    await probe.waitFor((recs) => recs.some((r) => r.id === "shape:frame1" && (r.props as { html?: string }).html === "<p>hi</p>"))
    timings.c = performance.now() - t0
    expect(timings.c).toBeLessThanOrEqual(1000)
  })

  test("(d) deleting A removes the bindings to A on the probe (the arrow's other end stays bound)", async () => {
    const t0 = performance.now()
    await boardWrite([{ op: "delete", id: a }], "test")
    const bindings = (recs: Array<{ typeName: string; toId?: unknown }>) => recs.filter((r) => r.typeName === "binding")
    await probe.waitFor((recs) => !recs.some((r) => r.id === a) && bindings(recs).length === 1 && !bindings(recs).some((b) => b.toId === a))
    timings.d = performance.now() - t0
    expect(bindings(boardRecords()).map((b) => b.toId)).toEqual(["shape:brainB"])
    expect(timings.d).toBeLessThanOrEqual(1000)
  })

  test("(e) probe presence selection → read focus returns it and presence[0].selection", async () => {
    const t0 = performance.now()
    probe.presence(["shape:brainB"])
    while (boardPresence().length === 0) {
      if (performance.now() - t0 > 1000) throw new Error("presence not seen within 1 s")
      await Bun.sleep(10)
    }
    timings.e = performance.now() - t0
    const read = boardRead({ focus: true })
    expect(read.shapes.map((s) => s.id)).toEqual(["shape:brainB"])
    expect(read.presence[0]!.selection).toEqual(["shape:brainB"])
    expect(read.presence[0]!.user).toBe("Jeremie · Probe")
    // No x/y: placed 80 px right of the selection (note at x 400, 200 wide).
    const placed = await boardWrite([{ op: "create", type: "note", text: "beside" }], "test")
    const view = boardRead({ ids: [placed.ids[0]!] }).shapes[0]!
    expect(view.x).toBe(680)
    expect(view.y).toBe(100)
    console.log(`board realtime timings (ms): ${Object.entries(timings).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ")}`)
    probe.close()
  })

  test("a restart keeps the shapes (same COMPANION_DB_PATH)", async () => {
    const before = boardRecords().filter((r) => r.typeName === "shape").map((r) => r.id).sort()
    expect(before.length).toBeGreaterThan(0)
    closeBoardRoom()
    expect(boardRecords(boardRoom()).filter((r) => r.typeName === "shape").map((r) => r.id).sort()).toEqual(before)
  })

  test("import: refused once the board has shapes; concurrent imports into an empty room → one wins", async () => {
    expect(await importBoard({ store: {}, schema: {} })).toEqual({ ok: false, status: 409, error: "board_not_empty" })
    await boardWrite(boardRecords().filter((r) => r.typeName === "shape" && String(r.parentId).startsWith("page:")).map((r) => ({ op: "delete" as const, id: r.id })), "test")
    const page = { id: "page:p1", typeName: "page", name: "Mine", index: "a1", meta: {} }
    const doc = { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} }
    const { buildShape } = await import("./board-records")
    const sticky = buildShape({ type: "note", parentId: "page:p1", index: "a1", x: 1, y: 2, text: "old", by: "mac" })
    const schema = (await import("./board-schema")).boardSchema.serialize()
    const snap = { document: { store: { [page.id]: page, [doc.id]: doc, [sticky.id]: sticky, "camera:x": { id: "camera:x", typeName: "camera" } }, schema } }
    const [r1, r2] = await Promise.all([importBoard(snap), importBoard(snap)])
    expect([r1, r2].filter((r) => r.ok)).toEqual([{ ok: true, imported: 1 }])
    expect([r1, r2].filter((r) => !r.ok)).toEqual([{ ok: false, status: 409, error: "board_not_empty" }])
    expect(boardRead({}).shapes.map((s) => s.text)).toEqual(["old"])
  })
})
