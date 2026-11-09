import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { MergeGateFn } from "./merge-gate"
import { passGate } from "./merge-gate.test-util"
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
const READY = "mergeable,mergeStateStatus,headRefOid,baseRefName,statusCheckRollup"
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
const deps = { gh, exec, host: "mac", gate: passGate("abc123") }
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
  readiness = { baseRefName: "main" }
  readinessAfter = null
})

describe("merge", () => {
  test("a gate refusal returns before readiness: one state read, no merge, no row", async () => {
    const out = await mergePr({ ...deps, gate: async () => ({ ok: false, status: 403, error: "human-merge-path", extra: { action: "park", reason: "touches hooks/x.py — human merge only", head: "abc123" } }) }, target)
    expect(out).toEqual({ kind: "error", status: 403, error: "human-merge-path", extra: { action: "park", reason: "touches hooks/x.py — human merge only", head: "abc123" } })
    expect(calls).toEqual([["pr", "view", URL, "--json", "state"]])
    expect(ledger()).toEqual([])
  })

  test("a closed PR is stale before the gate runs", async () => {
    state = "MERGED"
    const out = await mergePr({ ...deps, gate: async () => { throw new Error("must not run") } }, target)
    expect(out.kind).toBe("stale")
  })

  test("squash-merges by full URL, verifies MERGED, then marks the task done and ledgers outcome:merged", async () => {
    const out = await mergePr(deps, target)
    expect(out).toEqual({ kind: "done", detail: { state: "MERGED" } })
    expect(calls).toEqual([["pr", "view", URL, "--json", "state"], ["pr", "view", URL, "--json", READY], ["pr", "merge", URL, "--squash", "--match-head-commit", "abc123"], ["pr", "view", URL, "--json", "state"]])
    expect(task().done).toBe(1)
    expect(ledger()).toEqual([{ agent_slug: "builder", action: "outcome:merged", target_id: "t1", summary: "PR #4 merged" }])
  })

  test("not MERGED afterwards (e.g. auto-merge queued) → 409 merge_unverified, nothing recorded", async () => {
    mergeEffect = "OPEN"
    const out = await mergePr(deps, target)
    expect(out).toMatchObject({ kind: "error", status: 409, error: "merge_unverified", extra: { state: "OPEN" } })
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
  const green = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "abc123", baseRefName: "main", statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] }
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

  test("readiness at a head the gate didn't check: 409 head_moved, no row, no merge", async () => {
    readiness = { ...green, headRefOid: "def456", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }
    expect(await mergePr(deps, target)).toEqual({ kind: "error", status: 409, error: "head_moved" })
    expect(approvals()).toEqual([])
    expect(calls.some((c) => c[1] === "merge")).toBe(false)
  })

  test("a hold with no head reported can't be approved: 409 head_moved, no row, no merge", async () => {
    readiness = { mergeable: "CONFLICTING" }
    expect(await mergePr(deps, target)).toEqual({ kind: "error", status: 409, error: "head_moved" })
    expect(approvals()).toEqual([])
    expect(calls.some((c) => c[1] === "merge")).toBe(false)
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

  test("GitHub refuses the merge and only then reports a conflict → the tap still counts: queued, not merge_unverified", async () => {
    readiness = green
    readinessAfter = { ...green, mergeable: "CONFLICTING" }
    mergeEffect = "OPEN"
    expect(await mergePr(deps, target)).toMatchObject({ kind: "queued", detail: { reason: "conflict" } })
    expect(approvals()).toHaveLength(1)
  })

  test("a push after the gate, seen by the first read with nothing holding the PR: 409 head_moved, no merge", async () => {
    readiness = { ...green, headRefOid: "def456" }
    expect(await mergePr(deps, target)).toEqual({ kind: "error", status: 409, error: "head_moved" })
    expect(calls.some((c) => c[1] === "merge")).toBe(false)
    expect(approvals()).toEqual([])
    expect(ledger()).toEqual([])
  })

  test("a push between the gate and gh pr merge: the pin refuses it, and the answer is 409 head_moved, not a 5xx", async () => {
    readiness = green
    readinessAfter = { ...green, headRefOid: "def456" }
    mergeEffect = "OPEN"
    expect(await mergePr(deps, target)).toEqual({ kind: "error", status: 409, error: "head_moved" })
    expect(approvals()).toEqual([])
  })

  test("the same, with a hold on the new head: 409 head_moved, no approval for a head nothing checked", async () => {
    readiness = green
    readinessAfter = { ...green, headRefOid: "def456", mergeable: "CONFLICTING" }
    mergeEffect = "OPEN"
    expect(await mergePr(deps, target)).toEqual({ kind: "error", status: 409, error: "head_moved" })
    expect(approvals()).toEqual([])
  })

  test("a retarget after the gate, seen before the merge: 409 base_moved, no merge, no row", async () => {
    readiness = { ...green, baseRefName: "release" }
    expect(await mergePr(deps, target)).toEqual({ kind: "error", status: 409, error: "base_moved" })
    expect(calls.some((c) => c[1] === "merge")).toBe(false)
    expect(approvals()).toEqual([])
    expect(ledger()).toEqual([])
  })

  test("the same with a hold: 409 base_moved, no approval for a diff the gate never read", async () => {
    readiness = { ...green, baseRefName: "release", mergeable: "CONFLICTING" }
    expect(await mergePr(deps, target)).toEqual({ kind: "error", status: 409, error: "base_moved" })
    expect(approvals()).toEqual([])
  })

  test("a retarget seen only after GitHub refused the merge: 409 base_moved, no approval", async () => {
    readiness = green
    readinessAfter = { ...green, baseRefName: "release", mergeable: "CONFLICTING" }
    mergeEffect = "OPEN"
    expect(await mergePr(deps, target)).toEqual({ kind: "error", status: 409, error: "base_moved" })
    expect(approvals()).toEqual([])
  })

  test("the client left during the gate: 409 client_gone, no merge, no row", async () => {
    const left = new AbortController()
    const gate: MergeGateFn = async () => { left.abort(); return { ok: true, head: "abc123", base: "main" } }
    readiness = green
    expect(await mergePr({ ...deps, gate, signal: left.signal }, target)).toEqual({ kind: "error", status: 409, error: "client_gone" })
    expect(calls.some((c) => c[1] === "merge")).toBe(false)
    expect(ledger()).toEqual([])
  })

  test("the client left on a held PR: no approval either, the re-send records it", async () => {
    readiness = { ...green, mergeable: "CONFLICTING" }
    expect(await mergePr({ ...deps, signal: AbortSignal.abort() }, target)).toEqual({ kind: "error", status: 409, error: "client_gone" })
    expect(approvals()).toEqual([])
  })

  describe("the client left during the assignee lookup: 409 client_gone, no approval", () => {
    const leaves = () => {
      const left = new AbortController()
      const lookup: ExecFn = async (sql, args) => {
        if (sql.includes("SELECT assignee")) left.abort()
        return exec(sql, args)
      }
      return { exec: lookup, signal: left.signal }
    }
    test("a hold seen before the merge", async () => {
      readiness = { ...green, mergeable: "CONFLICTING" }
      expect(await mergePr({ ...deps, ...leaves() }, target)).toEqual({ kind: "error", status: 409, error: "client_gone" })
      expect(approvals()).toEqual([])
    })
    test("a hold seen after GitHub refused the merge", async () => {
      readiness = green
      readinessAfter = { ...green, mergeable: "CONFLICTING" }
      mergeEffect = "OPEN"
      expect(await mergePr({ ...deps, ...leaves() }, target)).toEqual({ kind: "error", status: 409, error: "client_gone" })
      expect(approvals()).toEqual([])
    })
  })

  test("a live signal changes nothing", async () => {
    readiness = green
    expect(await mergePr({ ...deps, signal: new AbortController().signal }, target)).toMatchObject({ kind: "done" })
  })

  // No pin exists for the base, so this read is the only check: no answer means no merge, unlike the head.
  for (const [what, down] of [
    ["fails", (async () => ({ code: 1, stdout: "", stderr: "HTTP 502" })) as GhFn],
    ["can't start", (async () => { throw new GhUnreachable("ENOENT") }) as GhFn],
    ["reports no base", (async () => ({ code: 0, stdout: JSON.stringify({ mergeable: "MERGEABLE", headRefOid: "abc123" }), stderr: "" })) as GhFn],
  ] as const) {
    test(`the read before the merge ${what}: 409 gate_unavailable, no merge, no row`, async () => {
      const blind: GhFn = async (args) => (args[4] === READY ? down(args) : gh(args))
      expect(await mergePr({ ...deps, gh: blind }, target)).toEqual({ kind: "error", status: 409, error: "gate_unavailable", extra: { detail: "couldn't read the PR base" } })
      expect(calls.some((c) => c[1] === "merge")).toBe(false)
      expect(ledger()).toEqual([])
    })
  }

  test("GitHub refuses on the gated head for another reason: 409 merge_unverified", async () => {
    readiness = green
    readinessAfter = green
    mergeEffect = "OPEN"
    expect(await mergePr(deps, target)).toMatchObject({ kind: "error", status: 409, error: "merge_unverified" })
  })

  // The answer to a pinned merge GitHub rejected when nothing afterwards can say why. A 5xx here could be re-sent, and a
  // re-send passes the gate on a head Jeremie never tapped.
  for (const [what, after, state] of [
    ["the state read fails", { code: 1, stdout: "", stderr: "HTTP 502" }, "unknown"],
    ["the state read is garbage", { code: 0, stdout: "not json", stderr: "" }, "unknown"],
    ["the PR reads closed", { code: 0, stdout: JSON.stringify({ state: "CLOSED" }), stderr: "" }, "CLOSED"],
  ] as const) {
    test(`pinned merge rejected, then ${what}: 409, the detail kept, nothing recorded`, async () => {
      const rejected: GhFn = async (args) => {
        if (args[1] === "merge") { calls.push(args); return { code: 1, stdout: "", stderr: "Head branch was modified" } }
        return calls.some((c) => c[1] === "merge") ? after : gh(args)
      }
      readiness = green
      expect(await mergePr({ ...deps, gh: rejected }, target)).toEqual({ kind: "error", status: 409, error: "merge_unverified", extra: { state, detail: "Head branch was modified" } })
      expect(task().done).toBe(0)
      expect(approvals()).toEqual([])
      expect(ledger()).toEqual([])
    })
  }

  test("pinned merge rejected, PR still open, the readiness read fails: 409, nothing recorded", async () => {
    const rejected: GhFn = async (args) => {
      if (args[1] === "merge") { calls.push(args); return { code: 1, stdout: "", stderr: "Head branch was modified" } }
      if (args[4] === READY && calls.some((c) => c[1] === "merge")) return { code: 1, stdout: "", stderr: "HTTP 502" }
      return gh(args)
    }
    readiness = green
    expect(await mergePr({ ...deps, gh: rejected }, target)).toEqual({ kind: "error", status: 409, error: "merge_unverified", extra: { state: "OPEN", detail: "Head branch was modified" } })
    expect(approvals()).toEqual([])
  })

  // A throw past the gate would reach iOS as a 503, which it queues and re-sends with the card hidden.
  const unverified = { kind: "error" as const, status: 409, error: "merge_unverified", extra: { detail: "gh or Turso failed after the gate" } }
  test("gh pr merge can't start: 409, it never escapes as a throw", async () => {
    const down: GhFn = async (args) => { if (args[1] === "merge") throw new GhUnreachable("ENOENT"); return gh(args) }
    readiness = green
    expect(await mergePr({ ...deps, gh: down }, target)).toEqual(unverified)
  })

  test("gh dies on the read back after the merge: 409, never a throw", async () => {
    let merged = false
    const down: GhFn = async (args) => {
      if (merged) throw new GhUnreachable("ENOENT")
      if (args[1] === "merge") merged = true
      return gh(args)
    }
    readiness = green
    expect(await mergePr({ ...deps, gh: down }, target)).toEqual(unverified)
  })

  test("Turso down while recording the approval: 409, no row, never a throw", async () => {
    const down: ExecFn = async () => { throw new Error("turso down") }
    readiness = { ...green, mergeable: "CONFLICTING" }
    expect(await mergePr({ ...deps, exec: down }, target)).toEqual(unverified)
    expect(approvals()).toEqual([])
  })

  test("a closed PR is stale (no approval recorded)", async () => {
    state = "CLOSED"
    readiness = { ...green, mergeable: "CONFLICTING" }
    expect(await mergePr(deps, target)).toMatchObject({ kind: "stale" })
    expect(approvals()).toEqual([])
  })

  test("holdReason / rollupState", () => {
    const r = (o: Partial<{ mergeable: string; mergeState: string; checks: "pass" | "fail" | "pending" | "none" }>) => ({ mergeable: "MERGEABLE", mergeState: "CLEAN", headSha: "x", base: "main", checks: "pass" as const, ...o })
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
