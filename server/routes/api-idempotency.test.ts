import { test, expect, beforeAll, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_KEY_LENGTH, TTL_MS, resetIdempotency, withIdempotency } from "../lib/idempotency"
import { addQuestionRequest, onQuestionRequest, onQuestionResolved } from "../lib/questions"
import { addApprovalRequest, getPending } from "../lib/pty-manager"

// Idempotency-Key on POST /api/inject and /api/answer (iOS outbox retries,
// claude-companion-ios#33). The inject side is driven through withIdempotency
// with a counting handler (a real inject needs a live tmux pane); the answer
// side runs through the real route.

let handleApiRoute: (req: Request, url: URL) => Promise<Response | null>

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "api-idem-")), "companion.db")
  handleApiRoute = (await import("./api")).handleApiRoute
})
beforeEach(() => resetIdempotency())

function post(path: string, body: unknown, key?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (key !== undefined) headers["idempotency-key"] = key
  return new Request(`http://localhost:4245${path}`, { method: "POST", headers, body: JSON.stringify(body) })
}

/** Stand-in for the inject handler: counts runs, answers like a delivered inject. */
function countingInject(status = 200, delayMs = 0) {
  let runs = 0
  const handler = async (): Promise<Response> => {
    runs++
    if (delayMs) await Bun.sleep(delayMs)
    return Response.json({ ok: status < 400, confirmed: true, run: runs }, { status })
  }
  return { handler, runs: () => runs }
}

test("inject: same key twice runs once and replays identical status + body with the replay header", async () => {
  const inj = countingInject()
  const first = await withIdempotency(post("/api/inject", { text: "hi" }, "k1"), "inject", inj.handler)
  const second = await withIdempotency(post("/api/inject", { text: "hi" }, "k1"), "inject", inj.handler)
  expect(inj.runs()).toBe(1)
  expect(first.headers.get("Idempotent-Replayed")).toBeNull()
  expect(second.headers.get("Idempotent-Replayed")).toBe("true")
  expect(second.status).toBe(first.status)
  expect(second.headers.get("content-type")).toBe(first.headers.get("content-type"))
  expect(await second.text()).toBe(await first.text())
})

test("inject: two concurrent same-key requests share the first result and run once", async () => {
  const inj = countingInject(200, 20)
  const [a, b] = await Promise.all([
    withIdempotency(post("/api/inject", { text: "hi" }, "k2"), "inject", inj.handler),
    withIdempotency(post("/api/inject", { text: "hi" }, "k2"), "inject", inj.handler),
  ])
  expect(inj.runs()).toBe(1)
  expect(await a.text()).toBe(await b.text())
  expect([a.headers.get("Idempotent-Replayed"), b.headers.get("Idempotent-Replayed")]).toEqual([null, "true"])
})

test("inject: a different key runs again; no key behaves exactly as before (runs every time, no header)", async () => {
  const inj = countingInject()
  await withIdempotency(post("/api/inject", { text: "hi" }, "k3"), "inject", inj.handler)
  await withIdempotency(post("/api/inject", { text: "hi" }, "k4"), "inject", inj.handler)
  expect(inj.runs()).toBe(2)
  const n1 = await withIdempotency(post("/api/inject", { text: "hi" }), "inject", inj.handler)
  const n2 = await withIdempotency(post("/api/inject", { text: "hi" }), "inject", inj.handler)
  expect(inj.runs()).toBe(4)
  expect(n1.headers.get("Idempotent-Replayed")).toBeNull()
  expect(n2.headers.get("Idempotent-Replayed")).toBeNull()
})

test("inject: only a success is remembered — 5xx, throws, 409 refusals and 200 ok:false all retry", async () => {
  const failing = countingInject(500)
  await withIdempotency(post("/api/inject", {}, "k5"), "inject", failing.handler)
  await withIdempotency(post("/api/inject", {}, "k5"), "inject", failing.handler)
  expect(failing.runs()).toBe(2)

  let throws = 0
  const boom = async (): Promise<Response> => { throws++; throw new Error("boom") }
  await expect(withIdempotency(post("/api/inject", {}, "k6"), "inject", boom)).rejects.toThrow("boom")
  await expect(withIdempotency(post("/api/inject", {}, "k6"), "inject", boom)).rejects.toThrow("boom")
  expect(throws).toBe(2)

  const refused = countingInject(409)
  await withIdempotency(post("/api/inject", {}, "k7"), "inject", refused.handler)
  const again = await withIdempotency(post("/api/inject", {}, "k7"), "inject", refused.handler)
  expect(refused.runs()).toBe(2)
  expect(again.headers.get("Idempotent-Replayed")).toBeNull()
})

test("inject: deliver_failed (200 ok:false) then recovery — the retry delivers, the next repeat replays", async () => {
  let runs = 0
  const flaky = async (): Promise<Response> => {
    runs++
    return Response.json(runs === 1 ? { ok: false, error: "deliver_failed" } : { ok: true, confirmed: true })
  }
  const failed = await withIdempotency(post("/api/inject", {}, "k9"), "inject", flaky)
  expect(await failed.json()).toEqual({ ok: false, error: "deliver_failed" })
  const recovered = await withIdempotency(post("/api/inject", {}, "k9"), "inject", flaky)
  expect(await recovered.json()).toEqual({ ok: true, confirmed: true })
  expect(recovered.headers.get("Idempotent-Replayed")).toBeNull()
  const replay = await withIdempotency(post("/api/inject", {}, "k9"), "inject", flaky)
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true")
  expect(runs).toBe(2)
})

