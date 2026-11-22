import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnWorkerOpts } from "../lib/worker-invocation"
import { type Session, recordSession, removeSessionByKey } from "../lib/sessions"
import { addQuestionRequest, getPendingQuestions } from "../lib/questions"
import { clients } from "../state"

// The one inject path with COMPANION_DESK_HEADLESS=1 (headless-desk P1): POST
// /api/inject, ws `input`, /api/session/interrupt, /api/dialog/key Escape and
// /api/spawn-session all land on the desk runner. Spawn is faked: no claude runs.

const dir = mkdtempSync(join(tmpdir(), "desk-deliver-"))
type Route = (req: Request, url: URL) => Promise<Response | null>
let handleApiRoute: Route
let handleDialogRoute: Route
let deliverInject: typeof import("./desk-deliver").deliverInject
let deskRunner: typeof import("./desk-deliver").deskRunner
let websocket: typeof import("../ws").websocket
const spawned: Array<{ opts: SpawnWorkerOpts; pid: number; kills: string[] }> = []
const frames: Array<Record<string, unknown>> = []
const fakeClient = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Parameters<typeof clients.add>[0]
let holds = false
let prevFlag: string | undefined

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(dir, "test.db")
  prevFlag = process.env.COMPANION_DESK_HEADLESS
  process.env.COMPANION_DESK_HEADLESS = "1"
  ;({ handleApiRoute } = await import("../routes/api"))
  ;({ handleDialogRoute } = await import("../routes/dialogs"))
  ;({ deliverInject, deskRunner } = await import("./desk-deliver"))
  ;({ websocket } = await import("../ws"))
  let pid = 7000
  deskRunner.override({
    stateFile: join(dir, "desk.json"),
    env: async () => ({}),
    spawn: (opts) => { const s = { opts, pid: pid++, kills: [] as string[] }; spawned.push(s); return { pid: s.pid, kill: () => {} } },
    kill: (p, sig) => { spawned.find((s) => s.pid === p)?.kills.push(sig) },
    isAlive: () => false,
    identity: (p) => `id:${p}`,
    transcriptExists: () => true,
    terminalHolds: () => holds,
  })
  clients.add(fakeClient)
})
afterAll(() => {
  clients.delete(fakeClient)
  if (prevFlag === undefined) delete process.env.COMPANION_DESK_HEADLESS
  else process.env.COMPANION_DESK_HEADLESS = prevFlag
})
beforeEach(() => { holds = false; frames.length = 0 })

let n = 0
function deskRow(): Session {
  n++
  return recordSession({ cwd: `/tmp/desk-${n}`, agent: "claude", sessionId: `desk-sid-${n}`, herdrPane: `headless:desk:desk-sid-${n}` }, { sessionIdConfirmed: true })!
}
const finish = (i: number): void => {
  const s = spawned[i]!
  deskRunner.noteAccepted(s.opts.args[s.opts.args.indexOf("--resume") + 1] ?? "")
  s.opts.onExit(0, null)
}
function post(path: string, body: unknown, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`http://localhost:4245${path}`)
  return [new Request(url.href, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), url]
}
const json = async (r: Response | null) => ({ status: r!.status, body: await r!.json() as Record<string, unknown> })

test("a desk row: one headless turn, confirmed; a second send queues", async () => {
  const s = deskRow()
  const before = spawned.length
  expect(await json(await deliverInject("hi", s.key))).toEqual({ status: 200, body: { ok: true, confirmed: true } })
  await Bun.sleep(0)
  expect(spawned.length).toBe(before + 1)
  expect(spawned.at(-1)!.opts.args).toContain(s.sessionId)
  expect(await json(await deliverInject("again", s.key))).toEqual({ status: 200, body: { ok: true, confirmed: true, queued: true } })
  expect(spawned.length).toBe(before + 1)
  finish(spawned.length - 1)
  await Bun.sleep(0)
  expect(spawned.at(-1)!.opts.args.at(-1)).toBe("again")
  finish(spawned.length - 1)
})

test("flag on: a terminal row still open → 409 terminal_owned, nothing spawned, no keystrokes", async () => {
  const s = recordSession({ cwd: "/tmp/desk-term", agent: "claude", sessionId: "term-sid", tty: "/dev/ttys990" })!
  holds = true
  const before = spawned.length
  expect(await json(await deliverInject("hi", s.key))).toEqual({ status: 409, body: { ok: false, error: "terminal_owned", key: s.key } })
  expect(spawned.length).toBe(before)
  removeSessionByKey(s.key)
})

test("untargeted → 410 no_target; kimi → 409 unsupported_agent", async () => {
  expect(await json(await deliverInject("hi"))).toEqual({ status: 410, body: { ok: false, error: "no_target" } })
  const k = recordSession({ cwd: "/tmp/desk-kimi", agent: "kimi", sessionId: "kimi-sid", tty: "/dev/ttys991" })!
  expect((await json(await deliverInject("hi", k.key))).body.error).toBe("unsupported_agent")
  removeSessionByKey(k.key)
})

