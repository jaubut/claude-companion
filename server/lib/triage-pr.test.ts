import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { type GhFn, GhUnreachable, closePr, mergePr } from "./triage-pr"
import type { ExecFn, Row, SqlArg } from "./turso"

// Triage merge / close: by full URL, state read back (MERGED / CLOSED) before
// anything is recorded; the ledger rows match dispatch-reconcile's.

const URL = "https://github.com/jaubut/tls-review/pull/4"
const turso = new Database(":memory:")
turso.exec(`
  CREATE TABLE tasks (id TEXT PRIMARY KEY, assignee TEXT, done INTEGER DEFAULT 0, dispatch_status TEXT, updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT, action TEXT, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')));
`)
const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (/^\s*SELECT/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  return { rows: [], affected: turso.query(sql).run(...args).changes }
}

let state: string
let calls: string[][]
let mergeEffect: string
let ghDown: boolean
const gh: GhFn = async (args) => {
  if (ghDown) throw new GhUnreachable("ENOENT")
  calls.push(args)
  if (args[1] === "view") return { code: 0, stdout: JSON.stringify({ state }), stderr: "" }
  if (args[1] === "merge") { state = mergeEffect; return { code: 0, stdout: "", stderr: "" } }
  if (args[1] === "close") { state = "CLOSED"; return { code: 0, stdout: "", stderr: "" } }
  return { code: 1, stdout: "", stderr: "unknown" }
}
const deps = { gh, exec, host: "mac" }
const target = { taskId: "t1", prUrl: URL, number: 4 }
const task = () => turso.query("SELECT * FROM tasks WHERE id = 't1'").get() as Record<string, unknown>
const ledger = () => turso.query("SELECT agent_slug, action, target_id, summary FROM agent_activity").all()

beforeEach(() => {
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity")
  turso.query("INSERT INTO tasks (id, assignee, done, dispatch_status) VALUES ('t1', 'agent:builder', 0, 'completed')").run()
  state = "OPEN"
  calls = []
  mergeEffect = "MERGED"
  ghDown = false
})

describe("merge", () => {
  test("squash-merges by full URL, verifies MERGED, then marks the task done and ledgers outcome:merged", async () => {
    const out = await mergePr(deps, target)
    expect(out).toEqual({ kind: "done", detail: { state: "MERGED" } })
    expect(calls).toEqual([["pr", "view", URL, "--json", "state"], ["pr", "merge", URL, "--squash"], ["pr", "view", URL, "--json", "state"]])
    expect(task().done).toBe(1)
    expect(ledger()).toEqual([{ agent_slug: "builder", action: "outcome:merged", target_id: "t1", summary: "PR #4 merged" }])
  })

  test("not MERGED afterwards (e.g. auto-merge queued) → 502 merge_unverified, nothing recorded", async () => {
    mergeEffect = "OPEN"
    const out = await mergePr(deps, target)
    expect(out).toMatchObject({ kind: "error", status: 502, error: "merge_unverified", extra: { state: "OPEN" } })
    expect(task().done).toBe(0)
    expect(ledger()).toEqual([])
  })

  test("already merged or closed → stale, gh merge never runs", async () => {
    state = "MERGED"
    expect(await mergePr(deps, target)).toMatchObject({ kind: "stale" })
    expect(calls.map((c) => c[1])).toEqual(["view"])
  })

  test("gh missing → 503 gh_unreachable", async () => {
    ghDown = true
    expect(await mergePr(deps, target)).toMatchObject({ kind: "error", status: 503, error: "gh_unreachable" })
  })
})

describe("close", () => {
  test("closes, verifies CLOSED, ledgers outcome:rejected with dispatch-reconcile's wording; the task row is untouched", async () => {
    const out = await closePr(deps, target)
    expect(out).toEqual({ kind: "done", detail: { state: "CLOSED" } })
    expect(task().done).toBe(0)
    expect(ledger()).toEqual([{ agent_slug: "builder", action: "outcome:rejected", target_id: "t1", summary: "PR #4 closed unmerged" }])
  })
})
