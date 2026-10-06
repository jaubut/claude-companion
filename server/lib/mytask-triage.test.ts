import { describe, expect, test } from "bun:test"
import type { TaskRow } from "./my-tasks"
import { BATCH_MIN, createMyTaskTriage, overdueItems } from "./mytask-triage"
import { allowedActions, fallbackPhrase, heuristicSeverity, withAskOpus, type TriageItem } from "./triage"
import { routable } from "./resolver"
import type { ExecFn, QueryFn, Row, SqlArg } from "./turso"

const TODAY = "2026-10-06"
const NOW = Date.parse("2026-10-06T15:00:00Z")
const row = (id: string, due: string | null, o: Partial<TaskRow> = {}): TaskRow => ({
  id, noteId: "projects/p1", parentId: null, text: `task ${id}`, description: null, due, position: 0,
  noteTitle: "Cage au Sport", noteRef: null, noteFolder: "projects", ...o,
})

describe("overdueItems", () => {
  test("only past-due tasks; today and undated never", () => {
    const items = overdueItems([row("a", "2026-10-05"), row("b", TODAY), row("c", null), row("d", "2026-11-01")], TODAY, NOW)
    expect(items.map((i) => i.refId)).toEqual(["a"])
    expect(items[0]!.facts.problem).toBe("Due 2026-10-05, 1 day ago.")
  })

  test(`a project with ≥ ${BATCH_MIN} overdue becomes one batch card, oldest first`, () => {
    const items = overdueItems([
      row("a", "2026-05-20"), row("b", "2026-05-18"), row("c", "2026-06-01"),
      row("x", "2026-10-01", { noteId: "projects/p2", noteTitle: "Granby" }),
    ], TODAY, NOW)
    const batch = items.find((i) => i.refId === "p:projects/p1")!
    expect(batch.title).toBe("3 overdue tasks in Cage au Sport")
    expect(batch.ref).toMatchObject({ source: "mytask", taskIds: ["b", "a", "c"], oldestDue: "2026-05-18", lateDays: 141 })
    expect(items.find((i) => i.refId === "x")!.title).toBe("task x")
  })

  test("version changes when a due date moves (a stale choose is refused)", () => {
    const a = overdueItems([row("a", "2026-10-01")], TODAY, NOW)[0]!.version
    const b = overdueItems([row("a", "2026-10-02")], TODAY, NOW)[0]!.version
    expect(a).not.toBe(b)
  })
})

describe("phrasing + policy", () => {
  const card = (late: string, n = 1) => overdueItems(Array.from({ length: n }, (_, i) => row(`t${i}`, late)), TODAY, NOW)[0]!

  test("recent → Move to next week first; stale → Drop the date first; snooze last", () => {
    const recent = fallbackPhrase(card("2026-10-01"))
    expect(recent.options.map((o) => o.label)).toEqual(["Move to next week", "Done", "Drop the date", "Snooze for a day"])
    expect(recent.recommended).toBe("a")
    const stale = fallbackPhrase(card("2026-05-01", 4))
    expect(stale.options.map((o) => o.label)).toEqual(["Drop the date", "Move to next week", "Mark all done", "Snooze for a day"])
    expect(stale.action).toContain("drop the dates")
    expect(stale.context).toContain("• task t0 (2026-05-01)")
  })

  test("money / client words: urgent and never 'Drop the date' first, however late", () => {
    const inv = overdueItems([row("i", "2026-05-05", { text: "Generate invoice from TLS-2026-04-Q001, send to client" })], TODAY, NOW)[0]!
    expect(heuristicSeverity(inv)).toBe("urgent")
    expect(fallbackPhrase(inv).options[0]!.label).toBe("Move to next week")
  })

  test("options ride on approve + task op (shown by the shipped iOS build)", () => {
    const p = fallbackPhrase(card("2026-10-01"))
    expect(p.options.slice(0, 3).map((o) => o.action)).toEqual([
      { kind: "approve", task: "next_week" }, { kind: "approve", task: "done" }, { kind: "approve", task: "undate" },
    ])
    expect(allowedActions(card("2026-10-01"))).toEqual(["approve", "snooze"])
  })

  test("severity: stale → low; recent → normal; never Opus, never an Ask Opus button", () => {
    expect(heuristicSeverity(card("2026-05-01"))).toBe("low")
    expect(heuristicSeverity(card("2026-10-01"))).toBe("normal")
    expect(routable(card("2026-10-01"))).toBe(false)
    const item = { source: "mytask", options: [] } as unknown as TriageItem
    expect(withAskOpus(item)).toBe(item)
  })
})

