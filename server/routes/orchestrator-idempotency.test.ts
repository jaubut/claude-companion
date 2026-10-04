import { test as bunTest, expect, beforeAll, beforeEach, mock } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetIdempotency, withIdempotency } from "../lib/idempotency"

// Idempotency-Key on the orchestrator POSTs (iOS outbox round 5,
// claude-companion-ios#41). Runs the real route + real sqlite; only the front
// door is stubbed (it routes to Jev / the brain, i.e. calls the model), with a
// counter standing in for "the orchestrator turn ran".
//
// Isolation: bun test shares one module registry across files, so importing
// orchestrator-chat here would bind its sqlite singleton (and the front-door
// mock.module) for every later file — e.g. breaking orchestrator-chat.test.ts's
// legacy-DB migration fixture. In the shared run this file therefore registers
// ONE test that re-runs itself in a child `bun test` with its own
// COMPANION_DB_PATH; the real cases only register inside that child.
const CHILD = process.env.ORCH_IDEM_CHILD === "1"
const test = (CHILD ? bunTest : () => {}) as typeof bunTest

if (!CHILD) {
  bunTest("orchestrator idempotency suite passes in an isolated process", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "orch-idem-")), "companion.db")
    const run = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: import.meta.dir,
      env: { ...process.env, ORCH_IDEM_CHILD: "1", COMPANION_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = run.stdout.toString() + run.stderr.toString()
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(/\b0 fail\b/)
    expect(out).toMatch(/\b[1-9]\d* pass\b/)
  }, 60_000)
}

let doorRuns = 0
let doorThrows = 0

if (CHILD) mock.module("../wiring/front-door", () => ({
  frontDoor: {
    handle: () => {
      if (doorThrows > 0) { doorThrows--; throw new Error("door boom") }
      doorRuns++
      return Promise.resolve()
    },
  },
}))

let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let handleOrchestratorRoute: (req: Request, url: URL) => Promise<Response | null>

if (CHILD) beforeAll(async () => {
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  handleOrchestratorRoute = (await import("./orchestrator")).handleOrchestratorRoute
})
if (CHILD) beforeEach(() => {
  resetIdempotency()
  doorRuns = 0
  doorThrows = 0
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
  expect(doorRuns).toBe(1)
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
  expect(doorRuns).toBe(1)
  expect(userTurns("general", "idem send 2")).toBe(1)
  expect(await a.text()).toBe(await b.text())
})

test("send: a refusal is not remembered — the retry runs once the channel exists", async () => {
  const refused = await post("/api/orchestrator/send", { text: "idem send 3", channel: "idem-later" }, "s-k3")
  expect(refused.status).toBe(404)
  const again = await post("/api/orchestrator/send", { text: "idem send 3", channel: "idem-later" }, "s-k3")
  expect(again.status).toBe(404)
  expect(replayed(again)).toBeNull()
  expect(doorRuns).toBe(0)

  const ch = channels.createChannel("idem later")
  expect(ch.id).toBe("idem-later")
  const delivered = await post("/api/orchestrator/send", { text: "idem send 3", channel: "idem-later" }, "s-k3")
  expect(delivered.status).toBe(200)
  expect(replayed(delivered)).toBeNull()
  expect(doorRuns).toBe(1)
  const replay = await post("/api/orchestrator/send", { text: "idem send 3", channel: "idem-later" }, "s-k3")
  expect(replayed(replay)).toBe("true")
  expect(doorRuns).toBe(1)
})

test("send: a failure (throw → 5xx) is not remembered — the retry runs", async () => {
  doorThrows = 1
  await expect(post("/api/orchestrator/send", { text: "idem send 4" }, "s-k4")).rejects.toThrow("door boom")
  const retry = await post("/api/orchestrator/send", { text: "idem send 4" }, "s-k4")
  expect(retry.status).toBe(200)
  expect(replayed(retry)).toBeNull()
  expect(doorRuns).toBe(1)
})

test("send: no header behaves exactly as before — runs every time, never flagged", async () => {
  const a = await post("/api/orchestrator/send", { text: "idem send 5" })
  const b = await post("/api/orchestrator/send", { text: "idem send 5" })
  expect(doorRuns).toBe(2)
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
  expect(doorRuns).toBe(1)
  expect((await send.json() as { turn?: unknown }).turn).toBeDefined()

  const inj2 = await withIdempotency(injReq(), "inject", inject)
  expect(injects).toBe(1)
  expect(replayed(inj2)).toBe("true")

  // …and across orchestrator endpoints: the same key on /channels runs too.
  const before = channels.listChannels().length
  const created = await post("/api/orchestrator/channels", { name: "Idem Shared" }, "shared-k")
  expect(replayed(created)).toBeNull()
  expect(channels.listChannels().length).toBe(before + 1)
})

// ── dispatch, proposal reject, task cancel ──

test("dispatch: a refusal (no project) is never remembered", async () => {
  const r1 = await post("/api/orchestrator/dispatch", { prompt: "idem d1" }, "d-k1")
  const r2 = await post("/api/orchestrator/dispatch", { prompt: "idem d1" }, "d-k1")
  expect([r1.status, r2.status]).toEqual([422, 422])
  expect(replayed(r2)).toBeNull()
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
  const a = chat.createTask("idem cancel a", "/tmp")
  const b = chat.createTask("idem cancel b", "/tmp")
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
  const before = channels.listChannels().length
  const first = await post("/api/orchestrator/channels", { name: "Idem Chan" }, "ch-k1")
  const second = await post("/api/orchestrator/channels", { name: "Idem Chan" }, "ch-k1")
  expect(replayed(second)).toBe("true")
  expect(await second.text()).toBe(await first.text())
  expect(channels.listChannels().length).toBe(before + 1)
})

test("auto toggle: same key appends the ON note once", async () => {
  const ch = channels.createChannel("idem auto")
  const path = `/api/orchestrator/channels/${ch.id}/auto`
  await post(path, { enabled: true }, "a-k1")
  const second = await post(path, { enabled: true }, "a-k1")
  expect(replayed(second)).toBe("true")
  expect(channels.getChannel(ch.id)?.autoDispatch).toBe(true)
  expect(chat.getThread(ch.id).filter((t) => t.text.startsWith("auto-dispatch ON")).length).toBe(1)
})
