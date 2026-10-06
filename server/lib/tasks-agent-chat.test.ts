import { describe, expect, test } from "bun:test"
import { createTasksAgentRoute } from "../routes/tasks-agent"
import type { TasksAgent } from "./tasks-agent"
import { CONFIRM_OVER, createTasksChat, parsePlan, planPrompt, renderList, tasksHint } from "./tasks-agent-chat"
import type { TaskRow } from "./my-tasks"
import type { ExecFn } from "./turso"
import { testDb, txOver } from "./tasks-agent-testdb.test-util"

const NOW = Date.parse("2026-10-06T15:00:00Z") // Tuesday 11:00 Toronto

function setup(planOut: (prompt: string) => string | null) {
  const t = testDb()
  const turns: { text: string; ch: string }[] = []
  const frames: Record<string, unknown>[] = []
  const prompts: string[] = []
  const chat = createTasksChat({
    query: t.query, exec: t.exec, tx: t.tx, now: () => NOW,
    plan: async (p) => { prompts.push(p); return planOut(p) },
    emitTurn: (text, ch) => turns.push({ text, ch }),
    notify: (f) => frames.push(f),
  })
  return { t, chat, turns, frames, prompts }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `g${String(i).padStart(9, "0")}`)

function seedGranby(t: ReturnType<typeof testDb>, n: number) {
  t.note("projects/granby", "Granby 321")
  for (const id of ids(n)) t.task({ id, note_id: "projects/granby", text: `Granby ${id}`, due_date: "2026-10-07" })
}

describe("hint", () => {
  test("my plate / moves to a day / mark done; not code or queue talk", () => {
    expect(tasksHint("what is on my plate this week")).toBe(true)
    expect(tasksHint("Qu'est-ce que j'ai dans mes tâches cette semaine?")).toBe(true)
    expect(tasksHint("move everything Granby to Friday")).toBe(true)
    expect(tasksHint("déplace Granby à vendredi")).toBe(true)
    expect(tasksHint("mark the Granby tasks done")).toBe(true)
    expect(tasksHint("move the sidebar to the left in tls-dashboard")).toBe(false)
    expect(tasksHint("what's running in the queue?")).toBe(false)
  })
})

describe("parsePlan", () => {
  const valid = new Set(["aaaaaaaaaa", "bbbbbbbbbb"])
  test("validates ops, dates and ids", () => {
    expect(parsePlan('{"op":"list","from":"2026-10-06","to":"2026-10-11","project":null}', valid)).toEqual({ op: "list", from: "2026-10-06", to: "2026-10-11", project: null })
    expect(parsePlan('```json\n{"op":"move","taskIds":["aaaaaaaaaa","zzz"],"due":"2026-10-09"}\n```', valid)).toEqual({ op: "move", taskIds: ["aaaaaaaaaa"], due: "2026-10-09" })
    expect(parsePlan('{"op":"move","taskIds":["zzz"],"due":"2026-10-09"}', valid)).toBeNull()
    expect(parsePlan('{"op":"move","taskIds":["aaaaaaaaaa"],"due":"Friday"}', valid)).toBeNull()
    expect(parsePlan('{"op":"move","taskIds":["aaaaaaaaaa"],"due":null}', valid)).toEqual({ op: "move", taskIds: ["aaaaaaaaaa"], due: null })
    expect(parsePlan('{"op":"done","taskIds":["bbbbbbbbbb"]}', valid)).toEqual({ op: "done", taskIds: ["bbbbbbbbbb"] })
    expect(parsePlan('{"op":"not_tasks"}', valid)).toEqual({ op: "not_tasks" })
    expect(parsePlan('{"op":"list","from":"2026-10-11","to":"2026-10-06"}', valid)).toBeNull()
    expect(parsePlan("sorry", valid)).toBeNull()
  })
})

describe("prompt + list", () => {
  const row = (id: string, due: string | null, title = "Granby 321"): TaskRow => ({
    id, noteId: "projects/granby", parentId: null, text: `text ${id}`, description: null, due, position: 0, noteTitle: title, noteRef: "PRJ-G", noteFolder: "projects",
  })
  test("the prompt carries today's weekday and every task id", () => {
    const p = planPrompt({ text: "what's on my plate", today: "2026-10-06", tasks: [row("aaaaaaaaaa", "2026-10-07")], recent: [] })
    expect(p).toContain("Tuesday 2026-10-06")
    expect(p).toContain("aaaaaaaaaa | 2026-10-07 | Granby 321 | text aaaaaaaaaa")
  })
  test("list: range, project filter, overdue footnote", () => {
    const tasks = [row("a1", "2026-10-07"), row("a2", "2026-10-03"), row("a3", "2026-10-20"), row("b1", "2026-10-08", "Other")]
    const out = renderList(tasks, { op: "list", from: "2026-10-06", to: "2026-10-11", project: "granby 321" }, "2026-10-06")
    expect(out).toBe("1 task in granby 321 for Tue, Oct 6 – Sun, Oct 11:\n• Wed, Oct 7 — Granby 321: text a1\n\nPlus 1 overdue in granby 321 (oldest 2026-10-03).")
    expect(renderList([], { op: "list", from: "2026-10-06", to: "2026-10-06", project: null }, "2026-10-06")).toBe("Nothing dated for Tue, Oct 6.")
  })
})

