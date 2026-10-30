import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import type { TriageItem } from "../lib/triage"
import type { GhFn } from "../lib/triage-pr"
import type { TriageEngine } from "../lib/triage-engine"
import type { RepoRunner } from "../wiring/triage-repos"
import { type GhPr, agentTaskTitle, prStatus, repoPrs } from "../lib/repo-view"

// Repo view — GET /api/orchestrator/repos/<repo> + POST …/agent. Same harness
// as body-agent.test.ts: real Companion sqlite (isolated COMPANION_DB_PATH),
// "Turso" = in-memory bun:sqlite behind the QueryFn / ExecFn seams, a fake gh.
// The tap files ONE builder task through fileProposal (byHand, herdr runner).

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-repo-view-")), "test.db")

const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-repo-view-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
writeFileSync(join(tempHome, ".claude", "agents", "builder.md"), "---\n---\n")
mkdirSync(join(tempHome, "apps", "ios"), { recursive: true })

const MAP = [
  "const REPO_MAP = [",
  `  { name: "companion-ios", match: /companion-ios/i, path: \`\${home}/apps/ios\`, project: "PRJ-IOS1", github: "jaubut/claude-companion-ios", requires: ["xcode"] },`,
  `  { name: "no-gh", match: /no-gh/i, path: \`\${home}/no-gh\`, project: "PRJ-IOS1" },`,
  `  { name: "orphan", match: /orphan/i, path: \`\${home}/orphan\`, project: "PRJ-NONE", github: "jaubut/orphan" },`,
  "]",
].join("\n")

let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let liveRepo: typeof import("../lib/live-repo")
let viewLib: typeof import("../wiring/repo-view")
let route: typeof import("./triage")

// ── fake Turso ───────────────────────────────────────────────────────────────

const turso = new Database(":memory:")
turso.exec(`
  CREATE TABLE notes (id TEXT PRIMARY KEY, folder TEXT, title TEXT, ref_code TEXT, status TEXT, type TEXT, body TEXT, updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_id TEXT DEFAULT '', text TEXT NOT NULL, description TEXT DEFAULT '',
    done INTEGER DEFAULT 0, due_date TEXT DEFAULT '', position INTEGER DEFAULT 0, assignee TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    dispatch_status TEXT, dispatch_run_id TEXT, dispatch_started_at TEXT, dispatch_completed_at TEXT,
    dispatch_blocker TEXT, dispatch_owner TEXT, dispatch_result_ref TEXT, dispatch_pr_url TEXT, last_pm_review TEXT,
    requires_host TEXT NOT NULL DEFAULT 'any', origin TEXT
  );
  CREATE TABLE agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT,
    target_id TEXT, summary TEXT, meta TEXT, ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO notes (id, folder, title, ref_code, status) VALUES ('projects/ios', 'projects', 'Companion iOS', 'PRJ-IOS1', 'active');
`)
let tursoDown = false
const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (tursoDown) throw new Error("turso down")
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  const res = turso.query(sql).run(...args)
  return { rows: [], affected: res.changes }
}
const query: QueryFn = async (sql, args) => (await exec(sql, args)).rows
const tasks = () => turso.query("SELECT * FROM tasks WHERE text LIKE '[repo:%'").all() as Record<string, any>[]

// ── fake gh ──────────────────────────────────────────────────────────────────

let ghCalls: string[][] = []
let ghPrs: Record<string, unknown>[] = []
let ghCode = 0
const gh: GhFn = async (args) => {
  ghCalls.push(args)
  return { code: ghCode, stdout: ghCode === 0 ? JSON.stringify(ghPrs) : "", stderr: ghCode === 0 ? "" : "boom" }
}

