import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BodyResponse, BodySnapshot } from "../lib/body"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import { TursoUnreachable } from "../lib/turso"

// orchestrator-one-queue P2 (write path) + P3 (#Body triage), route level.
// Real Companion sqlite (isolated COMPANION_DB_PATH); "Turso" is an in-memory
// bun:sqlite with the production tasks / notes / agent_activity columns, behind
// the QueryFn / ExecFn seams — so INSERT OR IGNORE, guarded UPDATEs and affected
// row counts behave as on libSQL. Temp HOME holds the agent allowlist.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-orch-write-")), "test.db")

const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-orch-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
for (const a of ["builder", "researcher"]) writeFileSync(join(tempHome, ".claude", "agents", `${a}.md`), "---\n---\n")

let routes: typeof import("./orchestrator")
let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let orch: typeof import("../wiring/orchestrator")
let sqlite: typeof import("../lib/orchestrator-db")["db"]

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

let down = false
let inserts = 0
// Runs right before the Companion's guarded UPDATE: simulates another writer.
let beforeUpdate: (() => void) | null = null

const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (down) throw new TursoUnreachable("network")
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  if (/^\s*UPDATE tasks/i.test(sql) && beforeUpdate) { const f = beforeUpdate; beforeUpdate = null; f() }
  if (/^\s*INSERT OR IGNORE INTO tasks/i.test(sql)) inserts++
  const res = turso.query(sql).run(...args)
  return { rows: [], affected: res.changes }
}
const query: QueryFn = async (sql, args) => (await exec(sql, args)).rows

const tursoTask = (id: string) => turso.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any> | null
const activity = (id: string) => turso.query("SELECT * FROM agent_activity WHERE target_id = ? ORDER BY id").all(id) as Record<string, any>[]

