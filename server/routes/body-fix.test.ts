import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"

// Mac body fixes in the one work stream (docs/one-stream-plan.md, Q1): approving
// a Mac card files ONE `pending` Turso row tagged requires_host=mac, so only the
// Mac's dispatch-run claims it once Jeremie stamps it on the dashboard. No peer
// forward, no live claim. Real Companion sqlite (isolated COMPANION_DB_PATH),
// "Turso" = in-memory bun:sqlite behind the QueryFn / ExecFn seams.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-body-fix-")), "test.db")

const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-body-fix-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
writeFileSync(join(tempHome, ".claude", "agents", "builder.md"), "---\n---\n")

let routes: typeof import("./orchestrator")
let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let store: import("../lib/body-fix").BodyFixStore
let sqlite: typeof import("../lib/orchestrator-db")["db"]

const turso = new Database(":memory:")
const TASKS = (extra: string) => `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_id TEXT DEFAULT '', text TEXT NOT NULL, description TEXT DEFAULT '',
    done INTEGER DEFAULT 0, due_date TEXT DEFAULT '', position INTEGER DEFAULT 0, assignee TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    dispatch_status TEXT, dispatch_run_id TEXT, dispatch_started_at TEXT, dispatch_completed_at TEXT,
    dispatch_blocker TEXT, dispatch_owner TEXT, dispatch_result_ref TEXT, dispatch_pr_url TEXT${extra}
  );`
turso.exec(`
  CREATE TABLE notes (id TEXT PRIMARY KEY, folder TEXT, title TEXT, ref_code TEXT, status TEXT, type TEXT, body TEXT, updated_at TEXT DEFAULT (datetime('now')));
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
const rows = () => turso.query("SELECT * FROM tasks").all() as Record<string, any>[]

let fetched = 0
const realFetch = globalThis.fetch

function makeHandler() {
  const w = poller.createDispatchWiring({
    query, exec,
    broadcast: () => {},
    appendTurn: (text, taskId, channelId) => chat.appendTurn("orchestrator", text, taskId, channelId),
    push: () => {}, pushEnabled: () => false,
    linkedNotes: channels.linkedNotes, getChannel: channels.getChannel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    liveIdentity: () => null,
    log: () => {}, mirror, generalChannel: "general",
  })
  return routes.createOrchestratorHandler(w)
}

async function approve(taskId: string, payload: unknown = {}) {
  const req = new Request(`http://localhost/api/orchestrator/proposal/${taskId}/approve`, { method: "POST", body: JSON.stringify(payload) })
  const res = await makeHandler()(req, new URL(req.url))
  return { status: res!.status, json: await res!.json() as Record<string, any> }
}

let seq = 0
/** A #Body card for a fix, as the report applier makes it (Zettlab side). */
function card(componentHost: "mac" | "zettlab") {
  channels.ensureChannel("body", "Body")
  const componentId = `${componentHost}:launchd:job${++seq}`
  const title = `Fix ${componentId}: restore it`
  const p = chat.createProposal("Fix it.\nRun on host: mac", "~/.claude", "Body investigation inv: x", "body", { noteId: "projects/dash", agent: "claude", title })
  if (componentHost === "mac") {
    store.recordCard({ taskId: p.taskId, host: "mac", componentId, cwd: "~/.claude", noteId: "projects/dash", agent: "claude", title, investigationId: "inv1" }, Date.now())
  }
  return p
}

beforeAll(async () => {
  process.env.HOME = tempHome
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  sqlite = (await import("../lib/orchestrator-db")).db
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  routes = await import("./orchestrator")
  store = (await import("../wiring/body-investigate")).bodyFixStore
  globalThis.fetch = (async () => { fetched++; throw new TypeError("no network in this test") }) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  // bun shares one sqlite across test files: body.test.ts expects #Body to be created by its first alert.
  sqlite.exec("DELETE FROM orchestrator_channels WHERE id = 'body'")
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

function resetTurso(withHostColumn: boolean) {
  turso.exec("DROP TABLE IF EXISTS tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.exec(TASKS(withHostColumn ? ", requires_host TEXT NOT NULL DEFAULT 'any'" : ""))
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES ('projects/dash', 'projects', 'Companion Orchestrator', 'PRJ-OR1T', 'active')").run()
}

beforeEach(() => {
  fetched = 0
  resetTurso(true)
})

describe("approving a Mac body fix", () => {
  test("files ONE pending row tagged requires_host=mac; no peer forward, no claim", async () => {
    const p = card("mac")
    const r = await approve(p.taskId)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, taskId: p.taskId, status: "pending_approval", replay: false })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ id: r.json.dispatchTaskId, dispatch_status: "pending", requires_host: "mac", dispatch_owner: null })
    expect(fetched).toBe(0)
    expect(chat.getTask(p.taskId)).toMatchObject({ status: "filed", dispatchTaskId: r.json.dispatchTaskId })
  })

  test("a non-Mac card stays untagged (any host)", async () => {
    const r = await approve(card("zettlab").taskId)
    expect(r.status).toBe(200)
    expect(rows()[0]).toMatchObject({ dispatch_status: "pending", requires_host: "any" })
  })

  test("before the requires_host column exists (slice G): still one pending row, the tag is skipped", async () => {
    resetTurso(false)
    const r = await approve(card("mac").taskId)
    expect(r.status).toBe(200)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ dispatch_status: "pending" })
    expect("requires_host" in rows()[0]!).toBe(false)
  })

  test("a replayed approve returns the same row", async () => {
    const p = card("mac")
    const a = await approve(p.taskId)
    const b = await approve(p.taskId)
    expect(b.json).toMatchObject({ ok: true, dispatchTaskId: a.json.dispatchTaskId, replay: true })
    expect(rows()).toHaveLength(1)
  })
})
