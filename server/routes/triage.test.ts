import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import type { LiveRunner } from "../wiring/live"
import type { Task } from "../lib/orchestrator-chat"
import type { SourceItem } from "../lib/triage"
import type { GhFn } from "../lib/triage-pr"
import type { ConsiderInput } from "../lib/body-investigate-engine"

// Triage, route level: the real wiring (guarded Turso writes, the proposal
// approve path incl. the Mac fix-card forward) behind GET / choose. Same harness
// as body-fix.test.ts: isolated COMPANION_DB_PATH (shared across route test
// files by Bun's module cache — fixtures here are disjoint: own channel, own
// ids), "Turso" = in-memory bun:sqlite, a fake tmux runner, a fake gh. The
// model returns null (deterministic fallback options) except for one task.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-triage-")), "companion.db")

const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-triage-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
writeFileSync(join(tempHome, ".claude", "agents", "builder.md"), "---\n---\n")
const dispatchRun = join(tempHome, "dispatch-run.ts")
writeFileSync(dispatchRun, "const REPO_MAP = []\n")
const fixCwd = mkdtempSync(join(tmpdir(), "cc-triage-fix-"))

let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let live: typeof import("../wiring/live")
let fix: typeof import("../wiring/body-fix")
let fixLib: typeof import("../lib/body-fix")
let triageWiring: typeof import("../wiring/triage")
let triageRoute: typeof import("./triage")
let invLib: typeof import("../lib/body-investigate")
let host: string
let sqlite: typeof import("../lib/orchestrator-db")["db"]
let fixStore: import("../lib/body-fix").BodyFixStore
let prevDeps: import("../wiring/body-fix").BodyFixDeps
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
const row = (id: string) => turso.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any>

let seq = 0
const hex = () => (++seq).toString(16).padStart(32, "c")
function turTask(status: string, blocker: string | null, over: Record<string, unknown> = {}): string {
  const id = hex()
  turso.query(
    "INSERT INTO tasks (id, note_id, text, description, assignee, dispatch_status, dispatch_blocker, dispatch_pr_url, done) VALUES (?, 'projects/dash', ?, 'Original brief', 'agent:builder', ?, ?, ?, ?)",
  ).run(id, String(over.text ?? `Task ${id.slice(-4)}`), status, blocker, (over.pr as string) ?? null, Number(over.done ?? 0))
  return id
}

// ── fakes ────────────────────────────────────────────────────────────────────

const spawns: { taskId: string; cwd: string }[] = []
const fakeRunner: LiveRunner = {
  async spawn(t: Task) {
    spawns.push({ taskId: t.taskId, cwd: t.cwd })
    chat.setTaskSpawn(t.taskId, `cc-fake-${t.taskId}`, null)
    return { ok: true }
  },
  async kill() {},
  async alive() { return true },
}

const peerCalls: Record<string, unknown>[] = []
const peerFetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  peerCalls.push(body)
  const req = fixLib.parseFixRequest(body)
  if ("error" in req) return Response.json({ ok: false, error: req.error }, { status: 400 })
  return fix.runBodyFix(req, harness.w, "mac")
}) as unknown as typeof fetch

let ghState = "OPEN"
/** `gh pr view --json mergeable,…` (merge intent); {} = GitHub reports nothing. */
let ghReady: Record<string, unknown> = {}
const ghCalls: string[][] = []
const gh: GhFn = async (args) => {
  ghCalls.push(args)
  if (args[1] === "view" && String(args[4]).startsWith("mergeable")) return { code: 0, stdout: JSON.stringify(ghReady), stderr: "" }
  if (args[1] === "view") return { code: 0, stdout: JSON.stringify({ state: ghState }), stderr: "" }
  if (args[1] === "merge") ghState = "MERGED"
  if (args[1] === "close") ghState = "CLOSED"
  return { code: 0, stdout: "", stderr: "" }
}