test("inject: a concurrent waiter on a failure is not flagged as a replay", async () => {
  const failing = countingInject(500, 20)
  const [a, b] = await Promise.all([
    withIdempotency(post("/api/inject", {}, "k10"), "inject", failing.handler),
    withIdempotency(post("/api/inject", {}, "k10"), "inject", failing.handler),
  ])
  expect(failing.runs()).toBe(1)
  expect([a.headers.get("Idempotent-Replayed"), b.headers.get("Idempotent-Replayed")]).toEqual([null, null])
})

test("keys expire after 24 h, are scoped per route, and over-long keys are rejected", async () => {
  const inj = countingInject()
  let now = 1_000
  await withIdempotency(post("/api/inject", {}, "k8"), "inject", inj.handler, () => now)
  now += TTL_MS - 1
  await withIdempotency(post("/api/inject", {}, "k8"), "inject", inj.handler, () => now)
  expect(inj.runs()).toBe(1)
  now += 1
  await withIdempotency(post("/api/inject", {}, "k8"), "inject", inj.handler, () => now)
  expect(inj.runs()).toBe(2)

  await withIdempotency(post("/api/answer", {}, "k8"), "answer", inj.handler, () => now)
  expect(inj.runs()).toBe(3)

  const long = await withIdempotency(post("/api/inject", {}, "x".repeat(MAX_KEY_LENGTH + 1)), "inject", inj.handler)
  expect(long.status).toBe(400)
  expect(inj.runs()).toBe(3)
})

test("POST /api/inject goes through the idempotency wrapper; a refusal is not remembered", async () => {
  // An unregistered target is refused with 410 before any keystroke. Refusals
  // are not remembered, so the repeat re-runs the route (no replay header).
  const body = { text: "hi", key: "idem-no-such-session" }
  const first = (await handleApiRoute(post("/api/inject", body, "route-k1"), new URL("http://localhost:4245/api/inject")))!
  const second = (await handleApiRoute(post("/api/inject", body, "route-k1"), new URL("http://localhost:4245/api/inject")))!
  expect(first.status).toBe(410)
  expect(second.status).toBe(410)
  expect(second.headers.get("Idempotent-Replayed")).toBeNull()
  expect(await second.json()).toEqual(await first.json())
})

// ── /api/answer through the real route ──

const question = { header: "Color", question: "Idempotent color?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }

function pendingQuestion(tag: string): { id: string; resolves: () => number } {
  let id = ""
  let resolves = 0
  const off = onQuestionRequest((r) => { if (r.sessionId === tag) id = r.id })
  onQuestionResolved((r) => { if (r.sessionId === tag) resolves++ })
  void addQuestionRequest({ sessionId: tag, cwd: "/tmp/" + tag, questions: [question], sessionKey: tag }, { expiryMs: 60_000 })
  off()
  return { id, resolves: () => resolves }
}

async function answer(id: string, key?: string): Promise<Response> {
  return (await handleApiRoute(
    post("/api/answer", { id, answers: [{ selected: ["Red"] }] }, key),
    new URL("http://localhost:4245/api/answer"),
  ))!
}

test("answer: same key twice resolves once and replays {ok:true} with the replay header", async () => {
  const q = pendingQuestion("idem-a1")
  const first = await answer(q.id, "ans-k1")
  const second = await answer(q.id, "ans-k1")
  expect(q.resolves()).toBe(1)
  expect(await first.json()).toEqual({ ok: true })
  expect(await second.json()).toEqual({ ok: true })
  expect(second.status).toBe(first.status)
  expect(second.headers.get("Idempotent-Replayed")).toBe("true")
})

test("answer: concurrent same-key requests resolve once", async () => {
  const q = pendingQuestion("idem-a2")
  const [a, b] = await Promise.all([answer(q.id, "ans-k2"), answer(q.id, "ans-k2")])
  expect(q.resolves()).toBe(1)
  expect(await a.json()).toEqual({ ok: true })
  expect(await b.json()).toEqual({ ok: true })
})

test("answer: a different key or no key runs again (second finds the question gone, as today)", async () => {
  const q = pendingQuestion("idem-a3")
  expect(await (await answer(q.id, "ans-k3")).json()).toEqual({ ok: true })
  const other = await answer(q.id, "ans-k4")
  expect(await other.json()).toEqual({ ok: false })
  expect(other.headers.get("Idempotent-Replayed")).toBeNull()

  const q2 = pendingQuestion("idem-a4")
  expect(await (await answer(q2.id)).json()).toEqual({ ok: true })
  const bare = await answer(q2.id)
  expect(await bare.json()).toEqual({ ok: false })
  expect(bare.headers.get("Idempotent-Replayed")).toBeNull()
  expect(q2.resolves()).toBe(1)
})

// ── /api/resolve through the real route ──

test("resolve: same key twice resolves once and replays {ok:true}; a lost-response retry does not see ok:false", async () => {
  let decided = 0
  void addApprovalRequest({ agent: "claude", sessionId: "idem-r1", tool: "Bash", input: { command: "ls" }, cwd: "/tmp", sessionKey: "idem-r1" }).then(() => decided++)
  const id = getPending().find((r) => r.sessionId === "idem-r1")!.id
  const resolve = async (key?: string) => (await handleApiRoute(
    post("/api/resolve", { id, decision: "allow" }, key),
    new URL("http://localhost:4245/api/resolve"),
  ))!
  const first = await resolve("res-k1")
  const second = await resolve("res-k1")
  await Bun.sleep(0)
  expect(decided).toBe(1)
  expect(await first.json()).toEqual({ ok: true })
  expect(await second.json()).toEqual({ ok: true })
  expect(second.headers.get("Idempotent-Replayed")).toBe("true")
  const bare = await resolve()
  expect(await bare.json()).toEqual({ ok: false })
})
