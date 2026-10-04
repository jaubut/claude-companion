import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { QueryFn, Row } from "../lib/turso"
import { TursoUnreachable } from "../lib/turso"

// Route level for the orchestrator-one-queue read path: real sqlite store
// (isolated COMPANION_DB_PATH), fake Turso through the QueryFn seam, the
// handler built around a test-owned dispatch wiring. The bearer 401 lives in
// the server's /api/* gate.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-orch-dispatch-")), "test.db")

type Routes = typeof import("./orchestrator")
let routes: Routes
let poller: typeof import("../lib/dispatch-poller")
let wiring: typeof import("../wiring/dispatch")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let db: typeof import("../lib/orchestrator-db")["db"]

const ID = "c".repeat(32)
let failing = false
let notes: Row[] = []
let taskRows: Row[] = []

const fakeQuery: QueryFn = async (sql, args) => {
  if (failing) throw new TursoUnreachable("network")
  if (sql.includes("pragma_table_info")) return [{ name: "dispatch_pr_url" }, { name: "dispatch_result_ref" }]
  if (sql.includes("FROM notes n WHERE n.folder = 'projects'")) return [{ id: "projects/dash", ref_code: "PRJ-WCLS", title: "TLS Dashboard", open_tasks: 2 }]
  if (sql.includes("FROM tasks t") && sql.includes("WHERE t.id = ?")) return taskRows.filter((r) => r.id === args[0])
  if (sql.includes("FROM tasks t")) return taskRows
  if (sql.includes("FROM agent_activity")) return [{ action: "dispatch:blocked", summary: "→blocked: fix it", ts: "2026-10-03 12:00:00" }]
  if (sql.includes("ref_code = ?")) return [{ ref_code: "RES-AB12", title: "[dispatch:blocked] builder", body: "how-to" }]
  if (sql.includes("FROM notes WHERE id = ?")) return notes.filter((n) => n.id === args[0])
  return []
}

function makeWiring() {
  const frames: Record<string, unknown>[] = []
  const w = poller.createDispatchWiring({
    query: fakeQuery,
    broadcast: (f) => frames.push(f),
    appendTurn: (text, taskId, channelId) => chat.appendTurn("orchestrator", text, taskId, channelId),
    push: () => {},
    pushEnabled: () => false,
    linkedNotes: channels.linkedNotes,
    getChannel: channels.getChannel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    log: () => {},
    mirror,
    generalChannel: "general",
  })
  return { w, frames, handler: routes.createOrchestratorHandler(w) }
}

async function call(handler: ReturnType<Routes["createOrchestratorHandler"]>, method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) })
  const res = await handler(req, new URL(req.url))
  return { status: res!.status, json: await res!.json() as Record<string, any> }
}

const blockedRow: Row = {
  id: ID, note_id: "projects/dash", text: "Fix tax rounding", assignee: "agent:builder", done: 0, description: "full spec",
  created_at: "2026-10-03 10:00:00", updated_at: "2026-10-03 12:00:00", dispatch_status: "blocked",
  dispatch_blocker: "no repo mapped", dispatch_owner: "zettlab", dispatch_pr_url: null, dispatch_result_ref: "RES-AB12",
  note_title: "TLS Dashboard", note_ref: "PRJ-WCLS",
}

beforeAll(async () => {
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  db = (await import("../lib/orchestrator-db")).db
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  wiring = await import("../wiring/dispatch")
  routes = await import("./orchestrator")
})

beforeEach(() => {
  failing = false
  db.exec("DELETE FROM dispatch_seen")
  db.exec("UPDATE orchestrator_channels SET note_id = NULL, note_title = NULL, note_ref = NULL")
  notes = [{ id: "projects/dash", title: "TLS Dashboard", ref_code: "PRJ-WCLS" }]
  taskRows = [blockedRow]
})

describe("GET /api/orchestrator/thread", () => {
  test("merges local rows and the channel's dispatch tasks; queue gains dispatch counts", async () => {
    const { w, handler } = makeWiring()
    await w.poll()
    const local = chat.createProposal("local proposal", "/x", "why", "general")
    const { status, json } = await call(handler, "GET", "/api/orchestrator/thread?channel=general")
    expect(status).toBe(200)
    const ids = json.tasks.map((t: { taskId: string }) => t.taskId)
    expect(ids).toContain(local.taskId)
    expect(ids).toContain(ID)
    expect(json.tasks.find((t: { taskId: string }) => t.taskId === local.taskId)).toMatchObject({ source: "proposal", status: "proposed" })
    expect(json.tasks.find((t: { taskId: string }) => t.taskId === ID)).toMatchObject({
      source: "dispatch", status: "error", dispatchStatus: "blocked", blocker: "no repo mapped", projectTitle: "TLS Dashboard", threadId: "general",
    })
    expect(json.queue).toEqual({ cap: 3, live: 0, queued: 0, dispatch: { queued: 0, running: 0, blocked: 1, pr: 0 } })
    expect(json.channels.find((c: { id: string }) => c.id === "general").counts).toEqual({ queued: 0, running: 0, blocked: 1, pr: 0 })
  })

  test("Turso down before the first poll: the thread still answers with local tasks only", async () => {
    failing = true
    const { w, handler } = makeWiring()
    await w.poll()
    const { status, json } = await call(handler, "GET", "/api/orchestrator/thread")
    expect(status).toBe(200)
    expect(json.tasks.every((t: { source: string }) => t.source !== "dispatch")).toBe(true)
  })
})

