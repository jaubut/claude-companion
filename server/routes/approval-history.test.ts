import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addApprovalRequest, getPending, resolveApproval, setDefaultApprovalExpiryMs } from "../lib/pty-manager"
import { addQuestionRequest, getPendingQuestions, resolveQuestion } from "../lib/questions"
import { useLearnedAllowDb } from "../lib/learned-allow"
import { getHistoryItem, useApprovalHistoryDb, type HistoryDetail } from "../lib/approval-history"
import { isSuperAuto, setSuperAutoInMemoryForTests } from "../lib/super-auto"
import { clients } from "../state"

// Route-level: every approval / question that reached the phone lands in
// approval_history and every exit moves it to its end state, with the
// `approval_history` WS frame on each change. Isolated sqlite throughout.

type Route = (req: Request, url: URL) => Promise<Response | null>
let handleHookRoute: Route
let handleApiRoute: Route
const superWas = isSuperAuto()
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Parameters<typeof clients.add>[0]

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-hist-route-"))
  process.env.COMPANION_DB_PATH = join(dir, "companion.db")
  useLearnedAllowDb(join(dir, "learned.db"))
  useApprovalHistoryDb(join(dir, "history.db"))
  await import("../wiring/events")
  handleHookRoute = (await import("./hooks")).handleHookRoute
  handleApiRoute = (await import("./api")).handleApiRoute
  clients.add(fake)
  setSuperAutoInMemoryForTests(false)
})
afterAll(() => {
  setSuperAutoInMemoryForTests(superWas)
  clients.delete(fake)
  setDefaultApprovalExpiryMs(null)
})

const PANE = { "x-companion-tty": "/dev/pts/77", "x-companion-tmux-pane": "%77777" }
const question = { header: "Color", question: "Which history color?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }

function req(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; headers?: Record<string, string> } = {}): [Request, URL] {
  const url = new URL(`http://localhost:4245${path}`)
  return [new Request(url.href, {
    method,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  }), url]
}
const post = (path: string, body: unknown, opts: { signal?: AbortSignal; headers?: Record<string, string> } = {}) => req("POST", path, body, opts)

async function waitFor<T>(find: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = find()
    if (v) return v
    await Bun.sleep(5)
  }
  throw new Error("never reached the phone")
}
const approvalFor = (sid: string) => waitFor(() => getPending().find((r) => r.sessionId === sid))
const questionFor = (sid: string) => waitFor(() => getPendingQuestions().find((r) => r.sessionId === sid))
const row = (id: string): HistoryDetail => getHistoryItem(id)!
const histFrames = (id: string) => frames.filter((f) => f.type === "approval_history" && (f.item as { id: string }).id === id).map((f) => (f.item as { state: string }).state)
// A distinct first word per session: a phone allow is learned per first word.
const cmdFor = (sid: string) => `zz-${sid} --flag`
const preTool = (sid: string, command = cmdFor(sid), opts = {}) =>
  handleHookRoute(...post("/hooks/pre-tool-use", { session_id: sid, tool_name: "Bash", tool_input: { command }, cwd: `/tmp/${sid}` }, opts))

test("escalation inserts pending + frame; phone allow → allowed/phone with the claimed device", async () => {
  const res = preTool("ah-allow")
  const r = await approvalFor("ah-allow")
  expect(row(r.id)).toMatchObject({ kind: "approval", state: "pending", tool: "Bash", summary: cmdFor("ah-allow"), session_id: "ah-allow", cwd: "/tmp/ah-allow", decided_via: null })
  const [rq, u] = post("/api/resolve", { id: r.id, decision: "allow" }, { headers: { "x-companion-device": "Jeremie iPhone" } })
  expect(await (await handleApiRoute(rq, u))!.json()).toEqual({ ok: true })
  await res
  expect(row(r.id)).toMatchObject({ state: "allowed", decided_via: "phone", device_claimed: "Jeremie iPhone" })
  expect(row(r.id).resolved_at).toBeTruthy()
  expect(histFrames(r.id)).toEqual(["pending", "allowed"])
  const frame = frames.find((f) => f.type === "approval_history")!.item as Record<string, unknown>
  expect(Object.keys(frame).sort()).toEqual(["created_at", "cwd", "decided_via", "id", "kind", "resolved_at", "session_id", "session_key", "state", "summary", "tool"])
})

test("phone deny → denied/phone", async () => {
  const res = preTool("ah-deny")
  const r = await approvalFor("ah-deny")
  expect(resolveApproval(r.id, "deny")).toBe(true)
  await res
  expect(row(r.id)).toMatchObject({ state: "denied", decided_via: "phone", device_claimed: null })
})

