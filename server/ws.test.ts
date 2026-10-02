import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addApprovalRequest, getPending } from "./lib/pty-manager"
import { addQuestionRequest, getPendingQuestions } from "./lib/questions"
import { clients } from "./state"

// A late / duplicate / unknown decision must not be announced to every phone
// as if it happened: only the sender hears back, with `resolve_failed`.

type Ws = Parameters<typeof clients.add>[0]
let websocket: typeof import("./ws").websocket
let dialogWatcher: typeof import("./wiring/dialogs").dialogWatcher

function fakeWs(): { ws: Ws; got: Array<Record<string, unknown>> } {
  const got: Array<Record<string, unknown>> = []
  const ws = { send: (m: string) => { got.push(JSON.parse(m)) }, data: { id: "t", client: { remote: "100.64.0.9", ua: "CompanionTest/1", device: "test-phone" } } } as unknown as Ws
  return { ws, got }
}

const sender = fakeWs()
const bystander = fakeWs()

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "ws-res-")), "companion.db")
  websocket = (await import("./ws")).websocket
  dialogWatcher = (await import("./wiring/dialogs")).dialogWatcher
  clients.add(sender.ws)
  clients.add(bystander.ws)
})
afterAll(() => {
  // Importing ws.ts starts the dialog poller; don't leave it running.
  dialogWatcher.stop()
  clients.delete(sender.ws)
  clients.delete(bystander.ws)
})

const send = (msg: unknown) => websocket.message!(sender.ws as never, JSON.stringify(msg))

test("approve for an unknown / already-ended id: no broadcast, resolve_failed to the sender only", async () => {
  sender.got.length = 0; bystander.got.length = 0
  await send({ type: "approve", id: "no-such-id" })
  await send({ type: "deny", id: "no-such-id" })
  expect(bystander.got).toEqual([])
  expect(sender.got).toEqual([
    { type: "resolve_failed", id: "no-such-id", reason: "gone" },
    { type: "resolve_failed", id: "no-such-id", reason: "gone" },
  ])
})

test("a real approve broadcasts once; the duplicate tap gets resolve_failed and no second broadcast", async () => {
  const decided = addApprovalRequest({ agent: "claude", sessionId: "ws-1", tool: "Bash", input: {}, cwd: "/tmp", sessionKey: "k-ws-1" })
  const id = getPending().find((r) => r.sessionId === "ws-1")!.id
  sender.got.length = 0; bystander.got.length = 0
  await send({ type: "approve", id })
  expect(await decided).toBe("allow")
  await send({ type: "approve", id })
  const resolved = { type: "resolved", id, decision: "allow" }
  expect(bystander.got).toEqual([resolved])
  expect(sender.got).toEqual([resolved, { type: "resolve_failed", id, reason: "gone" }])
})

test("answer for a gone question: resolve_failed to the sender, nothing broadcast", async () => {
  const q = addQuestionRequest(
    { agent: "claude", sessionId: "ws-q", cwd: "/tmp", sessionKey: "k-ws-q", questions: [{ header: "h", question: "q?", multiSelect: false, options: [{ label: "a" }] }] },
    { expiryMs: 5 },
  )
  const id = getPendingQuestions().find((r) => r.sessionId === "ws-q")!.id
  expect(await q).toEqual([])
  sender.got.length = 0; bystander.got.length = 0
  await send({ type: "answer", id, answers: [{ selected: ["a"] }] })
  expect(bystander.got).toEqual([])
  expect(sender.got).toEqual([{ type: "resolve_failed", id, reason: "gone" }])
})
