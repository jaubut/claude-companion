import { test, expect, describe, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Seed a legacy (pre-Phase-6) DB with 'main'-thread rows and NO channels table,
// BEFORE importing the module — so importing it exercises the real seed + the
// 'main' → 'general' backfill against a genuine sqlite file (no mocks).
const dbPath = join(mkdtempSync(join(tmpdir(), "cc-orch-")), "companion.db")
{
  const seed = new Database(dbPath)
  seed.exec(`
    CREATE TABLE orchestrator_turns (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL DEFAULT 'main', role TEXT NOT NULL,
      text TEXT NOT NULL, task_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE orchestrator_tasks (
      task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL DEFAULT 'main', prompt TEXT NOT NULL,
      cwd TEXT NOT NULL, session_key TEXT, tmux_session TEXT, reasoning TEXT,
      status TEXT NOT NULL DEFAULT 'dispatched', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `)
  seed.query("INSERT INTO orchestrator_turns (id, thread_id, role, text, task_id, created_at) VALUES ('t1','main','user','legacy hello',NULL,1)").run()
  seed.query("INSERT INTO orchestrator_tasks (task_id, thread_id, prompt, cwd, status, created_at, updated_at) VALUES ('k1','main','legacy task','/x','done',1,1)").run()
  seed.close()
}
process.env.COMPANION_DB_PATH = dbPath

// Import AFTER seeding + pointing COMPANION_DB_PATH at it, so module init (seed +
// backfill) runs against our fixture.
const chat = await import("./orchestrator-chat")

test("seeds General and backfills legacy 'main' history into it", () => {
  expect(chat.listChannels().some((c) => c.id === "general" && c.name === "General")).toBe(true)
  expect(chat.getThread("general").some((t) => t.text === "legacy hello")).toBe(true)
  expect(chat.listTasks("general").some((t) => t.taskId === "k1")).toBe(true)
  // nothing is left under the retired 'main' id
  expect(chat.getThread("main")).toHaveLength(0)
})

test("createChannel slugifies the name and disambiguates collisions", () => {
  expect(chat.createChannel("TLS Dashboard").id).toBe("tls-dashboard")
  expect(chat.createChannel("TLS Dashboard!").id).toBe("tls-dashboard-2")
})

test("turns and tasks are isolated per channel", () => {
  const x = chat.createChannel("Chan X", "/proj/x")
  const y = chat.createChannel("Chan Y")
  chat.appendTurn("user", "in x", null, x.id)
  chat.appendTurn("user", "in y", null, y.id)
  chat.createTask("do x", "/proj/x", null, x.id)

  expect(chat.getThread(x.id).map((t) => t.text)).toEqual(["in x"])
  expect(chat.getThread(y.id).map((t) => t.text)).toEqual(["in y"])
  expect(chat.listTasks(x.id).map((t) => t.prompt)).toEqual(["do x"])
  expect(chat.listTasks(y.id)).toHaveLength(0)
  expect(chat.getChannel(x.id)?.cwd).toBe("/proj/x")
})

test("proposals carry their channel through createProposal", () => {
  const z = chat.createChannel("Chan Z")
  const p = chat.createProposal("plan", "/proj/z", "because", z.id)
  expect(p.threadId).toBe(z.id)
  expect(p.status).toBe("proposed")
  expect(chat.listTasks(z.id).some((t) => t.taskId === p.taskId)).toBe(true)
})

test("log_tail migrates onto a legacy db and round-trips through setTaskLogTail", () => {
  // The legacy seed had no log_tail column — module init must have ALTERed it in.
  expect(chat.getTask("k1")?.logTail).toBeNull()
  const t = chat.createTask("tail me", "/y", "cc-y", "general")
  expect(t.logTail).toBeNull()
  chat.setTaskLogTail(t.taskId, "last\nlines")
  expect(chat.getTask(t.taskId)?.logTail).toBe("last\nlines")
  // a proposal carries the column too
  expect(chat.createProposal("p", "/y", "why", "general").logTail).toBeNull()
})

test("auto_dispatch migrates onto a legacy channels table and round-trips with trust", () => {
  const ch = chat.createChannel("Trust Lab", "/t")
  expect(ch.autoDispatch).toBe(false)
  expect(chat.setChannelAuto(ch.id, true)?.autoDispatch).toBe(true)
  expect(chat.getChannel(ch.id)?.autoDispatch).toBe(true)
  expect(chat.listChannels().find((c) => c.id === ch.id)?.autoDispatch).toBe(true)
  expect(chat.setChannelAuto("nope", true)).toBeNull()
})

test("channelTrust counts judged proposals only and tracks the approval streak", () => {
  const ch = chat.createChannel("Streak", "/s")
  const judge = (status: "dispatched" | "rejected" | "done" | "cancelled") => {
    const t = chat.createProposal("p", "/s", "why", ch.id)
    chat.setTaskStatus(t.taskId, status)
  }
  expect(chat.channelTrust(ch.id)).toEqual({ approved: 0, rejected: 0, streak: 0, eligible: false })
  chat.createProposal("pending", "/s", "why", ch.id) // unjudged → ignored
  chat.createTask("manual", "/s", "cc-s", ch.id) // no reasoning → ignored
  judge("done"); judge("dispatched"); judge("cancelled")
  expect(chat.channelTrust(ch.id)).toEqual({ approved: 3, rejected: 0, streak: 3, eligible: false })
  judge("rejected")
  judge("done"); judge("done")
  expect(chat.channelTrust(ch.id)).toEqual({ approved: 5, rejected: 1, streak: 2, eligible: false })
  judge("done"); judge("done"); judge("done")
  const t = chat.channelTrust(ch.id)
  expect(t.streak).toBe(5)
  expect(t.eligible).toBe(true)
  expect(chat.getChannel(ch.id)?.trust.eligible).toBe(true)
})

test("createQueuedTask parks a task with no tmux session; listQueued is FIFO", () => {
  const a = chat.createQueuedTask("first", "/z", "general")
  const b = chat.createQueuedTask("second", "/z", "general")
  expect(a.status).toBe("queued")
  expect(a.tmuxSession).toBeNull()
  const ids = chat.listQueued().map((t) => t.taskId)
  expect(ids.indexOf(a.taskId)).toBeLessThan(ids.indexOf(b.taskId))
})

// ---- backpressure (Phase 7) -------------------------------------------------
// Same module instance / same sqlite file as above: Bun shares the module cache
// across test files, so a second file setting COMPANION_DB_PATH would either be
// ignored or steal the binding from this file's legacy seed. Keep every test
// that touches orchestrator-chat in this one file.

const { createQueue } = await import("./orchestrator-queue")
const CWD = "/q"

describe("backpressure queue", () => {

  function makeQueue(cap: number, spawned: string[], failIds = new Set<string>()) {
    return createQueue({
      cap,
      countLive: chat.countLiveTasks,
      listQueued: chat.listQueued,
      markQueued: (t) => chat.setTaskStatus(t.taskId, "queued"),
      dispatch: async (t) => {
        if (failIds.has(t.taskId)) {
          chat.setTaskStatus(t.taskId, "error")
          return { ok: false }
        }
        spawned.push(t.taskId)
        chat.setTaskSpawn(t.taskId, `cc-${t.taskId}`) // → dispatched, holds a slot
        return { ok: true }
      },
    })
  }

  beforeEach(() => {
    // Neutralize every task from prior tests so the live count starts at zero.
    for (const t of chat.listTasks()) chat.setTaskStatus(t.taskId, "done")
  })

  test("admit dispatches while under the cap, queues at the cap", async () => {
    const spawned: string[] = []
    const q = makeQueue(2, spawned)
    const a = chat.createProposal("a", CWD, "why", "general")
    const b = chat.createProposal("b", CWD, "why", "general")
    const c = chat.createProposal("c", CWD, "why", "general")
    expect((await q.admit(a)).status).toBe("dispatched")
    expect((await q.admit(b)).status).toBe("dispatched")
    expect((await q.admit(c)).status).toBe("queued")
    expect(spawned).toEqual([a.taskId, b.taskId])
    expect(chat.getTask(c.taskId)?.status).toBe("queued")
    expect(chat.countLiveTasks()).toBe(2)
  })

  test("a task already sitting in the queue admits itself when a slot is free", async () => {
    const spawned: string[] = []
    const q = makeQueue(2, spawned)
    const a = chat.createQueuedTask("manual", CWD, "general")
    expect((await q.admit(a)).status).toBe("dispatched")
    expect(spawned).toEqual([a.taskId])
  })

  test("admit surfaces a failed spawn", async () => {
    const spawned: string[] = []
    const a = chat.createProposal("a", CWD, "why", "general")
    const q = makeQueue(2, spawned, new Set([a.taskId]))
    const r = await q.admit(a)
    expect(r.status).toBe("dispatched")
    expect(r.status === "dispatched" && r.ok).toBe(false)
    expect(chat.getTask(a.taskId)?.status).toBe("error")
  })

  test("drain starts queued tasks FIFO as slots free, never past the cap", async () => {
    const spawned: string[] = []
    const q = makeQueue(1, spawned)
    const a = chat.createProposal("a", CWD, "why", "general")
    const b = chat.createProposal("b", CWD, "why", "general")
    const c = chat.createProposal("c", CWD, "why", "general")
    await q.admit(a)
    await q.admit(b)
    await q.admit(c)
    expect(chat.listQueued().map((t) => t.taskId)).toEqual([b.taskId, c.taskId])
    expect(await q.drain()).toBe(0) // a still holds the only slot
    chat.setTaskStatus(a.taskId, "done")
    expect(await q.drain()).toBe(1)
    expect(spawned).toEqual([a.taskId, b.taskId])
    expect(chat.getTask(c.taskId)?.status).toBe("queued")
    chat.setTaskStatus(b.taskId, "error")
    expect(await q.drain()).toBe(1)
    expect(spawned).toEqual([a.taskId, b.taskId, c.taskId])
    expect(chat.listQueued()).toHaveLength(0)
  })

  test("a newcomer parks behind an existing queue even when a slot is free (FIFO)", async () => {
    const spawned: string[] = []
    const q = makeQueue(1, spawned)
    const a = chat.createProposal("a", CWD, "why", "general")
    const b = chat.createProposal("b", CWD, "why", "general")
    await q.admit(a)
    await q.admit(b) // queued
    chat.setTaskStatus(a.taskId, "done") // slot free, but b is ahead
    const c = chat.createProposal("c", CWD, "why", "general")
    expect((await q.admit(c)).status).toBe("queued")
    await Bun.sleep(10) // admit kicked an async drain
    expect(spawned).toEqual([a.taskId, b.taskId])
    expect(chat.getTask(c.taskId)?.status).toBe("queued")
  })

  test("a failed spawn does not consume a slot; the next queued task still gets it", async () => {
    const spawned: string[] = []
    const a = chat.createProposal("a", CWD, "why", "general")
    const b = chat.createProposal("b", CWD, "why", "general")
    const q = makeQueue(1, spawned, new Set([a.taskId]))
    chat.setTaskStatus(a.taskId, "queued")
    chat.setTaskStatus(b.taskId, "queued")
    expect(await q.drain()).toBe(1)
    expect(chat.getTask(a.taskId)?.status).toBe("error")
    expect(spawned).toEqual([b.taskId])
  })

  test("countLiveTasks counts only dispatched + running", () => {
    const t1 = chat.createTask("x", CWD, "cc-x", "general") // dispatched
    const t2 = chat.createTask("y", CWD, "cc-y", "general")
    chat.bindTaskSession(t2.taskId, "k") // running
    chat.createProposal("p", CWD, "why", "general") // proposed
    chat.createQueuedTask("qd", CWD, "general") // queued
    expect(chat.countLiveTasks()).toBe(2)
    chat.setTaskStatus(t1.taskId, "cancelled")
    expect(chat.countLiveTasks()).toBe(1)
  })
})