test("expiry → expired/expiry (PermissionRequest path recorded too)", async () => {
  setDefaultApprovalExpiryMs(30)
  try {
    const res = handleHookRoute(...post("/hooks/permission-request", { session_id: "ah-exp", tool_name: "Bash", tool_input: { command: cmdFor("ah-exp") }, cwd: "/tmp/ah-exp" }))
    const r = await approvalFor("ah-exp")
    await res
    expect(row(r.id)).toMatchObject({ state: "expired", decided_via: "expiry" })
  } finally {
    setDefaultApprovalExpiryMs(null)
  }
})

test("hook aborted → elsewhere/hook_gone", async () => {
  const ctrl = new AbortController()
  const res = preTool("ah-abort", undefined, { signal: ctrl.signal })
  const r = await approvalFor("ah-abort")
  ctrl.abort()
  await res
  expect(row(r.id)).toMatchObject({ state: "elsewhere", decided_via: "hook_gone" })
})

test("elsewhere via PostToolUse / UserPromptSubmit / Stop / SessionEnd, each named", async () => {
  const cases: Array<[string, string, (sid: string) => [Request, URL]]> = [
    ["ah-post", "post_tool_use", (sid) => post("/hooks/post-tool-use", { session_id: sid, tool_name: "Bash", tool_input: { command: cmdFor(sid) }, tool_response: {}, cwd: `/tmp/${sid}` })],
    ["ah-prompt", "user_prompt", (sid) => post("/hooks/user-prompt-submit", { session_id: sid, prompt: "next", cwd: `/tmp/${sid}` })],
    ["ah-stop", "stop", (sid) => post("/hooks/stop", { session_id: sid, cwd: `/tmp/${sid}`, last_assistant_message: "done" })],
    ["ah-end", "session_end", (sid) => post("/hooks/session-end", { session_id: sid, cwd: `/tmp/${sid}` })],
  ]
  for (const [sid, via, end] of cases) {
    const res = preTool(sid)
    const r = await approvalFor(sid)
    await handleHookRoute(...end(sid))
    expect(await (await res)!.json()).toEqual({})
    expect(row(r.id)).toMatchObject({ state: "elsewhere", decided_via: via })
  }
})

test("auto-judge allow and SUPER allow are NOT recorded", async () => {
  const before = frames.filter((f) => f.type === "approval_history").length
  const judged = await (await preTool("ah-auto", "cat /etc/hostname"))!.json() as { hookSpecificOutput: { permissionDecision: string } }
  expect(judged.hookSpecificOutput.permissionDecision).toBe("allow")
  setSuperAutoInMemoryForTests(true)
  try {
    const sup = await (await preTool("ah-super"))!.json() as { hookSpecificOutput: { permissionDecision: string } }
    expect(sup.hookSpecificOutput.permissionDecision).toBe("allow")
  } finally {
    setSuperAutoInMemoryForTests(false)
  }
  expect(frames.filter((f) => f.type === "approval_history").length).toBe(before)
  const [rq, u] = req("GET", "/api/approvals/history?q=ah-&limit=200")
  const body = await (await handleApiRoute(rq, u))!.json() as { items: Array<{ session_id: string }> }
  expect(body.items.some((i) => i.session_id === "ah-auto" || i.session_id === "ah-super")).toBe(false)
})

test("question answered on the phone → answered/phone, answers kept in detail", async () => {
  const res = handleHookRoute(...post("/hooks/permission-request", { session_id: "ah-q1", tool_name: "AskUserQuestion", tool_input: { questions: [question] }, cwd: "/tmp/ah-q1" }, { headers: PANE }))
  const q = await questionFor("ah-q1")
  expect(row(q.id)).toMatchObject({ kind: "question", state: "pending", tool: "AskUserQuestion", summary: "Which history color?" })
  const [rq, u] = post("/api/answer", { id: q.id, answers: [{ selected: ["Blue"] }] }, { headers: { "x-companion-device": "iPad" } })
  expect(await (await handleApiRoute(rq, u))!.json()).toEqual({ ok: true })
  await res
  const d = row(q.id)
  expect(d).toMatchObject({ state: "answered", decided_via: "phone", device_claimed: "iPad" })
  expect(d.detail).toMatchObject({ questions: [{ question: "Which history color?" }], answers: [{ selected: ["Blue"] }] })
})

test("question answered at the terminal → elsewhere/post_tool_use; question at turn end → expired/stop", async () => {
  const res = handleHookRoute(...post("/hooks/permission-request", { session_id: "ah-q2", tool_name: "AskUserQuestion", tool_input: { questions: [question] }, cwd: "/tmp/ah-q2" }, { headers: PANE }))
  const q = await questionFor("ah-q2")
  await handleHookRoute(...post("/hooks/post-tool-use", { session_id: "ah-q2", tool_name: "AskUserQuestion", tool_input: { questions: [question] }, tool_response: {}, cwd: "/tmp/ah-q2" }, { headers: PANE }))
  await res
  expect(row(q.id)).toMatchObject({ state: "elsewhere", decided_via: "post_tool_use" })

  const res2 = handleHookRoute(...post("/hooks/permission-request", { session_id: "ah-q3", tool_name: "AskUserQuestion", tool_input: { questions: [question] }, cwd: "/tmp/ah-q3" }, { headers: PANE }))
  const q3 = await questionFor("ah-q3")
  await handleHookRoute(...post("/hooks/stop", { session_id: "ah-q3", cwd: "/tmp/ah-q3", last_assistant_message: "x" }, { headers: PANE }))
  await res2
  expect(row(q3.id)).toMatchObject({ state: "expired", decided_via: "stop" })
})

