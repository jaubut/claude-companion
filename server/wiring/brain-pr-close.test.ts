import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GhFn, GhResult } from "../lib/triage-pr"
import type { ExecFn, Row } from "../lib/turso"

// bin/pr-close gate (wiring/brain-pr-close.ts): every refusal and the close,
// gh faked at the process boundary, Turso a real sqlite with the prod columns.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-prclose-")), "test.db")
const { closeDeadPr, PR_CLOSE_ACTION } = await import("./brain-pr-close")

const URL = "https://github.com/o/r/pull/7"

function world(pr: Record<string, unknown>, seed = "") {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, done INTEGER DEFAULT 0, dispatch_status TEXT, dispatch_pr_url TEXT);
    CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')));
    ${seed}
  `)
  const exec: ExecFn = async (sql, args) => /^\s*SELECT/i.test(sql)
    ? { rows: db.query(sql).all(...args) as Row[], affected: 0 }
    : { rows: [], affected: db.query(sql).run(...args).changes }
  const state = { ...pr }
  const calls: string[][] = []
  const events: string[] = []
  const gh: GhFn = async (args): Promise<GhResult> => {
    calls.push(args)
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ url: URL, ...state }), stderr: "" }
    if (args[0] === "pr" && args[1] === "close") { state.state = "CLOSED"; return { code: 0, stdout: "", stderr: "" } }
    return { code: 1, stdout: "", stderr: "unexpected" }
  }
  return { db, calls, events, deps: { gh, exec, event: (t: string) => events.push(t) } }
}

const input = { repo: "o/r", pr: 7, reason: "dead: conflicts with main" }
const open = (over: Record<string, unknown> = {}) => ({ state: "OPEN", headRefName: "dispatch/abcd1234", mergeable: "MERGEABLE", ...over })
const closes = (calls: string[][]) => calls.filter((c) => c[1] === "close")
const parkMeta = (reason: string) => JSON.stringify({ reason, url: URL, repo: "r", pr: 7 }).replace(/'/g, "''")

describe("bin/pr-close gate", () => {
  test("409 not_open on a closed or merged PR", async () => {
    const w = world(open({ state: "MERGED" }))
    const out = await closeDeadPr(input, w.deps)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe("not_open")
    expect(closes(w.calls)).toHaveLength(0)
  })

  for (const branch of ["deps/rolling", "agent/chores", "agent/chores-2", "jeremie/feature", "rolling"]) {
    test(`403 not_agent_branch on ${branch}, even when conflicting`, async () => {
      const w = world(open({ headRefName: branch, mergeable: "CONFLICTING" }))
      const out = await closeDeadPr(input, w.deps)
      expect(out.status).toBe(403)
      expect(out.body.error).toBe("not_agent_branch")
      expect(closes(w.calls)).toHaveLength(0)
    })
  }

  test("409 not_dead on a healthy agent PR (task running, no park)", async () => {
    const w = world(open(), `INSERT INTO tasks VALUES ('abcd1234-0000', 0, 'pr', '${URL}');`)
    const out = await closeDeadPr(input, w.deps)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe("not_dead")
    expect(closes(w.calls)).toHaveLength(0)
    expect(w.events).toHaveLength(0)
  })

  test("409 not_dead: a park whose budget is not spent does not count", async () => {
    const w = world(open(), `INSERT INTO tasks VALUES ('abcd1234-0000', 0, 'pr', '${URL}');
      INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', 'abcd1234-0000', '${parkMeta("touches auth.ts — needs your review")}');`)
    expect((await closeDeadPr(input, w.deps)).body.error).toBe("not_dead")
  })

  test("409 not_dead: a budget-spent park lifted by a later unpark does not count", async () => {
    const w = world(open(), `INSERT INTO tasks VALUES ('abcd1234-0000', 0, 'pr', '${URL}');
      INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', 'abcd1234-0000', '${parkMeta("CI still failing after 3 fixes: tsc")}');
      INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('jeremie', 'pr:unpark', 'task', 'abcd1234-0000', '{"by":"manual"}');`)
    expect((await closeDeadPr(input, w.deps)).body.error).toBe("not_dead")
  })

  const deadCases: Array<[string, Record<string, unknown>, string, string]> = [
    ["conflicting", open({ mergeable: "CONFLICTING" }), "", "conflicting"],
    ["superseded", open(), `INSERT INTO tasks VALUES ('abcd1234-0000', 0, 'pr', 'https://github.com/o/r/pull/9');`, "superseded by https://github.com/o/r/pull/9"],
    ["task done", open(), `INSERT INTO tasks VALUES ('abcd1234-0000', 1, 'completed', '${URL}');`, "task done"],
    ["task cancelled", open(), `INSERT INTO tasks VALUES ('abcd1234-0000', 0, 'cancelled', '${URL}');`, "task cancelled"],
    ["parked, budget spent", open(), `INSERT INTO tasks VALUES ('abcd1234-0000', 0, 'pr', '${URL}');
      INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', 'abcd1234-0000', '${parkMeta("merge conflict unresolved after 2 attempts")}');`, "parked: merge conflict unresolved after 2 attempts"],
  ]
  for (const [name, pr, seed, evidence] of deadCases) {
    test(`closes when ${name}: comment, no branch delete, activity row, brain event`, async () => {
      const w = world(pr, seed)
      const out = await closeDeadPr(input, w.deps)
      expect(out.status).toBe(200)
      expect(out.body.evidence).toContain(evidence)
      const [close] = closes(w.calls)
      expect(close).toEqual(["pr", "close", "7", "--repo", "o/r", "--comment", "Closed by the brain: dead: conflicts with main"])
      expect(close).not.toContain("--delete-branch")
      const rows = w.db.query("SELECT agent_slug, action, meta FROM agent_activity WHERE action = ?").all(PR_CLOSE_ACTION) as Row[]
      expect(rows).toHaveLength(1)
      expect(rows[0]!.agent_slug).toBe("brain")
      expect(JSON.parse(String(rows[0]!.meta)).url).toBe(URL)
      expect(w.events).toHaveLength(1)
      expect(w.events[0]).toContain("o/r#7")
    })
  }

  test("the reason is length-capped in the comment", async () => {
    const w = world(open({ mergeable: "CONFLICTING" }))
    await closeDeadPr({ ...input, reason: "x".repeat(1000) }, w.deps)
    const body = closes(w.calls)[0]!.at(-1)!
    expect(body.length).toBeLessThanOrEqual("Closed by the brain: ".length + 300)
  })

  test("502 close_unverified when GitHub still reads it open", async () => {
    const w = world(open({ mergeable: "CONFLICTING" }))
    const gh: GhFn = async (args) => args[1] === "close" ? { code: 1, stdout: "", stderr: "nope" } : w.deps.gh(args)
    const out = await closeDeadPr(input, { ...w.deps, gh })
    expect(out.status).toBe(502)
    expect(out.body.error).toBe("close_unverified")
    expect(w.events).toHaveLength(0)
  })

  test("503 gh_unreachable when gh cannot start", async () => {
    const w = world(open())
    const out = await closeDeadPr(input, { ...w.deps, gh: async () => { throw new Error("spawn failed") } })
    expect(out.status).toBe(503)
  })
})
