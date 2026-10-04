import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import type { LiveRunner } from "../wiring/live"
import type { Task } from "../lib/orchestrator-chat"

// Mac body fixes run LIVE ON THE MAC — route level. Same harness as
// orchestrator-live.test.ts: real Companion sqlite (isolated COMPANION_DB_PATH),
// "Turso" = in-memory bun:sqlite behind the QueryFn / ExecFn seams, a fake tmux
// runner. One process plays both hosts: the approve route runs as Zettlab and
// the fake peer fetch calls the Mac side (runBodyFix with local "mac").

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-body-fix-")), "test.db")

const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-body-fix-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
writeFileSync(join(tempHome, ".claude", "agents", "builder.md"), "---\n---\n")
// The note's mapped repo (what live mode would pick from the note) — the fix must NOT run there.
const mappedRepo = join(tempHome, "mapped-repo")
mkdirSync(mappedRepo, { recursive: true })
const dispatchRun = join(tempHome, "dispatch-run.ts")
writeFileSync(dispatchRun, "const REPO_MAP = [\n  { match: /dash|PRJ-WCLS|orchestrator/i, path: `${HOME}/mapped-repo` },\n]\n")
const fixCwd = mkdtempSync(join(tmpdir(), "cc-body-fix-cwd-"))

let routes: typeof import("./orchestrator")
let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let live: typeof import("../wiring/live")
let fix: typeof import("../wiring/body-fix")
let fixLib: typeof import("../lib/body-fix")
let host: string
let sqlite: typeof import("../lib/orchestrator-db")["db"]
let store: import("../lib/body-fix").BodyFixStore
let prevDeps: import("../wiring/body-fix").BodyFixDeps

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
let inserts = 0
const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  if (/^\s*INSERT OR IGNORE INTO tasks/i.test(sql)) inserts++
  const res = turso.query(sql).run(...args)
  return { rows: [], affected: res.changes }
}
const query: QueryFn = async (sql, args) => (await exec(sql, args)).rows
const tursoRows = () => turso.query("SELECT * FROM tasks").all() as Record<string, any>[]

// ── fake runner (records the cwd each worker would start in) ─────────────────

const spawns: { taskId: string; cwd: string }[] = []
const fakeRunner: LiveRunner = {
  async spawn(t: Task) {
    spawns.push({ taskId: t.taskId, cwd: t.cwd })
    await new Promise((r) => setTimeout(r, 5))
    chat.setTaskSpawn(t.taskId, `cc-fake-${t.taskId}`, null)
    return { ok: true }
  },
  async kill() {},
  async alive() { return true },
}

// ── fake peer: the "Mac" side, in-process ────────────────────────────────────

let macDown = false
const peerCalls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
let wiring: ReturnType<typeof makeWiring>

const peerFetch = (async (url: string, init: RequestInit) => {
  if (macDown) throw new TypeError("fetch failed")
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  peerCalls.push({ url, headers: init.headers as Record<string, string>, body })
  const req = fixLib.parseFixRequest(body)
  if ("error" in req) return Response.json({ ok: false, error: req.error }, { status: 400 })
  return fix.runBodyFix(req, wiring.w, "mac")
}) as unknown as typeof fetch

