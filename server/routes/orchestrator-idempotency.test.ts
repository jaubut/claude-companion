import { test, expect, beforeAll, beforeEach, mock } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetIdempotency, withIdempotency } from "../lib/idempotency"

// Idempotency-Key on the orchestrator POSTs (iOS outbox round 5,
// claude-companion-ios#41). Runs the real route + real sqlite; only the
// wiring module is stubbed (it spawns tmux workers, calls the model and
// starts timers at import time), with counters on runBrain and admit.

let brainRuns = 0
let admitRuns = 0
let admitResult: { status: "queued" } | { status: "dispatched"; ok: boolean; error?: string } = { status: "queued" }
let emitThrows = 0

mock.module("../wiring/orchestrator", () => ({
  WIP_CAP: 3,
  emitChannel: () => {},
  emitTask: () => {},
  executeDispatch: async () => ({ ok: true }),
  orchEmit: () => {
    if (emitThrows > 0) { emitThrows--; throw new Error("emit boom") }
  },
  runBrain: async () => { brainRuns++ },
  workerQueue: {
    cap: 3,
    admit: async () => { admitRuns++; return admitResult },
    drain: async () => 0,
  },
}))

type Chat = typeof import("../lib/orchestrator-chat")
let chat: Chat
let handleOrchestratorRoute: (req: Request, url: URL) => Promise<Response | null>

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "orch-idem-")), "companion.db")
  chat = await import("../lib/orchestrator-chat")
  handleOrchestratorRoute = (await import("./orchestrator")).handleOrchestratorRoute
})
beforeEach(() => {
  resetIdempotency()
  brainRuns = 0
  admitRuns = 0
  admitResult = { status: "queued" }
  emitThrows = 0
})

async function post(path: string, body: unknown, key?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (key !== undefined) headers["idempotency-key"] = key
  const req = new Request(`http://localhost:4245${path}`, { method: "POST", headers, body: JSON.stringify(body) })
  return (await handleOrchestratorRoute(req, new URL(req.url)))!
}

const replayed = (r: Response) => r.headers.get("Idempotent-Replayed")
const userTurns = (channel: string, text: string) =>
  chat.getThread(channel).filter((t) => t.role === "user" && t.text === text).length

// ── /api/orchestrator/send ──

test("send: same key twice runs the turn once; the repeat is a replay of the same status + body", async () => {
  const first = await post("/api/orchestrator/send", { text: "idem send 1" }, "s-k1")
  const second = await post("/api/orchestrator/send", { text: "idem send 1" }, "s-k1")
  expect(brainRuns).toBe(1)
  expect(userTurns("general", "idem send 1")).toBe(1)
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(replayed(first)).toBeNull()
  expect(replayed(second)).toBe("true")
  expect(await second.text()).toBe(await first.text())
})

test("send: concurrent same-key requests run once", async () => {
  const [a, b] = await Promise.all([
    post("/api/orchestrator/send", { text: "idem send 2" }, "s-k2"),
    post("/api/orchestrator/send", { text: "idem send 2" }, "s-k2"),
  ])
  expect(brainRuns).toBe(1)
  expect(userTurns("general", "idem send 2")).toBe(1)
  expect(await a.text()).toBe(await b.text())
})

test("send: a refusal is not remembered — the retry runs once the channel exists", async () => {
  const refused = await post("/api/orchestrator/send", { text: "idem send 3", channel: "idem-later" }, "s-k3")
  expect(refused.status).toBe(404)
  const again = await post("/api/orchestrator/send", { text: "idem send 3", channel: "idem-later" }, "s-k3")
  expect(again.status).toBe(404)
  expect(replayed(again)).toBeNull()
  expect(brainRuns).toBe(0)

  const ch = chat.createChannel("idem later")
  expect(ch.id).toBe("idem-later")
  const delivered = await post("/api/orchestrator/send", { text: "idem send 3", channel: "idem-later" }, "s-k3")
  expect(delivered.status).toBe(200)
  expect(replayed(delivered)).toBeNull()
  expect(brainRuns).toBe(1)
  const replay = await post("/api/orchestrator/send", { text: "idem send 3", channel: "idem-later" }, "s-k3")
  expect(replayed(replay)).toBe("true")
  expect(brainRuns).toBe(1)
})

test("send: a failure (throw → 5xx) is not remembered — the retry runs", async () => {
  emitThrows = 1
  await expect(post("/api/orchestrator/send", { text: "idem send 4" }, "s-k4")).rejects.toThrow("emit boom")
  const retry = await post("/api/orchestrator/send", { text: "idem send 4" }, "s-k4")
  expect(retry.status).toBe(200)
  expect(replayed(retry)).toBeNull()
  expect(brainRuns).toBe(1)
})

test("send: no header behaves exactly as before — runs every time, never flagged", async () => {
  const a = await post("/api/orchestrator/send", { text: "idem send 5" })
  const b = await post("/api/orchestrator/send", { text: "idem send 5" })
  expect(brainRuns).toBe(2)
  expect(userTurns("general", "idem send 5")).toBe(2)
  expect(replayed(a)).toBeNull()
  expect(replayed(b)).toBeNull()
})

