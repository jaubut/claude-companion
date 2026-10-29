import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clients } from "../state"

// brain-v2 send branch (routes/orchestrator.ts): the brain thread goes to the
// supervised brain's outbox, never the front door; the user turn is persisted
// and emitted exactly as before; 200 even with the brain down; an
// Idempotency-Key replay never enqueues twice. Plus appendTurn without a card
// stays byte-identical.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-send-")), "test.db")

let handler: (req: Request, url: URL) => Promise<Response | null>
let chat: typeof import("../lib/orchestrator-chat")
let sqlite: typeof import("../lib/orchestrator-db")["db"]
let frontDoor: typeof import("../wiring/front-door")["frontDoor"]
let realHandle: typeof frontDoor.handle
let frontDoorCalls: string[] = []
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Parameters<typeof clients.add>[0]

beforeAll(async () => {
  chat = await import("../lib/orchestrator-chat")
  sqlite = (await import("../lib/orchestrator-db")).db
  ;(await import("../lib/orchestrator-channels")).ensureChannel("brain", "Brain")
  frontDoor = (await import("../wiring/front-door")).frontDoor
  realHandle = frontDoor.handle
  frontDoor.handle = (async (text: string) => { frontDoorCalls.push(text) }) as typeof frontDoor.handle
  handler = (await import("./orchestrator")).handleOrchestratorRoute
  clients.add(fake)
})
afterAll(() => {
  frontDoor.handle = realHandle
  clients.delete(fake)
})
beforeEach(() => {
  frontDoorCalls = []
  frames.length = 0
  sqlite.exec("DELETE FROM brain_outbox")
})

async function send(body: unknown, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/api/orchestrator/send", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  const res = await handler(req, new URL(req.url))
  return { status: res!.status, json: await res!.json() as { ok: boolean; turn: import("../lib/orchestrator-chat").Turn } }
}

const outbox = () => sqlite.query("SELECT turn_id FROM brain_outbox").all() as { turn_id: string }[]

test("brain send: persisted + emitted user turn, enqueued for the brain, never the front door, 200 with the brain down", async () => {
  const r = await send({ text: "what's blocked?", channel: "brain" })
  expect(r.status).toBe(200)
  expect(r.json.ok).toBe(true)
  expect(r.json.turn).toMatchObject({ threadId: "brain", role: "user", text: "what's blocked?", taskId: null })
  expect(r.json.turn.card).toBeUndefined()
  expect(frames.filter((f) => f.type === "orchestrator").map((f) => (f.turn as { id: string }).id)).toContain(r.json.turn.id)
  expect(outbox().map((o) => o.turn_id)).toEqual([r.json.turn.id])
  expect(frontDoorCalls).toEqual([])
})

test("voice: {durationMs, locale} → the turn's voice card; malformed fields dropped", async () => {
  const r = await send({ text: "dispatch it", channel: "brain", voice: { durationMs: 31000.4, locale: "fr-CA" } })
  expect(r.json.turn.card).toEqual({ kind: "voice", source: "app", durationMs: 31000, locale: "fr-CA" })
  expect(chat.getTurn(r.json.turn.id)!.card).toEqual(r.json.turn.card)
  const bad = await send({ text: "dispatch it", channel: "brain", voice: { durationMs: -5, locale: "fr;rm" } })
  expect(bad.json.turn.card).toEqual({ kind: "voice", source: "app" })
})

test("a replayed Idempotency-Key returns the cached answer and enqueues once", async () => {
  const h = { "idempotency-key": `brain-send-${Date.now()}` }
  const a = await send({ text: "once", channel: "brain" }, h)
  const b = await send({ text: "once", channel: "brain" }, h)
  expect(b.json.turn.id).toBe(a.json.turn.id)
  expect(outbox()).toHaveLength(1)
})

test("other channels keep the front door, and get no card even with voice", async () => {
  const r = await send({ text: "hello general", channel: "general", voice: { durationMs: 10 } })
  expect(r.status).toBe(200)
  expect(r.json.turn.card).toBeUndefined()
  await Bun.sleep(1)
  expect(frontDoorCalls).toEqual(["hello general"])
  expect(outbox()).toEqual([])
})

test("appendTurn without a card is byte-identical to the pre-brain shape (row and JSON)", () => {
  const t = chat.appendTurn("orchestrator", "plain", "abc12345", "general")
  expect(Object.keys(t)).toEqual(["id", "threadId", "role", "text", "taskId", "createdAt"])
  const back = chat.getThread("general").find((x) => x.id === t.id)!
  expect(JSON.stringify(back)).toBe(JSON.stringify(t))
  const row = sqlite.query("SELECT card FROM orchestrator_turns WHERE id = ?").get(t.id) as { card: string | null }
  expect(row.card).toBeNull()
})

test("reserved channel names are refused; the brain channel cannot be linked", async () => {
  const req = new Request("http://localhost/api/orchestrator/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Brain" }) })
  const res = await handler(req, new URL(req.url))
  expect(res!.status).toBe(409)
  const link = new Request("http://localhost/api/orchestrator/channels/brain/link", { method: "POST", body: JSON.stringify({ noteId: null }) })
  expect((await handler(link, new URL(link.url)))!.status).toBe(400)
  const { createChannel } = await import("../lib/orchestrator-channels")
  const made = createChannel("Body")
  sqlite.query("DELETE FROM orchestrator_channels WHERE id = ?").run(made.id)
  expect(made.id).toBe("body-2")
})
