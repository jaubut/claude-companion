import { test, expect, describe } from "bun:test"
import { type QueryFn, type Row, type SqlArg, TursoUnreachable } from "../lib/turso"
import { CACHE_TTL_MS, type GoalsResponse, PROJECT_CAP, createGoalsHandler, extractStatusParagraph, isoDate } from "./goals"

// Handler tests with an injected query function — no network, no token. The
// 401 lives in the server's /api/* gate and is verified by curl.

interface FakeTask { id: number; note_id: string; text: string; position: number; done: number; due_date?: string | null; assignee?: string | null; dispatch_status?: string | null }

function fakeDb(notes: Row[], tasks: FakeTask[]) {
  const calls: { sql: string; args: SqlArg[] }[] = []
  const query: QueryFn = async (sql, args) => {
    calls.push({ sql, args })
    if (sql.includes("FROM notes")) {
      const limit = Number(args[args.length - 1])
      return notes.slice(0, limit)
    }
    const perNote = Number(args[args.length - 1])
    const ids = new Set(args.slice(0, -1).map(String))
    const open = tasks.filter((t) => t.done === 0 && ids.has(t.note_id))
    const rows: Row[] = []
    for (const id of ids) {
      const mine = open.filter((t) => t.note_id === id).sort((a, b) => a.position - b.position)
      for (const t of mine.slice(0, perNote)) {
        rows.push({ id: t.id, note_id: t.note_id, text: t.text, due_date: t.due_date ?? null, assignee: t.assignee ?? null, dispatch_status: t.dispatch_status ?? null, open_count: mine.length })
      }
    }
    return rows
  }
  return { query, calls }
}

const note = (i: number, body = `Paragraph ${i}.`): Row => ({
  id: `projects/2026-09-0${i % 9}-p${i}`, ref_code: `PRJ-${i}`, title: `Project ${i}`, status: "active", body, updated_at: `2026-09-${String(10 + (i % 18)).padStart(2, "0")} 10:00:00`,
})

async function get(handler: ReturnType<typeof createGoalsHandler>, qs = "", method = "GET"): Promise<Response | null> {
  const req = new Request(`http://localhost/api/goals${qs}`, { method })
  return handler(req, new URL(req.url))
}

describe("GET /api/goals", () => {
  test("shape: projects with next ≤3 open tasks by position and openCount", async () => {
    const n = note(1, "# Title\n\n## Status\n\nShipping phase 2.")
    const tasks: FakeTask[] = [
      { id: 1, note_id: String(n.id), text: "fourth", position: 4, done: 0 },
      { id: 2, note_id: String(n.id), text: "first", position: 1, done: 0, due_date: "2026-09-30", assignee: "agent:builder", dispatch_status: "queued" },
      { id: 3, note_id: String(n.id), text: "done", position: 0, done: 1 },
      { id: 4, note_id: String(n.id), text: "second", position: 2, done: 0 },
      { id: 5, note_id: String(n.id), text: "third", position: 3, done: 0 },
    ]
    const { query } = fakeDb([n, note(2)], tasks)
    const res = await get(createGoalsHandler({ query, now: () => 0 }))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as GoalsResponse
    expect(body.generatedAt).toBe(new Date(0).toISOString())
    expect(body.projects).toHaveLength(2)
    const p = body.projects[0]
    expect(p).toEqual({
      id: String(n.id), refCode: "PRJ-1", title: "Project 1", status: "active", statusParagraph: "Shipping phase 2.",
      updatedAt: isoDate(String(n.updated_at)), openCount: 4,
      nextTasks: [
        { id: "2", text: "first", dueDate: "2026-09-30", assignee: "agent:builder", dispatchStatus: "queued" },
        { id: "4", text: "second", dueDate: null, assignee: null, dispatchStatus: null },
        { id: "5", text: "third", dueDate: null, assignee: null, dispatchStatus: null },
      ],
    })
    expect(body.projects[1]!.nextTasks).toEqual([])
    expect(body.projects[1]!.openCount).toBe(0)
  })

  test("queries are parameterized and capped at 25 projects", async () => {
    const notes = Array.from({ length: 40 }, (_, i) => note(i))
    const { query, calls } = fakeDb(notes, [])
    const body = (await (await get(createGoalsHandler({ query })))!.json()) as GoalsResponse
    expect(body.projects).toHaveLength(PROJECT_CAP)
    expect(calls[0]!.args).toEqual(["projects", "active", "pending", PROJECT_CAP])
    expect(calls[0]!.sql).not.toContain("projects'")
    expect(calls[1]!.args).toHaveLength(PROJECT_CAP + 1)
  })

  test("a query fn that ignores LIMIT still yields ≤25", async () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(i))
    const query: QueryFn = async (sql) => (sql.includes("FROM notes") ? notes : [])
    const body = (await (await get(createGoalsHandler({ query })))!.json()) as GoalsResponse
    expect(body.projects).toHaveLength(PROJECT_CAP)
  })

  test("cache: second call within TTL skips Turso; after TTL or ?fresh=1 it refetches", async () => {
    let t = 1_000
    const { query, calls } = fakeDb([note(1)], [])
    const h = createGoalsHandler({ query, now: () => t })
    await get(h)
    expect(calls).toHaveLength(2)
    t += CACHE_TTL_MS - 1
    await get(h)
    expect(calls).toHaveLength(2)
    await get(h, "?fresh=1")
    expect(calls).toHaveLength(4)
    t += CACHE_TTL_MS
    await get(h)
    expect(calls).toHaveLength(6)
  })

  test("Turso failure → 503 turso_unreachable, no SQL, no stack; failure is not cached", async () => {
    let fail = true
    const ok = fakeDb([note(1)], [])
    const query: QueryFn = async (sql, args) => {
      if (fail) throw new TursoUnreachable("network")
      return ok.query(sql, args)
    }
    const h = createGoalsHandler({ query })
    const res = await get(h)
    expect(res?.status).toBe(503)
    const text = await res!.text()
    expect(JSON.parse(text)).toEqual({ error: "turso_unreachable" })
    expect(text).not.toMatch(/SELECT|at |stack/i)
    fail = false
    expect((await get(h))?.status).toBe(200)
  })

  test("unexpected error also maps to 503", async () => {
    const query: QueryFn = async () => { throw new Error("SELECT * FROM notes blew up") }
    const res = await get(createGoalsHandler({ query }))
    expect(res?.status).toBe(503)
    expect(await res!.json()).toEqual({ error: "turso_unreachable" })
  })

  test("other paths and methods → null", async () => {
    const h = createGoalsHandler({ query: async () => [] })
    expect(await get(h, "", "POST")).toBeNull()
    const req = new Request("http://localhost/api/goalsx")
    expect(await h(req, new URL(req.url))).toBeNull()
  })
})