function makeWiring() {
  const w = poller.createDispatchWiring({
    query, exec,
    broadcast: () => {},
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
  return { w, handler: routes.createOrchestratorHandler(w) }
}

async function approve(taskId: string, payload: unknown = {}) {
  const req = new Request(`http://localhost/api/orchestrator/proposal/${taskId}/approve`, { method: "POST", body: JSON.stringify(payload) })
  const res = await wiring.handler(req, new URL(req.url))
  return { status: res!.status, json: await res!.json() as Record<string, any> }
}

let seq = 0
/** A #Body card for a fix, as the report applier makes it (Zettlab side). */
function card(componentHost: "mac" | "zettlab" = "mac") {
  channels.ensureChannel("body", "Body")
  const componentId = `${componentHost}:launchd:job${++seq}`
  const title = `Fix ${componentId}: restore it`
  const p = chat.createProposal("Fix it.\nRun on host: mac", fixCwd, "Body investigation inv: x", "body", { noteId: "projects/dash", agent: "claude", title })
  if (componentHost === "mac") {
    store.recordCard({ taskId: p.taskId, host: "mac", componentId, cwd: fixCwd, noteId: "projects/dash", agent: "claude", title, investigationId: "inv1" }, Date.now())
  }
  return p
}

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
  routes = await import("./orchestrator")
  host = (await import("../state")).HOST_INFO.name
  store = fixLib.createBodyFixStore(sqlite)
  live.setLiveRunner(fakeRunner)
  wiring = makeWiring()
  prevDeps = fix.setBodyFixDeps({ store, localHost: () => "zettlab", peer: () => ({ base: "https://mac.test", token: "peer-token" }), fetchFn: peerFetch })
})

