import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createTasksAgent, undoSpec } from "../lib/tasks-agent"
import { rowKey, rowVersion } from "../lib/tasks-agent-row"
import { createTasksChat } from "../lib/tasks-agent-chat"
import { parseAssignRules } from "../lib/tasks-agent-rules"
import { createTasksAgentStore } from "../lib/tasks-agent-store"
import { testDb, txOver } from "../lib/tasks-agent-testdb.test-util"
import type { ExecFn } from "../lib/turso"
import { createTasksAgentRoute } from "./tasks-agent"

const NOW = Date.parse("2026-10-06T15:00:00Z") // 11:00 Toronto
const RULES = parseAssignRules(`ROUTES = [
    (r"\\b(design|wireframe)\\b", "frontend-design"),
    (r"\\b(send invoice)\\b", "human"),
]
`)
const VAGUE = "the whole website thing with the new client and the photos and the blog maybe"
const A = "aaaaaaaaaa", B = "bbbbbbbbbb"
/** The row of a subtask exactly as insertSubtasks creates it under A. */
const SUBKEY = rowKey({ text: "Draft the site map", description: "", noteId: "projects/p1", parentRaw: A, dueRaw: "", done: false, assigneeRaw: "human:jeremie" })
const PV = rowVersion({ text: VAGUE, description: "", noteId: "projects/p1", parentRaw: "", dueRaw: "", done: false, assigneeRaw: "human:jeremie" })

interface Opts { busy?: Map<string, number> | null; split?: string[] | null; exec?: (base: ExecFn) => ExecFn }

function setup(o: Opts = {}) {
  const t = testDb()
  let now = NOW
  const frames: Record<string, unknown>[] = []
  const store = createTasksAgentStore(new Database(":memory:"))
  const splitCalls: string[] = []
  const exec = o.exec ? o.exec(t.exec) : t.exec
  const agent = createTasksAgent({
    query: t.query, exec, tx: txOver(exec), store, rules: () => RULES, now: () => now,
    busy: async () => (o.busy === undefined ? new Map([["2026-10-07", 7]]) : o.busy),
    splitter: async (task) => { splitCalls.push(task.text); return o.split === undefined ? ["Draft the site map", "Pick the photos", "Write the blog post"] : o.split },
  })
  const turns: string[] = []
  const chat = createTasksChat({ query: t.query, exec: t.exec, tx: t.tx, plan: async () => null, emitTurn: (x) => turns.push(x), notify: (f) => frames.push(f), now: () => now })
  const handle = createTasksAgentRoute({ agent, chat, notify: (f) => frames.push(f) })
  const call = async (path: string, init?: RequestInit) => {
    const req = new Request(`http://localhost${path}`, init)
    return (await handle(req, new URL(req.url)))!
  }
  const get = async (device = "iphone") => {
    const r = await call("/api/tasks/agent", { headers: { "X-Companion-Device": device } })
    return { status: r.status, body: (await r.json()) as any }
  }
  const post = async (path: string, body: unknown) => {
    const r = await call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
    return { status: r.status, body: (await r.json()) as any }
  }
  return { t, agent, chat, frames, splitCalls, turns, call, get, post, advance: (ms: number) => { now += ms } }
}

describe("GET /api/tasks/agent", () => {
  test("digest + proposals + load in one body", async () => {
    const s = setup()
    s.t.task({ id: A, due_date: "2026-10-07" })
    s.t.task({ id: B, due_date: "2026-10-07", assignee: "human" })
    s.t.activity({ agent: "pm", action: "assignee_changed", target: A, meta: { from: null, to: "human:jeremie" }, ts: "2026-10-06 07:30:00" })
    const r = await s.get()
    expect(r.status).toBe(200)
    expect(r.body.today).toBe("2026-10-06")
    expect(r.body.digest.items.map((i: any) => i.action)).toEqual(["assignee_changed"])
    expect(r.body.proposals.counts).toEqual({ reschedule: 0, merge: 0, assign: 0, split: 0 })
    expect(r.body.load.days[1]).toEqual({ day: "2026-10-07", tasks: 2, busyHours: 7, overbooked: true, reasons: ["busy"] })
  })

  test("calendar unavailable → load still served with busyHours null", async () => {
    const s = setup({ busy: null })
    s.t.task({ id: A, due_date: "2026-10-06" })
    const r = await s.get()
    expect(r.body.load.calendar).toBe("unavailable")
    expect(r.body.load.days[0]).toMatchObject({ tasks: 1, busyHours: null })
  })

  test("Turso down → 503; wrong method → 405; other paths fall through", async () => {
    const s = setup()
    s.t.setDown(true)
    expect((await s.get()).status).toBe(503)
    expect((await s.call("/api/tasks/agent", { method: "POST" })).status).toBe(405)
    const req = new Request("http://localhost/api/tasks/mine")
    expect(await createTasksAgentRoute({ agent: s.agent, chat: null, notify: () => {} })(req, new URL(req.url))).toBeNull()
  })
})