describe("POST /api/orchestrator/channels/<id>/link", () => {
  test("links, re-routes the note's tasks, 409 elsewhere, unlinks with null", async () => {
    const { w, frames, handler } = makeWiring()
    await w.poll()
    const a = channels.createChannel("Dash A")
    const b = channels.createChannel("Dash B")
    frames.length = 0
    const linked = await call(handler, "POST", `/api/orchestrator/channels/${a.id}/link`, { noteId: "projects/dash" })
    expect(linked.status).toBe(200)
    expect(linked.json.channel).toMatchObject({ id: a.id, noteId: "projects/dash", noteTitle: "TLS Dashboard", noteRef: "PRJ-WCLS", counts: { blocked: 1 } })
    const taskFrame = frames.find((f) => f.type === "orchestrator_task")
    expect(taskFrame?.task).toMatchObject({ taskId: ID, threadId: a.id })
    expect(w.tasksFor(a.id).map((t) => t.taskId)).toEqual([ID])
    expect(w.tasksFor("general").map((t) => t.taskId)).not.toContain(ID)

    const clash = await call(handler, "POST", `/api/orchestrator/channels/${b.id}/link`, { noteId: "projects/dash" })
    expect(clash).toEqual({ status: 409, json: { ok: false, error: "note_linked_elsewhere" } })

    const unlinked = await call(handler, "POST", `/api/orchestrator/channels/${a.id}/link`, { noteId: null })
    expect(unlinked.json.channel).toMatchObject({ noteId: null, counts: { blocked: 0 } })
    expect(w.tasksFor("general").map((t) => t.taskId)).toContain(ID)
  })

  test("validation: unknown note 404, unknown channel 404, system channel 400, bad body 400, Turso down 503", async () => {
    const { handler } = makeWiring()
    const c = channels.createChannel("Dash C")
    expect((await call(handler, "POST", `/api/orchestrator/channels/${c.id}/link`, { noteId: "projects/nope" })).status).toBe(404)
    expect((await call(handler, "POST", "/api/orchestrator/channels/nope/link", { noteId: null })).status).toBe(404)
    expect((await call(handler, "POST", "/api/orchestrator/channels/general/link", { noteId: "projects/dash" })).status).toBe(400)
    expect((await call(handler, "POST", `/api/orchestrator/channels/${c.id}/link`, { noteId: 7 })).status).toBe(400)
    expect((await call(handler, "POST", `/api/orchestrator/channels/${c.id}/link`, "{")).status).toBe(400)
    failing = true
    expect(await call(handler, "POST", `/api/orchestrator/channels/${c.id}/link`, { noteId: "projects/dash" })).toEqual({
      status: 503, json: { ok: false, error: "turso_unreachable" },
    })
  })
})

describe("GET /api/orchestrator/task/<id>", () => {
  test("Turso task: DTO, description, result excerpt, activity", async () => {
    const { handler } = makeWiring()
    const { status, json } = await call(handler, "GET", `/api/orchestrator/task/${ID}`)
    expect(status).toBe(200)
    expect(json).toMatchObject({
      ok: true, description: "full spec",
      task: { taskId: ID, dispatchStatus: "blocked", resultRef: "RES-AB12", agent: "builder", owner: "zettlab", mode: "headless" },
      result: { ref: "RES-AB12", title: "[dispatch:blocked] builder", excerpt: "how-to" },
      activity: [{ action: "dispatch:blocked", summary: "→blocked: fix it", ts: "2026-10-03 12:00:00" }],
    })
  })

  test("local task from sqlite; unknown 404; Turso down 503", async () => {
    const { handler } = makeWiring()
    const local = chat.createProposal("p", "/x", "why", "general")
    expect((await call(handler, "GET", `/api/orchestrator/task/${local.taskId}`)).json).toMatchObject({
      ok: true, task: { taskId: local.taskId, source: "proposal" }, description: "p", activity: [],
    })
    expect((await call(handler, "GET", `/api/orchestrator/task/${"d".repeat(32)}`)).status).toBe(404)
    expect((await call(handler, "GET", "/api/orchestrator/task/bad%20id")).status).toBe(404)
    failing = true
    expect((await call(handler, "GET", `/api/orchestrator/task/${ID}`)).status).toBe(503)
  })
})

