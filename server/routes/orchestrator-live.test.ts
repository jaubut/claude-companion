import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import { TursoUnreachable } from "../lib/turso"
import type { LiveRunner } from "../wiring/live"
import type { Task } from "../lib/orchestrator-chat"

// orchestrator-one-queue P4 (live mode), route level. Same harness as
// orchestrator-write.test.ts: real Companion sqlite (isolated COMPANION_DB_PATH),
// "Turso" = in-memory bun:sqlite behind the QueryFn / ExecFn seams, and a fake
// tmux runner (setLiveRunner) so nothing spawns or kills real tmux.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-orch-live-")), "test.db")

const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-orch-live-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
writeFileSync(join(tempHome, ".claude", "agents", "builder.md"), "---\n---\n")
const repoDir = mkdtempSync(join(tmpdir(), "cc-orch-live-repo-"))

let routes: typeof import("./orchestrator")
let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let live: typeof import("../wiring/live")
let tasks: typeof import("../lib/dispatch-tasks")
let host: string
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

const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (down) throw new TursoUnreachable("network")
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  if (/^\s*INSERT OR IGNORE INTO tasks/i.test(sql)) inserts++
  const res = turso.query(sql).run(...args)
  return { rows: [], affected: res.changes }
}
const query: QueryFn = async (sql, args) => (await exec(sql, args)).rows