test("parked question re-asked under the same id stays ONE row, then answered", async () => {
  const id = crypto.randomUUID()
  const base = { agent: "claude" as const, sessionId: "ah-park", cwd: "/tmp/ah-park", sessionKey: "", questions: [question] }
  // PreToolUse window lapses → parked (still pending, no exit fired)
  expect(await addQuestionRequest(base, { id, expiryMs: 10, parkMs: 2_000 })).toEqual([])
  expect(row(id).state).toBe("pending")
  // PermissionRequest sibling re-asks with the same id
  const second = addQuestionRequest(base, { id, expiryMs: 2_000 })
  expect(resolveQuestion(id, [{ selected: ["Red"] }])).toBe(true)
  expect(await second).toEqual([{ selected: ["Red"] }])
  const [rq, u] = req("GET", "/api/approvals/history?kind=question&q=history%20color&limit=200")
  const body = await (await handleApiRoute(rq, u))!.json() as { items: Array<{ id: string }> }
  expect(body.items.filter((i) => i.id === id).length).toBe(1)
  expect(row(id)).toMatchObject({ state: "answered", decided_via: "phone" })
})

test("GET list (filters, 400s, cursor), GET :id, DELETE prune", async () => {
  // a known pending row for the filters
  const pending = addApprovalRequest({ sessionId: "ah-list", tool: "Bash", input: { command: "zz list" }, cwd: "/tmp/ah-list", sessionKey: "" }, { expiryMs: 5_000 })
  const live = await approvalFor("ah-list")
  const get = async (path: string) => {
    const res = (await handleApiRoute(...req("GET", path)))!
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const all = await get("/api/approvals/history?limit=3")
  expect(all.status).toBe(200)
  expect(all.body.ok).toBe(true)
  expect(typeof all.body.host).toBe("string")
  expect((all.body.items as unknown[]).length).toBe(3)
  expect(typeof all.body.next).toBe("string")
  const page2 = await get(`/api/approvals/history?limit=3&before=${encodeURIComponent(all.body.next as string)}`)
  const ids1 = (all.body.items as Array<{ id: string }>).map((i) => i.id)
  expect((page2.body.items as Array<{ id: string }>).some((i) => ids1.includes(i.id))).toBe(false)
  const pend = await get("/api/approvals/history?state=pending")
  expect((pend.body.items as Array<{ id: string; state: string }>).map((i) => i.id)).toContain(live.id)
  const resolved = await get("/api/approvals/history?state=resolved&limit=200")
  expect((resolved.body.items as Array<{ state: string }>).every((i) => i.state !== "pending")).toBe(true)
  expect((await get("/api/approvals/history?state=bogus")).status).toBe(400)
  expect((await get("/api/approvals/history?kind=bogus")).status).toBe(400)
  expect((await get("/api/approvals/history?limit=abc")).status).toBe(400)
  expect(((await get("/api/approvals/history?limit=9999")).body.items as unknown[]).length).toBeLessThanOrEqual(200)

  const one = await get(`/api/approvals/history/${live.id}`)
  expect(one.body).toMatchObject({ ok: true, item: { id: live.id, state: "pending", detail: { input: { command: "zz list" } } } })
  expect((await get("/api/approvals/history/nope")).status).toBe(404)

  expect((await handleApiRoute(...req("DELETE", "/api/approvals/history?before=garbage")))!.status).toBe(400)
  const del = await (await handleApiRoute(...req("DELETE", `/api/approvals/history?before=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)))!.json() as { ok: boolean; deleted: number }
  expect(del.ok).toBe(true)
  expect(del.deleted).toBeGreaterThan(0)
  // only the live pending row survives a prune
  expect(((await get("/api/approvals/history?limit=200")).body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([live.id])
  resolveApproval(live.id, "deny")
  await pending
})

test("the /api gate requires the bearer on /api/approvals/history", async () => {
  process.env.COMPANION_AUTH_TOKEN ??= "approval-history-test-token-0123456789"
  const { createCompanionServer } = await import("../companion-server")
  const { getAuthToken } = await import("../lib/auth")
  const server = createCompanionServer(0)
  try {
    const url = `http://127.0.0.1:${server.port}/api/approvals/history`
    expect((await fetch(url)).status).toBe(401)
    const ok = await fetch(url, { headers: { authorization: `Bearer ${getAuthToken()}` } })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true)
  } finally {
    server.stop(true)
  }
})