afterAll(() => {
  fix.setBodyFixDeps(prevDeps)
  live.setLiveRunner(live.tmuxRunner)
  live.setLiveCap(null)
  sqlite.exec("UPDATE orchestrator_tasks SET status = 'done' WHERE dispatch_task_id IS NOT NULL AND status IN ('dispatched', 'running')")
  // bun shares one sqlite across test files: body.test.ts expects #Body to be created by its first alert.
  sqlite.exec("DELETE FROM orchestrator_channels WHERE id = 'body'")
  delete process.env.COMPANION_DISPATCH_RUN
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

beforeEach(() => {
  macDown = false
  inserts = 0
  spawns.length = 0
  peerCalls.length = 0
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES ('projects/dash', 'projects', 'Companion Orchestrator', 'PRJ-OR1T', 'active')").run()
  live.setLiveCap(chat.countLiveTasks() + 3)
})

describe("approving a Mac body fix on Zettlab", () => {
  test("forwards to the Mac (bearer + hop); never files a queued Turso row; the Mac claims live in the fix's cwd", async () => {
    const p = card()
    const r = await approve(p.taskId, {}) // a plain (headless) approve
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, taskId: p.taskId, host: "mac", status: "running", mode: "live", replay: false })
    const id = r.json.dispatchTaskId as string

    expect(peerCalls).toHaveLength(1)
    expect(peerCalls[0]).toMatchObject({
      url: "https://mac.test/api/body/fix",
      headers: { authorization: "Bearer peer-token", "x-companion-body-hop": "1" },
      body: { fixId: p.taskId, host: "mac", cwd: fixCwd, noteId: "projects/dash", agent: "claude" },
    })
    // Exactly one Turso row: claimed running by the live path, never `queued` for Zettlab's dispatch-run.
    const rows = tursoRows()
    expect(rows).toHaveLength(1)
    expect(rows.filter((x) => x.dispatch_status === "queued")).toHaveLength(0)
    expect(rows[0]).toMatchObject({ id, dispatch_status: "running", dispatch_owner: `companion:${host}`, assignee: "agent:claude" })
    expect(inserts).toBe(1)

    // The Mac-side local row runs in the fix's cwd — not the note's mapped repo.
    const macTaskId = store.run(p.taskId)!
    expect(macTaskId).not.toBe(p.taskId)
    expect(spawns).toEqual([{ taskId: macTaskId, cwd: fixCwd }])
    expect(chat.getTask(macTaskId)).toMatchObject({ cwd: fixCwd, dispatchTaskId: id, threadId: "body" })
    expect(spawns.some((s) => s.cwd === mappedRepo)).toBe(false)

    // The Zettlab card leaves (filed, stamped with the Mac's id).
    expect(chat.getTask(p.taskId)).toMatchObject({ status: "filed", dispatchTaskId: id })
  })

  test("mode live forwards the same way", async () => {
    const p = card()
    const r = await approve(p.taskId, { mode: "live" })
    expect(r.json).toMatchObject({ ok: true, host: "mac", mode: "live" })
    expect(peerCalls).toHaveLength(1)
    expect(tursoRows().map((x) => x.dispatch_status)).toEqual(["running"])
  })

  test("replay: a repeat or a concurrent double approve reuses one Mac run and one Turso row", async () => {
    const p = card()
    const [a, b] = await Promise.all([approve(p.taskId), approve(p.taskId)])
    const again = await approve(p.taskId)
    for (const r of [a, b, again]) expect(r).toMatchObject({ status: 200, json: { ok: true, dispatchTaskId: a.json.dispatchTaskId, host: "mac" } })
    expect(again.json.replay).toBe(true)
    expect(spawns).toHaveLength(1)
    expect(tursoRows()).toHaveLength(1)
    expect(inserts).toBeLessThanOrEqual(2) // INSERT OR IGNORE under one stamped id
    expect(peerCalls.length).toBeLessThanOrEqual(2) // the filed replay never calls the Mac
  })

  test("Mac unreachable → 503 host_unreachable; the card stays proposed and retryable", async () => {
    const p = card()
    macDown = true
    const r = await approve(p.taskId)
    expect(r.status).toBe(503)
    expect(r.json).toMatchObject({ ok: false, error: "host_unreachable", host: "mac", taskId: p.taskId })
    expect(chat.getTask(p.taskId)).toMatchObject({ status: "proposed", dispatchTaskId: null })
    expect(tursoRows()).toHaveLength(0)
    expect(spawns).toHaveLength(0)
    macDown = false
    const retry = await approve(p.taskId)
    expect(retry).toMatchObject({ status: 200, json: { ok: true, host: "mac" } })
    expect(tursoRows()).toHaveLength(1)
  })

  test("no peer configured → 503 host_unreachable naming the env var", async () => {
    const p = card()
    const prev = fix.setBodyFixDeps({ peer: () => null })
    try {
      const r = await approve(p.taskId)
      expect(r.status).toBe(503)
      expect(r.json).toMatchObject({ error: "host_unreachable", reason: "no peer configured (COMPANION_BODY_PEER)" })
      expect(chat.getTask(p.taskId)!.status).toBe("proposed")
    } finally {
      fix.setBodyFixDeps(prev)
    }
  })

  test("the Mac's refusal passes through; its 401 becomes a 502 (not the phone's auth)", async () => {
    const p = card()
    const prev = fix.setBodyFixDeps({ fetchFn: (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch })
    try {
      const r = await approve(p.taskId)
      expect(r).toMatchObject({ status: 502, json: { ok: false, error: "host_refused" } })
      expect(chat.getTask(p.taskId)!.status).toBe("proposed")
    } finally {
      fix.setBodyFixDeps(prev)
    }
  })

  test("zettlab components keep the normal headless filing", async () => {
    const p = card("zettlab")
    const r = await approve(p.taskId)
    expect(r.json).toMatchObject({ ok: true, status: "queued" })
    expect(peerCalls).toHaveLength(0)
    expect(tursoRows().map((x) => x.dispatch_status)).toEqual(["queued"])
  })

  test("/api/body/fix side refuses a component it does not own (never re-forwards)", async () => {
    const req = fixLib.parseFixRequest({ fixId: "abc12345", host: "mac", componentId: "mac:launchd:x", prompt: "p", title: "t", cwd: fixCwd, noteId: "projects/dash", agent: "claude" })
    if ("error" in req) throw new Error(req.error)
    const res = await fix.runBodyFix(req, wiring.w, "zettlab")
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, error: "not_owner" })
    expect(fixLib.parseFixRequest({ fixId: "x", host: "mac", componentId: "c", prompt: "p", title: "t", cwd: "rel", noteId: "n", agent: "a" })).toEqual({ error: "cwd must be absolute" })
  })
})
