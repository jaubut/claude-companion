import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clients } from "../state"

// The status frame rides the sessions listener and goes out only on a change.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-canvas-")), "test.db")
type Ws = Parameters<typeof clients.add>[0]
const got: Record<string, unknown>[] = []
const ws = { send: (m: string) => { got.push(JSON.parse(m)) } } as unknown as Ws
let canvas: typeof import("./canvas")
let sessions: typeof import("../lib/sessions")

beforeAll(async () => {
  canvas = await import("./canvas")
  sessions = await import("../lib/sessions")
  clients.add(ws)
})
afterAll(() => { clients.delete(ws) })

test("approval → needs-you frame; re-asserting it sends nothing; clearing → resting", () => {
  const s = sessions.recordSession({ cwd: "/tmp/canvas-wiring", tty: "/dev/pts/77" })!
  const statusFrames = () => got.filter((f) => f.type === "canvas" && f.op === "status")
  expect(canvas.canvasStatus()[s.key]).toBe("resting")

  got.length = 0
  sessions.setSessionWaiting(s.key, "approval", "a1")
  expect(statusFrames()).toEqual([{ type: "canvas", op: "status", status: expect.objectContaining({ [s.key]: "needs-you" }) }])
  sessions.setSessionWaiting(s.key, "turn-end")
  expect(statusFrames().length).toBe(1)
  sessions.clearSessionWaiting(s.key, "approval")
  expect(canvas.canvasStatus()[s.key]).toBe("resting")
  expect(statusFrames().length).toBe(2)
  sessions.removeSessionByKey(s.key)
})

test("send goes through the inject guards: an unregistered agent session is refused, nothing typed", async () => {
  const add = (kind: "agent" | "note", ref: string, data: Record<string, unknown> = {}) =>
    canvas.canvasStore.addNode({ kind, ref, x: 0, y: 0, w: 1, h: 1, data }, 1).node
  const note = add("note", "", { text: "hello" })
  const gone = add("agent", "claude:tty:/dev/pts/nope")
  const unbound = add("agent", "")
  for (const [to, error] of [[gone, "target_gone"], [unbound, "target_gone"]] as const) {
    const r = canvas.canvasStore.addEdge({ kind: "context", from: note.id, to: to.id }, 1)
    if (!r.ok) throw new Error(r.error)
    expect(await canvas.canvasSend(r.edge)).toMatchObject({ ok: false, status: 410, error })
  }
  for (const n of [note, gone, unbound]) canvas.canvasStore.removeNode(n.id)
})

test("snapshot: null on an empty board, the board once it has a node", () => {
  expect(canvas.canvasSnapshot()).toBeNull()
  const { node } = canvas.canvasStore.addNode({ kind: "note", ref: "", x: 1, y: 2, w: 3, h: 4, data: {} }, 1)
  expect(canvas.canvasSnapshot()).toMatchObject({ type: "canvas", op: "snapshot", nodes: [{ id: node.id }], edges: [] })
  canvas.canvasStore.removeNode(node.id)
})

test("snapshot: a canvas db error yields no frame instead of throwing (ws open keeps replaying)", () => {
  const nodes = canvas.canvasStore.nodes
  canvas.canvasStore.nodes = () => { throw new Error("SQLITE_CORRUPT") }
  try {
    expect(canvas.canvasSnapshot()).toBeNull()
  } finally {
    canvas.canvasStore.nodes = nodes
  }
})

test("send: a different agent on the bound session's tty → 409 target_changed, nothing typed; re-pointing rebinds", async () => {
  const first = sessions.recordSession({ cwd: "/tmp/canvas-bind", tty: "/dev/pts/78", sessionId: "sid-first" }, { sessionIdConfirmed: true })!
  const note = canvas.canvasStore.addNode({ kind: "note", ref: "", x: 0, y: 0, w: 1, h: 1, data: { text: "do the thing" } }, 1).node
  const agent = canvas.canvasStore.addNode({ kind: "agent", ref: first.key, x: 0, y: 0, w: 1, h: 1, data: {} }, 1).node
  expect(agent.boundSid).toBe("sid-first")

  // The first agent exits; a new one starts on the same tty (same Session.key, new sessionId).
  sessions.removeSessionByKey(first.key)
  const second = sessions.recordSession({ cwd: "/tmp/canvas-bind", tty: "/dev/pts/78", sessionId: "sid-second" }, { sessionIdConfirmed: true })!
  expect(second.key).toBe(first.key)

  const r = canvas.canvasStore.addEdge({ kind: "context", from: note.id, to: agent.id }, 1)
  if (!r.ok) throw new Error(r.error)
  expect(await canvas.canvasSend(r.edge)).toMatchObject({ ok: false, status: 409, error: "target_changed" })

  // Re-pointing the node at the session (same key) binds it to the new agent.
  expect(canvas.canvasStore.patchNode(agent.id, { ref: second.key }, 2)?.boundSid).toBe("sid-second")
  // A client-sent data patch never clears the binding.
  expect(canvas.canvasStore.patchNode(agent.id, { data: { label: "x" } }, 3)?.boundSid).toBe("sid-second")

  for (const n of [note, agent]) canvas.canvasStore.removeNode(n.id)
  sessions.removeSessionByKey(second.key)
})
