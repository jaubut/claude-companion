import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { type WriteCtx, routeTask } from "./dispatch-tasks"
import type { ExecFn, Row, SqlArg } from "./turso"

// routeTask (Opus `route` action) against real SQLite: the guard is the SQL, so
// the compare-and-set and the marker prefix are exercised as on libSQL.

let db: Database
const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (/^\s*SELECT/i.test(sql)) return { rows: db.query(sql).all(...args) as Row[], affected: 0 }
  return { rows: [], affected: db.query(sql).run(...args).changes }
}
const ctx = (): WriteCtx => ({ exec, cols: { prUrl: true, resultRef: true }, host: "test", channel: "general" })
const row = (id: string) => db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any>
const NO_REPO = "No local repo mapped for this task. — how-to: RES-W2FH"

function seed(id: string, over: Record<string, SqlArg> = {}) {
  const r: Record<string, SqlArg> = { id, note_id: "projects/x", text: "WP1 tasks endpoint", assignee: "agent:builder", dispatch_status: "blocked", dispatch_blocker: NO_REPO, done: 0, ...over }
  const cols = Object.keys(r)
  db.query(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c]!))
}

beforeEach(() => {
  db = new Database(":memory:")
  db.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, ref_code TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, note_id TEXT, text TEXT, description TEXT DEFAULT '', done INTEGER DEFAULT 0, assignee TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      dispatch_status TEXT, dispatch_run_id TEXT, dispatch_started_at TEXT, dispatch_completed_at TEXT, dispatch_blocker TEXT,
      dispatch_owner TEXT, dispatch_result_ref TEXT, dispatch_pr_url TEXT);
    CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT, action TEXT, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')));
  `)
})

describe("routeTask", () => {
  test("no-repo blocked → queued, marker prefixed, run fields cleared, one ledger row", async () => {
    seed("t1", { dispatch_result_ref: "RES-W2FH" })
    const out = await routeTask(ctx(), "t1", "claude-companion")
    expect(out.ok).toBe(true)
    const r = row("t1")
    expect(r.text).toBe("[repo:claude-companion] WP1 tasks endpoint")
    expect(r.dispatch_status).toBe("queued")
    expect(r.dispatch_blocker).toBeNull()
    expect(r.dispatch_result_ref).toBeNull()
    const act = db.query("SELECT action, meta FROM agent_activity").all() as Record<string, string>[]
    expect(act.map((a) => a.action)).toEqual(["dispatch:queued"])
    expect(JSON.parse(act[0]!.meta ?? "{}")).toMatchObject({ op: "route", repo: "claude-companion" })
  })

  test("a different blocker is never routed", async () => {
    seed("t2", { dispatch_blocker: "Round per line or on the total?" })
    expect(await routeTask(ctx(), "t2", "claude-companion")).toMatchObject({ ok: false, error: "conflict" })
    expect(row("t2").text).toBe("WP1 tasks endpoint")
  })

  test("an already-marked task is never re-routed (no loop)", async () => {
    seed("t3", { text: "[repo:tls-dashboard-v2] old" })
    expect(await routeTask(ctx(), "t3", "claude-companion")).toMatchObject({ ok: false, error: "conflict" })
    expect(row("t3").text).toBe("[repo:tls-dashboard-v2] old")
  })

  test("running belongs to its runner; missing → no_such_task", async () => {
    seed("t4", { dispatch_status: "running" })
    expect(await routeTask(ctx(), "t4", "claude-companion")).toMatchObject({ ok: false, error: "running" })
    expect(await routeTask(ctx(), "nope", "claude-companion")).toEqual({ ok: false, error: "no_such_task" })
  })
})
