import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MergeGateFn } from "../lib/merge-gate"
import { passGate } from "../lib/merge-gate.test-util"
import type { GhFn, GhResult } from "../lib/triage-pr"
import type { ExecFn, Row } from "../lib/turso"

// bin/pr-merge gate (wiring/brain-pr-merge.ts): every refusal and the merge,
// gh faked at the process boundary, Turso a real sqlite with the prod columns.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-prmerge-")), "test.db")
const { mergeAgentPr, hasRecentUserMergeApproval, hasRecentUserTaskCancelApproval, PR_MERGE_ACTION, MERGE_CAP } = await import("./brain-pr-merge")

// Default to unpaused reviews, independent of the host's flag.
const flagDir = mkdtempSync(join(tmpdir(), "cc-prmerge-unpaused-"))
afterAll(() => rmSync(flagDir, { recursive: true, force: true }))

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
    state: "OPEN", isDraft: false, headRefName: "dispatch/abcd1234", headRefOid: SHA, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
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
  // The gate has its own matrix (merge-gate-callers.test.ts): here it passes at the head GitHub reports.
  const gate: MergeGateFn = async () => ({ ok: true, head: String(state.headRefOid), base: String(state.baseRefName) })
  return { db, calls, events, deps: { gh, exec, event: (t: string) => events.push(t), gate, pausedFlag: join(flagDir, "claude-review-paused") } }
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

  const tier = (name: string) => ({ body: `Review tier: ${name} <!-- review-tier: ${name} -->`, author: { login: BOT } })
  const docsOnly = [{ path: "docs/brain-api.md" }, { path: "server/lib/a.test.ts" }, { path: "architecture.json" }]

  test("low tier: green CI merges with no review, on files the server sees are low", async () => {
    expect((await mergeAgentPr(input, world(green({ files: docsOnly, comments: [tier("low")] })).deps)).status).toBe(200)
  })

  test("low tier: a CHANGES on the head still refuses", async () => {
    const out = await refused(green({ files: docsOnly, comments: [tier("low"), review("claude", "CHANGES")] }))
    expect([out.status, out.body.error]).toEqual([409, "not_approved"])
  })

  for (const [what, files] of [["code", [{ path: "server/lib/a.ts" }]], ["agent instructions", [{ path: "brain/CLAUDE.md" }]], ["no file list", []]] as const) {
    test(`a low marker on ${what} needs both reviews: the comment alone proves nothing`, async () => {
      const out = await refused(green({ files, comments: [tier("low")] }))
      expect([out.status, out.body.error]).toEqual([409, "not_approved"])
    })
  }

  test("normal tier: one Claude APPROVE on the head merges", async () => {
    expect((await mergeAgentPr(input, world(green({ comments: [tier("normal"), review("claude", "APPROVE")] })).deps)).status).toBe(200)
  })

  test("normal tier: an APPROVE of an older head does not count", async () => {
    const out = await refused(green({ comments: [tier("normal"), review("codex", "APPROVE")] }))
    expect([out.status, out.body.error]).toEqual([409, "not_approved"])
  })

  for (const [what, marker] of [["high", [tier("high")]], ["no", []], ["a stale normal then high", [tier("normal"), tier("high")]], ["a stranger's normal", [{ ...tier("normal"), author: { login: "x" } }]]] as const) {
    test(`${what} marker needs Codex too`, async () => {
      const out = await refused(green({ comments: [...marker, review("claude", "APPROVE")] }))
      expect([out.status, out.body.error]).toEqual([409, "not_approved"])
    })
  }

  // Claude reviews paused: the flag file's existence (read on each call) lets a normal-tier, non-client PR merge on Codex alone.
  describe("claude-review-paused flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-prmerge-flag-"))
    const flag = join(dir, "claude-review-paused")
    const absent = join(dir, "never-created")
    writeFileSync(flag, "")
    const CLIENT_TASK = `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', 'client', '${URL}');`
    const run = async (pr: Record<string, unknown>, path: string, seed = TASK) => {
      const w = world(pr, seed)
      const out = await mergeAgentPr(input, { ...w.deps, pausedFlag: path })
      return { out, merged: merges(w.calls).length }
    }
    const codexOnly = (...extra: unknown[]) => green({ comments: [tier("normal"), review("codex", "APPROVE"), ...extra] })
    const notApproved = (r: Awaited<ReturnType<typeof run>>) => {
      expect([r.out.status, r.out.body.error, r.merged]).toEqual([409, "not_approved", 0])
    }

    test("flag absent: normal tier + Codex only still 409 not_approved", async () => notApproved(await run(codexOnly(), absent)))

    test("flag present, normal tier, Codex APPROVE: merges", async () => {
      const r = await run(codexOnly(), flag)
      expect([r.out.status, r.merged]).toEqual([200, 1])
    })

    test("flag present: a Codex comment tagged (codex only, Claude review paused) merges", async () => {
      const tagged = { author: { login: BOT }, body: `🧠 **Codex review** (codex only, Claude review paused)\n\nVERDICT: APPROVE <!-- reviewed-sha: ${SHA} -->` }
      const r = await run(green({ comments: [tier("normal"), tagged] }), flag)
      expect([r.out.status, r.merged]).toEqual([200, 1])
    })

    test("flag is read on every call, never cached", async () => {
      const f = join(dir, "toggled")
      writeFileSync(f, "")
      expect((await run(codexOnly(), f)).out.status).toBe(200)
      rmSync(f)
      notApproved(await run(codexOnly(), f))
    })

    test("flag present: Codex CHANGES refuses", async () => notApproved(await run(green({ comments: [tier("normal"), review("codex", "CHANGES")] }), flag)))
    test("flag present: Claude CHANGES refuses even with a Codex APPROVE", async () => notApproved(await run(codexOnly(review("claude", "CHANGES")), flag)))
    test("flag present: Codex APPROVE of an older head refuses", async () => notApproved(await run(green({ comments: [tier("normal"), review("codex", "APPROVE", OLD)] }), flag)))
    test("flag present: no Codex review refuses", async () => notApproved(await run(green({ comments: [tier("normal")] }), flag)))
    test("flag present: GitHub CHANGES_REQUESTED refuses", async () => notApproved(await run({ ...codexOnly(), reviewDecision: "CHANGES_REQUESTED" }, flag)))

    for (const [what, marker] of [["high tier", [tier("high")]], ["no tier marker", []]] as const) {
      test(`flag present: ${what} still needs both`, async () => notApproved(await run(green({ comments: [...marker, review("codex", "APPROVE")] }), flag)))
    }

    test("flag present: a low marker on code still needs both", async () => notApproved(await run(green({ files: [{ path: "server/lib/a.ts" }], comments: [tier("low"), review("codex", "APPROVE")] }), flag)))

    test("flag present: a client-origin task is unchanged (needs both)", async () => notApproved(await run(codexOnly(), flag, CLIENT_TASK)))
    test("flag present: a client-origin PR label is unchanged (needs both)", async () => notApproved(await run({ ...codexOnly(), labels: [{ name: "client-origin" }] }, flag)))
    const claudeOnly = green({ comments: [tier("normal"), review("claude", "APPROVE")] })
    test("flag present: normal tier + Claude APPROVE only refuses (Codex replaces Claude)", async () => notApproved(await run(claudeOnly, flag)))
    test("flag present: a client-origin task with Claude APPROVE only refuses", async () => notApproved(await run(claudeOnly, flag, CLIENT_TASK)))
    test("flag present: a client-origin label with Claude APPROVE only refuses", async () => notApproved(await run({ ...claudeOnly, labels: [{ name: "client-origin" }] }, flag)))
    test("flag absent: a client-origin task with Claude APPROVE only merges, as before", async () => {
      expect((await run(claudeOnly, absent, CLIENT_TASK)).out.status).toBe(200)
    })
    test("flag present: client-origin with both reviews still merges, as today", async () => {
      const r = await run(green({ comments: [tier("normal"), review("claude", "APPROVE"), review("codex", "APPROVE")] }), flag, CLIENT_TASK)
      expect([r.out.status, r.merged]).toEqual([200, 1])
    })
  })

  const held: Array<[string, Record<string, unknown>, string?]> = [
    ["a conflict park", {}, park("pr:needs-human", "merge conflict unresolved after 2 attempts")],
    ["a spent CI fix budget", {}, park("pr:needs-human", "CI still failing after 3 fixes: tsc")],
    ["a spent review fix budget", {}, park("pr:needs-human", "review verdict CHANGES after 2 fix runs — see the reviewer summary")],
    ["a park with no reason", {}, `${TASK} INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', 'abcd1234-0000', '{"url":"${URL}"}');`],
    ["a cascade hold", {}, `${TASK} INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:hold', 'pr', '${URL}', '{"url":"${URL}"}');`],
    ["a tainted review park", {}, park("pr:needs-human", "tainted (web) PR: external link added — needs your review")],
    ["a client-prefixed tainted review park", {}, park("pr:needs-human", "client-origin PR — human review required: tainted (client) PR: external link added — needs your review")],
    ["a tainted human-merge-only park", {}, park("pr:needs-human", "tainted (web) PR touches server/lib/auth.ts — human merge only")],
    ["a C-017 park with clientPark's prefix", {}, park("pr:needs-human", "client-origin PR — human review required: tainted (client) PR touches server/lib/auth.ts — human merge only")],
    ["a truncated-list park (no `only`)", {}, park("pr:needs-human", "tainted (web) PR: file list may be truncated — human merge")],
    ["a human-merge path park", {}, park("pr:needs-human", "touches hooks/guard.py — human merge only")],
  ]
  for (const [what, over, seed] of held) {
    test(`403 parked: ${what}`, async () => {
      const out = await refused(green(over), seed ?? TASK)
      expect([out.status, out.body.error]).toEqual([403, "parked"])
      expect((out.body.reasons as string[]).length).toBeGreaterThan(0)
    })
  }

  test("409 head_moved: the gate checked a head other than the one this view would merge", async () => {
    const w = world(green())
    const out = await mergeAgentPr(input, { ...w.deps, gate: passGate(OLD) })
    expect([out.status, out.body.error]).toEqual([409, "head_moved"])
    expect(merges(w.calls)).toHaveLength(0)
  })

  test("409 base_moved: the gate read a base other than the one this view checked", async () => {
    const w = world(green())
    const out = await mergeAgentPr(input, { ...w.deps, gate: passGate(SHA, "release") })
    expect([out.status, out.body.error]).toEqual([409, "base_moved"])
    expect(merges(w.calls)).toHaveLength(0)
  })

  test("409 client_gone: the caller left, so nothing merges and nothing is recorded", async () => {
    const w = world(green())
    const out = await mergeAgentPr({ ...input, signal: AbortSignal.abort() }, w.deps)
    expect([out.status, out.body.error]).toEqual([409, "client_gone"])
    expect(merges(w.calls)).toHaveLength(0)
    expect(w.db.query("SELECT COUNT(*) AS n FROM agent_activity").get()).toEqual({ n: 0 })
  })

  test("the base is read again last, after every other check, right before the merge", async () => {
    const w = world(green())
    expect((await mergeAgentPr(input, w.deps)).status).toBe(200)
    expect(w.calls.slice(-3).map((c) => c[1])).toEqual(["view", "merge", "view"])
    expect(w.calls.at(-3)!.join(" ")).toContain("baseRefName")
  })

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

  // The MFA / human-review gate is retired (2026-10-31): money, origin and the shepherd's human-review park no longer
  // refuse a green, twice-approved dispatch PR. Hard stops are the merge gate's: its stub here passes.
  const routine: Array<[string, Record<string, unknown>, string?]> = [
    ["an invoice / billing path", { title: "invoices: Stripe checkout retry", body: "Changes the invoice footer and payment webhook.", files: [{ path: "server/lib/billing/invoice.ts" }], changedFiles: 1 }],
    ["an MFA path and a needs-mfa label", { files: [{ path: "client/src/mfa/Totp.tsx" }], changedFiles: 1, labels: [{ name: "needs-mfa" }, { name: "billing" }] }],
    ["a web-origin task", {}, `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', 'web', '${URL}');`],
    ["a client-origin task", {}, `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', 'client', '${URL}');`],
    ["an unset-origin task", {}, `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', NULL, '${URL}');`],
    ["no task linked by url", {}, ""],
    ["a client-origin park", {}, park("pr:needs-human", "client-origin PR — human review required: touches server/lib/pay.ts")],
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

  test("humanApproved (Jeremie said 'Merge 413' in Brain thread) lifts review-round pr:needs-human park and CHANGES, but never lifts pr:hold or tainted/human-merge hard stops", async () => {
    const now = 1_700_000_000_000
    expect(hasRecentUserMergeApproval(413, [
      { role: "orchestrator", text: "Merge #413, or would you rather investigate the runner first?", createdAt: now - 30_000 },
      { role: "user", text: "Merge 413", createdAt: now - 5_000 },
    ], now)).toBe(true)

    expect(hasRecentUserMergeApproval(413, [
      { role: "orchestrator", text: "Merge #413, or investigate first?", createdAt: now - 30_000 },
      { role: "user", text: "yes", createdAt: now - 5_000 },
    ], now)).toBe(true)

    expect(hasRecentUserMergeApproval(8, [
      { role: "orchestrator", text: "All 157 stores are on the map now (PR #8): https://github.com/jaubut/le-brouemont-maquette/pull/8", createdAt: now - 30_000 },
      { role: "user", text: "Merge it", createdAt: now - 5_000 },
    ], now)).toBe(true)

    expect(hasRecentUserMergeApproval(425, [
      { role: "orchestrator", text: "PR #425 is held by false-alarm gate 06e76ee4.", createdAt: now - 30_000 },
      { role: "user", text: "You have the permission", createdAt: now - 5_000 },
    ], now)).toBe(true)

    expect(hasRecentUserTaskCancelApproval("06e76ee4021e42bea3e2bf0a38c0b407", [
      { role: "orchestrator", text: "PR #425 is held by false-alarm infra-gate task 06e76ee4.", createdAt: now - 30_000 },
      { role: "user", text: "You have the permission", createdAt: now - 5_000 },
    ], now)).toBe(true)

    expect(hasRecentUserTaskCancelApproval("06e76ee4021e42bea3e2bf0a38c0b407", [
      { role: "user", text: "Cancel 06e76ee4", createdAt: now - 5_000 },
    ], now)).toBe(true)

    expect(hasRecentUserMergeApproval(413, [
      { role: "user", text: "Do not merge 413 yet", createdAt: now - 5_000 },
    ], now)).toBe(false)

    // With humanApproved: true, a green PR parked after 2 review rounds with Codex CHANGES merges cleanly
    const reviewParked = world(
      green({ comments: [review("claude", "APPROVE"), review("codex", "CHANGES")] }),
      park("pr:needs-human", "review verdict CHANGES after 2 fix runs — see the reviewer summary"),
    )
    const okOut = await mergeAgentPr(input, { ...reviewParked.deps, humanApproved: () => true })
    expect(okOut.status).toBe(200)
    expect(merges(reviewParked.calls)).toHaveLength(1)

    // With humanApproved: true, a green PR parked with "— needs your review" (size/dependency/external-url) merges cleanly
    const needsReviewParked = world(
      green(),
      park("pr:needs-human", "tainted (unknown) PR: 10700 changed lines > 150; dependency manifest/lockfile: bun.lock, package.json — needs your review"),
    )
    const okNeedsReview = await mergeAgentPr(input, { ...needsReviewParked.deps, humanApproved: () => true })
    expect(okNeedsReview.status).toBe(200)
    expect(merges(needsReviewParked.calls)).toHaveLength(1)

    // Even with humanApproved: true, pr:hold and tainted/human-merge parks remain blocked
    const holdParked = world(green(), park("pr:hold", "infra hold"))
    expect((await mergeAgentPr(input, { ...holdParked.deps, humanApproved: () => true })).status).toBe(403)

    const taintedParked = world(green(), park("pr:needs-human", "tainted (web) PR touches server/lib/auth.ts — human merge only"))
    expect((await mergeAgentPr(input, { ...taintedParked.deps, humanApproved: () => true })).status).toBe(403)
  })
})
