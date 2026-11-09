import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { Server, ServerWebSocket } from "bun"
import { createCanvasStore } from "../lib/canvas"
import type { Row } from "../lib/turso"
import { broadcast, clients, type WsData } from "../state"
import { type SendResult, createCanvasRoute } from "./canvas"

// Canvas REST round trip + the P5 check: two WS clients see the same move live.
// A real Bun server: the route over an in-memory store, notify = the real
// broadcast to the real `clients` set, two real WebSocket clients.

const store = createCanvasStore(new Database(":memory:"))
// Turso's real `notes` table (sqlite_master, 2026-10-30) behind the route's QueryFn.
const notes = new Database(":memory:")
notes.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, folder TEXT NOT NULL, filename TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  body TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')), ref_code TEXT DEFAULT NULL)`)
const SID = "sid-route"
const sent: string[] = []
let sendResult: SendResult | Error = { ok: true }
const route = createCanvasRoute({
  store, status: () => ({ "claude:tty:/dev/ttys001": "working" }), host: "testhost", notify: broadcast,
  references: (who) => (who.brain ? store.references("brain") : store.references({ key: who.key ?? "", sid: SID })),
  query: async (sql, args) => notes.query(sql).all(...(args as (string | number | null)[])) as Row[],
  send: async (edge) => {
    sent.push(edge.id)
    if (sendResult instanceof Error) throw sendResult
    return sendResult
  },
  pickNotify: async (node) => {
    picks.push(node.id)
    if (pickResult instanceof Error) throw pickResult
    return pickResult
  },
})
const picks: string[] = []
let pickResult: SendResult | null | Error = null
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
    expect(e.json.edge).toMatchObject({ kind: "reference", state: "linked", from: "note-1", to: aid })
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

  test("brain node (P7a): stored once by its fixed id; a note links to it as a reference", async () => {
    const brain = { id: "brain", kind: "brain", x: -700, y: -230, w: 360, h: 460 }
    const first = await call("POST", "/api/canvas/nodes", brain)
    expect(first.status).toBe(201)
    expect(first.json.node).toMatchObject({ id: "brain", kind: "brain", w: 360 })
    expect((await call("POST", "/api/canvas/nodes", { ...brain, x: 5 })).status).toBe(200)
    expect((await call("GET", "/api/canvas")).json.nodes).toEqual([expect.objectContaining({ id: "brain", x: -700 })])
    await call("POST", "/api/canvas/nodes", { id: "note-b", kind: "note", x: 0, y: 0, w: 1, h: 1, data: { text: "x" } })
    const link = await call("POST", "/api/canvas/edges", { from: "note-b", to: "brain" })
    expect(link.status).toBe(201)
    expect(link.json.edge).toMatchObject({ kind: "reference", state: "linked", from: "note-b", to: "brain" })
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
  test("only note|task → agent (and note → brain)", async () => {
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
    await call("POST", "/api/canvas/nodes", { kind: "task", ref: "task-2", x: 0, y: 0, w: 1, h: 1, id: "tap-note" })
    const e = (await call("POST", "/api/canvas/edges", { from: "tap-note", to: aid })).json.edge as { id: string }
    sent.length = 0
    sendResult = { ok: true }
    const [a, b] = await Promise.all([call("POST", `/api/canvas/edges/${e.id}/send`), call("POST", `/api/canvas/edges/${e.id}/send`)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(sent).toEqual([e.id])
    for (const id of [aid, "tap-note"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })

  test("a note link needs no Send?: /send answers 409 edge_linked and types nothing", async () => {
    const aid = ((await call("POST", "/api/canvas/nodes", agent)).json.node as { id: string }).id
    await call("POST", "/api/canvas/nodes", { kind: "note", x: 0, y: 0, w: 1, h: 1, id: "ref-note", data: { text: "x" } })
    const e = (await call("POST", "/api/canvas/edges", { kind: "context", from: "ref-note", to: aid })).json.edge as { id: string }
    sent.length = 0
    const r = await call("POST", `/api/canvas/edges/${e.id}/send`)
    expect(r.status).toBe(409)
    expect(r.json.error).toBe("edge_linked")
    expect(sent).toEqual([])
    for (const id of [aid, "ref-note"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })

  test("linked-notes: an agent's and the brain's linked notes, CURRENT content, scoped to the target", async () => {
    store.addNode({ id: "ln-agent", kind: "agent", ref: "claude:tty:/dev/ttys009", x: 0, y: 0, w: 1, h: 1, data: {}, boundSid: SID }, 1)
    await call("POST", "/api/canvas/nodes", { id: "ln-brain", kind: "brain", x: 0, y: 0, w: 1, h: 1 })
    await call("POST", "/api/canvas/nodes", { id: "ln-spec", kind: "turso_note", ref: "RES-LN01", x: 0, y: 0, w: 1, h: 1, data: { title: "Spec" } })
    await call("POST", "/api/canvas/nodes", { id: "ln-sticky", kind: "note", x: 0, y: 0, w: 1, h: 1, data: { text: "v1" } })
    await call("POST", "/api/canvas/nodes", { id: "ln-other", kind: "note", x: 0, y: 0, w: 1, h: 1, data: { text: "not linked" } })
    notes.query("INSERT INTO notes (id, folder, filename, title, body, ref_code) VALUES ('resources/ln', 'resources', 'ln.md', 'Spec', 'body v1', 'RES-LN01')").run()
    await call("POST", "/api/canvas/edges", { from: "ln-spec", to: "ln-agent" })
    await call("POST", "/api/canvas/edges", { from: "ln-sticky", to: "ln-brain" })

    const q = "?session=" + encodeURIComponent("claude:tty:/dev/ttys009")
    const list = await call("GET", "/api/canvas/linked-notes" + q)
    expect(list.json.notes).toEqual([expect.objectContaining({ nodeId: "ln-spec", ref: "RES-LN01", refCode: "RES-LN01", title: "Spec", body: "body v1", source: "turso" })])

    notes.query("UPDATE notes SET body = 'body v2' WHERE ref_code = 'RES-LN01'").run()
    expect((await call("GET", "/api/canvas/linked-notes/RES-LN01" + q)).json.note).toMatchObject({ body: "body v2" })
    expect((await call("GET", "/api/canvas/linked-notes/canvas:ln-other" + q)).status).toBe(404) // not linked to it

    await call("PATCH", "/api/canvas/nodes/ln-sticky", { data: { text: "v2" } })
    const brain = await call("GET", "/api/canvas/linked-notes?brain=1")
    expect(brain.json.notes).toEqual([expect.objectContaining({ nodeId: "ln-sticky", ref: "canvas:ln-sticky", source: "canvas", body: "v2" })])
    expect((await call("GET", "/api/canvas/linked-notes/canvas%3Aln-sticky?brain=1")).json.note).toMatchObject({ body: "v2" })
    expect((await call("GET", "/api/canvas/linked-notes/canvas%3Aln-sticky?brain=1")).json.content).toBeUndefined() // Phase 1 reply unchanged
    const rich = await call("GET", "/api/canvas/linked-notes/canvas%3Aln-sticky?brain=1&content=1")
    expect(rich.json).toMatchObject({ ok: true, note: { body: "v2" }, content: [{ type: "text", text: "v2" }], omitted: 0 })
    expect((await call("GET", "/api/canvas/linked-notes")).json.error).toBe("missing_target")
    for (const id of ["ln-agent", "ln-brain", "ln-spec", "ln-sticky", "ln-other"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })
})

describe("preview pick (design-first)", () => {
  const preview = (id: string, group: string, extra: Record<string, unknown> = {}) =>
    call("POST", "/api/canvas/nodes", { id, kind: "preview", ref: `http://zettlab:3147/${id}.html`, x: 0, y: 600, w: 1, h: 1, data: { title: id, direction: id, group, ...extra } })
  const data = (id: string): Record<string, unknown> => store.node(id)!.data

  const delayedPicks = () => {
    const deliveries: ReturnType<typeof Promise.withResolvers<SendResult>>[] = []
    const handle = createCanvasRoute({
      store, status: () => ({}), host: "testhost", notify: () => {}, references: () => [], query: async () => [],
      send: async () => ({ ok: true }), now: () => 42,
      pickNotify: () => {
        const delivery = Promise.withResolvers<SendResult>()
        deliveries.push(delivery)
        return delivery.promise
      },
    })
    const pick = async (id: string) => {
      const url = new URL(`/api/canvas/nodes/${id}/pick`, base)
      const response = (await handle(new Request(url.href, { method: "POST" }), url))!
      return { status: response.status, json: await response.json() as Record<string, unknown> }
    }
    return { deliveries, pick }
  }

  test("a delayed A success cannot settle a newer A claim after A -> B -> A", async () => {
    await preview("race-a", "race")
    await preview("race-b", "race")
    const { deliveries, pick } = delayedPicks()
    const firstA = pick("race-a")
    const b = pick("race-b")
    const latestA = pick("race-a")
    expect(deliveries).toHaveLength(3)
    deliveries[0]!.resolve({ ok: true })
    deliveries[1]!.resolve({ ok: true })
    await Promise.all([firstA, b])
    try {
      expect(await pick("race-a")).toMatchObject({ status: 200, json: { duplicate: true, delivered: false } })
    } finally {
      deliveries[2]!.resolve({ ok: false, status: 409, error: "pane_not_ready" })
      await latestA
    }
    const retry = pick("race-a")
    expect(deliveries).toHaveLength(4)
    deliveries[3]!.resolve({ ok: true })
    expect(await retry).toMatchObject({ status: 200, json: { delivered: true } })
    for (const id of ["race-a", "race-b"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })

  for (const state of ["sending", "sent"] as const) {
    for (const fields of [{}, { picked: false, pickedAt: -1 }]) {
      test(`a data PATCH preserves the ${state} pick claim (${Object.keys(fields).length ? "forged" : "omitted"} pick fields)`, async () => {
        const id = `patch-${state}-${Object.keys(fields).length}`
        await preview(id, id)
        const { deliveries, pick } = delayedPicks()
        const first = pick(id)
        if (state === "sent") {
          deliveries[0]!.resolve({ ok: true })
          await first
        }
        try {
          const patched = await call("PATCH", `/api/canvas/nodes/${id}`, { data: { title: "edited", ...fields } })
          expect(patched.json.node).toMatchObject({ data: { title: "edited", picked: true, pickedAt: 42 } })
          expect(await pick(id)).toMatchObject({ status: 200, json: { duplicate: true, delivered: state === "sent" } })
          expect(deliveries).toHaveLength(1)
        } finally {
          for (const delivery of deliveries) delivery.resolve({ ok: true })
          await first
          await call("DELETE", `/api/canvas/nodes/${id}`)
        }
      })
    }
  }

  test("404 / 400 invalid_kind / 400 invalid_id, nothing typed", async () => {
    picks.length = 0
    expect(await call("POST", "/api/canvas/nodes/nope/pick", {})).toMatchObject({ status: 404, json: { error: "not_found" } })
    await call("POST", "/api/canvas/nodes", { id: "pk-note", kind: "note", x: 0, y: 0, w: 1, h: 1 })
    expect(await call("POST", "/api/canvas/nodes/pk-note/pick", {})).toMatchObject({ status: 400, json: { error: "invalid_kind" } })
    expect(await call("POST", "/api/canvas/nodes/a%20b/pick", {})).toMatchObject({ status: 400, json: { error: "invalid_id" } })
    expect(data("pk-note").picked).toBeUndefined()
    expect(picks).toEqual([])
    await call("DELETE", "/api/canvas/nodes/pk-note")
  })

  test("group exclusivity + one node frame per changed node; delivered true/false", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
    const frames: Record<string, unknown>[] = []
    ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)))
    await new Promise((r) => { ws.onopen = r })
    for (const id of ["safe", "bold", "wild"]) await preview(id, "g1")
    await preview("other", "g2", { picked: true })
    const nodeFrames = async (n: number) => {
      for (let i = 0; i < 100 && frames.length < n; i++) await Bun.sleep(10)
      return frames.splice(0).map((f) => (f.node as { id: string; data: Record<string, unknown> }))
    }
    await nodeFrames(4)

    picks.length = 0
    pickResult = null
    const a = await call("POST", "/api/canvas/nodes/bold/pick", {})
    expect(a).toMatchObject({ status: 200, json: { ok: true, delivered: false, node: { id: "bold", data: { picked: true, pickedAt: expect.any(Number), direction: "bold" } } } })
    expect(data("safe").picked).toBe(false)
    expect(data("wild").picked).toBe(false)
    expect(data("other").picked).toBe(true) // another group is untouched
    expect((await nodeFrames(3)).map((n) => [n.id, n.data.picked])).toEqual([["bold", true], ["safe", false], ["wild", false]])

    pickResult = { ok: true }
    const b = await call("POST", "/api/canvas/nodes/wild/pick", {})
    expect(b).toMatchObject({ status: 200, json: { ok: true, delivered: true, node: { id: "wild", data: { picked: true } } } })
    expect(data("bold").picked).toBe(false)
    // safe was already false: only wild and bold change.
    expect((await nodeFrames(2)).map((n) => [n.id, n.data.picked])).toEqual([["wild", true], ["bold", false]])
    expect(picks).toEqual(["bold", "wild"])
    ws.close()
    for (const id of ["safe", "bold", "wild", "other"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })

  test("a double tap types once, concurrent or not; a failed delivery can be retried; a new pick re-claims", async () => {
    await preview("dt-a", "g4")
    await preview("dt-b", "g4")
    picks.length = 0
    pickResult = { ok: true }
    const [x, y] = await Promise.all(["a", "b"].map(() => call("POST", "/api/canvas/nodes/dt-a/pick", {})))
    expect([x!.status, y!.status]).toEqual([200, 200])
    expect([x!.json.duplicate, y!.json.duplicate].filter(Boolean)).toEqual([true])
    expect(picks).toEqual(["dt-a"])
    expect(await call("POST", "/api/canvas/nodes/dt-a/pick", {})).toMatchObject({ status: 200, json: { delivered: true, duplicate: true } })
    expect(picks).toEqual(["dt-a"])

    const claimed = store.pickNode("dt-b", 1)
    expect(claimed).toMatchObject({ ok: true, claimed: true })
    if (!claimed.ok || !claimed.claimed) throw new Error("pick was not claimed")
    expect(store.pickNode("dt-b", 2)).toMatchObject({ ok: true, claimed: false, sent: false, changed: [] })
    store.settlePick("dt-b", claimed.token, false)

    pickResult = { ok: false, status: 409, error: "pane_not_ready" }
    expect((await call("POST", "/api/canvas/nodes/dt-b/pick", {})).status).toBe(409)
    pickResult = { ok: true }
    expect(await call("POST", "/api/canvas/nodes/dt-b/pick", {})).toMatchObject({ status: 200, json: { delivered: true } })
    expect(picks).toEqual(["dt-a", "dt-b", "dt-b"])

    expect(await call("POST", "/api/canvas/nodes/dt-a/pick", {})).toMatchObject({ status: 200, json: { delivered: true } })
    expect(picks).toEqual(["dt-a", "dt-b", "dt-b", "dt-a"])
    pickResult = null
    for (const id of ["dt-a", "dt-b"]) await call("DELETE", `/api/canvas/nodes/${id}`)
  })

  test("inject refusals answer with /send's codes; the pick is still stored", async () => {
    await preview("pk-a", "g3")
    await preview("pk-b", "g3")
    for (const [res, status] of [
      [{ ok: false, status: 409, error: "pane_not_ready", detail: { ok: true, reason: "busy" } }, 409],
      [{ ok: false, status: 409, error: "dialog_open" }, 409],
      [{ ok: false, status: 410, error: "target_gone" }, 410],
    ] as const) {
      pickResult = res
      const r = await call("POST", "/api/canvas/nodes/pk-a/pick", {})
      expect(r.status).toBe(status)
      expect(r.json).toMatchObject({ ok: false, error: res.error, delivered: false, node: { id: "pk-a", data: { picked: true } } })
    }
    pickResult = new Error("boom")
    expect(await call("POST", "/api/canvas/nodes/pk-b/pick", {})).toMatchObject({ status: 503, json: { error: "send_failed", delivered: false } })
    expect(data("pk-b").picked).toBe(true)
    expect(data("pk-a").picked).toBe(false)
    pickResult = null
    for (const id of ["pk-a", "pk-b"]) await call("DELETE", `/api/canvas/nodes/${id}`)
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
