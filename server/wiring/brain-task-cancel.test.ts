import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, Row } from "../lib/turso"

// bin/task-cancel gate (wiring/brain-task-cancel.ts): every refusal and the
// cancel, Turso a real sqlite with the prod columns; worker liveness and gh faked.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-taskcancel-")), "test.db")
const { cancelAgentTask, TASK_CANCEL_ACTION } = await import("./brain-task-cancel")

const ID = "abcd1234aaaa0000bbbb1111cccc2222"
const PR = "https://github.com/o/r/pull/7"

interface Seed { id?: string; assignee?: string; done?: number; status?: string | null; pr?: string | null; owner?: string | null }

function world(seeds: Seed[], opts: { gone?: boolean; prState?: string } = {}) {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, note_id TEXT NOT NULL DEFAULT 'projects/p', text TEXT NOT NULL DEFAULT 'a task', assignee TEXT, done INTEGER DEFAULT 0,
      dispatch_status TEXT, dispatch_owner TEXT, dispatch_blocker TEXT, dispatch_pr_url TEXT, dispatch_completed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')));
  `)
  for (const s of seeds) {
    db.query("INSERT INTO tasks (id, assignee, done, dispatch_status, dispatch_pr_url, dispatch_owner) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.id ?? ID, s.assignee ?? "agent:builder", s.done ?? 0, s.status === undefined ? "queued" : s.status, s.pr ?? null, s.owner ?? null)
  }
  const exec: ExecFn = async (sql, args) => /^\s*SELECT/i.test(sql)
    ? { rows: db.query(sql).all(...args) as Row[], affected: 0 }
    : { rows: [], affected: db.query(sql).run(...args).changes }
  const events: string[] = []
  const gh: string[] = []
  const deps = {
    exec,
    workerGone: async () => opts.gone ?? false,
    prState: async (url: string) => { gh.push(url); return opts.prState ?? "OPEN" },
    event: (t: string) => events.push(t),
  }
  const row = (id = ID) => db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row
  const activity = () => db.query("SELECT * FROM agent_activity WHERE action = ?").all(TASK_CANCEL_ACTION) as Row[]
  return { db, deps, events, gh, row, activity }
}

const input = { task: ID, reason: "superseded by task 9f00aa11" }

function expectUntouched(w: ReturnType<typeof world>, before: Row): void {
  expect(w.row(String(before.id))).toEqual(before)
  expect(w.activity()).toHaveLength(0)
  expect(w.events).toHaveLength(0)
}

describe("bin/task-cancel gate", () => {
  test("404 not_found: no such task", async () => {
    const w = world([])
    const out = await cancelAgentTask(input, w.deps)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe("not_found")
  })

  test("404 not_found: an ambiguous 8-char prefix", async () => {
    const w = world([{ id: ID }, { id: "abcd1234ffff0000" }])
    const before = w.row()
    const out = await cancelAgentTask({ ...input, task: "abcd1234" }, w.deps)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe("not_found")
    expectUntouched(w, before)
  })

  test("403 not_agent_task: Jeremie's own to-do is never cancelled", async () => {
    for (const assignee of ["human:jeremie", ""]) {
      const w = world([{ assignee, status: null }])
      const before = w.row()
      const out = await cancelAgentTask(input, w.deps)
      expect(out.status).toBe(403)
      expect(out.body.error).toBe("not_agent_task")
      expectUntouched(w, before)
    }
  })

  test("409 running: a live worker", async () => {
    const w = world([{ status: "running", owner: "zettlab" }], { gone: false })
    const before = w.row()
    const out = await cancelAgentTask(input, w.deps)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe("running")
    expectUntouched(w, before)
  })

  for (const [name, seed] of [["done", { done: 1, status: "completed" }], ["merged", { done: 1, status: "completed", pr: PR }], ["cancelled", { done: 1, status: "cancelled" }], ["cancelled, done 0", { status: "cancelled" }]] as const) {
    test(`409 already_final: ${name}`, async () => {
      const w = world([seed])
      const before = w.row()
      const out = await cancelAgentTask(input, w.deps)
      expect(out.status).toBe(409)
      expect(out.body.error).toBe("already_final")
      expectUntouched(w, before)
    })
  }

  for (const status of ["pending", "queued", "blocked", "failed"]) {
    test(`cancels a ${status} task by 8-char prefix: status, done, reason, activity row, brain event`, async () => {
      const w = world([{ status }])
      const out = await cancelAgentTask({ ...input, task: ID.slice(0, 8) }, w.deps)
      expect(out.status).toBe(200)
      expect(out.body).toEqual({ ok: true, cancelled: ID, from: status })
      const r = w.row()
      expect(r.dispatch_status).toBe("cancelled")
      expect(r.done).toBe(1)
      expect(r.dispatch_blocker).toBe("Cancelled by the brain: superseded by task 9f00aa11")
      const [a] = w.activity()
      expect(a!.agent_slug).toBe("brain")
      expect(a!.target_id).toBe(ID)
      expect(JSON.parse(String(a!.meta))).toMatchObject({ from: status, reason: input.reason })
      expect(w.events).toHaveLength(1)
      expect(w.events[0]).toContain("abcd1234")
      expect(w.gh).toHaveLength(0)
    })
  }

  test("a running task whose worker is gone is cancelled", async () => {
    const w = world([{ status: "running", owner: "zettlab" }], { gone: true })
    const out = await cancelAgentTask(input, w.deps)
    expect(out.status).toBe(200)
    expect(w.row().dispatch_status).toBe("cancelled")
  })

  test("an open PR is left open and named in the reply", async () => {
    const w = world([{ status: "completed", pr: PR }], { prState: "OPEN" })
    const out = await cancelAgentTask(input, w.deps)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, pr: PR, prState: "OPEN" })
    expect(String(out.body.note)).toContain("bin/pr-close")
    expect(w.row().done).toBe(1)
  })

  test("a closed PR is not named", async () => {
    const w = world([{ status: "completed", pr: PR }], { prState: "CLOSED" })
    const out = await cancelAgentTask(input, w.deps)
    expect(out.status).toBe(200)
    expect(out.body.pr).toBeUndefined()
  })

  test("the reason is bound, never spliced into SQL", async () => {
    const w = world([{}])
    const reason = "x'); DROP TABLE tasks; --"
    expect((await cancelAgentTask({ ...input, reason }, w.deps)).status).toBe(200)
    expect(w.row().dispatch_blocker).toBe(`Cancelled by the brain: ${reason}`)
  })

  test("409 changed when a runner moved the row first (compare-and-set)", async () => {
    const w = world([{}])
    const exec: ExecFn = async (sql, args) => {
      if (/^\s*UPDATE/i.test(sql)) w.db.exec(`UPDATE tasks SET dispatch_status = 'running' WHERE id = '${ID}'`)
      return w.deps.exec(sql, args)
    }
    const out = await cancelAgentTask(input, { ...w.deps, exec })
    expect(out.status).toBe(409)
    expect(out.body.error).toBe("changed")
    expect(w.row().dispatch_status).toBe("running")
    expect(w.events).toHaveLength(0)
  })

  test("503 turso_unreachable when Turso is down", async () => {
    const w = world([{}])
    const out = await cancelAgentTask(input, { ...w.deps, exec: async () => { throw new Error("down") } })
    expect(out.status).toBe(503)
  })
})