function seedTask(id: string, over: Record<string, SqlArg> = {}): void {
  const row: Record<string, SqlArg> = {
    id, note_id: "projects/dash", text: "Fix tax rounding", description: "spec", assignee: "agent:builder",
    dispatch_status: "queued", done: 0, ...over,
  }
  const cols = Object.keys(row)
  turso.query(`INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]!))
}

// What dispatch.sh does with DISPATCH_FROM: a guarded transition by another writer.
function otherWriter(id: string, to: string, from: string[], extra = ""): number {
  return turso.query(
    `UPDATE tasks SET dispatch_status = ?, updated_at = datetime('now')${extra} WHERE id = ? AND dispatch_status IN (${from.map(() => "?").join(", ")})`,
  ).run(to, id, ...from).changes
}

// ── harness ──────────────────────────────────────────────────────────────────

const body: BodyResponse = {
  ok: true, generated_at: "2026-10-03T12:00:00.000Z",
  summary: { ok: 38, failing: 1, dead: 1, crash_loop: 0, dormant: 2, stopped: 0, unknown: 1, total: 43 },
  components: [{
    id: "mac:launchd:backup", host: "mac", kind: "launchd", name: "backup", criticality: "critical", state: "dead",
    last_run_at: null, last_ok_at: null, last_exit: 1, consecutive_failures: 3, detail: "exit 1", depends_on: [], dependents_count: 0,
  }],
  recent_events: [],
}
const fakeBody: BodySnapshot = { get: async () => body }

function makeWiring() {
  const frames: Record<string, unknown>[] = []
  const w = poller.createDispatchWiring({
    query, exec,
    broadcast: (f) => frames.push(f),
    appendTurn: (text, taskId, channelId) => chat.appendTurn("orchestrator", text, taskId, channelId),
    push: () => {}, pushEnabled: () => false,
    linkedNotes: channels.linkedNotes, getChannel: channels.getChannel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    log: () => {}, mirror, generalChannel: "general",
  })
  return { w, frames, handler: routes.createOrchestratorHandler(w, { body: fakeBody }) }
}

type Handler = ReturnType<typeof routes.createOrchestratorHandler>

async function call(handler: Handler, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost${path}`, {
    method, headers, ...(payload === undefined ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
  })
  const res = await handler(req, new URL(req.url))
  return { status: res!.status, json: await res!.json() as Record<string, any> }
}

let seq = 0
const tid = () => (++seq).toString(16).padStart(32, "a")

beforeAll(async () => {
  process.env.HOME = tempHome
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  sqlite = (await import("../lib/orchestrator-db")).db
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  orch = await import("../wiring/orchestrator")
  routes = await import("./orchestrator")
})

afterAll(() => {
  // Shared test sqlite across test files: leave no #Body behind (body.test.ts expects to create it).
  sqlite.exec("DELETE FROM orchestrator_turns WHERE thread_id = 'body'")
  sqlite.exec("DELETE FROM orchestrator_tasks WHERE thread_id = 'body'")
  sqlite.exec("DELETE FROM orchestrator_channels WHERE id = 'body'")
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

beforeEach(() => {
  down = false
  inserts = 0
  beforeUpdate = null
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES (?, 'projects', 'TLS Dashboard', 'PRJ-WCLS', 'active')").run("projects/dash")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES (?, 'projects', 'Pelchat', 'PRJ-PELC', 'active')").run("projects/pel")
  sqlite.exec("DELETE FROM dispatch_seen")
  sqlite.exec("UPDATE orchestrator_channels SET note_id = NULL, note_title = NULL, note_ref = NULL, auto_dispatch = 0")
})

// ── approve → Turso ──────────────────────────────────────────────────────────

describe("POST /api/orchestrator/proposal/<id>/approve", () => {
  test("files one queued Turso task; a replay returns the same id and inserts nothing", async () => {
    const { handler, frames } = makeWiring()
    const ch = channels.createChannel("Approve A")
    channels.setChannelNote(ch.id, { noteId: "projects/dash", title: "TLS Dashboard", ref: "PRJ-WCLS" })
    const p = chat.createProposal("Fix the payload\nfull detail", "", "small fix", ch.id, { title: "Fix the payload" })

    const first = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`)
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ ok: true, taskId: p.taskId, status: "queued", replay: false })
    const id = first.json.dispatchTaskId as string
    expect(id).toMatch(/^[0-9a-f]{32}$/)

    const row = tursoTask(id)!
    expect(row).toMatchObject({ note_id: "projects/dash", text: "Fix the payload", assignee: "agent:builder", dispatch_status: "queued", done: 0 })
    expect(row.description).toContain("Fix the payload\nfull detail")
    expect(row.description).toContain(`proposal ${p.taskId}`)
    expect(activity(id)).toHaveLength(1)
    expect(activity(id)[0]).toMatchObject({ agent_slug: "builder", action: "dispatch:queued", target_kind: "task" })
    expect(JSON.parse(activity(id)[0]!.meta)).toMatchObject({ source: "companion", channel: ch.id, op: "file" })

    expect(chat.getTask(p.taskId)).toMatchObject({ status: "filed", dispatchTaskId: id, noteId: "projects/dash", agent: "builder" })
    expect(chat.listTasks(ch.id).map((t) => t.taskId)).not.toContain(p.taskId)
    expect(frames.some((f) => f.type === "orchestrator_task" && (f.task as { taskId: string }).taskId === id)).toBe(true)

    const again = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`)
    expect(again).toMatchObject({ status: 200, json: { ok: true, dispatchTaskId: id, replay: true } })
    expect(turso.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 })
    expect(inserts).toBe(1) // the replay never reached Turso
    expect(activity(id)).toHaveLength(1)
  })

  test("fileProposal twice, concurrently and after a Turso failure: still one row, same id", async () => {
    const { w } = makeWiring()
    const p = chat.createProposal("Do X", "", "why", "general", { noteId: "projects/dash" })
    down = true
    expect(await orch.fileProposal(p.taskId, {}, w)).toEqual({ ok: false, status: 503, error: "turso_unreachable" })
    const stamped = chat.getTask(p.taskId)!
    expect(stamped.status).toBe("proposed") // retryable, still on the phone
    expect(stamped.dispatchTaskId).toMatch(/^[0-9a-f]{32}$/)
    down = false
    const [a, b] = await Promise.all([orch.fileProposal(p.taskId, {}, w), orch.fileProposal(p.taskId, {}, w)])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.dispatchTaskId).toBe(stamped.dispatchTaskId!)
    expect(b.dispatchTaskId).toBe(stamped.dispatchTaskId!)
    expect(turso.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 })
    expect(activity(a.dispatchTaskId)).toHaveLength(1)
  })

  test("no project → 422 no_project; unknown agent → 400; brain-picked note wins over the channel's", async () => {
    const { handler } = makeWiring()
    const loose = chat.createProposal("Do Y", "", "why", "general")
    expect(await call(handler, "POST", `/api/orchestrator/proposal/${loose.taskId}/approve`)).toMatchObject({ status: 422, json: { error: "no_project" } })
    expect(chat.getTask(loose.taskId)!.status).toBe("proposed")
    expect(await call(handler, "POST", `/api/orchestrator/proposal/${loose.taskId}/approve`, { noteId: "projects/dash", agent: "nope" }))
      .toMatchObject({ status: 400, json: { error: "unknown_agent" } })
    const ok = await call(handler, "POST", `/api/orchestrator/proposal/${loose.taskId}/approve`, { noteId: "projects/pel", agent: "agent:researcher" })
    expect(ok.status).toBe(200)
    expect(tursoTask(ok.json.dispatchTaskId)).toMatchObject({ note_id: "projects/pel", assignee: "agent:researcher" })
  })

  test("reject stays local: no Turso row", async () => {
    const { handler } = makeWiring()
    const p = chat.createProposal("Nope", "", "why", "general", { noteId: "projects/dash" })
    expect((await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/reject`)).json).toMatchObject({ ok: true, status: "rejected" })
    expect(turso.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 })
    expect((await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`)).status).toBe(409)
  })
})

