import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GhFn, GhResult } from "../lib/triage-pr"
import { type ExecFn, type Row, TursoUnreachable } from "../lib/turso"

// bin/pr-close gate (wiring/brain-pr-close.ts): every refusal and the close,
// gh faked at the process boundary, notes DB a real sqlite with the prod columns.

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

  test("humanApproved: closes human/non-dispatch and healthy MERGEABLE PRs, cancels matching open task best-effort, and verifies metadata", async () => {
    // 1. Non-dispatch human branch + MERGEABLE closes with 'Closed via Companion PR Gate card' and keeps branch
    const humanWorld = world(
      open({ headRefName: "jeremie/feature-x", mergeable: "MERGEABLE", title: "feat: human PR" }),
      `INSERT INTO tasks VALUES ('human-task-1', 0, 'pr', '${URL}');`,
    )
    const humanOut = await closeDeadPr(
      {
        repo: "o/r",
        pr: 7,
        reason: "Closed via A2UI PR Gate card",
        humanApproved: true,
        expectedTitle: "feat: human PR",
        expectedUrl: URL,
      },
      humanWorld.deps,
    )
    expect(humanOut).toEqual({
      status: 200,
      body: { ok: true, closed: true, url: URL, evidence: ["human-card"] },
    })
    const [humanClose] = closes(humanWorld.calls)
    expect(humanClose).toEqual(["pr", "close", "7", "--repo", "o/r", "--comment", "Closed via Companion PR Gate card"])
    expect(humanClose).not.toContain("--delete-branch")
    const taskRow = humanWorld.db.query("SELECT dispatch_status, done FROM tasks WHERE id = 'human-task-1'").get() as Row
    expect(taskRow.dispatch_status).toBe("cancelled")
    expect(taskRow.done).toBe(0)
    const actRows = humanWorld.db.query("SELECT agent_slug, action, target_kind, target_id, meta FROM agent_activity WHERE action = ?").all(PR_CLOSE_ACTION) as Row[]
    expect(actRows).toHaveLength(1)
    expect(actRows[0]!.target_kind).toBe("task")
    expect(actRows[0]!.target_id).toBe("human-task-1")
    expect(JSON.parse(String(actRows[0]!.meta)).evidence).toEqual(["human-card"])
    expect(humanWorld.events).toEqual(["Closed o/r#7 via PR Gate card"])

    // 2. Stale metadata (title or url mismatch) returns 409 pr_metadata_stale before gh pr close
    const staleWorld = world(open({ headRefName: "jeremie/feature-x", title: "live title on GitHub" }))
    const staleTitleOut = await closeDeadPr(
      {
        repo: "o/r",
        pr: 7,
        reason: "Closed via A2UI PR Gate card",
        humanApproved: true,
        expectedTitle: "old card title",
        expectedUrl: URL,
      },
      staleWorld.deps,
    )
    expect(staleTitleOut.status).toBe(409)
    expect(staleTitleOut.body.error).toBe("pr_metadata_stale")
    expect(closes(staleWorld.calls)).toHaveLength(0)

    const staleUrlOut = await closeDeadPr(
      {
        repo: "o/r",
        pr: 7,
        reason: "Closed via A2UI PR Gate card",
        humanApproved: true,
        expectedTitle: "live title on GitHub",
        expectedUrl: "https://github.com/o/r/pull/999",
      },
      staleWorld.deps,
    )
    expect(staleUrlOut.status).toBe(409)
    expect(staleUrlOut.body.error).toBe("pr_metadata_stale")
    expect(closes(staleWorld.calls)).toHaveLength(0)

    // 3. Turso hiccup is non-fatal when humanApproved === true
    const tursoDownWorld = world(open({ headRefName: "dispatch/abcd1234", mergeable: "MERGEABLE", title: "feat: resilient close" }))
    const tursoDownOut = await closeDeadPr(
      {
        repo: "o/r",
        pr: 7,
        reason: "Closed via A2UI PR Gate card",
        humanApproved: true,
        expectedTitle: "feat: resilient close",
        expectedUrl: URL,
      },
      {
        ...tursoDownWorld.deps,
        exec: async () => {
          throw new TursoUnreachable("sqld timeout")
        },
      },
    )
    expect(tursoDownOut.status).toBe(200)
    expect(tursoDownOut.body.closed).toBe(true)
    expect(closes(tursoDownWorld.calls)).toHaveLength(1)
    expect(tursoDownWorld.events).toEqual(["Closed o/r#7 via PR Gate card"])
  })

  const human = { repo: "o/r", pr: 7, reason: "Closed via A2UI PR Gate card", humanApproved: true }

  test("humanApproved: closing a superseded PR leaves the task (already on a newer PR) live", async () => {
    const w = world(open({ title: "t" }), `INSERT INTO tasks VALUES ('abcd1234-0000', 0, 'pr', 'https://github.com/o/r/pull/9');`)
    const out = await closeDeadPr({ ...human, expectedTitle: "t", expectedUrl: URL }, w.deps)
    expect(out.status).toBe(200)
    const t = w.db.query("SELECT dispatch_status FROM tasks WHERE id = 'abcd1234-0000'").get() as Row
    expect(t.dispatch_status).toBe("pr")
    const act = w.db.query("SELECT target_kind FROM agent_activity WHERE action = ?").get(PR_CLOSE_ACTION) as Row
    expect(act.target_kind).toBe("pr")
  })

  test("humanApproved: a short dispatch/<slug> branch never prefix-matches a short task id", async () => {
    const w = world(open({ headRefName: "dispatch/abc", title: "t" }), `INSERT INTO tasks (id, done, dispatch_status) VALUES ('abc', 0, 'running');`)
    expect((await closeDeadPr({ ...human, expectedTitle: "t", expectedUrl: URL }, w.deps)).status).toBe(200)
    expect((w.db.query("SELECT dispatch_status FROM tasks WHERE id = 'abc'").get() as Row).dispatch_status).toBe("running")
  })

  test("humanApproved: a null expected title/url (card lost them) fails closed as stale", async () => {
    const w = world(open({ title: "t" }))
    const out = await closeDeadPr({ ...human, expectedTitle: null, expectedUrl: null }, w.deps)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe("pr_metadata_stale")
    expect(closes(w.calls)).toHaveLength(0)
  })
})
