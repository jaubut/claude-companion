import { test, expect } from "bun:test"
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
