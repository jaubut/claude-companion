import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { Server, ServerWebSocket } from "bun"
import { createCanvasStore } from "../lib/canvas"
import { broadcast, clients, type WsData } from "../state"
import { type SendResult, createCanvasRoute } from "./canvas"

// Canvas REST round trip + the P5 check: two WS clients see the same move live.
// A real Bun server: the route over an in-memory store, notify = the real
// broadcast to the real `clients` set, two real WebSocket clients.

const store = createCanvasStore(new Database(":memory:"))
const sent: string[] = []
let sendResult: SendResult | Error = { ok: true }
const route = createCanvasRoute({
  store, status: () => ({ "claude:tty:/dev/ttys001": "working" }), host: "testhost", notify: broadcast,
  send: async (edge) => {
    sent.push(edge.id)
    if (sendResult instanceof Error) throw sendResult
    return sendResult
  },
})
let server: Server<WsData>
let base: string

beforeAll(() => {
  server = Bun.serve<WsData>({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/ws") return srv.upgrade(req, { data: { id: crypto.randomUUID() } }) ? undefined : new Response("no", { status: 500 })
      return (await route(req, url)) ?? new Response("Not found", { status: 404 })
    },
    websocket: {
      open: (ws: ServerWebSocket<WsData>) => { clients.add(ws) },
      message() {},
      close: (ws: ServerWebSocket<WsData>) => { clients.delete(ws) },
    },
  })
  base = `http://localhost:${server.port}`
})
afterAll(() => { server.stop(true) })

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, json: (await r.json()) as Record<string, unknown> }
}

const agent = { kind: "agent", ref: "claude:tty:/dev/ttys001", x: 10, y: 20, w: 300, h: 200, data: { host: "zettlab" } }