describe("digest", () => {
  test("agent changes on my tasks only; my own taps, agent tasks and accepted proposals are left out", async () => {
    const s = setup()
    s.t.task({ id: A })
    s.t.task({ id: B, assignee: "agent:builder" })
    const ts = "2026-10-06 08:00:00"
    s.t.activity({ agent: "pm", action: "status_changed", target: A, meta: { from: "open", to: "done" }, ts })
    s.t.activity({ agent: "companion", action: "due_changed", target: A, meta: { from: null, to: "2026-10-09" }, ts })
    s.t.activity({ agent: "builder", action: "dispatch:running", target: B, meta: {}, ts })
    s.t.activity({ agent: "tasks-agent", action: "due_changed", target: A, meta: { from: null, to: "2026-10-09", by: "jeremie" }, ts })
    s.t.activity({ agent: "pm", action: "due_changed", target: A, summary: "old row, no meta", ts })
    const items = (await s.get()).body.digest.items
    expect(items.map((i: any) => [i.agent, i.action, i.undoable])).toEqual([["pm", "due_changed", false], ["pm", "status_changed", true]])
    expect(items[1]).toMatchObject({ taskId: A, taskText: `task ${A}`, project: "Title projects/p1", from: "open", to: "done" })
  })

  test("first open = last 24 h; later opens = since the previous open; a quick refetch keeps the baseline", async () => {
    const s = setup()
    s.t.task({ id: A })
    s.t.activity({ agent: "pm", action: "status_changed", target: A, meta: { from: "open", to: "done" }, ts: "2026-10-04 08:00:00" })
    s.t.activity({ agent: "pm", action: "assignee_changed", target: A, meta: { from: null, to: "human:jeremie" }, ts: "2026-10-06 08:00:00" })
    expect((await s.get()).body.digest.items.length).toBe(1) // 2 days old row is out
    s.advance(60_000)
    expect((await s.get()).body.digest.items.length).toBe(1) // same open
    s.advance(31 * 60_000)
    expect((await s.get()).body.digest.items.length).toBe(0) // new open, nothing new
    s.t.activity({ agent: "pm", action: "due_changed", target: A, meta: { from: null, to: "2026-10-10" }, ts: "2026-10-06 16:00:00" })
    s.advance(31 * 60_000)
    expect((await s.get()).body.digest.items.map((i: any) => i.action)).toEqual(["due_changed"])
    // another device has its own baseline
    expect((await s.get("ipad")).body.digest.items.length).toBe(2)
  })
})

