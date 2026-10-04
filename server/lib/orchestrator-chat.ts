import { randomUUID } from "node:crypto"
import { GENERAL_CHANNEL, db } from "./orchestrator-db"

// Single-thread orchestrator (PRJ-OR1T Phase 1). One always-open chat thread per
// host; every user message and every dispatched-worker reply lands in it, tagged
// by task. Turns and local tasks; the sqlite store is orchestrator-db.ts and the
// channel roster orchestrator-channels.ts.

export type TurnRole = "user" | "orchestrator" | "worker"
// proposed → (approve | auto) → dispatched → running → done | error ; (reject) → rejected
// Backpressure (Phase 7): past the WIP cap an admitted task parks as queued and
// drains FIFO into dispatched when a live worker exits. cancelled = user pulled a
// queued/dispatched/running task (its tmux worker is killed).
// filed (orchestrator-one-queue P2) = approved and handed to Turso `tasks`
// under dispatch_task_id; the local row is history, listTasks hides it.
export type TaskStatus = "proposed" | "queued" | "dispatched" | "running" | "done" | "error" | "rejected" | "cancelled" | "filed"

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
  // Socket path of the tmux server holding tmuxSession (COMPANION_TMUX_SOCKET).
  // null/absent = the default server.
  tmuxSocket?: string | null
  reasoning: string | null
  logTail: string | null
  status: TaskStatus
  createdAt: number
  updatedAt: number
  // Proposal target (P2): the Turso project note + agent it files to, and the
  // Turso id it was (or is being) filed as. Absent on legacy rows.
  noteId?: string | null
  agent?: string | null
  title?: string | null
  dispatchTaskId?: string | null
}

/** Where a proposal files to; every field optional (resolved at approve time). */
export interface ProposalTarget { noteId?: string | null; agent?: string | null; title?: string | null }

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
  tmux_socket: string | null
  reasoning: string | null
  log_tail: string | null
  status: TaskStatus
  created_at: number
  updated_at: number
  note_id: string | null
  agent: string | null
  title: string | null
  dispatch_task_id: string | null
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
    tmuxSocket: r.tmux_socket ?? null,
    reasoning: r.reasoning,
    logTail: r.log_tail,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    noteId: r.note_id ?? null,
    agent: r.agent ?? null,
    title: r.title ?? null,
    dispatchTaskId: r.dispatch_task_id ?? null,
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