test("keys are scoped per endpoint: /api/inject and /api/orchestrator/send never collide", async () => {
  let injects = 0
  const inject = async () => { injects++; return Response.json({ ok: true, confirmed: true }) }
  const injReq = () => new Request("http://localhost:4245/api/inject", { method: "POST", headers: { "idempotency-key": "shared-k" } })

  await withIdempotency(injReq(), "inject", inject)
  const send = await post("/api/orchestrator/send", { text: "idem send 6" }, "shared-k")
  expect(replayed(send)).toBeNull()
  expect(brainRuns).toBe(1)
  expect((await send.json() as { turn?: unknown }).turn).toBeDefined()

  const inj2 = await withIdempotency(injReq(), "inject", inject)
  expect(injects).toBe(1)
  expect(replayed(inj2)).toBe("true")

  // …and across orchestrator endpoints: the same key on /dispatch runs too.
  const dispatch = await post("/api/orchestrator/dispatch", { prompt: "idem p", cwd: "/tmp" }, "shared-k")
  expect(replayed(dispatch)).toBeNull()
  expect(admitRuns).toBe(1)
})

// ── /api/orchestrator/dispatch ──

test("dispatch: same key creates one task; 5xx spawn failures are not remembered", async () => {
  const before = chat.listTasks("general").length
  await post("/api/orchestrator/dispatch", { prompt: "idem d1", cwd: "/tmp" }, "d-k1")
  const replay = await post("/api/orchestrator/dispatch", { prompt: "idem d1", cwd: "/tmp" }, "d-k1")
  expect(replayed(replay)).toBe("true")
  expect(admitRuns).toBe(1)
  expect(chat.listTasks("general").length).toBe(before + 1)

  admitResult = { status: "dispatched", ok: false, error: "spawn failed" }
  const f1 = await post("/api/orchestrator/dispatch", { prompt: "idem d2", cwd: "/tmp" }, "d-k2")
  const f2 = await post("/api/orchestrator/dispatch", { prompt: "idem d2", cwd: "/tmp" }, "d-k2")
  expect([f1.status, f2.status]).toEqual([500, 500])
  expect(replayed(f2)).toBeNull()
  expect(admitRuns).toBe(3)
})

// ── proposal approve/reject, task cancel ──

test("proposal approve: a lost-response retry replays the success instead of a 409", async () => {
  const task = chat.createProposal("idem approve", "/tmp", "why", "general")
  const path = `/api/orchestrator/proposal/${task.taskId}/approve`
  const first = await post(path, {}, "p-k1")
  expect(first.status).toBe(200)
  // The fake admit doesn't move the task on; do what the real queue does.
  chat.setTaskStatus(task.taskId, "queued")
  const second = await post(path, {}, "p-k1")
  expect(second.status).toBe(200)
  expect(replayed(second)).toBe("true")
  expect(admitRuns).toBe(1)
  // Without a key the retry sees the state as before: 409.
  expect((await post(path, {})).status).toBe(409)
})

test("proposal reject: replayed on retry; a 409 refusal is never remembered", async () => {
  const task = chat.createProposal("idem reject", "/tmp", "why", "general")
  const path = `/api/orchestrator/proposal/${task.taskId}/reject`
  await post(path, {}, "p-k2")
  const again = await post(path, {}, "p-k2")
  expect(again.status).toBe(200)
  expect(replayed(again)).toBe("true")

  const r1 = await post(path, {}, "p-k3")
  const r2 = await post(path, {}, "p-k3")
  expect([r1.status, r2.status]).toEqual([409, 409])
  expect(replayed(r2)).toBeNull()
})

test("task cancel: replayed on retry; the same key on another task's cancel is not a collision", async () => {
  const a = chat.createQueuedTask("idem cancel a", "/tmp", "general")
  const b = chat.createQueuedTask("idem cancel b", "/tmp", "general")
  const first = await post(`/api/orchestrator/task/${a.taskId}/cancel`, {}, "c-k1")
  const second = await post(`/api/orchestrator/task/${a.taskId}/cancel`, {}, "c-k1")
  expect(first.status).toBe(200)
  expect(replayed(second)).toBe("true")
  expect(await second.json()).toEqual({ ok: true, taskId: a.taskId, status: "cancelled" })

  const other = await post(`/api/orchestrator/task/${b.taskId}/cancel`, {}, "c-k1")
  expect(replayed(other)).toBeNull()
  expect(chat.getTask(b.taskId)?.status).toBe("cancelled")
})

// ── channel create, auto toggle ──

test("channel create: same key creates one channel", async () => {
  const before = chat.listChannels().length
  const first = await post("/api/orchestrator/channels", { name: "Idem Chan" }, "ch-k1")
  const second = await post("/api/orchestrator/channels", { name: "Idem Chan" }, "ch-k1")
  expect(replayed(second)).toBe("true")
  expect(await second.text()).toBe(await first.text())
  expect(chat.listChannels().length).toBe(before + 1)
})

test("auto toggle: same key appends the ON note once", async () => {
  const ch = chat.createChannel("idem auto")
  const path = `/api/orchestrator/channels/${ch.id}/auto`
  await post(path, { enabled: true }, "a-k1")
  const second = await post(path, { enabled: true }, "a-k1")
  expect(replayed(second)).toBe("true")
  expect(chat.getChannel(ch.id)?.autoDispatch).toBe(true)
  expect(chat.getThread(ch.id).filter((t) => t.text.startsWith("auto-dispatch ON")).length).toBe(1)
})
