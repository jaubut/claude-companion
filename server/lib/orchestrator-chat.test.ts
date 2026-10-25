import { test, expect, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Seed a legacy (pre-Phase-6) DB with 'main'-thread rows and NO channels table,
// BEFORE importing the module — so importing it exercises the real seed + the
// 'main' → 'general' backfill against a genuine sqlite file (no mocks).
const dbPath = join(mkdtempSync(join(tmpdir(), "cc-orch-")), "test.db")
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
const chat = { ...(await import("./orchestrator-chat")), ...(await import("./orchestrator-channels")) }

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

test("log_tail migrates onto a legacy db", () => {
  // The legacy seed had no log_tail column — module init must have ALTERed it in.
  expect(chat.getTask("k1")?.logTail).toBeNull()
  expect(chat.createTask("tail me", "/y", "cc-y", "general").logTail).toBeNull()
  expect(chat.createProposal("p", "/y", "why", "general").logTail).toBeNull()
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

// Same module instance / same sqlite file as above: Bun shares the module cache
// across test files, so a second file setting COMPANION_DB_PATH would either be
// ignored or steal the binding from this file's legacy seed. Keep every test
// that touches orchestrator-chat in this one file.

test("legacy rows (pre tmux_socket column) read as the default server", () => {
  expect(chat.getTask("k1")?.tmuxSocket).toBeNull()
})

test("countLiveTasks counts only legacy dispatched + running rows", () => {
  for (const t of chat.listTasks()) chat.setTaskStatus(t.taskId, "done")
  const t1 = chat.createTask("x", "/q", "cc-x", "general") // dispatched
  const t2 = chat.createTask("y", "/q", "cc-y", "general")
  chat.setTaskStatus(t2.taskId, "running")
  chat.createProposal("p", "/q", "why", "general") // proposed
  chat.createQueuedTask("qd", "/q", "general") // queued
  expect(chat.countLiveTasks()).toBe(2)
  chat.setTaskStatus(t1.taskId, "cancelled")
  expect(chat.countLiveTasks()).toBe(1)
})

describe("getThread returns the NEWEST turns, not the oldest", () => {
  test("a channel past the limit still shows the turn just appended", () => {
    const c = chat.createChannel("Overflow")
    const limit = 10
    // limit + 5, appended in a tight loop so most share a created_at
    // millisecond — which is exactly the tie the rowid tiebreak has to settle.
    for (let i = 1; i <= limit + 5; i++) chat.appendTurn("user", `turn ${i}`, null, c.id)

    const turns = chat.getThread(c.id, limit)
    expect(turns).toHaveLength(limit)
    // The regression: before the fix this was "turn 1".."turn 10" and the last
    // five were invisible no matter how many more arrived.
    expect(turns.at(-1)?.text).toBe(`turn ${limit + 5}`)
    expect(turns[0]?.text).toBe("turn 6")
    // Callers still get ascending order.
    expect(turns.map((t) => t.text)).toEqual(
      Array.from({ length: limit }, (_, i) => `turn ${i + 6}`),
    )
  })

  test("a worker reply appended to a full channel is visible", () => {
    const c = chat.createChannel("Overflow Worker")
    for (let i = 1; i <= 12; i++) chat.appendTurn("user", `noise ${i}`, null, c.id)
    chat.appendTurn("worker", "PONG from the worker", "task-1", c.id)

    const turns = chat.getThread(c.id, 5)
    expect(turns.at(-1)?.text).toBe("PONG from the worker")
    expect(turns.at(-1)?.role).toBe("worker")
    expect(turns.at(-1)?.taskId).toBe("task-1")
  })

  test("under the limit, the whole thread comes back ascending", () => {
    const c = chat.createChannel("Short")
    chat.appendTurn("user", "one", null, c.id)
    chat.appendTurn("orchestrator", "two", null, c.id)
    expect(chat.getThread(c.id, 200).map((t) => t.text)).toEqual(["one", "two"])
  })
})
