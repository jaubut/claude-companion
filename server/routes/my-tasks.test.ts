import { describe, expect, test } from "bun:test"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import { TursoUnreachable } from "../lib/turso"
import { createMyTasks } from "./my-tasks"

// In-memory stand-in for Turso: answers the exact statements my-tasks issues.
interface T { id: string; note_id: string; parent_id: string; text: string; description: string; due_date: string; position: number; done: number; assignee: string | null }

function fakeDb(tasks: T[]) {
  const activity: SqlArg[][] = []
  let down = false
  const mineOf = (args: SqlArg[], from: number) => new Set(args.slice(from).map(String))
  const query: QueryFn = async (sql, args) => {
    if (down) throw new TursoUnreachable("down")
    if (!sql.includes("FROM tasks t LEFT JOIN notes")) throw new Error(`unexpected read: ${sql}`)
    const mine = new Set(args.slice(0, -1).map(String))
    return tasks.filter((t) => t.done === 0 && t.assignee && mine.has(t.assignee)).map((t): Row => ({
      ...t, note_title: `Title ${t.note_id}`, note_ref: null, note_folder: "projects",
    }))
  }
  const exec: ExecFn = async (sql, args) => {
    if (down) throw new TursoUnreachable("down")
    if (sql.startsWith("INSERT INTO agent_activity")) { activity.push(args); return { rows: [], affected: 1 } }
    if (sql.startsWith("SELECT done, due_date, text FROM tasks")) {
      const mine = mineOf(args, 1)
      const t = tasks.find((x) => x.id === args[0] && x.assignee && mine.has(x.assignee))
      return { rows: t ? [{ done: t.done, due_date: t.due_date, text: t.text }] : [], affected: 0 }
    }
    if (sql.startsWith("UPDATE tasks SET done")) {
      const [done, id, ...rest] = args
      const mine = new Set(rest.slice(0, -1).map(String))
      const t = tasks.find((x) => x.id === id && x.assignee && mine.has(x.assignee) && x.done !== done)
      if (t) t.done = Number(done)
      return { rows: [], affected: t ? 1 : 0 }
    }
    if (sql.startsWith("UPDATE tasks SET due_date")) {
      const [due, id, ...rest] = args
      const mine = new Set(rest.map(String))
      const t = tasks.find((x) => x.id === id && x.assignee && mine.has(x.assignee))
      if (t) t.due_date = String(due)
      return { rows: [], affected: t ? 1 : 0 }
    }
    throw new Error(`unexpected exec: ${sql}`)
  }
  return { query, exec, activity, tasks, setDown: (v: boolean) => { down = v } }
}

const task = (id: string, o: Partial<T> = {}): T => ({
  id, note_id: "projects/p1", parent_id: "", text: `task ${id}`, description: "", due_date: "", position: 0, done: 0, assignee: "human:jeremie", ...o,
})

const NOW = Date.parse("2026-10-06T15:00:00Z") // 11:00 in Toronto

function setup(tasks: T[], now = () => NOW) {
  const db = fakeDb(tasks)
  const frames: Record<string, unknown>[] = []
  const api = createMyTasks({ query: db.query, exec: db.exec, now, notify: (f) => frames.push(f) })
  const call = async (path: string, init?: RequestInit) => {
    const req = new Request(`http://localhost${path}`, init)
    return api.handle(req, new URL(req.url))
  }
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
  return { db, frames, api, call, post }
}

const ID = "0123456789abcdef0123456789abcdef"

describe("GET /api/tasks/mine", () => {
  test("cascade of my open tasks only (human:jeremie + bare human)", async () => {
    const { call } = setup([
      task(ID, { due_date: "2026-10-01" }),
      task("bbbbbbbbbb", { assignee: "human" }),
      task("cccccccccc", { assignee: "agent:builder" }),
      task("dddddddddd", { done: 1 }),
    ])
    const res = (await call("/api/tasks/mine"))!
    expect(res.status).toBe(200)
    const body = await res.json() as { total: number; today: string; sections: { key: string; count: number }[] }
    expect(body.today).toBe("2026-10-06")
    expect(body.total).toBe(2)
    expect(body.sections.find((s) => s.key === "overdue")!.count).toBe(1)
    expect(body.sections.find((s) => s.key === "none")!.count).toBe(1)
  })

  test("cached 30 s; ?fresh=1 bypasses", async () => {
    const { call, db } = setup([task(ID)])
    await call("/api/tasks/mine")
    db.tasks.push(task("eeeeeeeeee"))
    expect(((await (await call("/api/tasks/mine"))!.json()) as { total: number }).total).toBe(1)
    expect(((await (await call("/api/tasks/mine?fresh=1"))!.json()) as { total: number }).total).toBe(2)
  })

  test("cache never serves yesterday's buckets across Toronto midnight", async () => {
    let now = Date.parse("2026-10-07T03:59:00Z") // 23:59 on the 6th in Toronto
    const { call } = setup([task(ID, { due_date: "2026-10-07" })], () => now)
    const a = await (await call("/api/tasks/mine"))!.json() as { sections: { key: string; count: number }[] }
    expect(a.sections.find((s) => s.key === "week")!.count).toBe(1)
    now += 2 * 60_000 // 00:01 on the 7th, still inside the TTL
    const b = await (await call("/api/tasks/mine"))!.json() as { today: string; sections: { key: string; count: number }[] }
    expect(b.today).toBe("2026-10-07")
    expect(b.sections.find((s) => s.key === "today")!.count).toBe(1)
  })

  test("Turso down → 503 turso_unreachable", async () => {
    const { call, db } = setup([task(ID)])
    db.setDown(true)
    const res = (await call("/api/tasks/mine"))!
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "turso_unreachable" })
  })

  test("other paths fall through; wrong method 405", async () => {
    const { call } = setup([])
    expect(await call("/api/goals")).toBeNull()
    expect((await call("/api/tasks/mine", { method: "POST" }))!.status).toBe(405)
  })
})