const considered: ConsiderInput[] = []
let invStore: import("../lib/body-investigate").InvestigationStore
let modelFor: Set<string>
const frames: Record<string, unknown>[] = []
// Source `mytask` (Jeremie's overdue tasks): a fake, empty unless a test fills it.
let mytaskItems: import("../lib/triage").SourceItem[] = []
const mytaskCalls: { refId: string; action: unknown }[] = []
const mytasks = {
  collect: async () => mytaskItems,
  current: async (src: import("../lib/triage").SourceItem) => mytaskItems.find((i) => i.refId === src.refId) ?? null,
  execute: async (src: import("../lib/triage").SourceItem, option: import("../lib/triage").TriageOption) => {
    mytaskCalls.push({ refId: src.refId, action: option.action })
    mytaskItems = []
    return { kind: "done" as const, detail: { op: option.action.kind === "approve" ? option.action.task : null } }
  },
}

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
    model: async (prompt) => {
      const hit = [...modelFor].find((id) => prompt.includes(`Task ${id.slice(-4)}`))
      if (!hit) return null
      return JSON.stringify({
        title: "Currency?", problem: "The export waits for a currency.", action: "Answer CAD.",
        options: [{ label: "Use CAD", action: { kind: "answer", text: "Use CAD." } }, { label: "Cancel", action: { kind: "cancel" } }],
      })
    },
    severity: async () => null,
    investigations: () => invStore,
    consider: async (input) => { considered.push(input); return { status: "started", id: "inv-new" } },
    body: { get: async () => ({ components: [] }) } as never,
    mytasks,
    broadcast: (f) => frames.push(f),
  })
  return { w, engine, handler: triageRoute.createTriageHandler(() => engine) }
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

async function choose(id: string, payload: Record<string, unknown>, key?: string) {
  const req = new Request(`http://localhost/api/orchestrator/triage/${encodeURIComponent(id)}/choose`, {
    method: "POST", body: JSON.stringify(payload), headers: key ? { "Idempotency-Key": key } : {},
  })
  const res = await harness.handler(req, new URL(req.url))
  return { status: res!.status, json: await res!.json() as Record<string, any>, replayed: res!.headers.get("Idempotent-Replayed") }
}

const opt = (item: any, kind: string) => item.options.find((o: any) => o.action.kind === kind).id as string
const itemOf = async (id: string) => (await get()).items.find((i) => i.id === id)

beforeAll(async () => {
  process.env.HOME = tempHome
  process.env.COMPANION_DISPATCH_RUN = dispatchRun
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  sqlite = (await import("../lib/orchestrator-db")).db
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  live = await import("../wiring/live")
  fix = await import("../wiring/body-fix")
  fixLib = await import("../lib/body-fix")
  invLib = await import("../lib/body-investigate")
  triageWiring = await import("../wiring/triage")
  triageRoute = await import("./triage")
  host = (await import("../state")).HOST_INFO.name
  fixStore = fixLib.createBodyFixStore(sqlite)
  live.setLiveRunner(fakeRunner)
  channelId = channels.createChannel("triage-test").id
  prevDeps = fix.setBodyFixDeps({ store: fixStore, localHost: () => "zettlab", peer: () => ({ base: "https://mac.test", token: "t" }), fetchFn: peerFetch })
})