test("Canvas guard: a send whose claim is gone is refused before the turn", async () => {
  const s = deskRow()
  expect((await json(await deliverInject("x", s.key, undefined, "other-sid", () => true))).body.error).toBe("target_changed")
  expect((await json(await deliverInject("x", s.key, undefined, s.sessionId, () => false))).body.error).toBe("target_changed")
})

test("POST /api/inject: same Idempotency-Key once, even after the in-memory map is lost (restart)", async () => {
  const { resetIdempotency } = await import("../lib/idempotency")
  const s = deskRow()
  const before = spawned.length
  const a = await json(await handleApiRoute(...post("/api/inject", { text: "once", key: s.key }, { "idempotency-key": "idem-1" })))
  const b = await json(await handleApiRoute(...post("/api/inject", { text: "once", key: s.key }, { "idempotency-key": "idem-1" })))
  expect(a).toEqual({ status: 200, body: { ok: true, confirmed: true } })
  expect(b).toEqual(a)
  resetIdempotency()
  expect((await json(await handleApiRoute(...post("/api/inject", { text: "once", key: s.key }, { "idempotency-key": "idem-1" })))).status).toBe(200)
  await Bun.sleep(0)
  expect(spawned.length).toBe(before + 1)
  finish(spawned.length - 1)
})

test("ws input: same path; a refusal answers the sender with inject_error", async () => {
  const s = deskRow()
  const sent: Array<Record<string, unknown>> = []
  const ws = { data: {}, send: (m: string) => { sent.push(JSON.parse(m)) } } as unknown as Parameters<NonNullable<typeof websocket.message>>[0]
  const before = spawned.length
  await websocket.message!(ws, JSON.stringify({ type: "input", text: "from ws", key: s.key }))
  await Bun.sleep(0)
  expect(spawned.length).toBe(before + 1)
  expect(sent).toEqual([])
  finish(spawned.length - 1)
  await websocket.message!(ws, JSON.stringify({ type: "input", text: "nowhere", key: "claude:sid:gone" }))
  expect(sent).toEqual([expect.objectContaining({ type: "inject_error", error: "target_gone", key: "claude:sid:gone" })])
})

test("Stop: /api/session/interrupt and Escape kill the turn; Escape with a question open cancels only it", async () => {
  const s = deskRow()
  await deliverInject("long turn", s.key)
  await Bun.sleep(0)
  const turn = spawned.at(-1)!
  const q = addQuestionRequest({ sessionId: s.sessionId, cwd: s.cwd, questions: [{ header: "H", question: "Desk Q?", multiSelect: false, options: [{ label: "A" }] }], sessionKey: s.key }, { expiryMs: 60_000 })
  expect(await json(await handleDialogRoute(...post("/api/dialog/key", { key: s.key, name: "Escape" })))).toEqual({ status: 200, body: { ok: true } })
  expect(await q).toEqual([])
  expect(turn.kills).toEqual([])
  expect(deskRunner.running(s.sessionId)).toBe(true)
  expect(await json(await handleDialogRoute(...post("/api/dialog/key", { key: s.key, name: "Escape" })))).toEqual({ status: 200, body: { ok: true } })
  expect(turn.kills).toEqual(["SIGINT"])
  expect(await json(await handleDialogRoute(...post("/api/dialog/key", { key: s.key, name: "Enter" })))).toEqual({ status: 410, body: { ok: false, error: "no_dialogs" } })
  expect(await json(await handleDialogRoute(...post("/api/dialog/pick", { key: s.key, index: 0 })))).toEqual({ status: 410, body: { ok: false, error: "no_dialogs" } })
  turn.opts.onExit(130, null)
  expect(await json(await handleApiRoute(...post("/api/session/interrupt", { key: s.key })))).toEqual({ status: 200, body: { ok: true, stopped: false } })
  expect(await json(await handleApiRoute(...post("/api/session/interrupt", { key: "claude:sid:none" })))).toEqual({ status: 410, body: { ok: false, error: "target_gone" } })
  expect(getPendingQuestions().filter((x) => x.sessionKey === s.key)).toEqual([])
})

