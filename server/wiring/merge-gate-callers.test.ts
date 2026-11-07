import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { toolsDir } from "../lib/live-repo"
import { type MergeGateFn, mergeGate } from "../lib/merge-gate"
import { writeStubTools } from "../lib/merge-gate.test-util"
import { type GhFn, GhUnreachable, mergePr } from "../lib/triage-pr"
import type { ExecFn, Row } from "../lib/turso"

// The acceptance matrix: bin/pr-merge and the Companion tap call one gate, loaded by the real loader. gh is faked at
// the process boundary, Turso is a real sqlite with the prod columns. It runs on stub tools (CI has no
// ~/.claude/tools) and again on the real files on any host that has them, so a stub that drifts fails there.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-gate-callers-")), "test.db")
const { mergeAgentPr, retiredPark } = await import("./brain-pr-merge")

const URL = "https://github.com/o/r/pull/7"
const SHA = "1111111111111111111111111111111111111111"
const OTHER = "2222222222222222222222222222222222222222"
const BOT = "jaubut"
const TASK = "abcd1234-0000"

interface PrShape { files?: Array<string | [string, string]>; labels?: string[]; head?: string; draft?: boolean; state?: string; mergeable?: string; mergeState?: string; afterMerge?: { mergeable: string; head: string } | null; moved?: string }
const review = (who: "claude" | "codex") => ({
  author: { login: BOT },
  body: `${who === "claude" ? "🤖 **Auto-review**" : "🧠 **Codex review**"} (sonnet)\n\nVERDICT: APPROVE <!-- reviewed-sha: ${SHA} -->`,
})

