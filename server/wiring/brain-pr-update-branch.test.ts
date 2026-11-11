import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GhFn, GhResult } from "../lib/triage-pr"
import type { ExecFn, Row } from "../lib/turso"

// bin/pr-update-branch gate (wiring/brain-pr-update-branch.ts): every refusal and
// the update, gh faked at the process boundary, Turso a real sqlite with the prod columns.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-prupdate-")), "test.db")
const { updateAgentPr, PR_UPDATE_ACTION } = await import("./brain-pr-update-branch")

const URL = "https://github.com/o/r/pull/7"
const OLD = "a".repeat(40)
const NEW = "b".repeat(40)
const OK: GhResult = { code: 0, stdout: "", stderr: "" }

/** `update` is the fake `gh pr update-branch`; it may move `state.headRefOid`. */
function world(pr: Record<string, unknown>, update?: (state: Record<string, unknown>) => GhResult) {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')))")
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, origin TEXT, dispatch_pr_url TEXT)")
  const exec: ExecFn = async (sql, args) => /^\s*SELECT/i.test(sql)
    ? { rows: db.query(sql).all(...args) as Row[], affected: 0 }
    : { rows: [], affected: db.query(sql).run(...args).changes }
  const state: Record<string, unknown> = { url: URL, title: "Stale PR", ...pr }
  const calls: string[][] = []
  const events: string[] = []
  const gh: GhFn = async (args) => {
    calls.push(args)
    if (args[1] === "view") return { code: 0, stdout: JSON.stringify(state), stderr: "" }
    if (args[1] === "update-branch") return (update ?? ((s) => { s.headRefOid = NEW; return OK }))(state)
    return { code: 1, stdout: "", stderr: "unexpected" }
  }
  return { db, calls, events, state, deps: { gh, exec, event: (t: string) => { events.push(t) }, sleep: async () => undefined } }
}

const input = { repo: "o/r", pr: 7, reason: "stale CI, main moved" }
const open = (over: Record<string, unknown> = {}) => ({ state: "OPEN", headRefName: "dispatch/abcd1234", headRefOid: OLD, mergeable: "MERGEABLE", labels: [], ...over })
const updates = (calls: string[][]) => calls.filter((c) => c[1] === "update-branch")
const activity = (db: Database) => db.query("SELECT agent_slug, action, target_id, meta FROM agent_activity WHERE action = ?").all(PR_UPDATE_ACTION) as Row[]