describe("POST /api/tasks/:id/done", () => {
  test("marks done, logs one activity row, pushes tasks_changed", async () => {
    const { post, db, frames } = setup([task(ID)])
    const res = (await post(`/api/tasks/${ID}/done`, { done: true }))!
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, done: true, due: null })
    expect(db.tasks[0]!.done).toBe(1)
    expect(db.activity.length).toBe(1)
    expect(db.activity[0]![1]).toBe("status_changed")
    expect(frames).toEqual([{ type: "tasks_changed", taskId: ID, why: "done" }])
  })

  test("already done → ok, no second activity row", async () => {
    const { post, db } = setup([task(ID, { done: 1 })])
    expect(await (await post(`/api/tasks/${ID}/done`, { done: true }))!.json()).toEqual({ ok: true, done: true, due: null })
    expect(db.activity.length).toBe(0)
  })

  test("an agent's task is not mine → 404, untouched", async () => {
    const { post, db } = setup([task(ID, { assignee: "agent:builder" })])
    expect((await post(`/api/tasks/${ID}/done`, { done: true }))!.status).toBe(404)
    expect(db.tasks[0]!.done).toBe(0)
  })

  test("validation: bad id, bad json, non-boolean", async () => {
    const { post } = setup([task(ID)])
    expect((await post("/api/tasks/x';--/done", { done: true }))!.status).toBe(400)
    expect((await post(`/api/tasks/${ID}/done`, "{nope"))!.status).toBe(400)
    expect((await post(`/api/tasks/${ID}/done`, { done: "yes" }))!.status).toBe(400)
  })

  test("ids with : / # _ (mail-watcher, note-scoped, task_) are accepted", async () => {
    const ids = ["mail-watcher:30f3d0c4f68221bc", "projects/2026-06-23-mobile-mechanic#s10", "task_capl_0"]
    const { post, db } = setup(ids.map((id) => task(id)))
    for (const id of ids) {
      const res = (await post(`/api/tasks/${encodeURIComponent(id)}/done`, { done: true }))!
      expect(res.status).toBe(200)
    }
    expect(db.tasks.every((t) => t.done === 1)).toBe(true)
  })
})

describe("POST /api/tasks/:id/due", () => {
  test("sets a date, then drops it (stored as '')", async () => {
    const { post, db, frames } = setup([task(ID)])
    expect(await (await post(`/api/tasks/${ID}/due`, { due: "2026-10-09" }))!.json()).toEqual({ ok: true, done: false, due: "2026-10-09" })
    expect(db.tasks[0]!.due_date).toBe("2026-10-09")
    expect(await (await post(`/api/tasks/${ID}/due`, { due: null }))!.json()).toEqual({ ok: true, done: false, due: null })
    expect(db.tasks[0]!.due_date).toBe("")
    expect(db.activity.map((a) => a[1])).toEqual(["due_changed", "due_changed"])
    expect(frames.length).toBe(2)
  })

  test("same date again → no activity row", async () => {
    const { post, db } = setup([task(ID, { due_date: "2026-10-09" })])
    await post(`/api/tasks/${ID}/due`, { due: "2026-10-09" })
    expect(db.activity.length).toBe(0)
  })

  test("rejects non-dates and datetimes", async () => {
    const { post } = setup([task(ID)])
    for (const due of ["tomorrow", "2026-10-09T10:00:00Z", 20261009, "2026-02-31x"]) {
      expect((await post(`/api/tasks/${ID}/due`, { due }))!.status).toBe(400)
    }
  })
})

describe("watcher", () => {
  test("first tick seeds silently; an outside edit pushes tasks_changed once", async () => {
    const { api, db, frames } = setup([task(ID)])
    expect(await api.watchTick()).toBe(false)
    expect(await api.watchTick()).toBe(false)
    db.tasks[0]!.due_date = "2026-10-08"
    expect(await api.watchTick()).toBe(true)
    expect(frames).toEqual([{ type: "tasks_changed", why: "external" }])
    expect(await api.watchTick()).toBe(false)
  })

  test("a write through the API is not re-announced by the watcher", async () => {
    const { api, post, frames } = setup([task(ID)])
    await api.watchTick()
    await post(`/api/tasks/${ID}/done`, { done: true })
    expect(await api.watchTick()).toBe(false)
    expect(frames.length).toBe(1)
  })
})