test("hooks: /exit hands a terminal's chat to the desk, /clear does not; a desk turn's UserPromptSubmit is from the phone and accepted", async () => {
  const { handleHookRoute } = await import("../routes/hooks")
  const { listSessions } = await import("../lib/sessions")
  const hook = async (path: string, body: unknown) => json(await handleHookRoute(...post(path, body)))
  recordSession({ cwd: "/tmp/desk-exit", agent: "claude", sessionId: "exit-sid", tty: "/dev/ttys992" })
  await hook("/hooks/session-end", { session_id: "exit-sid", cwd: "/tmp/desk-exit", reason: "prompt_input_exit" })
  expect(listSessions().find((s) => s.sessionId === "exit-sid")).toMatchObject({ key: "claude:sid:exit-sid", herdrPane: "headless:desk:exit-sid", agentStatus: "idle" })
  recordSession({ cwd: "/tmp/desk-clear", agent: "claude", sessionId: "clear-sid", tty: "/dev/ttys993" })
  await hook("/hooks/session-end", { session_id: "clear-sid", cwd: "/tmp/desk-clear", reason: "clear" })
  expect(listSessions().some((s) => s.sessionId === "clear-sid")).toBe(false)

  await deliverInject("from the phone", "claude:sid:exit-sid")
  await Bun.sleep(0)
  const turn = spawned.at(-1)!
  const ups = await hook("/hooks/user-prompt-submit", { session_id: "exit-sid", cwd: "/tmp/desk-exit", prompt: "from the phone" })
  expect(ups.body).toEqual({ fromPhone: true })
  turn.opts.onExit(0, null)
  expect(frames.some((f) => f.error === "turn_failed")).toBe(false)
})

test("auto-compact on a desk row: /compact runs as a desk turn; busy while it runs; a held chat is skipped", async () => {
  const { realAutoCompactDeps } = await import("./auto-compact")
  const s = deskRow()
  expect(await realAutoCompactDeps.inputState(s.key)).toBe("empty")
  expect(await realAutoCompactDeps.inject(s.key, "/compact keep: the plan")).toEqual({ ok: true })
  await Bun.sleep(0)
  expect(spawned.at(-1)!.opts.args.at(-1)).toBe("/compact keep: the plan")
  expect(await realAutoCompactDeps.inputState(s.key)).toBe("not_ready")
  finish(spawned.length - 1)
  holds = true
  expect(await realAutoCompactDeps.inject(s.key, "/compact")).toEqual({ ok: false, error: "terminal_owned" })
})

test("headless:worker deliverInject: existing Claude sessions keep claude family; unspecified/gemini sessions default to gemini", async () => {
  const { spyOn } = await import("bun:test")
  const { workerSupervisor } = await import("./worker-mcp")
  const getSpy = spyOn(workerSupervisor, "getTask").mockReturnValue(null)
  const dispatchCalls: Array<Record<string, unknown>> = []
  const dispSpy = spyOn(workerSupervisor, "dispatchTask").mockImplementation(async (input) => {
    dispatchCalls.push(input as unknown as Record<string, unknown>)
    return {
      ok: true,
      claim: "absent",
      task: {
        taskId: input.taskId, repo: input.repo, title: input.title ?? input.taskId, builder: "b",
        family: (input.family as "claude" | "codex" | "gemini") ?? "gemini", model: input.model ?? null,
        branch: `dispatch/${input.taskId}`, worktree: "/tmp/wt", sessionId: "sid", status: "running",
        turnCount: 1, step: null, pct: 5, result: "", prUrl: null, error: null, startedAt: 1, updatedAt: 1, completedAt: null,
      },
    }
  })
  const claudeWorker = recordSession({ cwd: "/tmp/wt-cl", agent: "claude", sessionId: "w-cl-sid", taskId: "w-cl", herdrPane: "headless:worker:w-cl", model: "claude-sonnet-5-5" }, { sessionIdConfirmed: true })!
  const geminiWorker = recordSession({ cwd: "/tmp/wt-gm", agent: "gemini", sessionId: "w-gm-sid", taskId: "w-gm", herdrPane: "headless:worker:w-gm" }, { sessionIdConfirmed: true })!
  const unspecifiedWorker = recordSession({ cwd: "/tmp/wt-un", agent: "kimi", sessionId: "w-un-sid", taskId: "w-un", herdrPane: "headless:worker:w-un" }, { sessionIdConfirmed: true })!
  try {
    expect((await deliverInject("continue", claudeWorker.key)).status).toBe(200)
    expect((await deliverInject("continue", geminiWorker.key)).status).toBe(200)
    expect((await deliverInject("continue", unspecifiedWorker.key)).status).toBe(200)
    expect(dispatchCalls[0]).toMatchObject({ taskId: "w-cl", family: "claude", model: "claude-sonnet-5-5" })
    expect(dispatchCalls[1]).toMatchObject({ taskId: "w-gm", family: "gemini" })
    expect(dispatchCalls[2]).toMatchObject({ taskId: "w-un", family: "gemini" })
  } finally {
    getSpy.mockRestore()
    dispSpy.mockRestore()
    removeSessionByKey(claudeWorker.key)
    removeSessionByKey(geminiWorker.key)
    removeSessionByKey(unspecifiedWorker.key)
  }
})
