import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { conflictTaskId } from "../lib/conflict-resolver"
import type { GhFn } from "../lib/triage-pr"
import type { ExecFn, Row } from "../lib/turso"
import type { DispatchTaskInput } from "../lib/worker-supervisor"

// bin/pr-resolve-conflicts gate (wiring/brain-pr-resolve-conflicts.ts): every refusal and the dispatch, gh and the
// worker supervisor faked at the boundary, notes DB a real sqlite with the prod columns.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-prresolve-")), "test.db")
const { resolveAgentPrConflicts, PR_RESOLVE_ACTION } = await import("./brain-pr-resolve-conflicts")

const URL = "https://github.com/jaubut/r/pull/7"
const HEAD = "abcdef1234567890".repeat(2).slice(0, 40)
const TASK_ID = `conflict-r-pr7-${HEAD.slice(0, 8)}`

function world(pr: Record<string, unknown>, dispatch?: (i: DispatchTaskInput) => ReturnType<NonNullable<Parameters<typeof resolveAgentPrConflicts>[1]>["dispatch"]>) {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')))")
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, origin TEXT, dispatch_pr_url TEXT)")
  const exec: ExecFn = async (sql, args) => /^\s*SELECT/i.test(sql)
    ? { rows: db.query(sql).all(...args) as Row[], affected: 0 }
    : { rows: [], affected: db.query(sql).run(...args).changes }
  const state: Record<string, unknown> = { url: URL, title: "Add resolver", ...pr }
  const calls: string[][] = []
  const events: string[] = []
  const dispatched: DispatchTaskInput[] = []
  const sleeps: number[] = []
  const gh: GhFn = async (args) => {
    calls.push(args)
    return args[1] === "view" ? { code: 0, stdout: JSON.stringify(state), stderr: "" } : { code: 1, stdout: "", stderr: "unexpected" }
  }
  const run = dispatch ?? (async () => ({ ok: true as const }))
  return {
    db, calls, events, state, dispatched, sleeps,
    deps: {
      gh, exec, event: (t: string) => { events.push(t) }, sleep: async (ms: number) => { sleeps.push(ms) },
      dispatch: async (i: DispatchTaskInput) => { dispatched.push(i); return run(i) },
    },
  }
}

const input = { repo: "jaubut/r", pr: 7, reason: "main moved, CI cannot merge" }
const open = (over: Record<string, unknown> = {}) => ({ state: "OPEN", headRefName: "dispatch/abcd1234", baseRefName: "main", headRefOid: HEAD, mergeable: "CONFLICTING", labels: [], isCrossRepository: false, ...over })
const activity = (db: Database) => db.query("SELECT agent_slug, action, target_id, meta FROM agent_activity WHERE action = ?").all(PR_RESOLVE_ACTION) as Row[]
const untouched = (w: ReturnType<typeof world>) => {
  expect(w.dispatched).toHaveLength(0)
  expect(w.events).toHaveLength(0)
  expect(activity(w.db)).toHaveLength(0)
}