describe("GET /api/orchestrator/projects", () => {
  test("active projects with open agent-task counts; cached; 503 when Turso is down on a cold cache", async () => {
    const { handler } = makeWiring()
    const { json } = await call(handler, "GET", "/api/orchestrator/projects")
    expect(json).toEqual({ projects: [{ noteId: "projects/dash", ref: "PRJ-WCLS", title: "TLS Dashboard", openAgentTasks: 2 }] })
    failing = true
    expect((await call(handler, "GET", "/api/orchestrator/projects")).status).toBe(200) // 5-min cache
    const cold = makeWiring()
    expect((await call(cold.handler, "GET", "/api/orchestrator/projects")).status).toBe(503)
  })
})

describe("POST /hooks/dispatch-event", () => {
  test("202 nudge from loopback, 403 off-box without bearer", async () => {
    // Keep the singleton's poll off the network: no token, unroutable URL.
    const saved = { token: process.env.TURSO_AUTH_TOKEN, url: process.env.TURSO_DATABASE_URL }
    delete process.env.TURSO_AUTH_TOKEN
    process.env.TURSO_DATABASE_URL = "http://127.0.0.1:9"
    try {
      const { handleHookRoute } = await import("./hooks")
      const { recordPeer } = await import("../lib/vault-guard")
      const nudge = (peer: string) => {
        const req = new Request("http://localhost/hooks/dispatch-event", { method: "POST", body: JSON.stringify({ taskId: ID }) })
        recordPeer(req, peer)
        return handleHookRoute(req, new URL(req.url))
      }
      const res = await nudge("127.0.0.1")
      expect(res!.status).toBe(202)
      expect(await res!.json()).toMatchObject({ ok: true })
      // Off-box without the bearer: refused (the nudge carries no state, but it is not a public poll trigger).
      expect((await nudge("192.168.1.50"))!.status).toBe(403)
      wiring.dispatchWiring.stop()
    } finally {
      if (saved.token !== undefined) process.env.TURSO_AUTH_TOKEN = saved.token
      if (saved.url !== undefined) process.env.TURSO_DATABASE_URL = saved.url
      else delete process.env.TURSO_DATABASE_URL
    }
  })
})

describe("sqlite announce cursor (lib/dispatch-mirror.ts)", () => {
  test("persists across a restart: a new poller on the same db re-announces nothing", async () => {
    taskRows = [{ ...blockedRow, dispatch_status: "queued", updated_at: "2026-10-03 09:00:00" }]
    await makeWiring().w.poll() // seed
    taskRows = [blockedRow]
    await makeWiring().w.poll()
    const turnsFor = () => chat.getThread("general", 1000).filter((t) => t.taskId === ID)
    expect(turnsFor()).toHaveLength(1)
    expect(mirror.lastSeen(ID)).toMatchObject({ phase: "blocked", updatedAt: "2026-10-03 12:00:00" })

    const restarted = makeWiring()
    await restarted.w.poll()
    expect(restarted.frames.filter((f) => f.type === "orchestrator_task")).toHaveLength(0)
    expect(turnsFor()).toHaveLength(1)
  })

  test("prune drops only stale ids outside the poll window", () => {
    taskRows = []
    const row = (id: string) => ({ id, noteId: "n", title: "t", agent: null, status: "queued" as const, done: false, blocker: null, owner: null, prUrl: null, resultRef: null, projectTitle: null, projectRef: null, createdAt: 0, updatedAt: 0, updatedAtRaw: "x" })
    mirror.markSeen(row("old-kept"), 0)
    mirror.markSeen(row("old-gone"), 0)
    mirror.markSeen(row("new"), 10_000)
    expect(mirror.pruneSeen(new Set(["old-kept"]), 5_000, 10_000)).toBe(1)
    expect(mirror.lastSeen("old-gone")).toBeNull()
    expect(mirror.lastSeen("old-kept")).not.toBeNull()
    expect(mirror.lastSeen("new")).not.toBeNull()
  })
})

describe("channel ↔ note link (lib/orchestrator-channels.ts)", () => {
  test("one live channel per note; unlink frees it", () => {
    const a = channels.createChannel("Link A")
    const b = channels.createChannel("Link B")
    expect(channels.setChannelNote(a.id, { noteId: "projects/one", title: "One", ref: "PRJ-1" })).toMatchObject({
      ok: true, channel: { noteId: "projects/one", noteTitle: "One", noteRef: "PRJ-1" },
    })
    expect(channels.setChannelNote(b.id, { noteId: "projects/one", title: "One", ref: null })).toEqual({ ok: false, error: "note_linked_elsewhere" })
    expect(channels.getChannelByNote("projects/one")?.id).toBe(a.id)
    expect(channels.linkedNotes().get("projects/one")).toBe(a.id)
    expect(channels.setChannelNote(a.id, null).ok).toBe(true)
    expect(channels.setChannelNote(b.id, { noteId: "projects/one", title: "One", ref: null }).ok).toBe(true)
    expect(channels.setChannelNote("nope", null)).toEqual({ ok: false, error: "no_such_channel" })
  })
})