describe("POST /api/tasks/agent/undo", () => {
  test("restores the old due date from meta, logs one undo row, pushes tasks_changed; a second undo is refused", async () => {
    const s = setup()
    s.t.task({ id: A, due_date: "2026-10-20" })
    const act = s.t.activity({ agent: "pm", action: "due_changed", target: A, meta: { from: "2026-10-08", to: "2026-10-20" } })
    const r = await s.post("/api/tasks/agent/undo", { activityId: act })
    expect(r).toEqual({ status: 200, body: { ok: true, taskId: A, field: "due", restored: "2026-10-08" } })
    expect(s.t.get(A)!.due_date).toBe("2026-10-08")
    const undo = s.t.activities().at(-1)!
    expect(undo).toMatchObject({ agent_slug: "tasks-agent", action: "undo", target_id: A })
    expect(JSON.parse(String(undo.meta))).toMatchObject({ undoes: act, field: "due", from: "2026-10-20", to: "2026-10-08" })
    expect(s.frames).toEqual([{ type: "tasks_changed", taskId: A, why: "undo" }])
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).body.error).toBe("already_undone")
    const item = (await s.get()).body.digest.items.find((i: any) => i.activityId === act)
    expect(item).toMatchObject({ undone: true, undoable: false })
  })

  test("restores a dropped date (from → '') and a null old date (→ '')", async () => {
    const s = setup()
    s.t.task({ id: A, due_date: "" })
    const act = s.t.activity({ agent: "pm", action: "due_changed", target: A, meta: { from: "2026-10-08", to: null } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).status).toBe(200)
    expect(s.t.get(A)!.due_date).toBe("2026-10-08")
    s.t.task({ id: B, due_date: "2026-10-09" })
    const act2 = s.t.activity({ agent: "pm", action: "due_changed", target: B, meta: { from: null, to: "2026-10-09" } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: act2 })).status).toBe(200)
    expect(s.t.get(B)!.due_date).toBe("")
  })

  test("reopens an auto-closed task; restores an assignee", async () => {
    const s = setup()
    s.t.task({ id: A, done: 1 })
    const closed = s.t.activity({ agent: "pm", action: "status_changed", target: A, meta: { from: "open", to: "done" } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: closed })).body).toMatchObject({ ok: true, field: "done", restored: false })
    expect(s.t.get(A)!.done).toBe(0)
    s.t.task({ id: B, assignee: "agent:researcher" })
    const moved = s.t.activity({ agent: "pm", action: "assignee_changed", target: B, meta: { from: "human:jeremie", to: "agent:researcher" } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: moved })).status).toBe(200)
    expect(s.t.get(B)!.assignee).toBe("human:jeremie")
  })

  test("undo is scoped like the digest: a reassignment between agents is refused, untouched", async () => {
    const s = setup()
    s.t.task({ id: B, assignee: "agent:builder" })
    const other = s.t.activity({ agent: "pm", action: "assignee_changed", target: B, meta: { from: "agent:researcher", to: "agent:builder" } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: other })).status).toBe(404)
    expect(s.t.get(B)!.assignee).toBe("agent:builder")
  })

  test("a failed undo write leaves no undo row, so the retry works", async () => {
    let fail = true
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("UPDATE tasks SET due_date") && fail) { fail = false; throw new Error("blip") }
      return base(sql, args)
    } })
    s.t.task({ id: A, due_date: "2026-10-20" })
    const act = s.t.activity({ agent: "pm", action: "due_changed", target: A, meta: { from: "2026-10-08", to: "2026-10-20" } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).status).toBe(503)
    expect(s.t.activities().length).toBe(1)
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).status).toBe(200)
    expect(s.t.get(A)!.due_date).toBe("2026-10-08")
  })

  test("no old value in meta → 409 not_undoable; changed since → 409 changed_since, nothing written", async () => {
    const s = setup()
    s.t.task({ id: A, due_date: "2026-10-25" })
    const noFrom = s.t.activity({ agent: "pm", action: "status_changed", target: A, meta: { to: "done" } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: noFrom })).body.error).toBe("not_undoable")
    const stale = s.t.activity({ agent: "pm", action: "due_changed", target: A, meta: { from: "2026-10-08", to: "2026-10-20" } })
    const before = s.t.activities().length
    expect((await s.post("/api/tasks/agent/undo", { activityId: stale }))).toEqual({ status: 409, body: { error: "changed_since" } })
    expect(s.t.get(A)!.due_date).toBe("2026-10-25")
    expect(s.t.activities().length).toBe(before)
  })

  test("validation and unknown ids", async () => {
    const s = setup()
    expect((await s.post("/api/tasks/agent/undo", "{nope")).status).toBe(400)
    expect((await s.post("/api/tasks/agent/undo", { activityId: "1" })).status).toBe(400)
    expect((await s.post("/api/tasks/agent/undo", { activityId: 999 })).status).toBe(404)
  })

  test("no log, no mutation: a failed activity insert leaves the task untouched", async () => {
    const s = setup({ exec: (base) => async (sql, args) => { if (sql.startsWith("INSERT INTO agent_activity")) throw new Error("ledger down"); return base(sql, args) } })
    s.t.task({ id: A, due_date: "2026-10-20" })
    const act = s.t.activity({ agent: "pm", action: "due_changed", target: A, meta: { from: "2026-10-08", to: "2026-10-20" } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).status).toBe(503)
    expect(s.t.get(A)!.due_date).toBe("2026-10-20")
  })

  test("atomic: the log insert failing after the UPDATE rolls the UPDATE back; the retry is not already_undone", async () => {
    let fail = true
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("INSERT INTO agent_activity") && fail) { fail = false; throw new Error("blip") }
      return base(sql, args)
    } })
    s.t.task({ id: A, due_date: "2026-10-20" })
    const act = s.t.activity({ agent: "pm", action: "due_changed", target: A, meta: { from: "2026-10-08", to: "2026-10-20" } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).status).toBe(503)
    expect([s.t.get(A)!.due_date, s.t.activities().length]).toEqual(["2026-10-20", 1])
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).status).toBe(200)
    expect([s.t.get(A)!.due_date, s.t.activities().length]).toEqual(["2026-10-08", 2])
  })
})