function world(shape: PrShape, origin: string | null = "jeremie", opts: { tursoDown?: boolean; ghThrows?: boolean } = {}) {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, origin TEXT, assignee TEXT, done INTEGER DEFAULT 0, dispatch_status TEXT, dispatch_pr_url TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT, action TEXT, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')));
  `)
  if (origin !== null) db.query("INSERT INTO tasks (id, origin, assignee, dispatch_status, dispatch_pr_url) VALUES (?, ?, 'agent:builder', 'completed', ?)").run(TASK, origin, URL)
  const exec: ExecFn = async (sql, args) => {
    if (opts.tursoDown) throw new Error("down")
    return /^\s*SELECT/i.test(sql) ? { rows: db.query(sql).all(...args) as Row[], affected: 0 } : { rows: [], affected: db.query(sql).run(...args).changes }
  }
  const files = (shape.files ?? ["server/lib/feed.ts"]).map((f) => (typeof f === "string" ? [f, ""] as const : f))
  let state = shape.state ?? "OPEN"
  let head = shape.head ?? SHA
  let merged = false
  const reads = { head: 0 }
  const calls: string[][] = []
  const rollup = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }]
  const ready = () => {
    const after = merged ? shape.afterMerge : null
    return { mergeable: after?.mergeable ?? shape.mergeable ?? "MERGEABLE", mergeStateStatus: shape.mergeState ?? "CLEAN", headRefOid: after?.head ?? head, statusCheckRollup: rollup }
  }
  const gh: GhFn = async (args) => {
    if (opts.ghThrows) throw new GhUnreachable("ENOENT")
    calls.push(args)
    const out = (o: unknown) => ({ code: 0, stdout: typeof o === "string" ? o : JSON.stringify(o), stderr: "" })
    if (args[0] === "api") return out(files.map(([a, b]) => `${a}\t${b}`).join("\n"))
    if (args[1] === "diff") return out(files.map(([a, b]) => `diff --git a/${b || a} b/${a}`).join("\n"))
    if (args[1] === "merge") {
      merged = true
      if (shape.afterMerge) return { code: 1, stdout: "", stderr: "not mergeable" }
      state = "MERGED"
      return out("")
    }
    const fields = String(args[args.indexOf("--json") + 1])
    if (fields === "state") return out({ state })
    if (fields.startsWith("mergeable")) return out(ready())
    if (fields === "url,headRefOid,labels") {
      reads.head += 1
      if (reads.head === 2 && shape.moved) head = shape.moved
      return out({ url: URL, headRefOid: head, labels: (shape.labels ?? []).map((name) => ({ name })) })
    }
    return out({
      state, isDraft: shape.draft ?? false, headRefName: "dispatch/abcd1234", headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "",
      url: URL, title: "t", author: { login: BOT }, labels: (shape.labels ?? []).map((name) => ({ name })), statusCheckRollup: rollup,
      comments: [review("claude"), review("codex")], files: files.map(([path]) => ({ path })),
    })
  }
  return { db, gh, exec, calls, approvals: () => db.query("SELECT target_id, meta FROM agent_activity WHERE action = 'pr:approved-merge'").all() as Array<{ meta: string }> }
}
type World = ReturnType<typeof world>

interface Outcome { status: number; error?: string; [k: string]: unknown }
const CALLERS: Array<[string, (w: World, gate: MergeGateFn) => Promise<Outcome>]> = [
  ["bin/pr-merge", async (w, gate) => {
    const out = await mergeAgentPr({ repo: "o/r", pr: 7, reason: "routine" }, { gh: w.gh, exec: w.exec, event: () => {}, gate })
    return { status: out.status, ...out.body } as Outcome
  }],
  ["the tap", async (w, gate) => {
    const out = await mergePr({ gh: w.gh, exec: w.exec, host: "zettlab", gate }, { taskId: TASK, prUrl: URL, number: 7 })
    if (out.kind === "done") return { status: 200 }
    if (out.kind === "queued") return { status: 202, ...out.detail }
    if (out.kind === "error") return { status: out.status, error: out.error, ...out.extra }
    return { status: 0, error: out.kind }
  }],
]
const merges = (w: World) => w.calls.filter((c) => c[1] === "merge")
const rows = (w: World) => w.db.query("SELECT COUNT(*) AS n FROM agent_activity WHERE action NOT IN ('outcome:merged', 'brain:pr-merge')").get() as { n: number }

const REAL_TOOLS = join(process.env.HOME || homedir(), ".claude", "tools")
const hasRealTools = existsSync(join(REAL_TOOLS, "pr-gate.ts"))

function matrix(toolsFor: () => string): void {
  const gate: MergeGateFn = (d, p) => mergeGate(d, p, { tools: toolsFor() })
  for (const [name, run] of CALLERS) {
    describe(name, () => {
      for (const [what, shape] of [
        ["a routine PR", {}],
        ["a doc about a migration", { files: ["docs/herdr-only-migration.md"] }],
        ["120 files, past gh pr view's cap of 100", { files: Array.from({ length: 120 }, (_, i) => `src/f${i}.ts`) }],
      ] as Array<[string, PrShape]>) {
        test(`${what} merges, pinned to the gated head`, async () => {
          const w = world(shape)
          expect((await run(w, gate)).status).toBe(200)
          expect(merges(w)).toHaveLength(1)
          expect(merges(w)[0]!.slice(-2)).toEqual(["--match-head-commit", SHA])
        })
      }

      for (const [what, shape, origin, error, action] of [
        ["a human-merge path", { files: ["server/lib/a.ts", "hooks/guard.py"] }, "jeremie", "human-merge-path", "park"],
        ["agent instructions", { files: ["CLAUDE.md"] }, "system", "human-merge-path", "park"],
        ["a rename out of memory/", { files: [["archive/x.md", "memory/x.md"]] }, "jeremie", "human-merge-path", "park"],
        ["a tainted sensitive path", { files: ["server/lib/auth.ts"] }, "web", "tainted-sensitive", "park"],
        ["a client task on a sensitive path", { files: ["server/lib/auth.ts"] }, "client", "tainted-sensitive", "park"],
        ["a sensitive path with no task (unknown)", { files: ["server/lib/auth.ts"] }, null, "tainted-sensitive", "park"],
        ["prod schema", { files: ["server/db/migrations/001.sql"] }, "jeremie", "prod-schema", "park"],
        ["a wip label", { labels: ["wip"] }, "jeremie", "hold-label", "wait"],
        ["a do-not-merge label over a human path", { labels: ["do-not-merge"], files: ["hooks/x.py"] }, "jeremie", "hold-label", "wait"],
        ["a sync/zettlab PR, no task", { files: ["memory/a.md", "skills/s/SKILL.md"] }, null, "tainted-sensitive", "park"],
        ["a sync/zettlab PR, trusted task", { files: ["memory/a.md", "skills/s/SKILL.md"] }, "jeremie", "human-merge-path", "park"],
      ] as Array<[string, PrShape, string | null, string, string]>) {
        test(`${what}: 403 ${error}, no merge, no row`, async () => {
          const w = world(shape, origin)
          const out = await run(w, gate)
          expect(out).toMatchObject({ status: 403, error, action, head: SHA })
          expect(String(out.reason).length).toBeGreaterThan(0)
          expect(merges(w)).toHaveLength(0)
          expect(rows(w).n).toBe(0)
        })
      }

      test("fail-closed: the gate missing on this host refuses and merges nothing", async () => {
        const w = world({})
        const none: MergeGateFn = (d, p) => mergeGate(d, p, { tools: "/nonexistent/tools" })
        expect(await run(w, none)).toMatchObject({ status: 409, error: "gate_unavailable" })
        expect(merges(w)).toHaveLength(0)
      })
      test("fail-closed: Turso down inside the gate", async () => {
        const w = world({}, "jeremie", { tursoDown: true })
        expect(await run(w, gate)).toMatchObject({ status: 409, error: "gate_unavailable" })
        expect(merges(w)).toHaveLength(0)
      })
      test("head moved during the gate: 409 head_moved, no merge", async () => {
        const w = world({ moved: OTHER })
        expect(await run(w, gate)).toMatchObject({ status: 409, error: "head_moved" })
        expect(merges(w)).toHaveLength(0)
      })
    })
  }

  describe("bin/pr-merge order", () => {
    const run = CALLERS[0]![1]
    test("a stop outranks draft", async () => {
      const w = world({ draft: true, files: ["hooks/x.py"] })
      expect(await run(w, gate)).toMatchObject({ status: 403, error: "human-merge-path" })
    })
    test("a C-017 park hidden by a newer pr:unpark is still refused: the gate reads live facts, not the ledger", async () => {
      const w = world({ files: ["server/lib/auth.ts"] }, "web")
      const row = w.db.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', ?, 'task', ?, ?)")
      row.run("pr:needs-human", TASK, JSON.stringify({ url: URL, reason: "tainted (web) PR touches server/lib/auth.ts — human merge only" }))
      row.run("pr:unpark", TASK, JSON.stringify({ url: URL }))
      expect(await run(w, gate)).toMatchObject({ status: 403, error: "tainted-sensitive" })
    })
    test("not_open makes no gate call", async () => {
      let called = 0
      const count: MergeGateFn = (d, p) => { called += 1; return gate(d, p) }
      expect(await run(world({ state: "MERGED" }), count)).toMatchObject({ status: 409, error: "not_open" })
      expect(called).toBe(0)
    })
  })

  describe("approval rows on the tap", () => {
    const tap = CALLERS[1]![1]
    test("a conflicting human-path PR writes no approval, so the shepherd can't lift it", async () => {
      const w = world({ files: ["hooks/x.py"], mergeable: "CONFLICTING", mergeState: "DIRTY" })
      expect(await tap(w, gate)).toMatchObject({ status: 403, error: "human-merge-path" })
      expect(w.approvals()).toEqual([])
    })
    test("a conflicting routine PR records the approval at the gated head", async () => {
      const w = world({ mergeable: "CONFLICTING", mergeState: "DIRTY" })
      expect(await tap(w, gate)).toMatchObject({ status: 202, approvedHeadSha: SHA })
      expect(w.approvals()).toHaveLength(1)
      expect(JSON.parse(w.approvals()[0]!.meta)).toMatchObject({ approvedHeadSha: SHA })
    })
    for (const mergeable of ["CONFLICTING", "MERGEABLE"]) {
      test(`late: a refused merge on a head the gate never saw (${mergeable}) is 409 head_moved and records nothing`, async () => {
        const w = world({ afterMerge: { mergeable, head: OTHER } })
        expect(await tap(w, gate)).toMatchObject({ status: 409, error: "head_moved" })
        expect(w.approvals()).toEqual([])
      })
    }
    test("late: a refused merge on the gated head still counts as the approval", async () => {
      const w = world({ afterMerge: { mergeable: "CONFLICTING", head: SHA } })
      expect(await tap(w, gate)).toMatchObject({ status: 202, approvedHeadSha: SHA })
      expect(w.approvals()).toHaveLength(1)
    })
    test("late: a refused merge nothing can explain is 409 merge_unverified, with no 5xx to re-send, and one merge", async () => {
      const w = world({ afterMerge: { mergeable: "MERGEABLE", head: SHA } })
      const blind: GhFn = async (args) => (merges(w).length && args[4] === "state" ? { code: 1, stdout: "", stderr: "HTTP 502" } : w.gh(args))
      expect(await tap({ ...w, gh: blind }, gate)).toMatchObject({ status: 409, error: "merge_unverified", state: "unknown" })
      expect(merges(w)).toHaveLength(1)
      expect(rows(w)).toEqual({ n: 0 })
    })
  })
}

describe("stub tools", () => {
  const tools = writeStubTools()
  matrix(() => tools)
  test("toolsDir is the path the matrix calls real", () => {
    expect(toolsDir()).toBe(REAL_TOOLS)
  })
  test("a thrown GhUnreachable never escapes either caller", async () => {
    const gate: MergeGateFn = (d, p) => mergeGate({ ...d, gh: async () => { throw new GhUnreachable("ENOENT") } }, p, { tools })
    for (const [, run] of CALLERS) expect(await run(world({}), gate)).toMatchObject({ status: 409, error: "gate_unavailable" })
  })
})

describe.skipIf(!hasRealTools)("the real gate on this host", () => {
  matrix(() => REAL_TOOLS)

  // A reworded hard stop must fail here, not quietly slip past bin/pr-merge's retired-park rule.
  test("no park reason from the real gate is one bin/pr-merge would retire, raw or with clientPark's prefix", async () => {
    const { gateVerdict } = await import(join(REAL_TOOLS, "pr-gate.ts")) as { gateVerdict(g: unknown): { stop: string; action: string; reason: string } | null }
    const base = { paths: ["src/a.ts"], holdLabels: [] as string[], approved: false }
    const taint = { origin: "client", sensitive: ["src/auth.ts"], stamped: false }
    const stops = [
      { ...base, taint },
      { ...base, taint: { ...taint, sensitive: [], truncated: true } },
      { ...base, paths: ["db/migrations/1.sql"] },
      { ...base, paths: ["CLAUDE.md"] },
      { ...base, pathsIncomplete: true },
    ].map((g) => gateVerdict(g)!)
    expect(new Set(stops.map((s) => s.stop))).toEqual(new Set(["tainted-sensitive", "prod-schema", "human-merge-path"]))
    for (const s of stops) {
      expect(s.action).toBe("park")
      expect(retiredPark(s.reason)).toBe(false)
      expect(retiredPark(`client-origin PR — human review required: ${s.reason}`)).toBe(false)
    }
    // A hold label writes no park row, so the rule doesn't apply: if that ever changes, this fails.
    expect(gateVerdict({ ...base, holdLabels: ["wip"] })).toMatchObject({ stop: "hold-label", action: "wait" })
  })
})