afterAll(() => {
  fix.setBodyFixDeps(prevDeps)
  live.setLiveRunner(live.tmuxRunner)
  live.setLiveCap(null)
  sqlite.query("UPDATE orchestrator_tasks SET status = 'rejected' WHERE thread_id = ? AND status = 'proposed'").run(channelId)
  sqlite.exec("UPDATE orchestrator_tasks SET status = 'done' WHERE dispatch_task_id IS NOT NULL AND status IN ('dispatched', 'running')")
  delete process.env.COMPANION_DISPATCH_RUN
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

beforeEach(() => {
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES ('projects/dash', 'projects', 'Dashboard', 'PRJ-WCLS', 'active')").run()
  // Proposals left by an earlier case would show up again: close them.
  sqlite.query("UPDATE orchestrator_tasks SET status = 'rejected' WHERE thread_id = ? AND status = 'proposed'").run(channelId)
  spawns.length = 0
  peerCalls.length = 0
  ghCalls.length = 0
  considered.length = 0
  frames.length = 0
  ghState = "OPEN"
  ghReady = {}
  modelFor = new Set()
  invStore = invLib.createInvestigationStore(new Database(":memory:"))
  live.setLiveCap(chat.countLiveTasks() + 3)
  harness = makeHarness()
})

describe("GET /api/orchestrator/triage", () => {
  test("collects a blocked task, a failed-retryable task and a local proposal; ignores the rest", async () => {
    const b = turTask("blocked", "Which currency?")
    const f = turTask("failed", "claude exited 1")
    const q = turTask("queued", null)
    const p = chat.createProposal("Ship the export", "", "Jeremie asked", channelId, { noteId: "projects/dash" })
    await sync()
    const body = await get()
    const ids = body.items.map((i) => i.id)
    expect(ids).toContain(`task:${b}`)
    expect(ids).toContain(`task:${f}`)
    expect(ids).toContain(`proposal:${p.taskId}`)
    expect(ids).not.toContain(`task:${q}`)
    expect(typeof body.generatedAt).toBe("number")
    expect(frames.at(-1)).toMatchObject({ type: "orchestrator_triage" })
  })
})

describe("choose → the existing guarded paths", () => {
  test("answer (model option) unblocks: Turso row queued, answer appended to the brief, one ledger row", async () => {
    const id = turTask("blocked", "Which currency?")
    modelFor.add(id)
    await sync()
    const item = await itemOf(`task:${id}`)
    expect(item.title).toBe("Currency?")
    const r = await choose(item.id, { optionId: opt(item, "answer") })
    expect(r).toMatchObject({ status: 200, json: { ok: true, result: "done" } })
    expect(row(id)).toMatchObject({ dispatch_status: "queued", done: 0 })
    expect(row(id).description).toContain("] Use CAD.")
    expect(turso.query("SELECT action FROM agent_activity WHERE target_id = ?").all(id)).toEqual([{ action: "dispatch:queued" }])
    expect((await get()).items.find((i) => i.id === item.id)).toBeUndefined()
  })

  test("answer_custom: 422 without text, then unblocks with Jeremie's words", async () => {
    const id = turTask("blocked", "Which currency?")
    await sync()
    const item = await itemOf(`task:${id}`)
    expect((await choose(item.id, { optionId: opt(item, "answer_custom") })).status).toBe(422)
    expect(row(id).dispatch_status).toBe("blocked")
    const r = await choose(item.id, { optionId: opt(item, "answer_custom"), text: "USD for now" })
    expect(r.status).toBe(200)
    expect(row(id).description).toContain("] USD for now")
  })

  test("cancel and requeue go through the guarded writes", async () => {
    const b = turTask("blocked", "Stuck")
    const f = turTask("failed", "claude exited 1")
    await sync()
    expect((await choose(`task:${b}`, { optionId: opt(await itemOf(`task:${b}`), "cancel") })).status).toBe(200)
    expect(row(b)).toMatchObject({ dispatch_status: "cancelled", done: 1 })
    expect((await choose(`task:${f}`, { optionId: opt(await itemOf(`task:${f}`), "requeue") })).status).toBe(200)
    expect(row(f)).toMatchObject({ dispatch_status: "queued", dispatch_blocker: null })
  })

  test("409 stale when the Turso row moved after the item was shown; the item comes back refreshed", async () => {
    const id = turTask("blocked", "Old question?")
    await sync()
    const item = await itemOf(`task:${id}`)
    turso.query("UPDATE tasks SET dispatch_blocker = 'New question?', updated_at = '2030-01-01 00:00:00' WHERE id = ?").run(id)
    const r = await choose(item.id, { optionId: opt(item, "requeue") })
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ ok: false, error: "stale", next: { id: item.id, problem: "New question?" } })
    expect(row(id).dispatch_status).toBe("blocked")
  })

  test("Idempotency-Key: the repeat replays (header set) and the unblock runs once", async () => {
    const id = turTask("blocked", "Which currency?")
    await sync()
    const item = await itemOf(`task:${id}`)
    const payload = { optionId: opt(item, "answer_custom"), text: "CAD" }
    const a = await choose(item.id, payload, "idem-1")
    const b = await choose(item.id, payload, "idem-1")
    expect(a.json.result).toBe("done")
    expect(b).toMatchObject({ status: 200, replayed: "true", json: { ok: true, result: "replay" } })
    expect((row(id).description as string).match(/\[unblock/g)).toHaveLength(1)
  })

  test("approve a proposal files one queued Turso row; reject marks it rejected", async () => {
    const p = chat.createProposal("Build the CSV export", "", "asked", channelId, { noteId: "projects/dash", agent: "builder" })
    const r2 = chat.createProposal("Something else", "", "maybe", channelId, { noteId: "projects/dash" })
    await sync()
    const a = await choose(`proposal:${p.taskId}`, { optionId: opt(await itemOf(`proposal:${p.taskId}`), "approve") })
    expect(a).toMatchObject({ status: 200, json: { ok: true, detail: { status: "queued" } } })
    expect(chat.getTask(p.taskId)!.status).toBe("filed")
    const rows = turso.query("SELECT dispatch_status, assignee FROM tasks").all()
    expect(rows).toEqual([{ dispatch_status: "queued", assignee: "agent:builder" }])
    expect((await choose(`proposal:${r2.taskId}`, { optionId: opt(await itemOf(`proposal:${r2.taskId}`), "reject") })).status).toBe(200)
    expect(chat.getTask(r2.taskId)!.status).toBe("rejected")
  })

  test("a Mac fix card keeps its host routing: approve forwards to the Mac, which claims it live in the fix's cwd", async () => {
    const p = chat.createProposal("Fix the launchd job", fixCwd, "Body investigation", channelId, { noteId: "projects/dash", agent: "claude", title: "Fix mac:launchd:x" })
    fixStore.recordCard({ taskId: p.taskId, host: "mac", componentId: "mac:launchd:x", cwd: fixCwd, noteId: "projects/dash", agent: "claude", title: "Fix mac:launchd:x", investigationId: "inv1" }, Date.now())
    await sync()
    const item = await itemOf(`proposal:${p.taskId}`)
    expect(item.options[0].label).toBe("Run the fix on the Mac")
    const r = await choose(item.id, { optionId: opt(item, "approve") })
    expect(r).toMatchObject({ status: 200, json: { ok: true, detail: { host: "mac", mode: "live" } } })
    expect(peerCalls).toHaveLength(1)
    expect(peerCalls[0]).toMatchObject({ fixId: p.taskId, host: "mac", cwd: fixCwd })
    const rows = turso.query("SELECT dispatch_status, dispatch_owner FROM tasks").all()
    expect(rows).toEqual([{ dispatch_status: "running", dispatch_owner: `companion:${host}` }])
    expect(spawns.map((s) => s.cwd)).toEqual([fixCwd])
    expect(chat.getTask(p.taskId)!.status).toBe("filed")
  })

  test("a parked PR: merge by full URL, verified MERGED, task done; close leaves outcome:rejected", async () => {
    const m = turTask("completed", "⚠ review: CHANGES", { pr: "https://github.com/jaubut/x/pull/3" })
    const c = turTask("completed", null, { pr: "https://github.com/jaubut/x/pull/4" })
    for (const [id, n] of [[m, 3], [c, 4]] as const) {
      turso.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('shepherd', 'pr:needs-human', 'task', ?, ?)")
        .run(id, JSON.stringify({ reason: "touches auth", repo: "x", pr: n, url: `https://github.com/jaubut/x/pull/${n}` }))
    }
    await sync()
    const mi = await itemOf("pr:jaubut/x#3")
    expect(mi).toMatchObject({ source: "pr", refId: "jaubut/x#3", problem: "touches auth" })
    expect((await choose(mi.id, { optionId: opt(mi, "merge") })).status).toBe(200)
    expect(ghCalls).toContainEqual(["pr", "merge", "https://github.com/jaubut/x/pull/3", "--squash"])
    expect(row(m).done).toBe(1)
    ghState = "OPEN"
    const ci = await itemOf("pr:jaubut/x#4")
    expect((await choose(ci.id, { optionId: opt(ci, "close_pr") })).status).toBe(200)
    expect(turso.query("SELECT action FROM agent_activity WHERE target_id = ? AND action LIKE 'outcome:%'").all(c)).toEqual([{ action: "outcome:rejected" }])
    expect(await itemOf("pr:jaubut/x#4")).toBeUndefined()
  })

  test("merge intent (#164): a conflicting PR's card says so; Merge → 202 queued, approval row, card moves to the queued row", async () => {
    const url = "https://github.com/jaubut/dash/pull/164"
    // Own id (not hex()): the shared companion.db keys thread turns by task id across route test files.
    const id = "d164".padEnd(32, "d")
    turso.query("INSERT INTO tasks (id, note_id, text, assignee, dispatch_status, dispatch_pr_url) VALUES (?, 'projects/dash', ?, 'agent:builder', 'completed', ?)")
      .run(id, "Quotes out of the books: safe to merge", url)
    const park = () => turso.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', ?, ?)")
      .run(id, JSON.stringify({ reason: "touches src/lib/books — needs your review", repo: "dash", pr: 164, url }))
    park()
    ghReady = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", headRefOid: "feed164", statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] }
    await sync()
    const item = await itemOf("pr:jaubut/dash#164")
    expect(item.title).toBe("Quotes out of the books: merge after the conflict fix")
    expect(item.options.find((o: any) => o.action.kind === "merge").label).toBe("Approve — merge after the conflict fix")
    const res = await choose(item.id, { optionId: opt(item, "merge") }, "k-164")
    expect(res.status).toBe(202)
    expect(res.json).toMatchObject({ ok: true, id: item.id, result: "queued", detail: { state: "approved_pending", reason: "conflict" } })
    expect(ghCalls.some((c) => c[1] === "merge")).toBe(false)
    const approval = turso.query("SELECT target_kind, target_id, meta FROM agent_activity WHERE action = 'pr:approved-merge'").all() as Record<string, string>[]
    expect(approval).toHaveLength(1)
    expect(approval[0]).toMatchObject({ target_kind: "task", target_id: id })
    expect(JSON.parse(String(approval[0]?.meta))).toMatchObject({ repo: "dash", pr: 164, url, approvedHeadSha: "feed164", by: "jeremie", via: "triage" })
    expect(row(id).done).toBe(0)
    const body = await get() as unknown as { items: any[]; resolving: any[] }
    expect(body.items.find((i) => i.id === item.id)).toBeUndefined()
    const queued = body.resolving.find((r) => r.id === item.id)
    expect(queued).toMatchObject({ source: "pr", approval: { state: "approved_pending", reason: "conflict", approvedHeadSha: "feed164" }, resolver: { status: "queued" } })
    expect(queued.title.startsWith("Approved — merging once the conflict clears")).toBe(true)
    // A replay of the same tap answers from the stored choice; no second row.
    expect((await choose(item.id, { optionId: opt(item, "merge") }, "k-164")).json.result).toBe("replay")
    expect(turso.query("SELECT COUNT(*) AS n FROM agent_activity WHERE action = 'pr:approved-merge'").get()).toEqual({ n: 1 })
  })

  test("PR review cascade: the ' · Opus:' park reason reaches the card; a url-targeted pr:cascade row changes nothing", async () => {
    const url = "https://github.com/jaubut/x/pull/7"
    const id = turTask("completed", null, { pr: url })
    const reason = "touches src/lib/auth · Opus: session cookie flag dropped, check before merge"
    turso.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', ?, ?)")
      .run(id, JSON.stringify({ reason, repo: "x", pr: 7, url, cascade: { stage: "opus", verdict: "ESCALATE", model: "opus", confidence: 0.8, brief: "session cookie flag dropped, check before merge" } }))
    await sync()
    const before = await itemOf("pr:jaubut/x#7")
    expect(before).toMatchObject({ source: "pr", problem: reason })
    // The shepherd's cascade log is keyed by PR url (target_kind 'pr'): triage never reads it.
    turso.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('pr-shepherd', 'pr:cascade', 'pr', ?, ?)")
      .run(url, JSON.stringify({ stage: "sonnet", verdict: "APPROVE", model: "sonnet", confidence: 0.9 }))
    await sync()
    const after = await itemOf("pr:jaubut/x#7")
    expect(after).toMatchObject({ problem: before.problem, updatedAt: before.updatedAt, options: before.options })
  })

  test("48 h safety net: a task-targeted pr:hold (waiting on an infra task) suppresses it; no pr:* row at all still trips it", async () => {
    const held = turTask("completed", null, { pr: "https://github.com/jaubut/x/pull/8" })
    const quiet = turTask("completed", null, { pr: "https://github.com/jaubut/x/pull/9" })
    turso.query("UPDATE tasks SET updated_at = datetime('now', '-3 days') WHERE id IN (?, ?)").run(held, quiet)
    turso.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta, ts) VALUES ('pr-shepherd', 'pr:hold', 'task', ?, ?, datetime('now', '-3 days'))")
      .run(held, JSON.stringify({ url: "https://github.com/jaubut/x/pull/8", infra_task: "f".repeat(32), reason: "waits on the CI runner fix", host: "zettlab" }))
    await sync()
    expect(await itemOf("pr:jaubut/x#8")).toBeUndefined()
    expect(await itemOf("pr:jaubut/x#9")).toMatchObject({ source: "pr", problem: "Open for more than 2 days with no review activity." })
  })

  test("a Body component whose diagnosis failed twice: requeue forces a new investigation", async () => {
    for (let i = 0; i < 2; i++) {
      const r = invStore.insert({ componentId: "zettlab:svc:y", host: "zettlab", state: "dead", trigger: "sweep", status: "running", runOn: "local", attempt: i + 1 }, Date.now() - 1000 + i)
      invStore.update(r.id, { status: "failed", finishedAt: Date.now() - 1000 + i, error: "timed out" })
    }
    await sync()
    const item = await itemOf("body:zettlab:svc:y")
    expect(item.options.map((o: any) => o.action.kind)).toEqual(["requeue", "open_url", "snooze"])
    expect((await choose(item.id, { optionId: opt(item, "requeue") })).status).toBe(200)
    expect(considered).toEqual([{ componentId: "zettlab:svc:y", trigger: "manual", force: true }])
  })

  test("404 for an unknown id", async () => {
    await sync()
    expect((await choose("task:nope", { optionId: "a" })).status).toBe(404)
  })
})