describe("bin/pr-resolve-conflicts gate", () => {
  test("dispatches a fresh sonnet worker on the PR head branch, records it and tells the brain thread", async () => {
    const w = world(open())
    const out = await resolveAgentPrConflicts(input, w.deps)
    expect(out).toEqual({ status: 200, body: { ok: true, dispatched: true, taskId: TASK_ID, url: URL, branch: "dispatch/abcd1234", head: HEAD } })
    expect(w.dispatched).toHaveLength(1)
    const d = w.dispatched[0]!
    expect(d).toMatchObject({ taskId: TASK_ID, repo: "r", family: "claude", model: "claude-sonnet-5-5", targetBranch: "dispatch/abcd1234", targetPrUrl: URL })
    expect(d.claim).toBeUndefined()
    expect(d.prompt).toContain("git merge --no-ff --no-commit origin/main")
    expect(d.prompt).toContain("git push origin HEAD:refs/heads/dispatch/abcd1234")
    expect(d.prompt).toContain(input.reason)
    const rows = activity(w.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agent_slug).toBe("brain")
    expect(rows[0]!.target_id).toBe(URL)
    expect(JSON.parse(String(rows[0]!.meta))).toMatchObject({ repo: "jaubut/r", pr: 7, branch: "dispatch/abcd1234", head: HEAD, taskId: TASK_ID })
    expect(w.events).toHaveLength(1)
    expect(w.events[0]).toContain("jaubut/r#7")
    expect(w.events[0]).toContain(TASK_ID)
  })

  test("403 not_own_repo before any gh call, 403 cross_repository for a fork, 403 unsafe_base for a shell-ish base", async () => {
    const other = world(open())
    expect(await resolveAgentPrConflicts({ ...input, repo: "other/r" }, other.deps)).toEqual({ status: 403, body: { ok: false, error: "not_own_repo" } })
    expect(other.calls).toHaveLength(0)
    untouched(other)
    for (const fork of [true, undefined]) {
      const w = world(open({ isCrossRepository: fork }))
      expect(await resolveAgentPrConflicts(input, w.deps)).toEqual({ status: 403, body: { ok: false, error: "cross_repository" } })
      untouched(w)
    }
    for (const base of ["main$(id)", "a|b", "main..x", "x y", ""]) {
      const w = world(open({ baseRefName: base }))
      expect(await resolveAgentPrConflicts(input, w.deps)).toMatchObject({ status: 403, body: { ok: false, error: "unsafe_base" } })
      untouched(w)
    }
  })

  test("409 head_moved when the head sha changes during the UNKNOWN retry", async () => {
    const w = world(open({ mergeable: "UNKNOWN" }))
    const out = await resolveAgentPrConflicts(input, { ...w.deps, sleep: async () => { w.state.headRefOid = "f".repeat(40); w.state.mergeable = "CONFLICTING" } })
    expect(out).toEqual({ status: 409, body: { ok: false, error: "head_moved", branch: "dispatch/abcd1234" } })
    untouched(w)
  })

  test("409 already_attempted when a resolver for this head already ran", async () => {
    const w = world(open(), async () => ({ ok: false, status: 409, error: "target_task_exists" }))
    expect(await resolveAgentPrConflicts(input, w.deps)).toEqual({ status: 409, body: { ok: false, error: "already_attempted", taskId: TASK_ID } })
    expect(w.events).toHaveLength(0)
  })

  test("task id is conflict-<repo>-pr<n>-<head8>, valid for the supervisor", () => {
    expect(conflictTaskId("jaubut/Claude.Companion", 363, "0123456789abcdef")).toBe("conflict-claude-companion-pr363-01234567")
  })

  test("409 not_open for a closed or merged PR", async () => {
    for (const state of ["CLOSED", "MERGED"]) {
      const w = world(open({ state }))
      expect(await resolveAgentPrConflicts(input, w.deps)).toEqual({ status: 409, body: { ok: false, error: "not_open", state } })
      untouched(w)
    }
  })

  for (const branch of ["main", "master", "feature/x", "dispatch/../x", ""]) {
    test(`403 not_agent_branch for head "${branch}"`, async () => {
      const w = world(open({ headRefName: branch }))
      expect(await resolveAgentPrConflicts(input, w.deps)).toEqual({ status: 403, body: { ok: false, error: "not_agent_branch", branch } })
      untouched(w)
    })
  }

  test("403 client_origin for a client task, and for the advisory label", async () => {
    const url = "https://github.com/jaubut/chantalmasse-website/pull/39"
    const task = world(open({ url }))
    task.db.query("INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES (?, ?, ?)").run("abcd1234-0000", "client", url)
    expect(await resolveAgentPrConflicts({ ...input, repo: "jaubut/chantalmasse-website", pr: 39 }, task.deps)).toEqual({ status: 403, body: { ok: false, error: "client_origin" } })
    untouched(task)
    const label = world(open({ labels: [{ name: "client-origin" }] }))
    expect(await resolveAgentPrConflicts(input, label.deps)).toEqual({ status: 403, body: { ok: false, error: "client_origin" } })
    untouched(label)
  })

  for (const [action, reason] of [["pr:needs-human", "human merge path"], ["pr:hold", "waiting on infra"]] as const) {
    test(`403 parked for ${action}`, async () => {
      const w = world(open())
      w.db.query("INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES (?, ?, ?)").run("abcd1234-0000", "jeremie", URL)
      w.db.query("INSERT INTO agent_activity (agent_slug, action, target_id, meta) VALUES (?, ?, ?, ?)")
        .run("pr-shepherd", action, URL, JSON.stringify({ url: URL, reason }))
      const out = await resolveAgentPrConflicts(input, w.deps)
      expect(out).toMatchObject({ status: 403, body: { ok: false, error: "parked" } })
      expect(String(out.body.reasons)).toContain(reason)
      expect(w.dispatched).toHaveLength(0)
      expect(w.events).toHaveLength(0)
    })
  }

  test("503 turso_unreachable refuses before dispatching", async () => {
    const w = world(open())
    expect(await resolveAgentPrConflicts(input, { ...w.deps, exec: async () => { throw new Error("turso down") } })).toEqual({ status: 503, body: { ok: false, error: "turso_unreachable" } })
    untouched(w)
  })

  test("409 not_conflicting for a MERGEABLE PR", async () => {
    const w = world(open({ mergeable: "MERGEABLE" }))
    expect(await resolveAgentPrConflicts(input, w.deps)).toEqual({ status: 409, body: { ok: false, error: "not_conflicting", mergeable: "MERGEABLE" } })
    untouched(w)
  })

  test("UNKNOWN is re-read once: still UNKNOWN -> 409 mergeable_unknown; resolved CONFLICTING -> dispatches", async () => {
    const stuck = world(open({ mergeable: "UNKNOWN" }))
    expect(await resolveAgentPrConflicts(input, stuck.deps)).toEqual({ status: 409, body: { ok: false, error: "mergeable_unknown" } })
    expect(stuck.calls.filter((c) => c[1] === "view")).toHaveLength(2)
    expect(stuck.sleeps).toHaveLength(1)
    untouched(stuck)

    const settles = world(open({ mergeable: "UNKNOWN" }))
    const out = await resolveAgentPrConflicts(input, { ...settles.deps, sleep: async () => { settles.state.mergeable = "CONFLICTING" } })
    expect(out.status).toBe(200)
    expect(settles.dispatched).toHaveLength(1)
  })

  test("409 already_resolving when the resolver for this head is running", async () => {
    const w = world(open(), async () => ({ ok: false, status: 409, error: "task_already_running" }))
    expect(await resolveAgentPrConflicts(input, w.deps)).toEqual({ status: 409, body: { ok: false, error: "already_resolving", taskId: TASK_ID } })
    expect(w.events).toHaveLength(0)
    expect(activity(w.db)).toHaveLength(0)
  })

  test("502 dispatch_failed when the supervisor refuses or throws: nothing recorded", async () => {
    for (const run of [async () => ({ ok: false as const, status: 500, error: "worktree add failed" }), async (): Promise<never> => { throw new Error("boom") }]) {
      const w = world(open(), run)
      const out = await resolveAgentPrConflicts(input, w.deps)
      expect(out.status).toBe(502)
      expect(out.body.error).toBe("dispatch_failed")
      expect(w.events).toHaveLength(0)
      expect(activity(w.db)).toHaveLength(0)
    }
  })

  test("a failed activity row does not fail the dispatch", async () => {
    const w = world(open())
    const exec: ExecFn = async (sql, args) => {
      if (/^INSERT/i.test(sql)) throw new Error("turso down")
      return w.deps.exec(sql, args)
    }
    expect((await resolveAgentPrConflicts(input, { ...w.deps, exec })).status).toBe(200)
    expect(w.events).toHaveLength(1)
  })

  test("404 pr_not_found and 502 gh_bad_json", async () => {
    const w = world(open())
    expect((await resolveAgentPrConflicts(input, { ...w.deps, gh: async () => ({ code: 1, stdout: "", stderr: "no such PR" }) })).body.error).toBe("pr_not_found")
    expect(await resolveAgentPrConflicts(input, { ...w.deps, gh: async () => ({ code: 0, stdout: "{", stderr: "" }) })).toEqual({ status: 502, body: { ok: false, error: "gh_bad_json" } })
    untouched(w)
  })
})
