import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clients } from "./state"

// brain-v2 frames on connect (ws.ts): only with COMPANION_BRAIN=1, and always
// after init (iOS resets host state on init). Flag off: init and the frame
// order are exactly the shipped ones (ws.test.ts:121 pins that order).

type Ws = Parameters<typeof clients.add>[0]
let websocket: typeof import("./ws").websocket
let dialogWatcher: typeof import("./wiring/dialogs").dialogWatcher
const savedFlag = process.env.COMPANION_BRAIN

function open(): Array<Record<string, unknown>> {
  const got: Array<Record<string, unknown>> = []
  const ws = { send: (m: string) => { got.push(JSON.parse(m)) }, data: { id: "b", client: { remote: "100.64.0.9", ua: "CompanionTest/1", device: "test-phone" } } } as unknown as Ws
  websocket.open!(ws as never)
  clients.delete(ws)
  return got
}

beforeAll(async () => {
  process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "ws-brain-")), "test.db")
  websocket = (await import("./ws")).websocket
  dialogWatcher = (await import("./wiring/dialogs")).dialogWatcher
})
afterAll(() => {
  dialogWatcher.stop()
  if (savedFlag === undefined) delete process.env.COMPANION_BRAIN
  else process.env.COMPANION_BRAIN = savedFlag
})

test("flag off: no brain frames, no init.brain", () => {
  delete process.env.COMPANION_BRAIN
  const got = open()
  expect(got[0]!.type).toBe("init")
  expect("brain" in got[0]!).toBe(false)
  expect(got.some((f) => f.type === "brain" || f.type === "brain_trace")).toBe(false)
})

test("flag on: init (with brain) first, then brain, then the brain_trace snapshot", async () => {
  process.env.COMPANION_BRAIN = "1"
  const { upsertRow } = await import("./lib/brain-trace")
  upsertRow({ id: "turn:ws-brain", turnId: "ws-brain", kind: "turn", status: "pending", title: "hello" })
  const got = open()
  expect(got.slice(0, 3).map((f) => f.type)).toEqual(["init", "brain", "brain_trace"])
  expect(got[0]!.brain).toMatchObject({ state: expect.any(String), restarts: expect.any(Number) })
  expect(got[2]!.op).toBe("snapshot")
  expect((got[2]!.rows as Array<{ id: string }>).some((r) => r.id === "turn:ws-brain")).toBe(true)
  delete process.env.COMPANION_BRAIN
})