describe("REST", () => {
  test("create → list → patch → edge → delete node cascades its edge", async () => {
    const a = await call("POST", "/api/canvas/nodes", agent)
    expect(a.status).toBe(201)
    const aid = (a.json.node as { id: string }).id
    const n = await call("POST", "/api/canvas/nodes", { kind: "note", x: 0, y: 0, w: 100, h: 100, id: "note-1", data: { text: "hi" } })
    expect(n.status).toBe(201)
    expect((await call("POST", "/api/canvas/nodes", { kind: "note", x: 5, y: 5, w: 1, h: 1, id: "note-1" })).status).toBe(200)

    const list = await call("GET", "/api/canvas")
    expect(list.json).toMatchObject({ ok: true, host: "testhost", status: { "claude:tty:/dev/ttys001": "working" } })
    expect((list.json.nodes as unknown[]).length).toBe(2)
    expect(list.json.nodes).toContainEqual(expect.objectContaining({ id: "note-1", x: 0, data: { text: "hi" } }))

    const p = await call("PATCH", `/api/canvas/nodes/${aid}`, { x: 400.5, y: -12 })
    expect(p.json.node).toMatchObject({ id: aid, x: 400.5, y: -12, w: 300, ref: agent.ref, data: { host: "zettlab" } })

    const e = await call("POST", "/api/canvas/edges", { from: "note-1", to: aid })
    expect(e.status).toBe(201)
    expect(e.json.edge).toMatchObject({ kind: "context", from: "note-1", to: aid })
    expect((await call("POST", "/api/canvas/edges", { from: "note-1", to: aid })).status).toBe(409)
    expect((await call("POST", "/api/canvas/edges", { from: "note-1", to: "note-1" })).json.error).toBe("self_edge")
    expect((await call("POST", "/api/canvas/edges", { from: "note-1", to: "nope" })).status).toBe(404)

    const d = await call("DELETE", "/api/canvas/nodes/note-1")
    expect(d.json).toEqual({ ok: true, edgeIds: [(e.json.edge as { id: string }).id] })
    expect(store.edges()).toEqual([])
    expect((await call("DELETE", "/api/canvas/nodes/note-1")).status).toBe(404)
    expect((await call("DELETE", `/api/canvas/nodes/${aid}`)).status).toBe(200)
  })

  test("validation: bad kind / coords / sizes / data / empty patch / unknown edge kind", async () => {
    expect((await call("POST", "/api/canvas/nodes", { ...agent, kind: "bogus" })).json.error).toBe("invalid_kind")
    expect((await call("POST", "/api/canvas/nodes", { ...agent, x: "1" })).json.error).toBe("invalid_x")
    expect((await call("POST", "/api/canvas/nodes", { ...agent, w: 0 })).json.error).toBe("invalid_w")
    expect((await call("POST", "/api/canvas/nodes", { ...agent, data: [1] })).json.error).toBe("invalid_data")
    expect((await call("POST", "/api/canvas/nodes", { ...agent, data: { t: "x".repeat(20_000) } })).json.error).toBe("invalid_data")
    expect((await call("POST", "/api/canvas/edges", { from: "a", to: "b", kind: "handoff" })).json.error).toBe("invalid_kind")
    const a = await call("POST", "/api/canvas/nodes", agent)
    const id = (a.json.node as { id: string }).id
    expect((await call("PATCH", `/api/canvas/nodes/${id}`, {})).json.error).toBe("empty_patch")
    expect((await call("PATCH", `/api/canvas/nodes/${id}`, { y: Number.MAX_VALUE })).json.error).toBe("invalid_y")
    expect((await call("PATCH", "/api/canvas/nodes/missing", { x: 1 })).status).toBe(404)
    const bad = await fetch(`${base}/api/canvas/nodes`, { method: "POST", body: "{" })
    expect(bad.status).toBe(400)
    await call("DELETE", `/api/canvas/nodes/${id}`)
  })

  test("brain node (P7a): stored once by its fixed id, not an edge target yet", async () => {
    const brain = { id: "brain", kind: "brain", x: -700, y: -230, w: 360, h: 460 }
    const first = await call("POST", "/api/canvas/nodes", brain)
    expect(first.status).toBe(201)
    expect(first.json.node).toMatchObject({ id: "brain", kind: "brain", w: 360 })
    expect((await call("POST", "/api/canvas/nodes", { ...brain, x: 5 })).status).toBe(200)
    expect((await call("GET", "/api/canvas")).json.nodes).toEqual([expect.objectContaining({ id: "brain", x: -700 })])
    await call("POST", "/api/canvas/nodes", { id: "note-b", kind: "note", x: 0, y: 0, w: 1, h: 1, data: { text: "x" } })
    expect((await call("POST", "/api/canvas/edges", { from: "note-b", to: "brain" })).json.error).toBe("invalid_endpoints")
    await call("DELETE", "/api/canvas/nodes/note-b")
    expect((await call("DELETE", "/api/canvas/nodes/brain")).status).toBe(200)
  })

  test("client ids must match [A-Za-z0-9_-]+", async () => {
    for (const bad of ["a/b", "..", "."]) {
      const r = await call("POST", "/api/canvas/nodes", { ...agent, id: bad })
      expect(r.status).toBe(400)
      expect(r.json.error).toBe("invalid_id")
    }
    expect((await call("POST", "/api/canvas/nodes", { ...agent, id: "n_1-x" })).status).toBe(201)
    expect((await call("PATCH", "/api/canvas/nodes/n_1-x", { x: 1 })).status).toBe(200)
    expect((await call("DELETE", "/api/canvas/nodes/n_1-x")).status).toBe(200)
  })
})