describe("bin/pr-update-branch gate", () => {
  test("merges the base in, reads the new head back, records it and tells the brain thread", async () => {
    const w = world(open())
    const out = await updateAgentPr(input, w.deps)
    expect(out).toEqual({ status: 200, body: { ok: true, updated: true, url: URL, head: NEW } })
    expect(updates(w.calls)).toEqual([["pr", "update-branch", "7", "--repo", "o/r"]])
    const rows = activity(w.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agent_slug).toBe("brain")
    expect(rows[0]!.target_id).toBe(URL)
    expect(JSON.parse(String(rows[0]!.meta))).toMatchObject({ repo: "o/r", pr: 7, from: OLD, head: NEW })
    expect(w.events).toHaveLength(1)
    expect(w.events[0]).toContain("o/r#7")
    expect(w.events[0]).toContain(NEW.slice(0, 7))
  })

  test("never rebases or forces", async () => {
    const w = world(open())
    await updateAgentPr(input, w.deps)
    const flat = w.calls.flat()
    expect(flat).not.toContain("--rebase")
    expect(flat).not.toContain("--force")
  })

  test("the new head may land after gh returns", async () => {
    const w = world(open(), () => OK)
    let slept = 0
    const out = await updateAgentPr(input, { ...w.deps, sleep: async () => { if (++slept === 2) w.state.headRefOid = NEW } })
    expect(out.status).toBe(200)
    expect(out.body.head).toBe(NEW)
  })

  test("a failed activity row does not fail the update", async () => {
    const w = world(open())
    const exec: ExecFn = async (sql, args) => {
      if (/^INSERT/i.test(sql)) throw new Error("turso down")
      return w.deps.exec(sql, args)
    }
    const out = await updateAgentPr(input, { ...w.deps, exec })
    expect(out.status).toBe(200)
    expect(w.events).toHaveLength(1)
  })

  for (const state of ["MERGED", "CLOSED"]) {
    test(`409 not_open on a ${state} PR`, async () => {
      const w = world(open({ state }))
      const out = await updateAgentPr(input, w.deps)
      expect(out.status).toBe(409)
      expect(out.body.error).toBe("not_open")
      expect(updates(w.calls)).toHaveLength(0)
    })
  }

  for (const branch of ["deps/rolling", "agent/chores", "jeremie/feature", "rolling", "dispatch/", "xdispatch/abcd1234"]) {
    test(`403 not_agent_branch on ${branch}`, async () => {
      const w = world(open({ headRefName: branch }))
      const out = await updateAgentPr(input, w.deps)
      expect(out.status).toBe(403)
      expect(out.body.error).toBe("not_agent_branch")
      expect(updates(w.calls)).toHaveLength(0)
    })
  }

  test("403 client_origin for a client task even without a label or park", async () => {
    const url = "https://github.com/jaubut/chantalmasse-website/pull/39"
    const w = world(open({ url }))
    w.db.query("INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES (?, ?, ?)").run("abcd1234-0000", "client", url)
    const out = await updateAgentPr({ ...input, repo: "jaubut/chantalmasse-website", pr: 39 }, w.deps)
    expect(out).toEqual({ status: 403, body: { ok: false, error: "client_origin" } })
    expect(updates(w.calls)).toHaveLength(0)
    expect(w.events).toHaveLength(0)
    expect(activity(w.db)).toHaveLength(0)
  })

  test("403 client_origin for the advisory client-origin label without a linked task", async () => {
    const w = world(open({ labels: [{ name: "client-origin" }] }))
    const out = await updateAgentPr(input, w.deps)
    expect(out).toEqual({ status: 403, body: { ok: false, error: "client_origin" } })
    expect(w.calls[0]!.at(-1)!.split(",")).toContain("labels")
    expect(updates(w.calls)).toHaveLength(0)
    expect(w.events).toHaveLength(0)
    expect(activity(w.db)).toHaveLength(0)
  })

  for (const [action, reason, target] of [
    ["pr:needs-human", "conflict unresolved", URL],
    ["pr:hold", "waiting on infra", "abcd1234-0000"],
    ["pr:needs-human", "client-origin PR — tainted (web) PR: sensitive paths — human merge", "abcd1234-0000"],
  ] as const) {
    test(`403 parked for ${action}: ${reason}`, async () => {
      const w = world(open())
      w.db.query("INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES (?, ?, ?)").run("abcd1234-0000", "jeremie", URL)
      w.db.query("INSERT INTO agent_activity (agent_slug, action, target_id, meta) VALUES (?, ?, ?, ?)")
        .run("pr-shepherd", action, target, JSON.stringify({ url: URL, reason }))
      const out = await updateAgentPr(input, w.deps)
      expect(out).toMatchObject({ status: 403, body: { ok: false, error: "parked" } })
      expect(String(out.body.reasons)).toContain(reason)
      expect(updates(w.calls)).toHaveLength(0)
      expect(w.events).toHaveLength(0)
      expect(activity(w.db)).toHaveLength(0)
    })
  }

  test("503 turso_unreachable refuses before attempting the update", async () => {
    const w = world(open())
    const out = await updateAgentPr(input, { ...w.deps, exec: async () => { throw new Error("turso down") } })
    expect(out).toEqual({ status: 503, body: { ok: false, error: "turso_unreachable" } })
    expect(updates(w.calls)).toHaveLength(0)
    expect(w.events).toHaveLength(0)
    expect(activity(w.db)).toHaveLength(0)
  })

  test("409 conflict when GitHub already reads it CONFLICTING: no update attempted", async () => {
    const w = world(open({ mergeable: "CONFLICTING" }))
    const out = await updateAgentPr(input, w.deps)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe("conflict")
    expect(updates(w.calls)).toHaveLength(0)
  })

  for (const stderr of ["X Cannot update PR branch due to conflicts", "GraphQL: merge conflict between base and head (updatePullRequestBranch)"]) {
    test(`409 conflict when the update refuses: ${stderr}`, async () => {
      const w = world(open({ mergeable: "UNKNOWN" }), () => ({ code: 1, stdout: "", stderr }))
      const out = await updateAgentPr(input, w.deps)
      expect(out.status).toBe(409)
      expect(out.body.error).toBe("conflict")
      expect(w.events).toHaveLength(0)
      expect(activity(w.db)).toHaveLength(0)
    })
  }

  test("409 up_to_date when the base has nothing new: nothing recorded", async () => {
    const w = world(open(), () => ({ code: 0, stdout: "✓ PR branch already up-to-date\n", stderr: "" }))
    const out = await updateAgentPr(input, w.deps)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe("up_to_date")
    expect(out.body.head).toBe(OLD)
    expect(w.events).toHaveLength(0)
    expect(activity(w.db)).toHaveLength(0)
  })

  test("404 pr_not_found when gh cannot read it", async () => {
    const w = world(open())
    const out = await updateAgentPr(input, { ...w.deps, gh: async () => ({ code: 1, stdout: "", stderr: "no such PR" }) })
    expect(out.status).toBe(404)
    expect(out.body.error).toBe("pr_not_found")
  })

  test("502 gh_bad_json when the initial PR read is malformed: no update attempted", async () => {
    const w = world(open())
    const gh: GhFn = async (args) => {
      if (args[1] === "view") return { code: 0, stdout: "{", stderr: "" }
      return w.deps.gh(args)
    }
    const out = await updateAgentPr(input, { ...w.deps, gh })
    expect(out).toEqual({ status: 502, body: { ok: false, error: "gh_bad_json" } })
    expect(updates(w.calls)).toHaveLength(0)
    expect(w.events).toHaveLength(0)
    expect(activity(w.db)).toHaveLength(0)
  })

  test("502 update_unverified when the head never moves: nothing recorded", async () => {
    const w = world(open(), () => ({ code: 0, stdout: "merged", stderr: "" }))
    const out = await updateAgentPr(input, w.deps)
    expect(out.status).toBe(502)
    expect(out.body.error).toBe("update_unverified")
    expect(out.body.detail).toBe("merged")
    expect(w.events).toHaveLength(0)
    expect(activity(w.db)).toHaveLength(0)
  })

  for (const [what, moved] of [["the head stays", false], ["a concurrent push moves the head", true]] as const) {
    test(`502 update_failed when the update exits nonzero and ${what}: nothing recorded`, async () => {
      const w = world(open(), (s) => { if (moved) s.headRefOid = NEW; return { code: 1, stdout: "", stderr: "HTTP 403" } })
      const out = await updateAgentPr(input, w.deps)
      expect(out.status).toBe(502)
      expect(out.body).toMatchObject({ ok: false, error: "update_failed", head: OLD, detail: "HTTP 403" })
      expect(w.events).toHaveLength(0)
      expect(activity(w.db)).toHaveLength(0)
    })
  }

  test("503 gh_unreachable when gh cannot start", async () => {
    const w = world(open())
    const out = await updateAgentPr(input, { ...w.deps, gh: async () => { throw new Error("spawn failed") } })
    expect(out.status).toBe(503)
  })

  test("503 gh_unreachable when gh dies on the update itself", async () => {
    const w = world(open())
    const gh: GhFn = async (args) => { if (args[1] === "update-branch") throw new Error("spawn failed"); return w.deps.gh(args) }
    const out = await updateAgentPr(input, { ...w.deps, gh })
    expect(out.status).toBe(503)
    expect(w.events).toHaveLength(0)
  })

  test("the reason is redacted and length-capped", async () => {
    const w = world(open())
    const secret = `ghp_${"a".repeat(36)}`
    await updateAgentPr({ ...input, reason: `${secret} ${"x".repeat(1000)}` }, w.deps)
    const meta = JSON.parse(String(activity(w.db)[0]!.meta)) as { reason: string }
    expect(meta.reason).not.toContain(secret)
    expect(meta.reason.length).toBeLessThanOrEqual(300)
    expect(w.events[0]).not.toContain(secret)
  })
})