describe("auto-dispatch channel", () => {
  test("a brain proposal files straight to Turso, reasoning turn visible, card filed", async () => {
    const { w } = makeWiring()
    const ch = channels.createChannel("Auto A")
    channels.setChannelNote(ch.id, { noteId: "projects/dash", title: "TLS Dashboard", ref: "PRJ-WCLS" })
    const auto = channels.setChannelAuto(ch.id, true)!
    const projects = await w.projects(true)
    await orch.applyDecision(
      { kind: "proposal", cwd: "", prompt: "Bump the rate limit", reasoning: "user asked", noteId: "projects/dash", agent: "build", title: "Bump rate limit" },
      auto, projects, w,
    )
    const rows = turso.query("SELECT * FROM tasks").all() as Record<string, any>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ text: "Bump rate limit", assignee: "agent:builder", dispatch_status: "queued", note_id: "projects/dash" })
    const turns = chat.getThread(ch.id).map((t) => t.text)
    expect(turns.some((t) => t.startsWith("Auto-dispatch [") && t.includes("Why: user asked"))).toBe(true)
    expect(turns.some((t) => t.startsWith("filed ["))).toBe(true)
  })

  test("#Body never auto-files, and a hallucinated note is dropped", async () => {
    const { w } = makeWiring()
    const { ensureChannel } = channels
    const bodyCh = channels.setChannelAuto(ensureChannel("body", "Body").channel.id, true)!
    await orch.applyDecision(
      { kind: "proposal", cwd: "", prompt: "Restart backup", reasoning: "dead", noteId: "projects/made-up", agent: "builder", title: null },
      bodyCh, await w.projects(true), w,
    )
    expect(turso.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 })
    const p = chat.listTasks("body").find((t) => t.prompt === "Restart backup")!
    expect(p).toMatchObject({ status: "proposed", noteId: null })
    channels.setChannelAuto("body", false)
  })
})

// ── cancel / requeue / unblock ───────────────────────────────────────────────