describe("source mytask (Jeremie's overdue tasks)", () => {
  test("deterministic batch card, no Ask Opus; choose runs the task op, not the proposal path", async () => {
    const { overdueItems } = await import("../lib/mytask-triage")
    const row = (id: string, due: string) => ({
      id, noteId: "projects/p1", parentId: null, text: `post ${id}`, description: null, due, position: 0,
      noteTitle: "Cage au Sport", noteRef: null, noteFolder: "projects",
    })
    mytaskItems = overdueItems([row("a", "2026-05-01"), row("b", "2026-05-02"), row("c", "2026-05-03")], "2026-10-06", Date.parse("2026-10-06T15:00:00Z"))
    await sync()
    const item = await itemOf("mytask:p:projects/p1")
    expect(item.title).toBe("3 overdue tasks in Cage au Sport")
    expect(item.severity).toBe("low")
    expect(item.options.map((o: any) => o.label)).toEqual(["Drop the date", "Move to next week", "Mark all done", "Snooze for a day"])
    expect(item.options.some((o: any) => o.action.kind === "ask_opus")).toBe(false)
    const r = await choose(item.id, { optionId: item.recommended })
    expect(r.status).toBe(200)
    expect(mytaskCalls).toEqual([{ refId: "p:projects/p1", action: { kind: "approve", task: "undate" } }])
    await sync()
    expect(await itemOf("mytask:p:projects/p1")).toBeUndefined()
  })
})
