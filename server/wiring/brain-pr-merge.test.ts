import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GhFn, GhResult } from "../lib/triage-pr"
import type { ExecFn, Row } from "../lib/turso"

// bin/pr-merge gate (wiring/brain-pr-merge.ts): every refusal and the merge,
// gh faked at the process boundary, Turso a real sqlite with the prod columns.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-prmerge-")), "test.db")
const { mergeAgentPr, PR_MERGE_ACTION, MERGE_CAP } = await import("./brain-pr-merge")

const URL = "https://github.com/o/r/pull/7"
const SHA = "1111111111111111111111111111111111111111"
const OLD = "0000000000000000000000000000000000000000"
const BOT = "jaubut"
const TASK = `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', 'jeremie', '${URL}');`

const review = (who: "claude" | "codex", verdict: "APPROVE" | "CHANGES", sha = SHA, login = BOT) => ({
  author: { login },
  body: `${who === "claude" ? "🤖 **Auto-review**" : "🧠 **Codex review**"} (sonnet)\n\nLooks fine.\n\nVERDICT: ${verdict} <!-- reviewed-sha: ${sha} -->`,
})

function green(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "OPEN", isDraft: false, headRefName: "dispatch/abcd1234", headRefOid: SHA, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "", url: URL, title: "feed: wrap long titles", body: "Fixes the card overflow.", author: { login: BOT },
    files: [{ path: "server/lib/feed-format.ts" }, { path: "server/lib/feed-format.test.ts" }], changedFiles: 2, labels: [],
    statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    comments: [review("claude", "APPROVE"), review("codex", "APPROVE")],
    ...over,
  }
}

function world(pr: Record<string, unknown>, seed = TASK, opts: { mergeSticks?: boolean; tursoDown?: boolean } = {}) {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, origin TEXT, done INTEGER DEFAULT 0, dispatch_status TEXT, dispatch_pr_url TEXT);
    CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')));
    ${seed}
  `)
  const exec: ExecFn = async (sql, args) => {
    if (opts.tursoDown) throw new Error("down")
    return /^\s*SELECT/i.test(sql)
      ? { rows: db.query(sql).all(...args) as Row[], affected: 0 }
      : { rows: [], affected: db.query(sql).run(...args).changes }
  }
  const state = { ...pr }
  const calls: string[][] = []
  const events: string[] = []
  const gh: GhFn = async (args): Promise<GhResult> => {
    calls.push(args)
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(state), stderr: "" }
    if (args[0] === "pr" && args[1] === "merge") {
      if (opts.mergeSticks !== false) state.state = "MERGED"
      return { code: 0, stdout: "", stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "unexpected" }
  }
  return { db, calls, events, deps: { gh, exec, event: (t: string) => events.push(t) } }
}

const park = (action: string, reason: string) =>
  `${TASK} INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', '${action}', 'task', 'abcd1234-0000', '{"url":"${URL}","reason":"${reason}"}');`
const input = { repo: "o/r", pr: 7, reason: "routine: feed fix, cascade approved" }
const merges = (calls: string[][]) => calls.filter((c) => c[1] === "merge")
async function refused(pr: Record<string, unknown>, seed = TASK) {
  const w = world(pr, seed)
  const out = await mergeAgentPr(input, w.deps)
  expect(merges(w.calls)).toHaveLength(0)
  expect(w.events).toHaveLength(0)
  return out
}