describe("POST /api/orchestrator/task/<id>/cancel", () => {
  test("queued → cancelled (done=1), ledger row, frame + turn", async () => {
    const { handler, frames } = makeWiring()
    const id = tid()
    seedTask(id)
    const res = await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, taskId: id, status: "cancelled", task: { dispatchStatus: "cancelled", done: true } })
    expect(tursoTask(id)).toMatchObject({ dispatch_status: "cancelled", done: 1 })
    expect(tursoTask(id)!.dispatch_completed_at).not.toBeNull()
    expect(activity(id).map((a) => a.action)).toEqual(["dispatch:cancelled"])
    expect(JSON.parse(activity(id)[0]!.meta)).toMatchObject({ source: "companion", from: "queued" })
    expect(frames.some((f) => f.type === "orchestrator_task")).toBe(true)
    expect(chat.getThread("general", 1000).some((t) => t.taskId === id && t.text.startsWith("cancelled ["))).toBe(true)
  })

  test("running dispatch task → 409 naming the host, unchanged, no ledger", async () => {
    const { handler } = makeWiring()
    const id = tid()
    seedTask(id, { dispatch_status: "running", dispatch_owner: "zettlab" })
    const res = await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)
    expect(res).toMatchObject({ status: 409, json: { ok: false, error: "running_on_zettlab", owner: "zettlab", dispatchStatus: "running" } })
    expect(tursoTask(id)).toMatchObject({ dispatch_status: "running", done: 0 })
    expect(activity(id)).toHaveLength(0)
  })

  test("race: the runner claims and completes between our read and our write → 409, state unchanged, no ledger", async () => {
    const { handler } = makeWiring()
    const id = tid()
    seedTask(id)
    beforeUpdate = () => {
      expect(otherWriter(id, "running", ["queued"], ", dispatch_owner = 'mac'")).toBe(1)
      expect(otherWriter(id, "completed", ["running"])).toBe(1)
    }
    const res = await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)
    expect(res).toMatchObject({ status: 409, json: { ok: false, error: "conflict", dispatchStatus: "completed" } })
    expect(tursoTask(id)).toMatchObject({ dispatch_status: "completed", done: 0 })
    expect(activity(id)).toHaveLength(0)
  })

  test("race, other order: cancel lands first, the runner's guarded completion loses", async () => {
    const { handler } = makeWiring()
    const id = tid()
    seedTask(id, { dispatch_status: "blocked", dispatch_blocker: "?" })
    expect((await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)).status).toBe(200)
    expect(otherWriter(id, "completed", ["running"])).toBe(0) // DISPATCH_FROM=running → exit 3
    expect(tursoTask(id)).toMatchObject({ dispatch_status: "cancelled", done: 1 })
  })

  test("completed → 409 conflict; unknown → 404; Turso down → 503", async () => {
    const { handler } = makeWiring()
    const id = tid()
    seedTask(id, { dispatch_status: "completed" })
    expect(await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)).toMatchObject({ status: 409, json: { error: "conflict" } })
    expect((await call(handler, "POST", `/api/orchestrator/task/${tid()}/cancel`)).status).toBe(404)
    down = true
    expect(await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)).toEqual({ status: 503, json: { ok: false, error: "turso_unreachable" } })
  })

  test("a cancel in an auto channel flips auto off (the veto)", async () => {
    const { handler } = makeWiring()
    const ch = channels.createChannel("Veto A")
    channels.setChannelNote(ch.id, { noteId: "projects/dash", title: "TLS Dashboard", ref: null })
    channels.setChannelAuto(ch.id, true)
    const id = tid()
    seedTask(id)
    expect((await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)).status).toBe(200)
    expect(channels.getChannel(ch.id)!.autoDispatch).toBe(false)
  })
})

