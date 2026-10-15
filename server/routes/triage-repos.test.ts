import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import type { GhFn } from "../lib/triage-pr"

// Repo cards, route level (needs-you-repo-yes-no, 2026-10-15; moved out of
// triage.test.ts for the file cap): the real wiring behind GET and
// POST /api/orchestrator/repos/<repo>/(yes|no) — guarded Turso writes (the
// pr:unpark row), the repo runner with its live seams. Same harness shape as
// triage.test.ts: isolated COMPANION_DB_PATH (shared across route test files
// by Bun's module cache — own channel, own ids), "Turso" = in-memory
// bun:sqlite, a fake gh, the model off (deterministic fallback cards).

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-triage-repos-")), "companion.db")

const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-triage-repos-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
writeFileSync(join(tempHome, ".claude", "agents", "builder.md"), "---\n---\n")
const dispatchRun = join(tempHome, "dispatch-run.ts")
writeFileSync(dispatchRun, "const REPO_MAP = []\n")

let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let triageWiring: typeof import("../wiring/triage")
let triageRoute: typeof import("./triage")
let repoWiring: typeof import("../wiring/triage-repos")
let triageStoreLib: typeof import("../lib/triage-store")
let invLib: typeof import("../lib/body-investigate")
let sqlite: typeof import("../lib/orchestrator-db")["db"]
let channelId: string

// ── fake Turso ───────────────────────────────────────────────────────────────

