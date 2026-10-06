import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createTasksAgent } from "./tasks-agent"
import { createTasksChat } from "./tasks-agent-chat"
import { setTaskDue } from "./tasks-agent"
import { ROW_COLUMNS, type RowRaw, readTask, rowGuard, rowVersion } from "./tasks-agent-row"
import { parseAssignRules } from "./tasks-agent-rules"
import { createTasksAgentStore } from "./tasks-agent-store"
import { testDb, txOver } from "./tasks-agent-testdb.test-util"
import type { ExecFn } from "./turso"

// The class guard: every Tasks-agent write is pinned to the WHOLE row it decided on. For each write path and each
// tracked field, an edit of that field (before the write reads the row, or between that read and the commit) must
// make the write refuse, and nothing may be written by the agent.

const NOW = Date.parse("2026-10-06T15:00:00Z")
const RULES = parseAssignRules(`ROUTES = [\n    (r"\\b(design|wireframe)\\b", "frontend-design"),\n]\n`)
const VAGUE = "the whole website thing with the new client and the photos and the blog maybe"
const A = "aaaaaaaaaa", B = "bbbbbbbbbb", K = "kkkkkkkkkk"
const NOTE = "projects/p1"
const HUMAN = "human:jeremie"

/** Tracked field → [column, a different value]. */
const FIELDS: Record<string, [string, string | number]> = {
  text: ["text", "Totally different text"],
  description: ["description", "new client notes"],
  note_id: ["note_id", "projects/other"],
  parent_id: ["parent_id", "zzparent"],
  due_date: ["due_date", "2026-12-31"],
  done: ["done", 1],
  assignee: ["assignee", "agent:builder"],
}
const FIELD_NAMES = Object.keys(FIELDS)
type When = "before" | "after"

function harness(target: string, when: When, field: string | null) {
  const t = testDb()
  let fired = false
  const edit = async () => {
    if (!field || fired) return
    fired = true
    const [col, val] = FIELDS[field]!
    t.db.query(`UPDATE tasks SET ${col} = ? WHERE id = ?`).run(val, target)
  }
  const exec: ExecFn = async (sql, args) => {
    // The write path's own read of the task (readTask / readTasks).
    const isRead = sql.startsWith("SELECT id, note_id") && args[0] === target
    if (isRead && when === "before") await edit()
    const r = await t.exec(sql, args)
    if (isRead && when === "after") await edit()
    return r
  }
  const agent = createTasksAgent({
    query: t.query, exec, tx: txOver(exec), store: createTasksAgentStore(new Database(":memory:")), rules: () => RULES, now: () => NOW,
    busy: async () => null, splitter: async () => ["Draft the site map", "Pick the photos"],
  })
  const agentRows = () => t.activities().filter((a) => a.agent_slug === "tasks-agent")
  return { t, exec, agent, agentRows, edited: () => fired }
}
type H = ReturnType<typeof harness>

const slip = (h: H, id: string) => {
  h.t.task({ id, due_date: "2026-10-01" })
  h.t.activity({ agent: "companion", action: "due_changed", target: id, meta: { from: "2026-09-10", to: "2026-09-20" } })
  h.t.activity({ agent: "companion", action: "due_changed", target: id, meta: { from: "2026-09-20", to: "2026-10-01" } })
}
const refused = (r: { ok: boolean; status?: number }) => { expect(r.ok).toBe(false); expect([404, 409]).toContain(r.status ?? 0) } // 404 = the edit moved the task out of his scope, 409 = it changed

interface Path { name: string; target: string; whens: When[]; run: (h: H) => Promise<void> }