describe("execute", () => {
  function db(tasks: { id: string; due_date: string; done: number }[]) {
    const writes: string[] = []
    const query: QueryFn = async () => tasks.filter((t) => t.done === 0).map((t): Row => ({
      id: t.id, note_id: "projects/p1", parent_id: "", text: `task ${t.id}`, description: "", due_date: t.due_date, position: 0,
      note_title: "Cage au Sport", note_ref: null, note_folder: "projects",
    }))
    const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
      if (sql.startsWith("INSERT INTO agent_activity")) return { rows: [], affected: 1 }
      const t = tasks.find((x) => x.id === (sql.startsWith("UPDATE") ? args[1] : args[0]))
      if (sql.startsWith("SELECT")) return { rows: t ? [{ done: t.done, due_date: t.due_date, text: `task ${t.id}` }] : [], affected: 0 }
      if (!t) return { rows: [], affected: 0 }
      if (sql.startsWith("UPDATE tasks SET done")) { if (t.done === args[0]) return { rows: [], affected: 0 }; t.done = Number(args[0]) }
      else t.due_date = String(args[0])
      writes.push(`${t.id}:${sql.startsWith("UPDATE tasks SET done") ? "done" : `due=${args[0]}`}`)
      return { rows: [], affected: 1 }
    }
    return { query, exec, writes, tasks }
  }
  const make = (d: ReturnType<typeof db>, onWrite?: (ids: string[]) => void) => createMyTaskTriage({ query: d.query, exec: d.exec, now: () => NOW, onWrite })

  test("batch: Drop the date applies to every task, pushes once", async () => {
    const d = db([{ id: "a", due_date: "2026-05-01", done: 0 }, { id: "b", due_date: "2026-05-02", done: 0 }, { id: "c", due_date: "2026-05-03", done: 0 }])
    const pushed: string[][] = []
    const tri = make(d, (ids) => pushed.push(ids))
    const [src] = await tri.collect()
    const opt = fallbackPhrase(src!).options[0]!
    expect(await tri.execute(src!, opt)).toEqual({ kind: "done", detail: { op: "undate", tasks: 3 } })
    expect(d.writes).toEqual(["a:due=", "b:due=", "c:due="])
    expect(pushed).toEqual([["a", "b", "c"]])
    expect(await tri.current(src!)).toBeNull() // nothing overdue any more → card leaves
  })

  test("Move to next week = today + 7 in Toronto (not old due + 7)", async () => {
    const d = db([{ id: "a", due_date: "2026-10-01", done: 0 }])
    const tri = make(d)
    const [src] = await tri.collect()
    const out = await tri.execute(src!, fallbackPhrase(src!).options[0]!)
    expect(out).toEqual({ kind: "done", detail: { op: "next_week", tasks: 1, due: "2026-10-13" } })
  })

  test("Done marks done; a card whose tasks vanished is stale", async () => {
    const d = db([{ id: "a", due_date: "2026-10-01", done: 0 }])
    const tri = make(d)
    const [src] = await tri.collect()
    const doneOpt = fallbackPhrase(src!).options.find((o) => o.label === "Done")!
    expect((await tri.execute(src!, doneOpt)).kind).toBe("done")
    expect(d.tasks[0]!.done).toBe(1)
    d.tasks.length = 0
    expect(await tri.execute(src!, doneOpt)).toEqual({ kind: "stale", reason: "tasks gone" })
  })

  test("a non-task action is refused", async () => {
    const d = db([{ id: "a", due_date: "2026-10-01", done: 0 }])
    const tri = make(d)
    const [src] = await tri.collect()
    expect(await tri.execute(src!, { id: "x", label: "x", action: { kind: "approve" } })).toEqual({ kind: "error", status: 400, error: "wrong_action" })
  })
})
