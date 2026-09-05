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
// COMPANION_DB_PATH lets tests run against an isolated sqlite file; production
// uses the real companion.db (shared with push-tokens / learned-allow).
const DB_PATH = process.env.COMPANION_DB_PATH ?? join(DB_DIR, "companion.db")

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

  CREATE TABLE IF NOT EXISTS orchestrator_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT,
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    auto_dispatch INTEGER NOT NULL DEFAULT 0
  );
`)
// Migrate dbs created before these columns existed. ALTER throws if the column
// is already present, so swallow that one case per column.
for (const col of ["tmux_session TEXT", "reasoning TEXT", "log_tail TEXT"]) {
  try {
    db.exec(`ALTER TABLE orchestrator_tasks ADD COLUMN ${col}`)
  } catch {
    /* column already exists */
  }
}
try {
  db.exec("ALTER TABLE orchestrator_channels ADD COLUMN auto_dispatch INTEGER NOT NULL DEFAULT 0")
} catch {
  /* column already exists */
}

// Default channel (PRJ-OR1T Phase 6). Was the single hardcoded thread id 'main';
// now the seeded catch-all channel that holds pre-Phase-6 history and any turn or
// task sent without an explicit channel.
export const GENERAL_CHANNEL = "general"

// Seed the General channel and fold the legacy single-thread 'main' history into
// it. Idempotent: INSERT OR IGNORE no-ops once General exists, and the backfill
// only rewrites rows still tagged 'main'.
db.query("INSERT OR IGNORE INTO orchestrator_channels (id, name, cwd, created_at) VALUES (?, 'General', NULL, ?)").run(
  GENERAL_CHANNEL,
  Date.now(),
)
db.query("UPDATE orchestrator_turns SET thread_id = ? WHERE thread_id = ?").run(GENERAL_CHANNEL, "main")
db.query("UPDATE orchestrator_tasks SET thread_id = ? WHERE thread_id = ?").run(GENERAL_CHANNEL, "main")

export type TurnRole = "user" | "orchestrator" | "worker"
// proposed → (approve | auto) → dispatched → running → done | error ; (reject) → rejected
// Backpressure (Phase 7): past the WIP cap an admitted task parks as queued and
// drains FIFO into dispatched when a live worker exits. cancelled = user pulled a
// queued/dispatched/running task (its tmux worker is killed).
export type TaskStatus = "proposed" | "queued" | "dispatched" | "running" | "done" | "error" | "rejected" | "cancelled"

// Statuses that hold a worker slot against the WIP cap.
export const LIVE_STATUSES: readonly TaskStatus[] = ["dispatched", "running"]

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
  logTail: string | null
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
  log_tail: string | null
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
    logTail: r.log_tail,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ---- turns ----------------------------------------------------------------

export function appendTurn(role: TurnRole, text: string, taskId: string | null = null, threadId: string = GENERAL_CHANNEL): Turn {
  const turn: Turn = { id: randomUUID(), threadId, role, text, taskId, createdAt: Date.now() }
  db.query(
    "INSERT INTO orchestrator_turns (id, thread_id, role, text, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(turn.id, turn.threadId, turn.role, turn.text, turn.taskId, turn.createdAt)
  return turn
}

export function getThread(threadId: string = GENERAL_CHANNEL, limit = 200): Turn[] {
  const rows = db
    .query("SELECT * FROM orchestrator_turns WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?")
    .all(threadId, limit) as TurnRow[]
  return rows.map(toTurn)
}

// ---- dispatch tasks -------------------------------------------------------

function insertTask(task: Task): void {
  db.query(
    "INSERT INTO orchestrator_tasks (task_id, thread_id, prompt, cwd, session_key, tmux_session, reasoning, log_tail, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    task.taskId, task.threadId, task.prompt, task.cwd, task.sessionKey,
    task.tmuxSession, task.reasoning, task.logTail, task.status, task.createdAt, task.updatedAt,
  )
}

// Direct dispatch (Phase 1, manual /dispatch): task is spawned immediately.
export function createTask(prompt: string, cwd: string, tmuxSession: string | null = null, threadId: string = GENERAL_CHANNEL): Task {
  const now = Date.now()
  const task: Task = {
    taskId: randomUUID().slice(0, 8), threadId, prompt, cwd,
    sessionKey: null, tmuxSession, reasoning: null, logTail: null, status: "dispatched", createdAt: now, updatedAt: now,
  }
  insertTask(task)
  return task
}

// Manual /dispatch that hit the WIP cap (Phase 7): recorded now, spawned by the
// queue drain once a worker slot frees. No tmux session until then.
export function createQueuedTask(prompt: string, cwd: string, threadId: string = GENERAL_CHANNEL): Task {
  const now = Date.now()
  const task: Task = {
    taskId: randomUUID().slice(0, 8), threadId, prompt, cwd,
    sessionKey: null, tmuxSession: null, reasoning: null, logTail: null, status: "queued", createdAt: now, updatedAt: now,
  }
  insertTask(task)
  return task
}

// Propose-confirm (Phase 2): the brain proposes a dispatch; nothing spawns until
// the user approves (setTaskSpawn flips it to dispatched).
export function createProposal(prompt: string, cwd: string, reasoning: string, threadId: string = GENERAL_CHANNEL): Task {
  const now = Date.now()
  const task: Task = {
    taskId: randomUUID().slice(0, 8), threadId, prompt, cwd,
    sessionKey: null, tmuxSession: null, reasoning, logTail: null, status: "proposed", createdAt: now, updatedAt: now,
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

// Final pane snapshot for the collapsed worker card (hybrid output model): live
// lines stream transiently over WS while running; only this last tail persists.
export function setTaskLogTail(taskId: string, logTail: string): void {
  db.query("UPDATE orchestrator_tasks SET log_tail = ?, updated_at = ? WHERE task_id = ?").run(logTail, Date.now(), taskId)
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

// List tasks, optionally scoped to one channel. threadId omitted → all channels
// (the Tasks panel's global view); scoped → that channel's dispatched work.
export function listTasks(threadId?: string): Task[] {
  const rows = threadId
    ? (db.query("SELECT * FROM orchestrator_tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT 100").all(threadId) as TaskRow[])
    : (db.query("SELECT * FROM orchestrator_tasks ORDER BY created_at DESC LIMIT 100").all() as TaskRow[])
  return rows.map(toTask)
}

// ---- backpressure (PRJ-OR1T Phase 7) --------------------------------------

// Workers currently holding a slot: dispatched (spawned, prompt in flight) or
// running (bound to a session). Queued/proposed tasks hold nothing.
export function countLiveTasks(): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM orchestrator_tasks WHERE status IN ('dispatched', 'running')")
    .get() as { n: number }
  return row.n
}

// FIFO: oldest queued task first — the order the user admitted them.
export function listQueued(): Task[] {
  const rows = db
    .query("SELECT * FROM orchestrator_tasks WHERE status = 'queued' ORDER BY created_at ASC")
    .all() as TaskRow[]
  return rows.map(toTask)
}

// ---- channels (PRJ-OR1T Phase 6) ------------------------------------------

// Trust ramp (Phase 7): how this channel's proposals have fared. approved = the
// user (or auto mode) let it run; rejected = tapped reject; streak = consecutive
// approvals since the last reject, newest first. eligible flags a streak long
// enough that the client may suggest auto-dispatch — the server never flips it.
export interface ChannelTrust {
  approved: number
  rejected: number
  streak: number
  eligible: boolean
}

export const AUTO_ELIGIBLE_STREAK = 5

export interface Channel {
  id: string
  name: string
  cwd: string | null
  createdAt: number
  archived: boolean
  autoDispatch: boolean
  trust: ChannelTrust
}

interface ChannelRow {
  id: string
  name: string
  cwd: string | null
  created_at: number
  archived: number
  auto_dispatch: number
}

// Proposals are the tasks that carry brain reasoning; manual /dispatch tasks
// don't count toward trust because the user never had a proposal to judge.
export function channelTrust(threadId: string): ChannelTrust {
  const rows = db
    .query(
      "SELECT status FROM orchestrator_tasks WHERE thread_id = ? AND reasoning IS NOT NULL AND status != 'proposed' ORDER BY created_at DESC LIMIT 200",
    )
    .all(threadId) as { status: TaskStatus }[]
  let approved = 0
  let rejected = 0
  let streak = 0
  let streakOpen = true
  for (const r of rows) {
    if (r.status === "rejected") {
      rejected++
      streakOpen = false
    } else {
      approved++
      if (streakOpen) streak++
    }
  }
  return { approved, rejected, streak, eligible: streak >= AUTO_ELIGIBLE_STREAK }
}

function toChannel(r: ChannelRow): Channel {
  return {
    id: r.id, name: r.name, cwd: r.cwd, createdAt: r.created_at, archived: !!r.archived,
    autoDispatch: !!r.auto_dispatch, trust: channelTrust(r.id),
  }
}

// Flip a channel's auto-dispatch. Returns the updated channel, null if unknown.
export function setChannelAuto(id: string, enabled: boolean): Channel | null {
  db.query("UPDATE orchestrator_channels SET auto_dispatch = ? WHERE id = ?").run(enabled ? 1 : 0, id)
  return getChannel(id)
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "channel"
}

export function listChannels(): Channel[] {
  const rows = db
    .query("SELECT * FROM orchestrator_channels WHERE archived = 0 ORDER BY created_at ASC")
    .all() as ChannelRow[]
  return rows.map(toChannel)
}

export function getChannel(id: string): Channel | null {
  const row = db.query("SELECT * FROM orchestrator_channels WHERE id = ?").get(id) as ChannelRow | null
  return row ? toChannel(row) : null
}

// Create a user-defined channel. The id is a slug of the name, disambiguated with
// a -N suffix on collision so two "TLS Dashboard" channels can coexist.
export function createChannel(name: string, cwd: string | null = null): Channel {
  const base = slugify(name)
  let id = base
  for (let n = 2; getChannel(id); n++) id = `${base}-${n}`
  const ch: Channel = {
    id, name: name.trim(), cwd: cwd?.trim() || null, createdAt: Date.now(), archived: false,
    autoDispatch: false, trust: { approved: 0, rejected: 0, streak: 0, eligible: false },
  }
  db.query("INSERT INTO orchestrator_channels (id, name, cwd, created_at, archived, auto_dispatch) VALUES (?, ?, ?, ?, 0, 0)").run(
    ch.id, ch.name, ch.cwd, ch.createdAt,
  )
  return ch
}