describe("POST /api/tasks/agent/proposals/:id", () => {
  const slipped = (s: ReturnType<typeof setup>, id: string) => {
    s.t.task({ id, due_date: "2026-10-01" })
    s.t.activity({ agent: "companion", action: "due_changed", target: id, meta: { from: "2026-09-10", to: "2026-09-20" } })
    s.t.activity({ agent: "companion", action: "due_changed", target: id, meta: { from: "2026-09-20", to: "2026-10-01" } })
  }

  test("reschedule: accept with the suggested date (+7 d), logged with the old value, then undoable", async () => {
    const s = setup()
    slipped(s, A)
    const g = await s.get()
    expect(g.body.proposals.items.map((p: any) => p.id)).toEqual([`slip:${A}`])
    const r = await s.post(`/api/tasks/agent/proposals/slip:${A}`, { action: "accept" })
    expect(r.body).toMatchObject({ ok: true, decision: "accept", detail: { due: "2026-10-13" } })
    expect(s.t.get(A)!.due_date).toBe("2026-10-13")
    const log = s.t.activities().at(-1)!
    expect(log).toMatchObject({ agent_slug: "tasks-agent", action: "due_changed" })
    expect(JSON.parse(String(log.meta))).toMatchObject({ from: "2026-10-01", to: "2026-10-13", by: "jeremie", proposal: `slip:${A}` })
    expect(s.frames.at(-1)).toMatchObject({ type: "tasks_changed", why: "agent" })
    expect((await s.get()).body.proposals.items).toEqual([]) // decided: hidden
    expect((await s.post("/api/tasks/agent/undo", { activityId: Number(log.id) })).status).toBe(200)
    expect(s.t.get(A)!.due_date).toBe("2026-10-01")
  })

  test("reschedule: the accepted date change does not count as another slip", async () => {
    const s = setup()
    slipped(s, A)
    await s.post(`/api/tasks/agent/proposals/slip:${A}`, { action: "accept" })
    s.t.activity({ agent: "companion", action: "due_changed", target: A, meta: { from: "2026-10-13", to: "2026-10-20" } })
    // 3 real slips vs 2 at decision time: still hidden (re-proposes after SLIP_REPROPOSE more).
    expect((await s.get()).body.proposals.items).toEqual([])
  })

  test("reschedule: drop the date (due null), or a bad date → 400", async () => {
    const s = setup()
    slipped(s, A)
    expect((await s.post(`/api/tasks/agent/proposals/slip:${A}`, { action: "accept", due: "friday" })).status).toBe(400)
    expect((await s.post(`/api/tasks/agent/proposals/slip:${A}`, { action: "accept", due: null })).status).toBe(200)
    expect(s.t.get(A)!.due_date).toBe("")
  })

  test("assign: accept sets the assignee only (never queued)", async () => {
    const s = setup()
    s.t.task({ id: A, assignee: null, text: "Wireframe the booking page" })
    s.t.task({ id: B, assignee: null, text: "Send invoice to Granby" })
    expect((await s.get()).body.proposals.items.map((p: any) => p.id)).toEqual([`assign:${A}`])
    const r = await s.post(`/api/tasks/agent/proposals/assign:${A}`, { action: "accept" })
    expect(r.body.detail).toEqual({ assignee: "agent:frontend-design" })
    expect(s.t.get(A)).toMatchObject({ assignee: "agent:frontend-design", dispatch_status: null })
    expect(JSON.parse(String(s.t.activities().at(-1)!.meta))).toMatchObject({ from: null, to: "agent:frontend-design" })
  })

  test("assign: an accepted assign proposal can be undone (back to unassigned)", async () => {
    const s = setup()
    s.t.task({ id: A, assignee: null, text: "Wireframe the booking page" })
    await s.post(`/api/tasks/agent/proposals/assign:${A}`, { action: "accept" })
    const log = s.t.activities().at(-1)!
    expect((await s.post("/api/tasks/agent/undo", { activityId: Number(log.id) })).body).toMatchObject({ ok: true, field: "assignee", restored: null })
    expect(s.t.get(A)!.assignee).toBeNull()
  })

  test("merge: accept closes the duplicate, keeps the first", async () => {
    const s = setup()
    s.t.task({ id: A, text: "Export the final cut", position: 1 })
    s.t.task({ id: B, text: "export the final cut!", position: 2 })
    const r = await s.post(`/api/tasks/agent/proposals/merge:${A}:${B}`, { action: "accept" })
    expect(r.body.detail).toEqual({ closed: B, kept: A })
    expect([s.t.get(A)!.done, s.t.get(B)!.done]).toEqual([0, 1])
    expect(JSON.parse(String(s.t.activities().at(-1)!.meta))).toMatchObject({ from: "open", to: "done", merged_into: A })
  })

  test("merge: refused when the kept task was closed meanwhile (never closes the last copy)", async () => {
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("SELECT id, note_id") && args[0] === A) await base("UPDATE tasks SET done = 1 WHERE id = ?", [A])
      return base(sql, args)
    } })
    s.t.task({ id: A, text: "Export the final cut", position: 1 })
    s.t.task({ id: B, text: "export the final cut!", position: 2 })
    expect((await s.post(`/api/tasks/agent/proposals/merge:${A}:${B}`, { action: "accept" })).body.error).toBe("stale")
    expect(s.t.get(B)!.done).toBe(0)
  })

  test("merge: the closing UPDATE re-checks the kept task and open subtasks (no race window)", async () => {
    const C = "cccccccccc"
    const raced = setup({ exec: (base) => async (sql, args) => {
      // The kept task is closed between the pre-check and the closing UPDATE.
      if (sql.startsWith("UPDATE tasks SET done")) await base("UPDATE tasks SET done = 1 WHERE id = ?", [A])
      return base(sql, args)
    } })
    raced.t.task({ id: A, text: "Export the final cut", position: 1 })
    raced.t.task({ id: B, text: "export the final cut!", position: 2 })
    expect((await raced.post(`/api/tasks/agent/proposals/merge:${A}:${B}`, { action: "accept" })).body.error).toBe("changed_since")
    expect(raced.t.get(B)!.done).toBe(0)
    expect(raced.t.activities().length).toBe(0)

    const kid = setup({ exec: (base) => async (sql, args) => {
      // An open subtask lands under the duplicate before the closing UPDATE.
      if (sql.startsWith("UPDATE tasks SET done")) base("INSERT INTO tasks (id, note_id, parent_id, text, assignee) VALUES (?, 'projects/p1', ?, 'kid', 'human:jeremie')", [C, B])
      return base(sql, args)
    } })
    kid.t.task({ id: A, text: "Export the final cut", position: 1 })
    kid.t.task({ id: B, text: "export the final cut!", position: 2 })
    expect((await kid.post(`/api/tasks/agent/proposals/merge:${A}:${B}`, { action: "accept" })).body.error).toBe("changed_since")
    expect(kid.t.get(B)!.done).toBe(0)
  })

  test("merge: refused when the kept task's text changed after the proposal (it no longer duplicates)", async () => {
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("SELECT id, note_id") && args[0] === A) await base("UPDATE tasks SET text = 'Something else entirely' WHERE id = ?", [A])
      return base(sql, args)
    } })
    s.t.task({ id: A, text: "Export the final cut", position: 1 })
    s.t.task({ id: B, text: "export the final cut!", position: 2 })
    expect((await s.post(`/api/tasks/agent/proposals/merge:${A}:${B}`, { action: "accept" })).body.error).toBe("stale")
    expect(s.t.get(B)!.done).toBe(0)
    expect(s.t.activities().length).toBe(0)
  })

  test("merge: the kept task's text edited between the read and the closing UPDATE closes nothing", async () => {
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("UPDATE tasks SET done")) await base("UPDATE tasks SET text = 'Something else entirely' WHERE id = ?", [A])
      return base(sql, args)
    } })
    s.t.task({ id: A, text: "Export the final cut", position: 1 })
    s.t.task({ id: B, text: "export the final cut!", position: 2 })
    expect((await s.post(`/api/tasks/agent/proposals/merge:${A}:${B}`, { action: "accept" })).body.error).toBe("changed_since")
    expect(s.t.get(B)!.done).toBe(0)
    expect(s.t.activities().length).toBe(0)
  })

  test("undo of a created subtask: reassigned to an agent between the scope check and the DELETE → nothing deleted", async () => {
    const K = "kkkkkkkkkk"
    const s = setup({ exec: (base) => async (sql, args) => {
      const r = await base(sql, args)
      if (sql.startsWith("SELECT id, note_id") && args[0] === K) await base("UPDATE tasks SET assignee = 'agent:builder' WHERE id = ?", [K])
      return r
    } })
    s.t.task({ id: A, text: VAGUE })
    s.t.task({ id: K, parent_id: A, text: "Draft the site map" })
    const act = s.t.activity({ agent: "tasks-agent", action: "subtask_created", target: K, meta: { from: null, to: "Draft the site map", created: true, parent: A, by: "jeremie", rowKey: SUBKEY } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).body.error).toBe("changed_since")
    expect(s.t.get(K)).not.toBeNull()
    expect(s.t.activities().filter((a) => a.action === "undo").length).toBe(0)
  })

  test("undo of a created subtask: a due date or description added since creation → nothing deleted, edit kept", async () => {
    const K = "kkkkkkkkkk"
    for (const edit of ["due_date = '2026-11-01'", "description = 'client notes'"]) {
      const s = setup({ exec: (base) => async (sql, args) => {
        const r = await base(sql, args)
        if (sql.startsWith("SELECT id, note_id") && args[0] === K) await base(`UPDATE tasks SET ${edit} WHERE id = ?`, [K])
        return r
      } })
      s.t.task({ id: A, text: VAGUE })
      s.t.task({ id: K, parent_id: A, text: "Draft the site map" })
      const act = s.t.activity({ agent: "tasks-agent", action: "subtask_created", target: K, meta: { from: null, to: "Draft the site map", created: true, parent: A, by: "jeremie", rowKey: SUBKEY } })
      expect((await s.post("/api/tasks/agent/undo", { activityId: act })).body.error).toBe("changed_since")
      expect(s.t.get(K)).not.toBeNull()
      expect(s.t.activities().filter((a) => a.action === "undo").length).toBe(0)
    }
  })

  test("merge: a duplicate moved to another project between the read and the write is not closed", async () => {
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("UPDATE tasks SET done")) await base("UPDATE tasks SET note_id = 'projects/other' WHERE id = ?", [B])
      return base(sql, args)
    } })
    s.t.task({ id: A, text: "Export the final cut", position: 1 })
    s.t.task({ id: B, text: "export the final cut!", position: 2 })
    expect((await s.post(`/api/tasks/agent/proposals/merge:${A}:${B}`, { action: "accept" })).body.error).toBe("changed_since")
    expect(s.t.get(B)!.done).toBe(0)
    expect(s.t.activities().length).toBe(0)
  })

  test("split: the parent moved to another project between the read and the insert → no children, 409", async () => {
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("SELECT MAX(position)")) await base("UPDATE tasks SET note_id = 'projects/other' WHERE id = ?", [A])
      return base(sql, args)
    } })
    s.t.task({ id: A, text: VAGUE, position: 4 })
    const r = await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept", subtasks: ["Draft the site map", "Pick the photos"], parentVersion: PV })
    expect([r.status, r.body.error]).toEqual([409, "changed_since"])
    expect(s.t.db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(A)).toEqual({ n: 0 })
    expect(s.t.activities().length).toBe(0)
  })

  test("split: a draft made for an older parent text is refused (draft_stale); a missing version is a 400", async () => {
    const s = setup()
    s.t.task({ id: A, text: VAGUE, position: 4 })
    const draft = await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept" })
    s.t.db.query("UPDATE tasks SET text = ? WHERE id = ?").run(`${VAGUE} and also the newsletter`, A)
    const body = { action: "accept", subtasks: draft.body.subtasks, parentVersion: draft.body.parentVersion }
    expect(await s.post(`/api/tasks/agent/proposals/split:${A}`, body)).toEqual({ status: 409, body: { error: "draft_stale" } })
    expect((await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept", subtasks: draft.body.subtasks })).body.error).toBe("parent_version_required")
    expect(s.t.db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(A)).toEqual({ n: 0 })
  })

  test("split: the parent text edited between the version check and the insert → nothing written", async () => {
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("SELECT MAX(position)")) await base("UPDATE tasks SET text = text || ' (edited)' WHERE id = ?", [A])
      return base(sql, args)
    } })
    s.t.task({ id: A, text: VAGUE, position: 4 })
    const r = await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept", subtasks: ["Draft the site map", "Pick the photos"], parentVersion: PV })
    expect([r.status, r.body.error]).toEqual([409, "changed_since"])
    expect(s.t.db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(A)).toEqual({ n: 0 })
  })

  test("undo of a created subtask: moved to another project between the read and the DELETE → nothing deleted", async () => {
    const K = "kkkkkkkkkk"
    const s = setup({ exec: (base) => async (sql, args) => {
      const r = await base(sql, args)
      if (sql.startsWith("SELECT id, note_id") && args[0] === K) await base("UPDATE tasks SET note_id = 'projects/other' WHERE id = ?", [K])
      return r
    } })
    s.t.task({ id: A, text: VAGUE })
    s.t.task({ id: K, parent_id: A, text: "Draft the site map" })
    const act = s.t.activity({ agent: "tasks-agent", action: "subtask_created", target: K, meta: { from: null, to: "Draft the site map", created: true, parent: A, by: "jeremie", rowKey: SUBKEY } })
    expect((await s.post("/api/tasks/agent/undo", { activityId: act })).body.error).toBe("changed_since")
    expect(s.t.get(K)).toMatchObject({ note_id: "projects/other" })
    expect(s.t.activities().filter((a) => a.action === "undo").length).toBe(0)
  })

  test("split: a description added after the draft makes the draft stale (parentVersion covers the description)", async () => {
    const s = setup()
    s.t.task({ id: A, text: VAGUE, position: 4 })
    const draft = await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept" })
    s.t.db.query("UPDATE tasks SET description = 'the client also wants a shop' WHERE id = ?").run(A)
    const r = await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept", subtasks: draft.body.subtasks, parentVersion: draft.body.parentVersion })
    expect([r.status, r.body.error]).toEqual([409, "draft_stale"])
    expect(s.t.db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(A)).toEqual({ n: 0 })
  })

  test("assign: a task edited after the proposal was derived (its rule no longer matches) is not assigned", async () => {
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("SELECT id, note_id") && args[0] === A) await base("UPDATE tasks SET text = 'Call the client about the photos' WHERE id = ?", [A])
      return base(sql, args)
    } })
    s.t.task({ id: A, assignee: null, text: "Wireframe the booking page" })
    const r = await s.post(`/api/tasks/agent/proposals/assign:${A}`, { action: "accept" })
    expect([r.status, r.body.error]).toEqual([409, "stale"])
    expect(s.t.get(A)!.assignee).toBeNull()
    expect(s.t.activities().length).toBe(0)
  })

  test("split: a mid-way failure rolls back (no log, no subtask); the retry inserts once, after the note's last task", async () => {
    let fail = true
    const s = setup({ exec: (base) => async (sql, args) => {
      if (sql.startsWith("INSERT INTO tasks") && args[3] === "Pick the photos" && fail) { fail = false; throw new Error("blip") }
      return base(sql, args)
    } })
    s.t.task({ id: A, text: VAGUE, position: 4 })
    s.t.task({ id: B, text: "Next sibling", position: 5 })
    const body = { action: "accept", subtasks: ["Draft the site map", "Pick the photos"], parentVersion: PV }
    expect((await s.post(`/api/tasks/agent/proposals/split:${A}`, body)).status).toBe(503)
    expect([s.t.db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(A), s.t.activities().length]).toEqual([{ n: 0 }, 0])
    expect((await s.post(`/api/tasks/agent/proposals/split:${A}`, body)).status).toBe(200)
    expect(s.t.db.query("SELECT text, position FROM tasks WHERE parent_id = ? ORDER BY position").all(A))
      .toEqual([{ text: "Draft the site map", position: 6 }, { text: "Pick the photos", position: 7 }])
  })

  test("split: a concurrent accept that already inserted subtasks → 409, nothing inserted twice", async () => {
    const C = "cccccccccc"
    const s = setup({ exec: (base) => async (sql, args) => {
      // The other accept commits its subtasks between our read and our insert transaction.
      if (sql.startsWith("SELECT MAX(position)")) await base("INSERT INTO tasks (id, note_id, parent_id, text, assignee) VALUES (?, 'projects/p1', ?, 'Draft the site map', 'human:jeremie')", [C, A])
      return base(sql, args)
    } })
    s.t.task({ id: A, text: VAGUE, position: 4 })
    const body = { action: "accept", subtasks: ["Draft the site map", "Pick the photos"], parentVersion: PV }
    expect((await s.post(`/api/tasks/agent/proposals/split:${A}`, body))).toEqual({ status: 409, body: { error: "changed_since" } })
    expect(s.t.db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(A)).toEqual({ n: 1 })
    expect(s.t.activities().length).toBe(0)
  })

  test("split: accept drafts subtasks (nothing written), accept with subtasks inserts them under the parent; each undoable", async () => {
    const s = setup()
    s.t.task({ id: A, text: VAGUE, position: 4 })
    const draft = await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept" })
    expect(draft.body).toEqual({ ok: true, stage: "confirm", proposalId: `split:${A}`, subtasks: ["Draft the site map", "Pick the photos", "Write the blog post"], parentVersion: PV })
    expect(s.t.activities().length).toBe(0)
    expect((await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept", subtasks: ["only one"] })).status).toBe(400)
    const r = await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept", subtasks: ["Draft the site map", "Pick the photos"], parentVersion: PV })
    expect(r.body.detail.subtaskIds.length).toBe(2)
    const kids = s.t.db.query("SELECT text, parent_id, assignee, done FROM tasks WHERE parent_id = ? ORDER BY position").all(A)
    expect(kids).toEqual([
      { text: "Draft the site map", parent_id: A, assignee: "human:jeremie", done: 0 },
      { text: "Pick the photos", parent_id: A, assignee: "human:jeremie", done: 0 },
    ])
    const logs = s.t.activities().filter((a) => a.action === "subtask_created")
    expect(logs.length).toBe(2)
    expect((await s.post("/api/tasks/agent/undo", { activityId: Number(logs[0]!.id) })).body).toMatchObject({ ok: true, field: "created" })
    expect(s.t.db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(A)).toEqual({ n: 1 })
  })

  test("split: Haiku unavailable → 502 split_unavailable", async () => {
    const s = setup({ split: null })
    s.t.task({ id: A, text: VAGUE })
    expect((await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "accept" }))).toEqual({ status: 502, body: { error: "split_unavailable" } })
  })

  test("dismiss hides it; unknown or stale ids → 404; bad input → 400", async () => {
    const s = setup()
    s.t.task({ id: A, text: VAGUE })
    expect((await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "dismiss" })).body).toMatchObject({ ok: true, decision: "dismiss" })
    expect((await s.get()).body.proposals.items).toEqual([])
    expect((await s.post(`/api/tasks/agent/proposals/split:${A}`, { action: "dismiss" })).status).toBe(404)
    expect((await s.post(`/api/tasks/agent/proposals/slip:${B}`, { action: "accept" })).status).toBe(404)
    expect((await s.post("/api/tasks/agent/proposals/nope", { action: "accept" })).status).toBe(400)
    expect((await s.post(`/api/tasks/agent/proposals/slip:${A}`, { action: "maybe" })).status).toBe(400)
    expect(s.t.activities().length).toBe(0)
  })

  test("a task changed under the proposal → 409 changed_since and no activity row left behind", async () => {
    const s = setup({
      exec: (base) => async (sql, args) => {
        // Someone moves the date between the read and the CAS update.
        if (sql.startsWith("UPDATE tasks SET due_date")) await base("UPDATE tasks SET due_date = '2026-12-01' WHERE id = ?", [args[1]!])
        return base(sql, args)
      },
    })
    slipped(s, A)
    const before = s.t.activities().length
    expect((await s.post(`/api/tasks/agent/proposals/slip:${A}`, { action: "accept" }))).toEqual({ status: 409, body: { error: "changed_since" } })
    expect(s.t.activities().length).toBe(before)
    expect(s.t.get(A)!.due_date).toBe("2026-12-01")
  })
})

test("undoSpec: only rows carrying the old value", () => {
  expect(undoSpec("due_changed", { from: "2026-10-08", to: "2026-10-20" })).toEqual({ field: "due", from: "2026-10-08", to: "2026-10-20" })
  expect(undoSpec("due_changed", { to: "2026-10-20" })).toBeNull()
  expect(undoSpec("status_changed", { from: "open", to: "done" })).toEqual({ field: "done", from: false, to: true })
  expect(undoSpec("status_changed", { to: "done" })).toBeNull()
  expect(undoSpec("assignee_changed", { from: null, to: "agent:x" })).toEqual({ field: "assignee", from: null, to: "agent:x" })
  expect(undoSpec("dispatch:running", { from: "a" })).toBeNull()
  expect(undoSpec("due_changed", null)).toBeNull()
})

describe("POST /api/tasks/agent/chat/:planId", () => {
  test("unknown plan → 404; bad body → 400", async () => {
    const s = setup()
    expect((await s.post("/api/tasks/agent/chat/abcdef0123456789", { confirm: true })).status).toBe(404)
    expect((await s.post("/api/tasks/agent/chat/abcdef0123456789", { confirm: "yes" })).status).toBe(400)
  })
})