const tursoTask = (id: string) => turso.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any> | null
const tursoCount = () => (turso.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n
const activity = (id: string) => turso.query("SELECT * FROM agent_activity WHERE target_id = ? ORDER BY id").all(id) as Record<string, any>[]

function seedRunning(id: string, owner: string): void {
  turso.query(
    "INSERT INTO tasks (id, note_id, text, assignee, dispatch_status, dispatch_owner, dispatch_started_at, done) VALUES (?, 'projects/dash', 'Live job', 'agent:builder', 'running', ?, datetime('now'), 0)",
  ).run(id, owner)
}

// ── fake runner ──────────────────────────────────────────────────────────────

const spawns: string[] = []
const kills: string[] = []
const alive = new Set<string>()
let spawnError: string | null = null

const fakeRunner: LiveRunner = {
  async spawn(t: Task) {
    spawns.push(t.taskId)
    await new Promise((r) => setTimeout(r, 5)) // a real spawn awaits tmux
    if (spawnError) return { ok: false, error: spawnError }
    chat.setTaskSpawn(t.taskId, `cc-fake-${t.taskId}`, null)
    return { ok: true }
  },
  async kill(t: Task) { kills.push(t.taskId) },
  async alive(t: Task) { return alive.has(t.taskId) },
}

// ── harness ──────────────────────────────────────────────────────────────────

function makeWiring() {
  const frames: Record<string, unknown>[] = []
  const w = poller.createDispatchWiring({
    query, exec,
    broadcast: (f) => frames.push(f),
    appendTurn: (text, taskId, channelId) => chat.appendTurn("orchestrator", text, taskId, channelId),
    push: () => {}, pushEnabled: () => false,
    linkedNotes: channels.linkedNotes, getChannel: channels.getChannel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    liveIdentity: (id) => {
      const t = chat.getTaskByDispatchId(id)
      return t ? { localTaskId: t.taskId, tmuxSession: t.tmuxSession, tmuxSocket: t.tmuxSocket ?? null, sessionKey: t.sessionKey, logTail: t.logTail } : null
    },
    log: () => {}, mirror, generalChannel: "general",
  })
  return { w, frames, handler: routes.createOrchestratorHandler(w) }
}

type Handler = ReturnType<typeof routes.createOrchestratorHandler>

async function call(handler: Handler, method: string, path: string, payload?: unknown) {
  const req = new Request(`http://localhost${path}`, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
  const res = await handler(req, new URL(req.url))
  return { status: res!.status, json: await res!.json() as Record<string, any> }
}

let seq = 0
const tid = () => (++seq).toString(16).padStart(32, "b")
let chSeq = 0

function linkedProposal(prompt = "Ship the live fix") {
  // One channel per note: the newest test channel takes the link.
  sqlite.exec("UPDATE orchestrator_channels SET note_id = NULL, note_title = NULL, note_ref = NULL")
  const ch = channels.createChannel(`Live ${++chSeq}`)
  channels.setChannelNote(ch.id, { noteId: "projects/dash", title: "TLS Dashboard", ref: "PRJ-WCLS" })
  return { ch, p: chat.createProposal(prompt, repoDir, "because", ch.id, { title: prompt }) }
}

/** Room for exactly `n` more live workers, whatever other test files left behind. */
const roomFor = (n: number) => live.setLiveCap(chat.countLiveTasks() + n)

beforeAll(async () => {
  process.env.HOME = tempHome
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  sqlite = (await import("../lib/orchestrator-db")).db
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  tasks = await import("../lib/dispatch-tasks")
  live = await import("../wiring/live")
  routes = await import("./orchestrator")
  host = (await import("../state")).HOST_INFO.name
  live.setLiveRunner(fakeRunner)
})

afterAll(() => {
  live.setLiveRunner(live.tmuxRunner)
  live.setLiveCap(null)
  // Leave no live worker rows for other files' WIP counts.
  sqlite.exec("UPDATE orchestrator_tasks SET status = 'done' WHERE dispatch_task_id IS NOT NULL AND status IN ('dispatched', 'running')")
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

beforeEach(() => {
  down = false
  inserts = 0
  spawnError = null
  spawns.length = 0
  kills.length = 0
  alive.clear()
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES (?, 'projects', 'TLS Dashboard', 'PRJ-WCLS', 'active')").run("projects/dash")
  sqlite.exec("DELETE FROM dispatch_seen")
  sqlite.exec("UPDATE orchestrator_channels SET note_id = NULL, note_title = NULL, note_ref = NULL, auto_dispatch = 0")
  roomFor(3)
})

// ── approve / dispatch live ──────────────────────────────────────────────────

describe("approve {mode:'live'}", () => {
  test("claims one running Turso row owned by this host, spawns one worker; replays reuse both", async () => {
    const { handler } = makeWiring()
    const { ch, p } = linkedProposal()
    const [a, b] = await Promise.all([
      call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" }),
      call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" }),
    ])
    const again = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" })
    for (const r of [a, b, again]) expect(r.status).toBe(200)
    const id = a.json.dispatchTaskId as string
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    for (const r of [a, b, again]) expect(r.json).toMatchObject({ ok: true, taskId: p.taskId, dispatchTaskId: id, status: "running", mode: "live" })
    expect([a.json.replay, b.json.replay, again.json.replay].filter((x) => x === false)).toHaveLength(1)

    expect(spawns).toEqual([p.taskId])
    expect(tursoCount()).toBe(1)
    expect(tursoTask(id)).toMatchObject({ dispatch_status: "running", dispatch_owner: `companion:${host}`, assignee: "agent:builder", note_id: "projects/dash", done: 0 })
    expect(tursoTask(id)!.dispatch_started_at).toBeTruthy()
    const ledger = activity(id)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.action).toBe("dispatch:running")
    expect(JSON.parse(ledger[0]!.meta)).toMatchObject({ source: "companion", host, channel: ch.id, mode: "live" })

    const local = chat.getTask(p.taskId)!
    expect(local).toMatchObject({ status: "dispatched", dispatchTaskId: id, tmuxSession: `cc-fake-${p.taskId}`, cwd: repoDir })
  })

  test("over the WIP cap → 429 live_cap and nothing filed", async () => {
    const { handler } = makeWiring()
    const { p } = linkedProposal()
    roomFor(0)
    const r = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" })
    expect(r.status).toBe(429)
    expect(r.json).toMatchObject({ ok: false, error: "live_cap" })
    expect(tursoCount()).toBe(0)
    expect(spawns).toHaveLength(0)
    expect(chat.getTask(p.taskId)).toMatchObject({ status: "proposed", dispatchTaskId: null })
  })

  test("no usable cwd → 422 no_cwd, nothing filed; the cap is headless-blind", async () => {
    const { handler } = makeWiring()
    const ch = channels.createChannel(`Live ${++chSeq}`)
    channels.setChannelNote(ch.id, { noteId: "projects/dash", title: "TLS Dashboard", ref: "PRJ-WCLS" })
    const p = chat.createProposal("no dir", "", "x", ch.id)
    process.env.COMPANION_DISPATCH_RUN = join(tempHome, "missing-dispatch-run.ts")
    try {
      const r = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" })
      expect(r.status).toBe(422)
      expect(r.json.error).toBe("no_cwd")
      const bad = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live", cwd: join(repoDir, "nope") })
      expect(bad.json.error).toBe("no_cwd")
    } finally {
      delete process.env.COMPANION_DISPATCH_RUN
    }
    expect(tursoCount()).toBe(0)
    // Headless approve ignores the live cap.
    roomFor(0)
    const headless = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`)
    expect(headless.status).toBe(200)
    expect(headless.json.status).toBe("queued")
  })

  test("spawn failure → 500, the claimed row goes failed with the reason", async () => {
    const { handler } = makeWiring()
    const { p } = linkedProposal()
    spawnError = "tmux not found"
    const r = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" })
    expect(r.status).toBe(500)
    const id = r.json.dispatchTaskId as string
    expect(tursoTask(id)).toMatchObject({ dispatch_status: "failed" })
    expect(tursoTask(id)!.dispatch_blocker).toContain("tmux not found")
    expect(chat.getTask(p.taskId)!.status).toBe("error")
  })

  test("Turso down → 503 and the proposal stays proposed (retryable)", async () => {
    const { handler } = makeWiring()
    const { p } = linkedProposal()
    down = true
    const r = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" })
    expect(r.status).toBe(503)
    expect(spawns).toHaveLength(0)
    expect(chat.getTask(p.taskId)!.status).toBe("proposed")
  })
})

describe("POST /api/orchestrator/dispatch {mode:'live'}", () => {
  test("claims + spawns; no project → 422", async () => {
    const { handler } = makeWiring()
    const ch = channels.createChannel(`Live ${++chSeq}`)
    const none = await call(handler, "POST", "/api/orchestrator/dispatch", { prompt: "x", channel: ch.id, mode: "live", cwd: repoDir })
    expect(none.status).toBe(422)
    expect(none.json.error).toBe("no_project")
    const r = await call(handler, "POST", "/api/orchestrator/dispatch", { prompt: "Do it live", channel: ch.id, noteId: "projects/dash", mode: "live", cwd: repoDir })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, status: "running", mode: "live", replay: false })
    expect(tursoTask(r.json.dispatchTaskId)).toMatchObject({ dispatch_status: "running", dispatch_owner: `companion:${host}`, text: "Do it live" })
    expect(spawns).toEqual([r.json.taskId])
  })
})

// ── finishLive ───────────────────────────────────────────────────────────────

async function startLive(handler: Handler) {
  const { p } = linkedProposal()
  const r = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" })
  expect(r.status).toBe(200)
  return { local: chat.getTask(p.taskId)!, id: r.json.dispatchTaskId as string }
}

describe("finishLive (stop hook)", () => {
  test("twice → one transition and one ledger row; the PR URL and result ref are kept", async () => {
    const { w, handler } = makeWiring()
    const { local, id } = await startLive(handler)
    const msg = "Done. Result note RES-AB12. PR: https://github.com/jaubut/claude-companion/pull/104"
    const first = await live.finishLiveFromStop(local, msg, w)
    const second = await live.finishLiveFromStop(local, msg, w)
    expect(first?.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, error: "conflict" })
    expect(tursoTask(id)).toMatchObject({
      dispatch_status: "completed", dispatch_pr_url: "https://github.com/jaubut/claude-companion/pull/104", dispatch_result_ref: "RES-AB12",
    })
    const ledger = activity(id).map((a) => a.action)
    expect(ledger).toEqual(["dispatch:running", "dispatch:completed"])
    expect(JSON.parse(activity(id)[1]!.meta)).toMatchObject({ mode: "live", pr: "https://github.com/jaubut/claude-companion/pull/104" })
  })

  test("on a cancelled row → no-op, no ledger row", async () => {
    const { w, handler } = makeWiring()
    const { local, id } = await startLive(handler)
    const c = await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)
    expect(c.status).toBe(200)
    const out = await live.finishLiveFromStop(local, "all done", w)
    expect(out).toMatchObject({ ok: false, error: "conflict" })
    expect(tursoTask(id)).toMatchObject({ dispatch_status: "cancelled", done: 1 })
    expect(activity(id).map((a) => a.action)).toEqual(["dispatch:running", "dispatch:cancelled"])
  })

  test("a row owned by another host is never finished from here", async () => {
    const ctx = { exec, cols: { prUrl: true, resultRef: true }, host, channel: null }
    const id = tid()
    seedRunning(id, "companion:other-host")
    expect(await tasks.finishLive(ctx, id, { status: "completed" })).toMatchObject({ ok: false, error: "conflict" })
    expect(tursoTask(id)!.dispatch_status).toBe("running")
    expect(activity(id)).toHaveLength(0)
  })
})

// ── cancel ───────────────────────────────────────────────────────────────────

describe("cancel a live task", () => {
  test("owned here (by Turso id or local id) → worker killed, cancelled, done=1", async () => {
    const { handler } = makeWiring()
    const a = await startLive(handler)
    const r = await call(handler, "POST", `/api/orchestrator/task/${a.id}/cancel`)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, status: "cancelled", dispatchTaskId: a.id, taskId: a.local.taskId })
    expect(kills).toEqual([a.local.taskId])
    expect(tursoTask(a.id)).toMatchObject({ dispatch_status: "cancelled", done: 1 })
    expect(chat.getTask(a.local.taskId)!.status).toBe("cancelled")

    const b = await startLive(handler)
    const viaLocal = await call(handler, "POST", `/api/orchestrator/task/${b.local.taskId}/cancel`)
    expect(viaLocal.status).toBe(200)
    expect(kills).toEqual([a.local.taskId, b.local.taskId])
    expect(tursoTask(b.id)).toMatchObject({ dispatch_status: "cancelled", done: 1 })
  })

  test("owned by another host → 409 running_on_<owner>, nothing killed", async () => {
    const { handler } = makeWiring()
    const id = tid()
    seedRunning(id, "companion:other-host")
    const r = await call(handler, "POST", `/api/orchestrator/task/${id}/cancel`)
    expect(r.status).toBe(409)
    expect(r.json.error).toBe("running_on_companion:other-host")
    expect(kills).toHaveLength(0)
    expect(tursoTask(id)!.dispatch_status).toBe("running")
  })
})

// ── boot reconcile ───────────────────────────────────────────────────────────

describe("boot reconcile", () => {
  test("orphan live rows owned here → failed; live workers, other hosts and headless rows untouched", async () => {
    const { w, handler } = makeWiring()
    const kept = await startLive(handler)
    alive.add(kept.local.taskId)
    const lost = await startLive(handler) // local row, but its tmux worker is gone
    const noLocal = tid()
    seedRunning(noLocal, `companion:${host}`)
    const other = tid()
    seedRunning(other, "companion:other-host")
    const headless = tid()
    seedRunning(headless, "zettlab")

    const closed = await live.reconcileLiveOnBoot(w, host)
    expect(closed).toBe(2)
    expect(tursoTask(kept.id)!.dispatch_status).toBe("running")
    for (const id of [lost.id, noLocal]) {
      expect(tursoTask(id)).toMatchObject({ dispatch_status: "failed", dispatch_blocker: live.WORKER_LOST })
    }
    expect(chat.getTask(lost.local.taskId)!.status).toBe("error")
    expect(tursoTask(other)!.dispatch_status).toBe("running")
    expect(tursoTask(headless)!.dispatch_status).toBe("running")
    expect(activity(other)).toHaveLength(0)
    // Idempotent: a second pass finds nothing to close.
    expect(await live.reconcileLiveOnBoot(w, host)).toBe(0)
  })
})

// ── DTO ──────────────────────────────────────────────────────────────────────

describe("live task DTO", () => {
  test("the Turso row is listed once with mode live and the tmux identity; the local row is not listed", async () => {
    const { w, handler, frames } = makeWiring()
    const { p, ch } = linkedProposal()
    const r = await call(handler, "POST", `/api/orchestrator/proposal/${p.taskId}/approve`, { mode: "live" })
    const id = r.json.dispatchTaskId as string
    await w.poll()
    const thread = await call(handler, "GET", `/api/orchestrator/thread?channel=${ch.id}`)
    const listed = (thread.json.tasks as Record<string, any>[]).filter((t) => t.taskId === id || t.taskId === p.taskId)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      taskId: id, source: "dispatch", mode: "live", dispatchStatus: "running", status: "running",
      owner: `companion:${host}`, tmuxSession: `cc-fake-${p.taskId}`, localTaskId: p.taskId,
    })
    const frame = frames.filter((f) => f.type === "orchestrator_task").map((f) => f.task as Record<string, any>).find((t) => t.taskId === id)
    expect(frame).toMatchObject({ mode: "live", localTaskId: p.taskId })
    // The local row on the wire reads `filed` (the proposal card leaves).
    expect(tasks.toTaskDto(chat.getTask(p.taskId)!)).toMatchObject({ status: "filed", dispatchTaskId: id, mode: "live" })
  })
})