const ghPr = (n: number, over: Record<string, unknown> = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/jaubut/claude-companion-ios/pull/${n}`, isDraft: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
  reviewDecision: "", updatedAt: `2026-10-2${n % 10}T12:00:00Z`, ...over,
})
const failing = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]

/** A dispatch PR task the shepherd parked (lib/triage-sources.ts prSources reads it). */
function parked(n: number, reason: string) {
  const id = `park${n}`.padEnd(32, "0")
  const url = `https://github.com/jaubut/claude-companion-ios/pull/${n}`
  turso.query("INSERT INTO tasks (id, note_id, text, assignee, dispatch_status, dispatch_pr_url) VALUES (?, 'projects/ios', ?, 'agent:builder', 'pr', ?)").run(id, `PR ${n}`, url)
  turso.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', ?, ?)").run(id, JSON.stringify({ url, reason }))
}

let items: TriageItem[] = []
const item = (repo: string | null): TriageItem => ({
  id: `task:${Math.random()}`, source: "task", refId: "x", title: "t", project: "p", repo, severity: "normal",
  problem: "", action: "", recommended: "", options: [], createdAt: 0, updatedAt: 0,
})

let w: ReturnType<typeof makeWiring>
let view: import("../wiring/repo-view").RepoView
let handler: ReturnType<typeof import("./triage").createTriageHandler>

function makeWiring() {
  return poller.createDispatchWiring({
    query, exec,
    broadcast: () => {},
    appendTurn: (text, taskId, channelId) => chat.appendTurn("orchestrator", text, taskId, channelId),
    push: () => {}, pushEnabled: () => false,
    linkedNotes: channels.linkedNotes, getChannel: channels.getChannel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    liveIdentity: () => null,
    log: () => {}, mirror, generalChannel: "general",
  })
}

const call = async (method: "GET" | "POST", repo: string, suffix = "") => {
  const url = new URL(`http://x/api/orchestrator/repos/${encodeURIComponent(repo)}${suffix}`)
  const res = await handler(new Request(url.toString(), { method }), url)
  return { status: res!.status, body: await res!.json() as Record<string, any> }
}

beforeAll(async () => {
  process.env.HOME = tempHome
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  liveRepo = await import("../lib/live-repo")
  viewLib = await import("../wiring/repo-view")
  route = await import("./triage")
  w = makeWiring()
})

afterAll(() => {
  process.env.HOME = savedHome
})

beforeEach(() => {
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity")
  tursoDown = false
  ghCalls = []
  ghCode = 0
  ghPrs = []
  items = []
  view = viewLib.createRepoView({ dispatch: w, gh, entries: () => liveRepo.parseRepoMap(MAP, tempHome), items: async () => items, now: Date.now })
  handler = route.createTriageHandler(() => ({}) as TriageEngine, () => ({}) as RepoRunner, () => view)
})

// ── status mapping (pure) ────────────────────────────────────────────────────

describe("prStatus", () => {
  const base: GhPr = { number: 1, title: "t", url: "u", isDraft: false, mergeable: "MERGEABLE", mergeState: "CLEAN", checks: "pass", reviewDecision: "", updatedAt: 0 }
  const cases: [string, Partial<GhPr>, string | null, string][] = [
    ["clean + green", {}, null, "ready"],
    ["no checks at all", { checks: "none" }, null, "ready"],
    ["draft wins over everything", { isDraft: true, mergeable: "CONFLICTING", checks: "fail" }, "ci", "draft"],
    ["conflicting", { mergeable: "CONFLICTING" }, null, "conflict"],
    ["dirty merge state", { mergeState: "DIRTY" }, null, "conflict"],
    ["failing checks", { checks: "fail" }, null, "checks_failing"],
    ["parked, otherwise green", {}, "touches sensitive path server/auth.ts", "parked"],
    ["checks running", { checks: "pending" }, null, "checks_running"],
    ["GitHub still computing", { mergeable: "UNKNOWN" }, null, "checks_running"],
    ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }, null, "review"],
    ["review required", { reviewDecision: "REVIEW_REQUIRED" }, null, "review"],
    ["blocked by protection", { mergeState: "BLOCKED" }, null, "review"],
    ["behind", { mergeState: "BEHIND" }, null, "behind"],
  ]
  for (const [name, over, park, want] of cases) {
    test(name, () => expect(prStatus({ ...base, ...over }, park).status).toBe(want as any))
  }

  test("a parked conflict reads as a conflict, with the shepherd's reason", () => {
    expect(prStatus({ ...base, mergeable: "CONFLICTING" }, "merge conflict I could not resolve")).toEqual({ status: "conflict", reason: "merge conflict I could not resolve" })
  })

  test("blocked PRs sort first, then newest", () => {
    const prs = repoPrs([{ ...base, number: 1, updatedAt: 3 }, { ...base, number: 2, checks: "fail", updatedAt: 1 }, { ...base, number: 3, updatedAt: 5 }], () => null)
    expect(prs.map((p) => p.number)).toEqual([2, 3, 1])
    expect(prs[0]).toMatchObject({ status: "checks_failing", label: "Checks failing" })
  })
})

// ── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/orchestrator/repos/<repo>", () => {
  test("open PRs in plain words, the shepherd's park, the Needs you count; gh gets the slug in argv", async () => {
    ghPrs = [ghPr(1), ghPr(2, { statusCheckRollup: failing }), ghPr(3, { mergeable: "CONFLICTING" }), ghPr(4), ghPr(5, { isDraft: true })]
    parked(4, "repeated CI failure · Opus: brief")
    items = [item("claude-companion-ios"), item("Claude-Companion-iOS"), item("other"), item(null)]
    const r = await call("GET", "claude-companion-ios")
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, repo: "claude-companion-ios", github: "jaubut/claude-companion-ios", blocked: 3, needsYou: 2, agent: null })
    const byNumber = Object.fromEntries((r.body.prs as any[]).map((p) => [p.number, p]))
    expect(byNumber[1]).toMatchObject({ status: "ready", label: "Ready to merge" })
    expect(byNumber[2]).toMatchObject({ status: "checks_failing", label: "Checks failing" })
    expect(byNumber[3]).toMatchObject({ status: "conflict", label: "Merge conflict" })
    expect(byNumber[4]).toMatchObject({ status: "parked", label: "Parked by shepherd", reason: "repeated CI failure" })
    expect(byNumber[5]).toMatchObject({ status: "draft", label: "Draft" })
    expect(ghCalls[0]).toEqual(["pr", "list", "--repo", "jaubut/claude-companion-ios", "--state", "open", "--limit", "50", "--json", expect.any(String)])
  })

  test("the repo name matches any case; gh is cached between views", async () => {
    ghPrs = [ghPr(1)]
    expect((await call("GET", "CLAUDE-companion-ios")).status).toBe(200)
    expect((await call("GET", "claude-companion-ios")).status).toBe(200)
    expect(ghCalls).toHaveLength(1)
  })

  test("unknown repo, a map entry without a GitHub slug, the Other card and a bad name → 404, gh never runs", async () => {
    for (const repo of ["nope", "no-gh", "_other", "a b;rm"]) {
      const r = await call("GET", repo)
      expect(r.status).toBe(404)
      expect(r.body).toMatchObject({ ok: false, error: "no_such_repo" })
    }
    expect(ghCalls).toHaveLength(0)
  })

  test("gh failing with nothing cached → 503 gh_unreachable", async () => {
    ghCode = 1
    expect(await call("GET", "claude-companion-ios")).toMatchObject({ status: 503, body: { error: "gh_unreachable" } })
  })
})

// ── POST …/agent ─────────────────────────────────────────────────────────────