describe("requeue / unblock", () => {
  test("requeue: blocked|failed|cancelled|completed-not-done → queued with run fields cleared", async () => {
    const { handler } = makeWiring()
    for (const over of [
      { dispatch_status: "blocked", dispatch_blocker: "no repo" },
      { dispatch_status: "failed", dispatch_blocker: "crash" },
      { dispatch_status: "cancelled", done: 1 },
      { dispatch_status: "completed", dispatch_pr_url: "https://github.com/o/r/pull/1", dispatch_result_ref: "RES-1" },
    ] as Record<string, SqlArg>[]) {
      const id = tid()
      seedTask(id, { ...over, dispatch_owner: "mac", dispatch_run_id: "run_1", dispatch_started_at: "2026-10-03 10:00:00" })
      const res = await call(handler, "POST", `/api/orchestrator/task/${id}/requeue`)
      expect(res.status).toBe(200)
      expect(res.json.task).toMatchObject({ taskId: id, dispatchStatus: "queued", done: false })
      expect(tursoTask(id)).toMatchObject({
        dispatch_status: "queued", done: 0, dispatch_run_id: null, dispatch_started_at: null, dispatch_completed_at: null,
        dispatch_blocker: null, dispatch_owner: null, dispatch_result_ref: null, dispatch_pr_url: null,
      })
      expect(activity(id).map((a) => a.action)).toEqual(["dispatch:queued"])
    }
  })

  test("requeue refuses queued, running and completed-and-done", async () => {
    const { handler } = makeWiring()
    for (const over of [{ dispatch_status: "queued" }, { dispatch_status: "completed", done: 1 }] as Record<string, SqlArg>[]) {
      const id = tid()
      seedTask(id, over)
      expect(await call(handler, "POST", `/api/orchestrator/task/${id}/requeue`)).toMatchObject({ status: 409, json: { error: "conflict" } })
    }
    const running = tid()
    seedTask(running, { dispatch_status: "running", dispatch_owner: "mac" })
    expect((await call(handler, "POST", `/api/orchestrator/task/${running}/requeue`)).json.error).toBe("running_on_mac")
  })

  test("unblock appends the dated marker to description, then queued", async () => {
    const { handler } = makeWiring()
    const id = tid()
    seedTask(id, { dispatch_status: "blocked", dispatch_blocker: "which repo?", description: "Original spec" })
    const res = await call(handler, "POST", `/api/orchestrator/task/${id}/unblock`, { answer: "  use tls-dashboard-v2  " })
    expect(res.status).toBe(200)
    expect(res.json.task).toMatchObject({ dispatchStatus: "queued", blocker: null })
    const today = new Date().toISOString().slice(0, 10)
    expect(tursoTask(id)!.description).toBe(`Original spec\n\n[unblock ${today}] use tls-dashboard-v2`)
    expect(tursoTask(id)).toMatchObject({ dispatch_status: "queued", dispatch_blocker: null, done: 0 })
    expect(activity(id)[0]).toMatchObject({ action: "dispatch:queued" })
    expect(JSON.parse(activity(id)[0]!.meta)).toMatchObject({ op: "unblock", from: "blocked", source: "companion" })
    expect(chat.getThread("general", 1000).some((t) => t.taskId === id && t.text.includes("Answer: use tls-dashboard-v2"))).toBe(true)
  })

  test("unblock: not blocked → 409 and description untouched; empty / oversized answer → 400", async () => {
    const { handler } = makeWiring()
    const id = tid()
    seedTask(id, { dispatch_status: "failed", description: "keep" })
    expect(await call(handler, "POST", `/api/orchestrator/task/${id}/unblock`, { answer: "x" })).toMatchObject({ status: 409, json: { error: "conflict" } })
    expect(tursoTask(id)!.description).toBe("keep")
    expect((await call(handler, "POST", `/api/orchestrator/task/${id}/unblock`, { answer: " " })).status).toBe(400)
    expect((await call(handler, "POST", `/api/orchestrator/task/${id}/unblock`, { answer: "x".repeat(4001) })).status).toBe(400)
    expect((await call(handler, "POST", `/api/orchestrator/task/${id}/unblock`, "{")).status).toBe(400)
  })

  test("Idempotency-Key: a replayed unblock appends once", async () => {
    const { handler } = makeWiring()
    const id = tid()
    seedTask(id, { dispatch_status: "blocked", description: "" })
    const h = { "idempotency-key": `k-${id}` }
    expect((await call(handler, "POST", `/api/orchestrator/task/${id}/unblock`, { answer: "yes" }, h)).status).toBe(200)
    expect((await call(handler, "POST", `/api/orchestrator/task/${id}/unblock`, { answer: "yes" }, h)).status).toBe(200)
    expect((tursoTask(id)!.description as string).match(/\[unblock /g)).toHaveLength(1)
  })

  test("local tasks: requeue / unblock are refused, unknown action 400", async () => {
    const { handler } = makeWiring()
    const p = chat.createProposal("p", "/x", "why", "general")
    expect((await call(handler, "POST", `/api/orchestrator/task/${p.taskId}/requeue`)).status).toBe(409)
    expect((await call(handler, "POST", `/api/orchestrator/task/${p.taskId}/explode`)).status).toBe(400)
  })
})

// ── channels with noteId, /dispatch ──────────────────────────────────────────

describe("POST /api/orchestrator/channels {noteId}", () => {
  test("creates a linked channel; second one on the same note → 409; unknown note → 404", async () => {
    const { handler } = makeWiring()
    const res = await call(handler, "POST", "/api/orchestrator/channels", { name: "Pel", noteId: "projects/pel" })
    expect(res.status).toBe(200)
    expect(res.json.channel).toMatchObject({ name: "Pel", noteId: "projects/pel", noteTitle: "Pelchat", noteRef: "PRJ-PELC", counts: { queued: 0 } })
    expect(await call(handler, "POST", "/api/orchestrator/channels", { name: "Pel 2", noteId: "projects/pel" })).toMatchObject({ status: 409, json: { error: "note_linked_elsewhere" } })
    expect((await call(handler, "POST", "/api/orchestrator/channels", { name: "Nope", noteId: "projects/none" })).status).toBe(404)
    expect((await call(handler, "POST", "/api/orchestrator/channels", { name: "Bad", noteId: 3 })).status).toBe(400)
    expect((await call(handler, "POST", "/api/orchestrator/channels", { name: "Plain" })).json.channel).toMatchObject({ noteId: null })
  })
})

describe("POST /api/orchestrator/dispatch", () => {
  test("files to Turso under the given note; no note → 422", async () => {
    const { handler } = makeWiring()
    const res = await call(handler, "POST", "/api/orchestrator/dispatch", { prompt: "Add a test", noteId: "projects/dash" })
    expect(res).toMatchObject({ status: 200, json: { ok: true, status: "queued" } })
    expect(tursoTask(res.json.dispatchTaskId)).toMatchObject({ text: "Add a test", assignee: "agent:builder", dispatch_status: "queued" })
    expect((await call(handler, "POST", "/api/orchestrator/dispatch", { prompt: "x" })).status).toBe(422)
  })
})

// ── P3: #Body triage ─────────────────────────────────────────────────────────

describe("#Body triage", () => {
  test("brain context in #Body = body digest + the blocked queue across projects", async () => {
    const { w } = makeWiring()
    const a = tid()
    const b = tid()
    seedTask(a, { dispatch_status: "blocked", dispatch_blocker: "no repo mapped", text: "Fix rounding" })
    seedTask(b, { dispatch_status: "blocked", dispatch_blocker: "needs API key", text: "Wire Stripe", note_id: "projects/pel" })
    seedTask(tid(), { dispatch_status: "queued", text: "Queued one" })
    const ch = channels.createChannel("Dash only")
    channels.setChannelNote(ch.id, { noteId: "projects/dash", title: "TLS Dashboard", ref: null })
    await w.poll()
    const bodyCh = channels.ensureChannel("body", "Body").channel
    const ctx = (await orch.brainContext(bodyCh, "what's blocked?", w, fakeBody))!
    expect(ctx).toContain("Body monitor (as of 2026-10-03T12:00:00.000Z): 43 components")
    expect(ctx).toContain("mac:launchd:backup")
    expect(ctx).toContain("Dispatch queue (all projects): 1 queued · 0 running · 2 blocked · 0 PR open")
    expect(ctx).toContain(`[${a.slice(0, 8)}] builder — Fix rounding (TLS Dashboard): no repo mapped`)
    expect(ctx).toContain(`[${b.slice(0, 8)}] builder — Wire Stripe (Pelchat): needs API key`)

    // A project channel sees only its own queue, and no Body digest for a work question.
    const dash = (await orch.brainContext(channels.getChannel(ch.id)!, "what's next?", w, fakeBody))!
    expect(dash).not.toContain("Body monitor")
    expect(dash).toContain("Dispatch queue (#Dash only): 1 queued · 0 running · 1 blocked")
    expect(dash).not.toContain("Wire Stripe")
  })

  test("GET /thread?channel=body carries the vitals header; other channels do not", async () => {
    const { w, handler } = makeWiring()
    seedTask(tid(), { dispatch_status: "blocked", dispatch_blocker: "x" })
    await w.poll()
    channels.ensureChannel("body", "Body")
    const res = await call(handler, "GET", "/api/orchestrator/thread?channel=body")
    expect(res.json.vitals).toEqual({
      line: "43 components: 38 ok · 1 failing · 1 dead · 2 dormant · 1 unknown — 1 task blocked",
      summary: body.summary, worst: "dead", problems: 2, blockedTasks: 1, generatedAt: body.generated_at,
    })
    const dispatched = res.json.tasks.filter((t: { source: string }) => t.source === "dispatch")
    expect(dispatched.map((t: { dispatchStatus: string }) => t.dispatchStatus)).toEqual(["blocked"])
    expect("vitals" in (await call(handler, "GET", "/api/orchestrator/thread?channel=general")).json).toBe(false)
  })

  test("vitals is null when the Body read fails or is slow", async () => {
    const { w } = makeWiring()
    channels.ensureChannel("body", "Body")
    const failing = routes.createOrchestratorHandler(w, { body: { get: async () => { throw new TursoUnreachable("network") } } })
    expect((await call(failing, "GET", "/api/orchestrator/thread?channel=body")).json.vitals).toBeNull()
    const slow = routes.createOrchestratorHandler(w, { body: { get: () => new Promise(() => {}) }, vitalsTimeoutMs: 20 })
    expect((await call(slow, "GET", "/api/orchestrator/thread?channel=body")).json.vitals).toBeNull()
  })
})