const PATHS: Path[] = [
  { name: "reschedule accept", target: A, whens: ["before", "after"], run: async (h) => { slip(h, A); refused(await h.agent.decide(`slip:${A}`, "accept", {})) } },
  { name: "assign accept", target: A, whens: ["before", "after"], run: async (h) => {
    h.t.task({ id: A, assignee: null, text: "Wireframe the booking page" }); refused(await h.agent.decide(`assign:${A}`, "accept", {}))
  } },
  { name: "merge accept, duplicate edited", target: B, whens: ["before", "after"], run: async (h) => {
    h.t.task({ id: A, text: "Export the final cut", position: 1 }); h.t.task({ id: B, text: "export the final cut!", position: 2 })
    refused(await h.agent.decide(`merge:${A}:${B}`, "accept", {}))
  } },
  { name: "merge accept, kept task edited", target: A, whens: ["before", "after"], run: async (h) => {
    h.t.task({ id: A, text: "Export the final cut", position: 1 }); h.t.task({ id: B, text: "export the final cut!", position: 2 })
    refused(await h.agent.decide(`merge:${A}:${B}`, "accept", {}))
  } },
  { name: "split accept", target: A, whens: ["before", "after"], run: async (h) => {
    h.t.task({ id: A, text: VAGUE, position: 4 })
    const pv = rowVersion({ text: VAGUE, description: "", note_id: NOTE, parent_id: "", due_date: "", done: 0, assignee: HUMAN })
    refused(await h.agent.decide(`split:${A}`, "accept", { subtasks: ["Draft the site map", "Pick the photos"], parentVersion: pv }))
    expect(h.t.db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(A)).toEqual({ n: 0 })
  } },
  { name: "undo of a due change", target: A, whens: ["after"], run: async (h) => {
    h.t.task({ id: A, due_date: "2026-10-20" })
    const act = h.t.activity({ agent: "pm", action: "due_changed", target: A, meta: { from: "2026-10-08", to: "2026-10-20" } })
    refused(await h.agent.undo(act) as { ok: boolean; status?: number })
  } },
  { name: "undo of a created subtask", target: K, whens: ["before", "after"], run: async (h) => {
    h.t.task({ id: A, text: VAGUE })
    h.t.task({ id: K, parent_id: A, text: "Draft the site map" })
    const raw = { text: "Draft the site map", description: "", note_id: NOTE, parent_id: A, due_date: "", done: 0, assignee: HUMAN }
    const act = h.t.activity({ agent: "tasks-agent", action: "subtask_created", target: K, meta: { from: null, to: "Draft the site map", created: true, parent: A, by: "jeremie", rowRaw: raw } })
    refused(await h.agent.undo(act) as { ok: boolean; status?: number })
    expect(h.t.get(K)).not.toBeNull()
  } },
]

describe("every guarded write refuses an edit to ANY tracked field", () => {
  for (const path of PATHS) {
    for (const when of path.whens) {
      for (const field of FIELD_NAMES) {
        test(`${path.name}: ${field} edited ${when === "before" ? "before the write reads the row" : "between the read and the commit"}`, async () => {
          const h = harness(path.target, when, field)
          await path.run(h)
          expect(h.edited()).toBe(true)
          expect(h.agentRows().filter((a) => a.action !== "subtask_created")).toEqual([])
        })
      }
    }
  }

  test("sanity: with no edit, each path does write (the guard is not just refusing everything)", async () => {
    const h = harness(A, "before", null)
    slip(h, A)
    expect((await h.agent.decide(`slip:${A}`, "accept", {})).ok).toBe(true)
    const g = harness(A, "before", null)
    g.t.task({ id: A, assignee: null, text: "Wireframe the booking page" })
    expect((await g.agent.decide(`assign:${A}`, "accept", {})).ok).toBe(true)
  })

  for (const field of FIELD_NAMES) {
    for (const when of ["before", "after"] as const) {
      test(`chat confirm: ${field} edited ${when === "before" ? "between the plan and the confirm" : "between the read and the commit"} → that task is skipped`, async () => {
        const T = "g000000002"
        const h = harness(T, "after", null)
        const turns: string[] = []
        let editNow = false
        const fieldEdit = () => { const [col, val] = FIELDS[field]!; h.t.db.query(`UPDATE tasks SET ${col} = ? WHERE id = ?`).run(val, T) }
        let fired = false
        const exec: ExecFn = async (sql, args) => {
          const r = await h.t.exec(sql, args)
          if (when === "after" && editNow && !fired && sql.startsWith("SELECT id, note_id") && args[0] === T) { fired = true; fieldEdit() }
          return r
        }
        const ids = ["g000000000", "g000000001", T, "g000000003", "g000000004"]
        h.t.note("projects/granby", "Granby 321")
        for (const id of ids) h.t.task({ id, note_id: "projects/granby", text: `Granby ${id}`, due_date: "2026-10-07" })
        const chat = createTasksChat({
          query: h.t.query, exec, tx: txOver(exec), now: () => NOW,
          plan: async () => `{"op":"move","taskIds":${JSON.stringify(ids)},"due":"2026-10-09"}`,
          emitTurn: (x) => turns.push(x), notify: () => {},
        })
        await chat.handle("move everything Granby to Friday", "general")
        if (when === "before") fieldEdit()
        else editNow = true
        await chat.confirmReply("confirm", "general")
        // The edited task was not moved by the agent (its date is whatever the edit left), the other four were.
        expect(h.t.get(T)!.due_date).not.toBe("2026-10-09")
        expect(ids.filter((id) => id !== T).every((id) => h.t.get(id)!.due_date === "2026-10-09")).toBe(true)
        expect(h.agentRows().some((a) => a.target_id === T)).toBe(false)
      })
    }
  }
})