describe("context edges (P6)", () => {
  test("only note|task → agent", async () => {
    const aid = ((await call("POST", "/api/canvas/nodes", agent)).json.node as { id: string }).id
    await call("POST", "/api/canvas/nodes", { kind: "note", x: 0, y: 0, w: 1, h: 1, id: "ep-note" })
    await call("POST", "/api/canvas/nodes", { kind: "preview", x: 0, y: 0, w: 1, h: 1, id: "ep-preview" })
    for (const [from, to] of [[aid, "ep-note"], ["ep-note", "ep-preview"], ["ep-preview", aid]]) {
      const r = await call("POST", "/api/canvas/edges", { from, to })
      expect(r.status).toBe(400)
      expect(r.json.error).toBe("invalid_endpoints")
    }
    for (const id of [aid, "ep-note", "ep-preview"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })

  test("proposed → Send? → sent once; a refusal leaves it failed and re-sendable", async () => {
    const aid = ((await call("POST", "/api/canvas/nodes", agent)).json.node as { id: string }).id
    await call("POST", "/api/canvas/nodes", { kind: "task", ref: "task-1", x: 0, y: 0, w: 1, h: 1, id: "send-task" })
    const e = (await call("POST", "/api/canvas/edges", { from: "send-task", to: aid })).json.edge as { id: string; state: string }
    expect(e.state).toBe("proposed")
    sent.length = 0

    sendResult = { ok: false, status: 409, error: "pane_not_ready", detail: { reason: "busy", ok: true } }
    const refused = await call("POST", `/api/canvas/edges/${e.id}/send`)
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ ok: false, error: "pane_not_ready", reason: "busy", edge: { state: "failed", error: "pane_not_ready" } })

    sendResult = new Error("turso down")
    const thrown = await call("POST", `/api/canvas/edges/${e.id}/send`)
    expect(thrown.status).toBe(503)
    expect(store.edge(e.id)).toMatchObject({ state: "failed", error: "send_failed" })

    sendResult = { ok: true }
    const ok = await call("POST", `/api/canvas/edges/${e.id}/send`)
    expect(ok.status).toBe(200)
    expect(ok.json.edge).toMatchObject({ state: "sent", error: "", sentAt: expect.any(Number) })
    const again = await call("POST", `/api/canvas/edges/${e.id}/send`)
    expect(again.status).toBe(409)
    expect(again.json.error).toBe("edge_sent")
    expect(sent).toEqual([e.id, e.id, e.id])

    expect((await call("POST", "/api/canvas/edges/nope/send")).status).toBe(404)
    for (const id of [aid, "send-task"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })

  test("a double tap types once", async () => {
    const aid = ((await call("POST", "/api/canvas/nodes", agent)).json.node as { id: string }).id
    await call("POST", "/api/canvas/nodes", { kind: "note", x: 0, y: 0, w: 1, h: 1, id: "tap-note", data: { text: "x" } })
    const e = (await call("POST", "/api/canvas/edges", { from: "tap-note", to: aid })).json.edge as { id: string }
    sent.length = 0
    sendResult = { ok: true }
    const [a, b] = await Promise.all([call("POST", `/api/canvas/edges/${e.id}/send`), call("POST", `/api/canvas/edges/${e.id}/send`)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(sent).toEqual([e.id])
    for (const id of [aid, "tap-note"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })
})

describe("live", () => {
  test("two clients see the same node move", async () => {
    const open = (): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> => new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
      const frames: Record<string, unknown>[] = []
      ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)))
      ws.onopen = () => resolve({ ws, frames })
    })
    const [one, two] = await Promise.all([open(), open()])
    while (clients.size < 2) await Bun.sleep(5)

    const id = ((await call("POST", "/api/canvas/nodes", agent)).json.node as { id: string }).id
    await call("PATCH", `/api/canvas/nodes/${id}`, { x: 777, y: 888 })

    const moved = (f: Record<string, unknown>): boolean => f.op === "node" && (f.node as { x: number }).x === 777
    for (let i = 0; i < 100 && !(one.frames.some(moved) && two.frames.some(moved)); i++) await Bun.sleep(10)
    for (const c of [one, two]) {
      expect(c.frames.map((f) => f.op)).toEqual(["node", "node"])
      expect(c.frames.find(moved)).toMatchObject({ type: "canvas", op: "node", node: { id, x: 777, y: 888 } })
    }
    one.ws.close()
    two.ws.close()
  })
})