describe("extractStatusParagraph", () => {
  test("fixture 1: paragraph under a 'Where we are' heading wins over earlier paragraphs", () => {
    const body = "---\nid: x\n---\n# Project\n\nIntro paragraph.\n\n## Goals\n\n- a\n\n## Where we are\n\nPhase 19 in progress,\nstep 6 next.\n\n## Log\n\nold"
    expect(extractStatusParagraph(body)).toBe("Phase 19 in progress, step 6 next.")
  })

  test("fixture 2: no status heading → first non-heading paragraph (skips frontmatter and code)", () => {
    const body = "---\ntitle: y\n---\n\n# Big Title\n\n```\ncode block\n```\n\nFirst real paragraph\nspanning two lines.\n\nSecond."
    expect(extractStatusParagraph(body)).toBe("First real paragraph spanning two lines.")
  })

  test("fixture 3: 'Living Status' heading, long paragraph clamped to 400 chars; empty status section falls back", () => {
    const long = "word ".repeat(200).trim()
    const out = extractStatusParagraph(`# P\n\nIntro.\n\n### Living Status — Sept\n\n${long}`)
    expect(out.length).toBeLessThanOrEqual(400)
    expect(out.endsWith("…")).toBe(true)
    expect(out.startsWith("word word")).toBe(true)
    expect(extractStatusParagraph("# P\n\nIntro.\n\n## Status\n\n## Next\n\nlater")).toBe("Intro.")
    expect(extractStatusParagraph(null)).toBe("")
    expect(extractStatusParagraph("# Only a heading")).toBe("")
  })
})


describe("review fixes on PR #44", () => {
  test("wire shape: empty due_date → null; updated_at normalised to ISO for both stored formats", async () => {
    const notes: Row[] = [
      { ...note(1), updated_at: "2026-09-14 01:52:57" },
      { ...note(2), updated_at: "2026-09-11T00:09:59.238273Z" },
    ]
    const { query } = fakeDb(notes, [{ id: 1, note_id: String(notes[0]!.id), text: "t", position: 1, done: 0, due_date: "" }])
    const body = (await (await get(createGoalsHandler({ query })))!.json()) as GoalsResponse
    expect(body.projects[0]!.nextTasks[0]!.dueDate).toBeNull()
    expect(body.projects[0]!.updatedAt).toBe("2026-09-14T01:52:57.000Z")
    expect(body.projects[1]!.updatedAt).toBe("2026-09-11T00:09:59.238Z")
    expect(isoDate(null)).toBeNull(); expect(isoDate("")).toBeNull(); expect(isoDate("garbage")).toBe("garbage")
  })

  test("cache: an older in-flight fetch never overwrites a newer ?fresh=1 result", async () => {
    let call = 0
    const gates: Array<() => void> = []
    const query: QueryFn = async (sql) => {
      if (sql.includes("FROM notes")) {
        const mine = ++call
        await new Promise<void>((r) => gates.push(r))          // resolve in test-controlled order
        return [{ ...note(1), title: mine === 1 ? "old" : "new" }]
      }
      return []
    }
    const h = createGoalsHandler({ query, now: () => 0 })
    const first = get(h)                 // starts fetch #1 ("old")
    await Promise.resolve()
    const second = get(h, "?fresh=1")    // starts fetch #2 ("new")
    await Promise.resolve()
    gates[1]!(); const r2 = (await (await second)!.json()) as GoalsResponse
    gates[0]!(); const r1 = (await (await first)!.json()) as GoalsResponse
    expect(r2.projects[0]!.title).toBe("new"); expect(r1.projects[0]!.title).toBe("old")
    // the cache must hold the NEWER result even though the older fetch finished last
    const cachedNow = (await (await get(h))!.json()) as GoalsResponse
    expect(cachedNow.projects[0]!.title).toBe("new")
  })
})