describe("row version and SQL guard (one raw-value source)", () => {
  const guardCount = (t: ReturnType<typeof testDb>, id: string, raw: RowRaw): number => {
    const g = rowGuard(raw)
    return (t.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE id = ? AND ${g.sql}`).get(id, ...g.args) as { n: number }).n
  }
  const base: RowRaw = { text: "t", description: "", note_id: "n", parent_id: "", due_date: "", done: 0, assignee: "x" }

  test("separator characters inside values cannot collide (the old concatenated key did)", async () => {
    const t = testDb()
    t.task({ id: A, text: "A\u001fB", description: "C" })
    const one = await readTask(t.exec, A)
    expect(rowVersion({ ...base, text: "A\u001fB", description: "C" })).not.toBe(rowVersion({ ...base, text: "A", description: "B\u001fC" }))
    // The row is edited to the colliding values: the guard built from the first read must not match.
    t.db.query("UPDATE tasks SET text = 'A', description = ? WHERE id = ?").run("B\u001fC", A)
    expect(guardCount(t, A, one!.raw)).toBe(0)
    expect((await readTask(t.exec, A))!.raw.description).toBe("B\u001fC")
  })

  test("whitespace-only text / parent / description are kept raw: an unchanged row is not a false 409", async () => {
    const t = testDb()
    t.task({ id: A, text: "   ", description: " ", parent_id: "  ", due_date: "2026-10-01" })
    const row = (await readTask(t.exec, A))!
    expect(row.raw).toMatchObject({ text: "   ", description: " ", parent_id: "  " })
    expect(guardCount(t, A, row.raw)).toBe(1)
    expect(await setTaskDue(t.tx, row, "2026-11-01")).toEqual({ ok: true })
    expect(t.get(A)!.due_date).toBe("2026-11-01")
  })

  test("NULL columns compare NULL-safe, and NULL differs from ''", async () => {
    const t = testDb()
    t.task({ id: A, assignee: null })
    t.db.query("UPDATE tasks SET description = NULL WHERE id = ?").run(A)
    const row = (await readTask(t.exec, A))!
    expect(row.raw).toMatchObject({ assignee: null, description: null })
    expect(guardCount(t, A, row.raw)).toBe(1)
    expect(rowVersion(row.raw)).not.toBe(rowVersion({ ...row.raw, description: "", assignee: "" }))
    expect(guardCount(t, A, { ...row.raw, description: "" })).toBe(0)
  })

  test("for every tracked column, the JS version and the SQL guard agree on rows read through the production mapper", async () => {
    for (const col of ROW_COLUMNS) {
      const t = testDb()
      t.task({ id: A, text: "héllo ", description: "d", note_id: "projects/p1", parent_id: "pp", due_date: "2026-10-01", assignee: HUMAN })
      const before = (await readTask(t.exec, A))!
      expect(guardCount(t, A, before.raw)).toBe(1)
      const [column, value] = FIELDS[col]!
      t.db.query(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(value, A)
      const after = (await readTask(t.exec, A))!
      expect(rowVersion(after.raw)).not.toBe(rowVersion(before.raw))
      expect(guardCount(t, A, before.raw)).toBe(0)
      expect(guardCount(t, A, after.raw)).toBe(1)
    }
  })
})