const turso = new Database(":memory:")
turso.exec(`
  CREATE TABLE notes (id TEXT PRIMARY KEY, folder TEXT, title TEXT, ref_code TEXT, status TEXT, type TEXT, body TEXT, updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_id TEXT DEFAULT '', text TEXT NOT NULL, description TEXT DEFAULT '',
    done INTEGER DEFAULT 0, due_date TEXT DEFAULT '', position INTEGER DEFAULT 0, assignee TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    dispatch_status TEXT, dispatch_run_id TEXT, dispatch_started_at TEXT, dispatch_completed_at TEXT,
    dispatch_blocker TEXT, dispatch_owner TEXT, dispatch_result_ref TEXT, dispatch_pr_url TEXT, last_pm_review TEXT
  );
  CREATE TABLE agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT,
    target_id TEXT, summary TEXT, meta TEXT, ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)
const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  const res = turso.query(sql).run(...args)
  return { rows: [], affected: res.changes }
}
const query: QueryFn = async (sql, args) => (await exec(sql, args)).rows

let seq = 0
const hex = () => (++seq).toString(16).padStart(32, "e")
function turTask(status: string, blocker: string | null, over: Record<string, unknown> = {}): string {
  const id = hex()
  turso.query(
    "INSERT INTO tasks (id, note_id, text, description, assignee, dispatch_status, dispatch_blocker, dispatch_pr_url, done) VALUES (?, 'projects/dash', ?, 'Original brief', 'agent:builder', ?, ?, ?, ?)",
  ).run(id, String(over.text ?? `Task ${id.slice(-4)}`), status, blocker, (over.pr as string) ?? null, Number(over.done ?? 0))
  return id
}

// ── fakes ────────────────────────────────────────────────────────────────────

const ghCalls: string[][] = []
const gh: GhFn = async (args) => {
  ghCalls.push(args)
  if (args[1] === "view" && String(args[4]).startsWith("mergeable")) return { code: 0, stdout: "{}", stderr: "" }
  if (args[1] === "view") return { code: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" }
  return { code: 0, stdout: "", stderr: "" }
}
const frames: Record<string, unknown>[] = []

function makeHarness() {
  const w = poller.createDispatchWiring({
    query, exec, broadcast: () => {},
    appendTurn: (text, taskId, ch) => chat.appendTurn("orchestrator", text, taskId, ch),
    push: () => {}, pushEnabled: () => false,
    linkedNotes: channels.linkedNotes, getChannel: channels.getChannel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    liveIdentity: () => null, log: () => {}, mirror, generalChannel: "general",
  })
  const engine = triageWiring.createLiveTriage({
    dispatch: w, gh,
    model: async () => null,
    severity: async () => null,
    investigations: () => invLib.createInvestigationStore(new Database(":memory:")),
    consider: async () => ({ status: "started", id: "inv-new" }),
    body: { get: async () => ({ components: [] }) } as never,
    mytasks: null,
    broadcast: (f) => frames.push(f),
  })
  const runner = repoWiring.createRepoRunner({ engine, store: triageStoreLib.createTriageStore(sqlite), ...triageWiring.repoSeams({ dispatch: w }) })
  return { w, engine, runner, handler: triageRoute.createTriageHandler(() => engine, () => runner) }
}
let harness: ReturnType<typeof makeHarness>

async function sync() {
  await harness.w.poll()
  await harness.engine.refresh()
  await harness.engine.idle()
}

async function get() {
  const req = new Request("http://localhost/api/orchestrator/triage")
  const res = await harness.handler(req, new URL(req.url))
  return await res!.json() as { items: any[]; generatedAt: number }
}

beforeAll(async () => {
  process.env.HOME = tempHome
  process.env.COMPANION_DISPATCH_RUN = dispatchRun
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  sqlite = (await import("../lib/orchestrator-db")).db
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  invLib = await import("../lib/body-investigate")
  triageWiring = await import("../wiring/triage")
  triageRoute = await import("./triage")
  repoWiring = await import("../wiring/triage-repos")
  triageStoreLib = await import("../lib/triage-store")
  channelId = channels.createChannel("triage-repos-test").id
})

afterAll(() => {
  sqlite.query("UPDATE orchestrator_tasks SET status = 'rejected' WHERE thread_id = ? AND status = 'proposed'").run(channelId)
  delete process.env.COMPANION_DISPATCH_RUN
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

beforeEach(() => {
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES ('projects/dash', 'projects', 'Dashboard', 'PRJ-WCLS', 'active')").run()
  sqlite.query("UPDATE orchestrator_tasks SET status = 'rejected' WHERE thread_id = ? AND status = 'proposed'").run(channelId)
  ghCalls.length = 0
  frames.length = 0
  harness = makeHarness()
})

describe("repo cards: Yes / No (needs-you-repo-yes-no, 2026-10-15)", () => {
  const fixturePath = join(import.meta.dir, "..", "..", "docs", "fixtures", "orchestrator-triage-repos.json")

  async function repoPost(repo: string, verb: "yes" | "no", payload: unknown, key?: string) {
    const req = new Request(`http://localhost/api/orchestrator/repos/${encodeURIComponent(repo)}/${verb}`, {
      method: "POST", body: typeof payload === "string" ? payload : JSON.stringify(payload), headers: key ? { "Idempotency-Key": key } : {},
    })
    const res = await harness.handler(req, new URL(req.url))
    return { status: res!.status, json: await res!.json() as Record<string, any>, replayed: res!.headers.get("Idempotent-Replayed") }
  }

  function park(id: string, url: string, reason: string) {
    turso.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', ?, ?)")
      .run(id, JSON.stringify({ reason, repo: "yes-dash", url }))
  }

  async function scene() {
    const u21 = "https://github.com/jaubut/yes-dash/pull/21"
    const u22 = "https://github.com/jaubut/yes-dash/pull/22"
    const t21 = turTask("completed", null, { pr: u21, text: "Flaky upload test" })
    const t22 = turTask("completed", null, { pr: u22, text: "Session cookie flags" })
    park(t21, u21, "CI still failing after 2 fixes: test")
    park(t22, u22, "touches src/lib/auth.ts — needs your review")
    const b = turTask("blocked", "Which currency?")
    const p = chat.createProposal("Ship the export", "", "Jeremie asked", channelId, { noteId: "projects/dash" })
    await sync()
    return { t21, t22, u21, b, p }
  }

  test("GET carries repos[] (one card per repo; held PR out of members); items[] unchanged; the shared fixture matches the server shape", async () => {
    const { b, p } = await scene()
    const body = await get() as unknown as { items: any[]; resolving: any[]; repos: any[]; generatedAt: number }
    expect(Array.isArray(body.repos)).toBe(true)
    const dash = body.repos.find((c) => c.repo === "yes-dash")
    expect(dash).toMatchObject({ id: "repo:yes-dash", name: "yes-dash", held: ["pr:jaubut/yes-dash#22"], counts: { members: 1, held: 1, prs: 2 } })
    expect(dash.members).toEqual([{ id: "pr:jaubut/yes-dash#21", version: expect.any(String), does: "hand_back" }])
    const other = body.repos.find((c) => c.id === "repo:_other")
    // Own ids only: the shared companion.db may hold other files' proposals (they fold into _other too).
    expect(other.members.map((m: any) => m.id)).toEqual(expect.arrayContaining([`proposal:${p.taskId}`, `task:${b}`]))
    expect(body.items.map((i) => i.id)).toContain("pr:jaubut/yes-dash#22")
    expect(frames.at(-1)).toMatchObject({ type: "orchestrator_triage", repos: expect.any(Array) })
  })

  test("Yes hands the parked PR back (pr:unpark, by manual, url from the park row); the held PR never moves; replay runs nothing twice", async () => {
    const { t21, t22, u21 } = await scene()
    const dash = (await get() as any).repos.find((c: any) => c.repo === "yes-dash")
    const members = [...dash.members.map((m: any) => ({ id: m.id, version: m.version })), { id: "pr:jaubut/yes-dash#22", version: "x" }]
    const r = await repoPost("yes-dash", "yes", { version: dash.version, members }, "repo-yes-1")
    expect(r.status).toBe(202)
    expect(r.json).toMatchObject({ ok: true, repo: "yes-dash", result: "running", skipped: [{ id: "pr:jaubut/yes-dash#22", reason: "held" }] })
    await harness.runner.idle()
    const rows = turso.query("SELECT agent_slug, target_kind, target_id, meta FROM agent_activity WHERE action = 'pr:unpark'").all() as Record<string, string>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ target_kind: "task", target_id: t21 })
    expect(JSON.parse(rows[0]!.meta!)).toMatchObject({ url: u21, by: "manual", via: "companion-repo-yes" })
    expect(turso.query("SELECT COUNT(*) AS n FROM agent_activity WHERE target_id = ? AND action = 'pr:unpark'").get(t22)).toEqual({ n: 0 })
    expect(turso.query("SELECT COUNT(*) AS n FROM agent_activity WHERE action = 'pr:approved-merge'").get()).toEqual({ n: 0 })
    expect(ghCalls.some((c) => c[1] === "merge")).toBe(false)
    const replay = await repoPost("yes-dash", "yes", { version: dash.version, members }, "repo-yes-1")
    expect(replay).toMatchObject({ status: 200, replayed: "true", json: { ok: true, result: "replay", runId: r.json.runId, run: { status: "done" } } })
    expect(turso.query("SELECT COUNT(*) AS n FROM agent_activity WHERE action = 'pr:unpark'").get()).toEqual({ n: 1 })
    const after = (await get() as any).repos.find((c: any) => c.repo === "yes-dash")
    expect(after.run).toMatchObject({ id: r.json.runId, decision: "yes", status: "done", results: [{ id: "pr:jaubut/yes-dash#21", result: "handed_back" }] })
    // The shared fixture (iOS decode test): a real frame with a repo card that carries a finished run.
    const frame = frames.at(-1) as Record<string, any>
    expect(frame.repos.find((c: any) => c.repo === "yes-dash").run).toMatchObject({ status: "done" })
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(fixturePath, `${JSON.stringify(frame, null, 2)}\n`)
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>
    expect(shapeOf(fixture)).toEqual(shapeOf(frame))
  })

  test("Yes with a tampered member version: that id is skipped as changed; the proposal it named is untouched", async () => {
    const { p, b } = await scene()
    const other = (await get() as any).repos.find((c: any) => c.id === "repo:_other")
    const own = new Set([`proposal:${p.taskId}`, `task:${b}`])
    const members = other.members.filter((m: any) => own.has(m.id)).map((m: any) => ({ id: m.id, version: m.id.startsWith("proposal:") ? "tampered" : m.version }))
    const r = await repoPost("_other", "yes", { version: other.version, members }, "repo-yes-2")
    expect(r.status).toBe(202)
    expect(r.json.skipped).toEqual([{ id: `proposal:${p.taskId}`, reason: "changed" }])
    await harness.runner.idle()
    expect(chat.getTask(p.taskId)!.status).toBe("proposed")
  })

  test("validation: 422 note_required, 404 no_such_repo, 400 for bad members / JSON", async () => {
    await scene()
    const dash = (await get() as any).repos.find((c: any) => c.repo === "yes-dash")
    expect((await repoPost("yes-dash", "no", { version: dash.version })).json).toMatchObject({ ok: false, error: "note_required" })
    expect((await repoPost("yes-dash", "no", { version: dash.version, note: "   " })).status).toBe(422)
    expect((await repoPost("yes-dash", "no", { version: dash.version, note: "x".repeat(2001) })).status).toBe(400)
    expect((await repoPost("nope-repo", "yes", { version: "v", members: [{ id: "task:x", version: "1" }] })).status).toBe(404)
    expect((await repoPost("yes-dash", "yes", { version: dash.version, members: "all" })).status).toBe(400)
    expect((await repoPost("yes-dash", "yes", { version: dash.version, members: Array.from({ length: 101 }, (_, i) => ({ id: `task:${i}`, version: "1" })) })).status).toBe(400)
    expect((await repoPost("yes-dash", "yes", "{not json")).status).toBe(400)
  })
})

/** The fixture's structure (keys + value types, arrays by their first element): values may differ run to run. */
function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [v.map(shapeOf).reduce(mergeShape)] : []
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]))
  return v === null ? "null" : typeof v
}

/** Union of two element shapes (keys merged; differing leaf types joined): an array's elements differ in optional keys. */
function mergeShape(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return a.length && b.length ? [mergeShape(a[0], b[0])] : a.length ? a : b
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()
    return Object.fromEntries(keys.map((k) => [k, k in ao && k in bo ? mergeShape(ao[k], bo[k]) : (ao[k] ?? bo[k])]))
  }
  return [...new Set([...String(a).split("|"), ...String(b).split("|")])].sort().join("|")
}