// The most recent `limit` turns, oldest-first.
//
// It used to select the OLDEST `limit` (ORDER BY created_at ASC LIMIT ?), so a
// channel past the limit froze: every new turn — worker replies included — was
// written, logged, and then invisible to both callers. Confirmed on the Linux host
// #General at 200 turns during the Phase 8 e2e (2026-09-09).
//
// Two callers, and the bug hurt each differently: routes/orchestrator.ts's
// /thread stopped showing the phone anything new, and wiring/orchestrator.ts
// fed brainDecide the channel's oldest 200 turns as "context" — so the brain
// was reasoning off frozen history on exactly the busy channels where context
// matters most.
//
// `rowid` breaks ties: created_at is Date.now(), so turns appended in the same
// millisecond are indistinguishable by it, and a tie straddling the LIMIT
// boundary would drop an arbitrary one of them. The table has an implicit
// rowid (id is TEXT PRIMARY KEY, not WITHOUT ROWID), monotonic in insert
// order. Select newest-first, then reverse in memory so callers keep the
// ascending order they have always been given.
export function getThread(threadId: string = GENERAL_CHANNEL, limit = 200): Turn[] {
  const rows = db
    .query("SELECT * FROM orchestrator_turns WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(threadId, limit) as TurnRow[]
  return rows.reverse().map(toTurn)
}

// ---- dispatch tasks -------------------------------------------------------

function insertTask(task: Task): void {
  db.query(
    "INSERT INTO orchestrator_tasks (task_id, thread_id, prompt, cwd, session_key, tmux_session, tmux_socket, reasoning, log_tail, status, created_at, updated_at, note_id, agent, title) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    task.taskId, task.threadId, task.prompt, task.cwd, task.sessionKey,
    task.tmuxSession, task.tmuxSocket || null, task.reasoning, task.logTail, task.status, task.createdAt, task.updatedAt,
    task.noteId ?? null, task.agent ?? null, task.title ?? null,
  )
}

// Legacy (pre-P2) local rows: no production caller since P4 — headless work is
// filed to Turso and live runs start from a proposal row (createProposal +
// stampDispatchId). Kept for the legacy-history fixtures in the tests.
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
export function createProposal(prompt: string, cwd: string, reasoning: string, threadId: string = GENERAL_CHANNEL, target: ProposalTarget = {}): Task {
  const now = Date.now()
  const task: Task = {
    taskId: randomUUID().slice(0, 8), threadId, prompt, cwd,
    sessionKey: null, tmuxSession: null, reasoning, logTail: null, status: "proposed", createdAt: now, updatedAt: now,
    noteId: target.noteId ?? null, agent: target.agent ?? null, title: target.title ?? null, dispatchTaskId: null,
  }
  insertTask(task)
  return task
}

// Approve a proposal: record the spawned worker's tmux session (and the server
// it is on — "" / null = default) and flip to dispatched so reconcileDispatch
// picks it up and delivers the prompt.
export function setTaskSpawn(taskId: string, tmuxSession: string | null, tmuxSocket: string | null = null): void {
  db.query("UPDATE orchestrator_tasks SET tmux_session = ?, tmux_socket = ?, status = 'dispatched', updated_at = ? WHERE task_id = ?").run(
    tmuxSession,
    tmuxSocket || null,
    Date.now(),
    taskId,
  )
}

// ---- filing (orchestrator-one-queue P2) -------------------------------------

/**
 * Stamp the Turso id a proposal will be filed as, BEFORE the Turso insert, so a
 * retried approve reuses it (INSERT OR IGNORE → never two rows). COALESCE keeps
 * the first id if two approves race. Returns the stamped id, null unless proposed.
 */
export function stampDispatchId(taskId: string, freshId: string): string | null {
  db.query("UPDATE orchestrator_tasks SET dispatch_task_id = COALESCE(dispatch_task_id, ?) WHERE task_id = ? AND status = 'proposed'").run(freshId, taskId)
  const row = db.query("SELECT dispatch_task_id, status FROM orchestrator_tasks WHERE task_id = ?").get(taskId) as
    | { dispatch_task_id: string | null; status: TaskStatus }
    | null
  return row?.status === "proposed" ? row.dispatch_task_id : null
}

/** proposed → filed once the Turso row exists. False when it was not proposed. */
export function markFiled(taskId: string, target: { noteId: string; agent: string }): boolean {
  const res = db.query(
    "UPDATE orchestrator_tasks SET status = 'filed', note_id = ?, agent = ?, updated_at = ? WHERE task_id = ? AND status = 'proposed' AND dispatch_task_id IS NOT NULL",
  ).run(target.noteId, target.agent, Date.now(), taskId)
  return res.changes > 0
}

/** Live run (P4): pin the cwd / note / agent a proposal runs with, while still proposed. */
export function setLiveTarget(taskId: string, target: { cwd: string; noteId: string; agent: string }): boolean {
  const res = db.query(
    "UPDATE orchestrator_tasks SET cwd = ?, note_id = ?, agent = ?, updated_at = ? WHERE task_id = ? AND status = 'proposed'",
  ).run(target.cwd, target.noteId, target.agent, Date.now(), taskId)
  return res.changes > 0
}

export function getTaskByDispatchId(dispatchTaskId: string): Task | null {
  const row = db.query("SELECT * FROM orchestrator_tasks WHERE dispatch_task_id = ?").get(dispatchTaskId) as TaskRow | null
  return row ? toTask(row) : null
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

// ---- worker identity matchers (PRJ-OR1T Phase 8) ---------------------------
//
// Correlating a hook event back to its task by cwd alone breaks the moment two
// workers share a directory. These are the identity-first lookups the resolver
// (lib/worker-identity.ts) walks before it ever falls back to cwd: the task id
// the worker carries in its env, then the tmux session it lives in. Each one
// filters on the status the event expects, so a task that is already bound (or
// already closed) never matches a second time.

// Tier 1, bind: the exact task this worker was dispatched as — only while it is
// still waiting for a session. A bound task returns null so a re-emitted
// session frame can't re-fire its prompt.
export function matchUnboundTaskById(taskId: string): Task | null {
  const row = db
    .query("SELECT * FROM orchestrator_tasks WHERE task_id = ? AND session_key IS NULL AND status = 'dispatched'")
    .get(taskId) as TaskRow | null
  return row ? toTask(row) : null
}

// Tier 1, close: the exact task this turn-end belongs to, only while it runs.
export function findRunningTaskById(taskId: string): Task | null {
  const row = db
    .query("SELECT * FROM orchestrator_tasks WHERE task_id = ? AND status = 'running'")
    .get(taskId) as TaskRow | null
  return row ? toTask(row) : null
}

// Tier 2, bind: we spawned every worker into a named tmux session, so the pane's
// session name identifies it even when the hook carries no task id.
export function matchUnboundTaskByTmuxSession(tmuxSession: string): Task | null {
  const row = db
    .query("SELECT * FROM orchestrator_tasks WHERE tmux_session = ? AND session_key IS NULL AND status = 'dispatched' ORDER BY created_at ASC LIMIT 1")
    .get(tmuxSession) as TaskRow | null
  return row ? toTask(row) : null
}

// Tier 2, close.
export function findRunningTaskByTmuxSession(tmuxSession: string): Task | null {
  const row = db
    .query("SELECT * FROM orchestrator_tasks WHERE tmux_session = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1")
    .get(tmuxSession) as TaskRow | null
  return row ? toTask(row) : null
}

// The ambiguity gate: how many tasks in this cwd a cwd-only match would have to
// choose between. 1 → the cwd is identity enough (today's behaviour); 2+ → the
// resolver must find real identity or refuse.
export function countUnboundTasksInCwd(cwd: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM orchestrator_tasks WHERE cwd = ? AND session_key IS NULL AND status = 'dispatched'")
    .get(cwd) as { n: number }
  return row.n
}

export function countRunningTasksInCwd(cwd: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM orchestrator_tasks WHERE cwd = ? AND status = 'running'")
    .get(cwd) as { n: number }
  return row.n
}

// List tasks, optionally scoped to one channel. threadId omitted → all channels
// (the Tasks panel's global view); scoped → that channel's dispatched work.
// Filed proposals are hidden: their Turso task is listed instead (P2). So are
// live runs (P4): a local worker row linked to a Turso id past `proposed` — the
// Turso row carries its tmux identity.
const LISTED = "status != 'filed' AND (dispatch_task_id IS NULL OR status IN ('proposed', 'rejected'))"

export function listTasks(threadId?: string): Task[] {
  const rows = threadId
    ? (db.query(`SELECT * FROM orchestrator_tasks WHERE thread_id = ? AND ${LISTED} ORDER BY created_at DESC LIMIT 100`).all(threadId) as TaskRow[])
    : (db.query(`SELECT * FROM orchestrator_tasks WHERE ${LISTED} ORDER BY created_at DESC LIMIT 100`).all() as TaskRow[])
  return rows.map(toTask)
}

// Every local worker row that may still hold a tmux worker (dispatched/running),
// listed or not — the worker tail resumes these on boot.
export function listLiveTasks(): Task[] {
  return (db.query("SELECT * FROM orchestrator_tasks WHERE status IN ('dispatched', 'running') ORDER BY created_at ASC").all() as TaskRow[]).map(toTask)
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