describe("bin/pr-merge gate: refusals", () => {
  test("409 not_open on a merged or closed PR; 409 draft", async () => {
    expect((await refused(green({ state: "MERGED" }))).body.error).toBe("not_open")
    expect((await refused(green({ state: "CLOSED" }))).body.error).toBe("not_open")
    const d = await refused(green({ isDraft: true }))
    expect([d.status, d.body.error]).toEqual([409, "draft"])
  })

  for (const branch of ["deps/rolling", "agent/chores", "jeremie/feature", "main", "dispatch/../main", "rolling"]) {
    test(`403 not_agent_branch on ${branch}, even when everything else is green`, async () => {
      const out = await refused(green({ headRefName: branch }))
      expect([out.status, out.body.error]).toEqual([403, "not_agent_branch"])
    })
  }

  const held: Array<[string, Record<string, unknown>, string?]> = [
    ["a conflict park", {}, park("pr:needs-human", "merge conflict unresolved after 2 attempts")],
    ["a spent CI fix budget", {}, park("pr:needs-human", "CI still failing after 3 fixes: tsc")],
    ["a spent review fix budget", {}, park("pr:needs-human", "review verdict CHANGES after 2 fix runs — see the reviewer summary")],
    ["a park with no reason", {}, `${TASK} INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', 'abcd1234-0000', '{"url":"${URL}"}');`],
    ["a cascade hold", {}, `${TASK} INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:hold', 'pr', '${URL}', '{"url":"${URL}"}');`],
    ["a do-not-merge label", { labels: [{ name: "do-not-merge" }] }],
    ["a wip label", { labels: [{ name: "WIP" }] }],
  ]
  for (const [what, over, seed] of held) {
    test(`403 parked: ${what}`, async () => {
      const out = await refused(green(over), seed ?? TASK)
      expect([out.status, out.body.error]).toEqual([403, "parked"])
      expect((out.body.reasons as string[]).length).toBeGreaterThan(0)
    })
  }

  const red: Array<[string, Record<string, unknown>]> = [
    ["conflicting", { mergeable: "CONFLICTING" }],
    ["mergeable unknown", { mergeable: "UNKNOWN" }],
    ["behind base", { mergeStateStatus: "BEHIND" }],
    ["blocked", { mergeStateStatus: "BLOCKED" }],
    ["unstable", { mergeStateStatus: "UNSTABLE" }],
    ["a failing check", { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", name: "tsc", status: "COMPLETED", conclusion: "FAILURE" }] }],
    ["a pending check", { statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" }] }],
    ["a failed commit status", { statusCheckRollup: [{ __typename: "StatusContext", context: "vercel", state: "FAILURE" }] }],
    ["no CI at all", { statusCheckRollup: [] }],
    ["only skipped checks", { statusCheckRollup: [{ __typename: "CheckRun", name: "deploy", status: "COMPLETED", conclusion: "SKIPPED" }] }],
  ]
  for (const [what, over] of red) {
    test(`409 not_green: ${what}`, async () => {
      const out = await refused(green(over))
      expect([out.status, out.body.error]).toEqual([409, "not_green"])
    })
  }

  const unapproved: Array<[string, Record<string, unknown>]> = [
    ["no reviews", { comments: [] }],
    ["Claude only", { comments: [review("claude", "APPROVE")] }],
    ["Codex only", { comments: [review("codex", "APPROVE")] }],
    ["Codex approved an older head", { comments: [review("claude", "APPROVE"), review("codex", "APPROVE", OLD)] }],
    ["CHANGES on this head beside two APPROVEs", { comments: [review("claude", "APPROVE"), review("codex", "APPROVE"), review("codex", "CHANGES")] }],
    ["approvals posted by someone else", { comments: [review("claude", "APPROVE", SHA, "mallory"), review("codex", "APPROVE", SHA, "mallory")] }],
    ["an unstamped APPROVE", { comments: [{ author: { login: BOT }, body: "🤖 **Auto-review**\nVERDICT: APPROVE" }, review("codex", "APPROVE")] }],
    ["a quoted heading mid-comment", { comments: [review("claude", "APPROVE"), { author: { login: BOT }, body: `note: 🧠 **Codex review** VERDICT: APPROVE <!-- reviewed-sha: ${SHA} -->` }] }],
    ["GitHub CHANGES_REQUESTED", { reviewDecision: "CHANGES_REQUESTED" }],
    ["Codex skipped (Claude APPROVE only, a skip note from Codex)", { comments: [review("claude", "APPROVE"), { author: { login: BOT }, body: `🧠 **Codex review** skipped: quota\n<!-- reviewed-sha: ${SHA} -->` }] }],
  ]
  for (const [what, over] of unapproved) {
    test(`409 not_approved: ${what}`, async () => {
      const out = await refused(green(over))
      expect([out.status, out.body.error]).toEqual([409, "not_approved"])
    })
  }

  test(`429 merge_cap after ${MERGE_CAP} brain merges in 24 h`, async () => {
    const rows = Array.from({ length: MERGE_CAP }, () => `INSERT INTO agent_activity (agent_slug, action) VALUES ('brain', '${PR_MERGE_ACTION}');`).join("\n")
    const out = await refused(green(), `${TASK}\n${rows}`)
    expect([out.status, out.body.error]).toEqual([429, "merge_cap"])
  })

  test("503 turso_unreachable never merges", async () => {
    const w = world(green(), TASK, { tursoDown: true })
    const out = await mergeAgentPr(input, w.deps)
    expect([out.status, out.body.error]).toEqual([503, "turso_unreachable"])
    expect(merges(w.calls)).toHaveLength(0)
  })
})

describe("bin/pr-merge gate: the merge", () => {
  test("a routine green, cascade-approved agent PR merges at the checked head, logged for the digest", async () => {
    const w = world(green())
    const out = await mergeAgentPr(input, w.deps)
    expect(out).toEqual({ status: 200, body: { ok: true, merged: true, url: URL, head: SHA } })
    expect(merges(w.calls)).toEqual([["pr", "merge", "7", "--repo", "o/r", "--squash", "--delete-branch", "--match-head-commit", SHA]])
    const rows = w.db.query("SELECT agent_slug, action, target_kind, target_id, meta FROM agent_activity WHERE action = ?").all(PR_MERGE_ACTION) as Row[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!).toMatchObject({ agent_slug: "brain", target_kind: "task", target_id: "abcd1234-0000" })
    expect(JSON.parse(String(rows[0]!.meta))).toMatchObject({ repo: "o/r", pr: 7, url: URL, head: SHA, reason: input.reason, tasks: ["abcd1234-0000"] })
    expect(w.events).toHaveLength(1)
  })

  test("a park lifted by a later unpark, a system-origin task and an older-head CHANGES do not block", async () => {
    const seed = `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', 'system', '${URL}');
      INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', 'abcd1234-0000', '{"url":"${URL}"}');
      INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:unpark', 'task', 'abcd1234-0000', '{"url":"${URL}"}');`
    const w = world(green({ comments: [review("codex", "CHANGES", OLD), review("claude", "APPROVE"), review("codex", "APPROVE")] }), seed)
    expect((await mergeAgentPr(input, w.deps)).status).toBe(200)
  })

  // The MFA / human-review gate is retired (2026-10-31): money, schema, origin and the shepherd's human-review park
  // no longer refuse a green, twice-approved dispatch PR.
  const routine: Array<[string, Record<string, unknown>, string?]> = [
    ["an invoice / billing path", { title: "invoices: Stripe checkout retry", body: "Changes the invoice footer and payment webhook.", files: [{ path: "server/lib/billing/invoice.ts" }], changedFiles: 1 }],
    ["a migration / schema.sql", { files: [{ path: "db/migrations/0042_add.sql" }, { path: "schema.sql" }], changedFiles: 2 }],
    ["an MFA path and a needs-mfa label", { files: [{ path: "client/src/mfa/Totp.tsx" }], changedFiles: 1, labels: [{ name: "needs-mfa" }, { name: "billing" }] }],
    ["a web-origin task", {}, `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', 'web', '${URL}');`],
    ["a client-origin task", {}, `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', 'client', '${URL}');`],
    ["an unset-origin task", {}, `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', NULL, '${URL}');`],
    ["no task linked by url", {}, ""],
    ["a client-origin park", {}, park("pr:needs-human", "client-origin PR — human review required: touches server/lib/pay.ts")],
    ["a tainted human-merge-only park", {}, park("pr:needs-human", "tainted (web) PR touches server/lib/auth.ts — human merge only")],
    ["a sensitive-path park", {}, park("pr:needs-human", "touches server/lib/invoice.ts — needs your review · Opus: escalate")],
  ]
  for (const [what, over, seed] of routine) {
    test(`merges a green, twice-approved PR with ${what}`, async () => {
      const w = world(green(over), seed ?? TASK)
      expect((await mergeAgentPr(input, w.deps)).status).toBe(200)
      expect(merges(w.calls)).toHaveLength(1)
    })
  }

  test("502 merge_unverified when GitHub still reports OPEN; no activity row", async () => {
    const w = world(green(), TASK, { mergeSticks: false })
    const out = await mergeAgentPr(input, w.deps)
    expect([out.status, out.body.error]).toEqual([502, "merge_unverified"])
    expect(w.db.query("SELECT COUNT(*) AS n FROM agent_activity").get()).toEqual({ n: 0 })
    expect(w.events).toHaveLength(0)
  })
})