describe("chat tool", () => {
  test("list → deterministic answer from his tasks", async () => {
    const s = setup(() => '{"op":"list","from":"2026-10-06","to":"2026-10-11","project":null}')
    seedGranby(s.t, 2)
    expect(await s.chat.handle("what is on my plate this week", "general")).toBe(true)
    expect(s.turns[0]!.text).toStartWith("2 tasks for")
    expect(s.prompts[0]).toContain("g000000000")
  })

  test(`move of <= ${CONFIRM_OVER} tasks applies at once through the tasks-agent transactional path`, async () => {
    const s = setup(() => `{"op":"move","taskIds":${JSON.stringify(ids(3))},"due":"2026-10-09"}`)
    seedGranby(s.t, 3)
    await s.chat.handle("move everything Granby to Friday", "general")
    expect(ids(3).map((id) => s.t.get(id)!.due_date)).toEqual(["2026-10-09", "2026-10-09", "2026-10-09"])
    expect(s.t.activities().map((a) => [a.agent_slug, a.action])).toEqual(Array(3).fill(["tasks-agent", "due_changed"]))
    expect(JSON.parse(String(s.t.activities()[0]!.meta))).toMatchObject({ from: "2026-10-07", to: "2026-10-09" })
    expect(s.turns.at(-1)!.text).toBe("Moved 3 tasks to Fri, Oct 9.")
    expect(s.frames).toEqual([{ type: "tasks_changed", why: "due" }])
  })

  test(`move of > ${CONFIRM_OVER} tasks is held as a confirm card; "confirm" applies it`, async () => {
    const s = setup(() => `{"op":"move","taskIds":${JSON.stringify(ids(5))},"due":"2026-10-09"}`)
    seedGranby(s.t, 5)
    await s.chat.handle("move everything Granby to Friday", "general")
    expect(s.t.activities().length).toBe(0)
    const card = s.frames[0]!
    expect(card).toMatchObject({ type: "tasks_agent_confirm", op: "move", due: "2026-10-09", threadId: "general" })
    expect((card.tasks as unknown[]).length).toBe(5)
    expect(s.turns[0]!.text).toStartWith("Move 5 tasks to Fri, Oct 9?")
    expect(await s.chat.confirmReply("confirm", "other-channel")).toBe(false)
    expect(await s.chat.confirmReply("confirm", "general")).toBe(true)
    expect(ids(5).every((id) => s.t.get(id)!.due_date === "2026-10-09")).toBe(true)
    expect(s.chat.pendingCount()).toBe(0)
  })

  test('"cancel" drops a held card; the confirm endpoint applies one', async () => {
    const s = setup(() => `{"op":"done","taskIds":${JSON.stringify(ids(4))}}`)
    seedGranby(s.t, 4)
    await s.chat.handle("mark all the Granby tasks done", "general")
    expect(await s.chat.confirmReply("cancel", "general")).toBe(true)
    expect(s.turns.at(-1)!.text).toBe("Cancelled — nothing changed.")
    expect(ids(4).every((id) => s.t.get(id)!.done === 0)).toBe(true)

    await s.chat.handle("mark all the Granby tasks done", "general")
    const planId = String(s.frames.at(-1)!.planId)
    const route = createTasksAgentRoute({ agent: {} as TasksAgent, chat: s.chat, notify: () => {} })
    const req = new Request(`http://localhost/api/tasks/agent/chat/${planId}`, { method: "POST", body: JSON.stringify({ confirm: true }) })
    const res = (await route(req, new URL(req.url)))!
    expect(await res.json()).toEqual({ ok: true, applied: 4 })
    expect(ids(4).every((id) => s.t.get(id)!.done === 1)).toBe(true)
    expect((await route(new Request(req.url, { method: "POST", body: JSON.stringify({ confirm: true }) }), new URL(req.url)))!.status).toBe(404)
  })

  test("not_tasks hands the message back; unreadable model output gets a clarifying turn", async () => {
    const back = setup(() => '{"op":"not_tasks"}')
    expect(await back.chat.handle("move the sidebar to friday's design", "general")).toBe(false)
    expect(back.turns.length).toBe(0)
    const lost = setup(() => null)
    expect(await lost.chat.handle("move it to friday", "general")).toBe(true)
    expect(lost.turns[0]!.text).toContain("couldn't work out")
  })

  test("a failed plan on a hint-only route hands the message back, no turn", async () => {
    const s = setup(() => null)
    expect(await s.chat.handle("move it to friday", "general", [], "hint")).toBe(false)
    expect(s.turns.length).toBe(0)
  })

  test("confirm skips a task whose due changed since the plan, applies the rest, reports it", async () => {
    const s = setup(() => `{"op":"move","taskIds":${JSON.stringify(ids(5))},"due":"2026-10-09"}`)
    seedGranby(s.t, 5)
    await s.chat.handle("move everything Granby to Friday", "general")
    const [changed, gone, ...rest] = ids(5)
    s.t.db.query("UPDATE tasks SET due_date = '2026-10-20' WHERE id = ?").run(changed!)
    s.t.db.query("UPDATE tasks SET assignee = 'agent:builder' WHERE id = ?").run(gone!)
    expect(await s.chat.confirmReply("confirm", "general")).toBe(true)
    expect(s.t.get(changed!)!.due_date).toBe("2026-10-20")
    expect(s.t.get(gone!)!.due_date).toBe("2026-10-07")
    expect(rest.every((id) => s.t.get(id)!.due_date === "2026-10-09")).toBe(true)
    expect(s.turns.at(-1)!.text).toBe(`Moved 3 tasks to Fri, Oct 9 (1 was already gone or no longer yours; skipped 1 changed since the plan: Granby ${changed}).`)
    expect(s.chat.pendingCount()).toBe(0)
  })

  test("a plain yes with nothing pending is not consumed", async () => {
    const s = setup(() => null)
    expect(await s.chat.confirmReply("yes", "general")).toBe(false)
  })

  test('only "confirm"/"cancel" answer a held card; "yes"/"ok" pass through to the brain', async () => {
    const s = setup(() => `{"op":"move","taskIds":${JSON.stringify(ids(5))},"due":"2026-10-09"}`)
    seedGranby(s.t, 5)
    await s.chat.handle("move everything Granby to Friday", "general")
    for (const w of ["yes", "ok", "go", "oui", "no"]) expect(await s.chat.confirmReply(w, "general")).toBe(false)
    expect(s.chat.pendingCount()).toBe(1)
    expect(s.t.activities().length).toBe(0)
  })

  test("a date edited between the stale-state check and the write is never overwritten (atomic CAS)", async () => {
    const t = testDb()
    const ch = createTasksChat({
      query: t.query, now: () => NOW, tx: t.tx,
      exec: async (sql, args) => {
        const r = await t.exec(sql, args)
        // The newer edit lands right after the chat reads the row, before its write.
        if (sql.startsWith("SELECT id, note_id") && args[0] === ids(1)[0]) t.db.query("UPDATE tasks SET due_date = '2026-12-01' WHERE id = ?").run(ids(1)[0]!)
        return r
      },
      plan: async () => `{"op":"move","taskIds":${JSON.stringify(ids(1))},"due":"2026-10-09"}`,
      emitTurn: (x) => turns.push(x), notify: () => {},
    })
    const turns: string[] = []
    seedGranby(t, 1)
    await ch.handle("move Granby to Friday", "general")
    expect(t.get(ids(1)[0]!)!.due_date).toBe("2026-12-01")
    expect(t.activities().length).toBe(0)
    expect(turns.at(-1)).toContain("skipped 1 changed since the plan")
  })

  test("a chat move and its activity row commit together: a failing log insert rolls the move back", async () => {
    const t = testDb()
    const flaky: ExecFn = async (sql, args) => {
      if (sql.startsWith("INSERT INTO agent_activity")) throw new Error("turso blip")
      return t.exec(sql, args)
    }
    const turns: string[] = []
    const ch = createTasksChat({
      query: t.query, now: () => NOW, tx: txOver(flaky), exec: flaky,
      plan: async () => `{"op":"move","taskIds":${JSON.stringify(ids(1))},"due":"2026-10-09"}`,
      emitTurn: (x) => turns.push(x), notify: () => {},
    })
    seedGranby(t, 1)
    await ch.handle("move Granby to Friday", "general")
    expect(t.get(ids(1)[0]!)!.due_date).toBe("2026-10-07")
    expect(turns.at(-1)).toContain("failed to save")
  })

  test("confirming an old card skips tasks renamed or moved to another project since the plan", async () => {
    const s = setup(() => `{"op":"move","taskIds":${JSON.stringify(ids(5))},"due":"2026-10-09"}`)
    seedGranby(s.t, 5)
    await s.chat.handle("move everything Granby to Friday", "general")
    const [renamed, moved, ...rest] = ids(5)
    s.t.db.query("UPDATE tasks SET text = 'Something else now' WHERE id = ?").run(renamed!)
    s.t.db.query("UPDATE tasks SET note_id = 'projects/other' WHERE id = ?").run(moved!)
    expect(await s.chat.confirmReply("confirm", "general")).toBe(true)
    expect([renamed!, moved!].map((id) => s.t.get(id)!.due_date)).toEqual(["2026-10-07", "2026-10-07"])
    expect(rest.every((id) => s.t.get(id)!.due_date === "2026-10-09")).toBe(true)
    expect(s.turns.at(-1)!.text).toContain("skipped 2 changed since the plan")
  })

  describe("echoed rowVersions on confirm", () => {
    const held = async () => {
      const s = setup(() => `{"op":"move","taskIds":${JSON.stringify(ids(5))},"due":"2026-10-09"}`)
      seedGranby(s.t, 5)
      await s.chat.handle("move everything Granby to Friday", "general")
      const frame = s.frames.find((f) => f.type === "tasks_agent_confirm") as { planId: string; rowVersions: Record<string, string> }
      return { s, frame }
    }

    test("the card carries each task's rowVersion", async () => {
      const { frame } = await held()
      expect(Object.keys(frame.rowVersions).sort()).toEqual(ids(5))
    })

    test("a stale echoed version skips that task, nothing written for it; the others apply", async () => {
      const { s, frame } = await held()
      const stale = { ...frame.rowVersions, [ids(5)[1]!]: "0000000000000000" }
      expect(await s.chat.confirm(frame.planId, true, stale)).toEqual({ ok: true, applied: 4 })
      expect(s.t.get(ids(5)[1]!)!.due_date).toBe("2026-10-07")
      expect(s.t.activities().some((a) => a.target_id === ids(5)[1])).toBe(false)
      expect(s.turns.at(-1)!.text).toContain("skipped 1 changed since the plan")
    })

    test("current echoed versions apply all; absent keeps the plan-time versions", async () => {
      const a = await held()
      expect(await a.s.chat.confirm(a.frame.planId, true, a.frame.rowVersions)).toEqual({ ok: true, applied: 5 })
      const b = await held()
      expect(await b.s.chat.confirm(b.frame.planId, true)).toEqual({ ok: true, applied: 5 })
    })

    test("malformed → 400 and the plan stays held", async () => {
      const { s, frame } = await held()
      expect(await s.chat.confirm(frame.planId, true, [1])).toEqual({ ok: false, status: 400, error: "row_versions_must_be_object_of_strings" })
      expect(s.chat.pendingCount()).toBe(1)
    })
  })

  test("an edit made while the model is planning is not taken as current: that task is skipped on confirm", async () => {
    let edit: () => void = () => {}
    const s = setup(() => { edit(); return `{"op":"done","taskIds":${JSON.stringify(ids(5))}}` })
    seedGranby(s.t, 5)
    const T = ids(5)[2]!
    edit = () => s.t.db.query("UPDATE tasks SET text = 'Edited during planning', due_date = '2026-12-01' WHERE id = ?").run(T)
    await s.chat.handle("mark the Granby tasks done", "general")
    const frame = s.frames.find((f) => f.type === "tasks_agent_confirm") as { planId: string; rowVersions: Record<string, string> }
    // The card's versions are the pre-model snapshot, so the edited task no longer matches.
    expect(await s.chat.confirm(frame.planId, true, frame.rowVersions)).toMatchObject({ ok: true })
    expect(s.t.get(T)!.done).toBe(0)
    expect(s.t.activities().some((a) => a.target_id === T)).toBe(false)
  })

  test("an edit during planning is skipped by a typed \"confirm\" reply too (versions are taken before the model call)", async () => {
    const T = ids(5)[2]!
    let edit: () => void = () => {}
    const s = setup(() => { edit(); return `{"op":"done","taskIds":${JSON.stringify(ids(5))}}` })
    seedGranby(s.t, 5)
    // Edit lands after the snapshot but before the model answers (the model call is the slow step).
    edit = () => s.t.db.query("UPDATE tasks SET description = 'new notes' WHERE id = ?").run(T)
    await s.chat.handle("mark the Granby tasks done", "general")
    expect(await s.chat.confirmReply("confirm", "general")).toBe(true)
    expect(s.t.get(T)!.done).toBe(0)
    expect(ids(5).filter((id) => id !== T).every((id) => s.t.get(id)!.done === 1)).toBe(true)
    expect(s.turns.at(-1)!.text).toContain("skipped 1 changed since the plan")
  })
})
