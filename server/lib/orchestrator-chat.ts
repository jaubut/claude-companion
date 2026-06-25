import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

// Single-thread orchestrator (PRJ-OR1T Phase 1). One always-open chat thread per
// host; every user message and every dispatched-worker reply lands in it, tagged
// by task. Persisted to the same companion.db as push-tokens/learned-allow so the
// thread survives a server restart — the "always there" property the orchestrator
// is built on (memory-proof gate, PRJ-OR1T Phase 0).

const DB_DIR = join(homedir(), ".claude-companion")
const DB_PATH = join(DB_DIR, "companion.db")

mkdirSync(DB_DIR, { recursive: true })
const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS orchestrator_turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL DEFAULT 'main',
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    task_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turns_thread ON orchestrator_turns (thread_id, created_at);

  CREATE TABLE IF NOT EXISTS orchestrator_tasks (
    task_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL DEFAULT 'main',
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL,
    session_key TEXT,
    tmux_session TEXT,
    reasoning TEXT,
    status TEXT NOT NULL DEFAULT 'dispatched',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_cwd ON orchestrator_tasks (cwd, status);
`)
// Migrate dbs created before these columns existed. ALTER throws if the column
// is already present, so swallow that one case per column.
for (const col of ["tmux_session TEXT", "reasoning TEXT"]) {
  try {
    db.exec(`ALTER TABLE orchestrator_tasks ADD COLUMN ${col}`)
  } catch {
    /* column already exists */
  }
}

// Single-thread product: one canonical thread id. Schema keeps thread_id so a
// future multi-thread mode is a non-breaking change.
export const MAIN_THREAD = "main"

export type TurnRole = "user" | "orchestrator" | "worker"
// proposed → (approve) → dispatched → running → done | error ; (reject) → rejected
export type TaskStatus = "proposed" | "dispatched" | "running" | "done" | "error" | "rejected"

export interface Turn {
  id: string
  threadId: string
  role: TurnRole
  text: string
  taskId: string | null
  createdAt: number
}

export interface Task {
  taskId: string
  threadId: string
  prompt: string
  cwd: string
  sessionKey: string | null
  tmuxSession: string | null
  reasoning: string | null
  status: TaskStatus
  createdAt: number
  updatedAt: number
}

interface TurnRow {
  id: string
  thread_id: string
  role: TurnRole
  text: string
  task_id: string | null
  created_at: number
}

interface TaskRow {
  task_id: string
  thread_id: string
  prompt: string
  cwd: string
  session_key: string | null
  tmux_session: string | null
  reasoning: string | null
  status: TaskStatus
  created_at: number
  updated_at: number
}

function toTurn(r: TurnRow): Turn {
  return { id: r.id, threadId: r.thread_id, role: r.role, text: r.text, taskId: r.task_id, createdAt: r.created_at }
}

function toTask(r: TaskRow): Task {
  return {
    taskId: r.task_id,
    threadId: r.thread_id,
    prompt: r.prompt,
    cwd: r.cwd,
    sessionKey: r.session_key,
    tmuxSession: r.tmux_session,
    reasoning: r.reasoning,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ---- turns ----------------------------------------------------------------

export function appendTurn(role: TurnRole, text: string, taskId: string | null = null, threadId: string = MAIN_THREAD): Turn {
  const turn: Turn = { id: randomUUID(), threadId, role, text, taskId, createdAt: Date.now() }
  db.query(
    "INSERT INTO orchestrator_turns (id, thread_id, role, text, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(turn.id, turn.threadId, turn.role, turn.text, turn.taskId, turn.createdAt)
  return turn
}

export function getThread(threadId: string = MAIN_THREAD, limit = 200): Turn[] {
  const rows = db
    .query("SELECT * FROM orchestrator_turns WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(threadId, limit) as TurnRow[]
  return rows.map(toTurn)
}

// ---- dispatch tasks -------------------------------------------------------

function insertTask(task: Task): void {
  db.query(
    "INSERT INTO orchestrator_tasks (task_id, thread_id, prompt, cwd, session_key, tmux_session, reasoning, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    task.taskId, task.threadId, task.prompt, task.cwd, task.sessionKey,
    task.tmuxSession, task.reasoning, task.status, task.createdAt, task.updatedAt,
  )
}

// Direct dispatch (Phase 1, manual /dispatch): task is spawned immediately.
export function createTask(prompt: string, cwd: string, tmuxSession: string | null = null, threadId: string = MAIN_THREAD): Task {
  const now = Date.now()
  const task: Task = {
    taskId: randomUUID().slice(0, 8), threadId, prompt, cwd,
    sessionKey: null, tmuxSession, reasoning: null, status: "dispatched", createdAt: now, updatedAt: now,
  }
  insertTask(task)
  return task
}

// Propose-confirm (Phase 2): the brain proposes a dispatch; nothing spawns until
// the user approves (setTaskSpawn flips it to dispatched).
export function createProposal(prompt: string, cwd: string, reasoning: string, threadId: string = MAIN_THREAD): Task {
  const now = Date.now()
  const task: Task = {
    taskId: randomUUID().slice(0, 8), threadId, prompt, cwd,
    sessionKey: null, tmuxSession: null, reasoning, status: "proposed", createdAt: now, updatedAt: now,
  }
  insertTask(task)
  return task
}

// Approve a proposal: record the spawned worker's tmux session and flip to
// dispatched so reconcileDispatch picks it up and delivers the prompt.
export function setTaskSpawn(taskId: string, tmuxSession: string | null): void {
  db.query("UPDATE orchestrator_tasks SET tmux_session = ?, status = 'dispatched', updated_at = ? WHERE task_id = ?").run(
    tmuxSession,
    Date.now(),
    taskId,
  )
}

export function getTask(taskId: string): Task | null {
  const row = db.query("SELECT * FROM orchestrator_tasks WHERE task_id = ?").get(taskId) as TaskRow | null
  return row ? toTask(row) : null
}

export function bindTaskSession(taskId: string, sessionKey: string): void {
  db.query("UPDATE orchestrator_tasks SET session_key = ?, status = 'running', updated_at = ? WHERE task_id = ?").run(
    sessionKey,
    Date.now(),
    taskId,
  )
}

export function setTaskStatus(taskId: string, status: TaskStatus): void {
  db.query("UPDATE orchestrator_tasks SET status = ?, updated_at = ? WHERE task_id = ?").run(status, Date.now(), taskId)
}

// Match a freshly-registered worker session back to the task that spawned it:
// the oldest still-unbound dispatched task in the same cwd. cwd is the only
// signal shared between /api/dispatch (we picked the cwd) and the session-start
// hook (Claude Code reports its cwd) before we know the session key.
export function matchUnboundTaskByCwd(cwd: string): Task | null {
  const row = db
    .query("SELECT * FROM orchestrator_tasks WHERE cwd = ? AND session_key IS NULL AND status = 'dispatched' ORDER BY created_at ASC LIMIT 1")
    .get(cwd) as TaskRow | null
  return row ? toTask(row) : null
}

// Find the task a turn-end belongs to, by cwd — the only identifier reliably
// present in every hook payload. A worker running inside tmux reports a pty that
// differs from the ps-discovered session key used at bind time, so matching on
// the key misses; cwd is stable across spawn → session-start → stop.
export function findRunningTaskByCwd(cwd: string): Task | null {
  const row = db
    .query("SELECT * FROM orchestrator_tasks WHERE cwd = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1")
    .get(cwd) as TaskRow | null
  return row ? toTask(row) : null
}

export function listTasks(status?: TaskStatus): Task[] {
  const rows = status
    ? (db.query("SELECT * FROM orchestrator_tasks WHERE status = ? ORDER BY created_at DESC").all(status) as TaskRow[])
    : (db.query("SELECT * FROM orchestrator_tasks ORDER BY created_at DESC LIMIT 100").all() as TaskRow[])
  return rows.map(toTask)
}
