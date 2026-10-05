import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { type GhFn, GhUnreachable, approvalRow, closePr, holdReason, mergePr, rollupState } from "./triage-pr"
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
/** What `gh pr view --json mergeable,…` answers (merge intent); {} = GitHub reports nothing. */
let readiness: Record<string, unknown>
let readinessAfter: Record<string, unknown> | null
const READY = "mergeable,mergeStateStatus,headRefOid,statusCheckRollup"
const gh: GhFn = async (args) => {
  if (ghDown) throw new GhUnreachable("ENOENT")
  calls.push(args)
  if (args[1] === "view" && args[4] === READY) {
    const merged = calls.some((c) => c[1] === "merge")
    return { code: 0, stdout: JSON.stringify(merged && readinessAfter ? readinessAfter : readiness), stderr: "" }
  }
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
  readiness = {}
  readinessAfter = null
})

describe("merge", () => {
  test("squash-merges by full URL, verifies MERGED, then marks the task done and ledgers outcome:merged", async () => {
    const out = await mergePr(deps, target)
    expect(out).toEqual({ kind: "done", detail: { state: "MERGED" } })
    expect(calls).toEqual([["pr", "view", URL, "--json", "state"], ["pr", "view", URL, "--json", READY], ["pr", "merge", URL, "--squash"], ["pr", "view", URL, "--json", "state"]])
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

// Merge intent (2026-10-05): a Merge tap is Jeremie's approval to land THIS PR.
describe("merge intent", () => {
  const green = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "abc123", statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] }
  const approvals = () => turso.query("SELECT agent_slug, action, target_kind, target_id, meta FROM agent_activity WHERE action = 'pr:approved-merge'").all() as Record<string, string>[]

  test("mergeable + checks green → merged now, no approval row", async () => {
    readiness = green
    expect(await mergePr(deps, target)).toEqual({ kind: "done", detail: { state: "MERGED" } })
    expect(approvals()).toEqual([])
  })

  test("CONFLICTING (the #164 incident) → no gh merge, approval recorded, queued approved_pending/conflict", async () => {
    readiness = { ...green, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }
    const out = await mergePr(deps, target)
    expect(out).toEqual({ kind: "queued", detail: { state: "approved_pending", reason: "conflict", approvedHeadSha: "abc123" } })
    expect(calls.map((c) => c[1])).toEqual(["view", "view"])
    expect(task().done).toBe(0)
    const rows = approvals()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_slug: "builder", action: "pr:approved-merge", target_kind: "task", target_id: "t1" })
    const meta = JSON.parse(String(rows[0]?.meta))
    expect(meta).toMatchObject({ repo: "tls-review", pr: 4, url: URL, approvedHeadSha: "abc123", by: "jeremie", via: "triage", reason: "conflict" })
    expect(Number.isFinite(Date.parse(meta.approvedAt))).toBe(true)
  })

  test("behind / checks pending / checks failing → queued with that reason", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...green, mergeStateStatus: "BEHIND" }, "behind"],
      [{ ...green, statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: "" }] }, "ci_pending"],
      [{ ...green, statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] }, "ci_failing"],
      [{ ...green, statusCheckRollup: [{ __typename: "StatusContext", context: "vercel", state: "PENDING" }] }, "ci_pending"],
    ]
    for (const [r, reason] of cases) {
      readiness = r
      expect(await mergePr(deps, target)).toMatchObject({ kind: "queued", detail: { state: "approved_pending", reason } })
    }
    expect(approvals()).toHaveLength(4)
  })

  test("GitHub refuses the merge and only then reports a conflict → the tap still counts: queued, not 502", async () => {
    readiness = green
    readinessAfter = { ...green, mergeable: "CONFLICTING" }
    mergeEffect = "OPEN"
    expect(await mergePr(deps, target)).toMatchObject({ kind: "queued", detail: { reason: "conflict" } })
    expect(approvals()).toHaveLength(1)
  })

  test("a closed PR is stale (no approval recorded)", async () => {
    state = "CLOSED"
    readiness = { ...green, mergeable: "CONFLICTING" }
    expect(await mergePr(deps, target)).toMatchObject({ kind: "stale" })
    expect(approvals()).toEqual([])
  })

  test("holdReason / rollupState", () => {
    const r = (o: Partial<{ mergeable: string; mergeState: string; checks: "pass" | "fail" | "pending" | "none" }>) => ({ mergeable: "MERGEABLE", mergeState: "CLEAN", headSha: "x", checks: "pass" as const, ...o })
    expect(holdReason(r({}))).toBeNull()
    expect(holdReason(r({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" }))).toBeNull()
    expect(holdReason(r({ mergeable: "CONFLICTING", checks: "fail" }))).toBe("conflict")
    expect(holdReason(r({ checks: "fail", mergeState: "BEHIND" }))).toBe("ci_failing")
    expect(holdReason(r({ mergeState: "BEHIND" }))).toBe("behind")
    expect(rollupState([])).toBe("none")
    expect(rollupState([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }, { __typename: "StatusContext", state: "SUCCESS" }])).toBe("pass")
  })

  test("approvalRow: an orphan PR (no task) is keyed by its URL", () => {
    const row = approvalRow({ taskId: null, url: URL, repo: "tls-review", number: 4, headSha: "h", reason: null, agent: "pr-shepherd", via: "cli", host: "mac", at: new Date("2026-10-05T06:00:00Z") })
    expect(row).toMatchObject({ targetKind: "pr", targetId: URL })
    expect(JSON.parse(row.meta)).toMatchObject({ approvedAt: "2026-10-05T06:00:00.000Z", via: "cli", by: "jeremie" })
  })
})