describe("POST /api/orchestrator/repos/<repo>/agent", () => {
  test("files ONE queued builder task: origin jeremie, [repo:] title, herdr runner, blocked PRs in the brief", async () => {
    ghPrs = [ghPr(1), ghPr(2, { title: "Fix feed", statusCheckRollup: failing }), ghPr(3, { title: "Notes", mergeable: "CONFLICTING" })]
    const r = await call("POST", "claude-companion-ios", "/agent")
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, repo: "claude-companion-ios", result: "filed", agent: { status: "queued" } })
    expect(r.body.approveUrl).toBeUndefined()
    const rows = tasks()
    expect(rows).toHaveLength(1)
    const t = rows[0]!
    expect(t).toMatchObject({
      id: r.body.agent.taskId, text: "[repo:claude-companion-ios] Resolve blocked PRs in claude-companion-ios",
      assignee: "agent:builder", dispatch_status: "queued", origin: "jeremie", note_id: "projects/ios", done: 0,
    })
    expect(t.description).toContain("\ndispatch-runner: herdr")
    expect(t.description).toContain("#2 Fix feed — Checks failing")
    expect(t.description).toContain("#3 Notes — Merge conflict")
    expect(t.description).not.toContain("#1 ")
    const act = turso.query("SELECT * FROM agent_activity WHERE action = 'repo:agent'").all() as Record<string, any>[]
    expect(act).toEqual([expect.objectContaining({ agent_slug: "builder", target_kind: "repo", target_id: "jaubut/claude-companion-ios" })])
  })

  test("idempotent: a second tap returns the open task; GET shows it as the agent", async () => {
    ghPrs = [ghPr(2, { statusCheckRollup: failing })]
    const a = await call("POST", "claude-companion-ios", "/agent")
    const b = await call("POST", "claude-companion-ios", "/agent")
    expect(b).toMatchObject({ status: 200, body: { ok: true, result: "existing", agent: { taskId: a.body.agent.taskId, status: "queued" } } })
    expect(tasks()).toHaveLength(1)
    turso.query("UPDATE tasks SET dispatch_status = 'running' WHERE id = ?").run(a.body.agent.taskId)
    expect((await call("GET", "claude-companion-ios")).body.agent).toEqual({ taskId: a.body.agent.taskId, status: "running" })
  })

  test("a concurrent double tap files one task", async () => {
    ghPrs = [ghPr(2, { statusCheckRollup: failing })]
    const [a, b] = await Promise.all([call("POST", "claude-companion-ios", "/agent"), call("POST", "claude-companion-ios", "/agent")])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(tasks()).toHaveLength(1)
  })

  test("a finished task (done / completed / failed) no longer counts: the next tap files a new one", async () => {
    ghPrs = [ghPr(2, { statusCheckRollup: failing })]
    const a = await call("POST", "claude-companion-ios", "/agent")
    turso.query("UPDATE tasks SET dispatch_status = 'failed' WHERE id = ?").run(a.body.agent.taskId)
    expect((await call("GET", "claude-companion-ios")).body.agent).toBeNull()
    const b = await call("POST", "claude-companion-ios", "/agent")
    expect(b.body).toMatchObject({ result: "filed" })
    expect(b.body.agent.taskId).not.toBe(a.body.agent.taskId)
  })

  test("a parked PR counts as blocked", async () => {
    ghPrs = [ghPr(4)]
    parked(4, "repeated CI failure")
    expect((await call("POST", "claude-companion-ios", "/agent")).body).toMatchObject({ result: "filed" })
  })

  test("nothing blocked → 409 nothing_blocked, no task", async () => {
    ghPrs = [ghPr(1), ghPr(5, { isDraft: true }), ghPr(6, { statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] })]
    expect(await call("POST", "claude-companion-ios", "/agent")).toMatchObject({ status: 409, body: { error: "nothing_blocked" } })
    expect(tasks()).toHaveLength(0)
  })

  test("unknown repo → 404; a repo whose project note is not in Turso → 422 no_project", async () => {
    expect(await call("POST", "nope", "/agent")).toMatchObject({ status: 404, body: { error: "no_such_repo" } })
    ghPrs = [ghPr(2, { statusCheckRollup: failing })]
    expect(await call("POST", "orphan", "/agent")).toMatchObject({ status: 422, body: { error: "no_project" } })
    expect(tasks()).toHaveLength(0)
  })

  test("Turso down → 503 turso_unreachable, nothing filed", async () => {
    ghPrs = [ghPr(2, { statusCheckRollup: failing })]
    tursoDown = true
    expect(await call("POST", "claude-companion-ios", "/agent")).toMatchObject({ status: 503, body: { error: "turso_unreachable" } })
    tursoDown = false
    expect(tasks()).toHaveLength(0)
  })

  test("the title marker is the GitHub name dispatch-run routes on", () => {
    expect(agentTaskTitle("TLSTUDIO")).toBe("[repo:TLSTUDIO] Resolve blocked PRs in TLSTUDIO")
  })
})
