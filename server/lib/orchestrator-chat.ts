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
  // brain-v2 card (docs/brain-api.md). Absent on every turn without one, so
  // those rows serialize byte-identical to before. card.taskId is never copied
  // into taskId: shipped builds group taskId turns as worker output.
  card?: TurnCard
}

/** A brain-thread card: a dispatch receipt or a voice turn from the app. */
export interface TurnCard {
  kind: "dispatch" | "voice"
  source: "app"
  taskId?: string
  audioId?: string
  durationMs?: number
  locale?: string
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
  card?: string | null
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

function parseCard(raw: string | null | undefined): TurnCard | null {
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as unknown
    return c && typeof c === "object" && !Array.isArray(c) ? c as TurnCard : null
  } catch {
    return null
  }
}

function toTurn(r: TurnRow): Turn {
  const card = parseCard(r.card)
  return { id: r.id, threadId: r.thread_id, role: r.role, text: r.text, taskId: r.task_id, createdAt: r.created_at, ...(card ? { card } : {}) }
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

const appendedListeners = new Set<(turn: Turn) => void>()

/** Run `fn` after every appended turn (wiring/brain.ts wakes the brain on its thread's events). */
export function onTurnAppended(fn: (turn: Turn) => void): () => void {
  appendedListeners.add(fn)
  return () => appendedListeners.delete(fn)
}

export function appendTurn(role: TurnRole, text: string, taskId: string | null = null, threadId: string = GENERAL_CHANNEL, card?: TurnCard): Turn {
  const turn: Turn = { id: randomUUID(), threadId, role, text, taskId, createdAt: Date.now(), ...(card ? { card } : {}) }
  db.query(
    "INSERT INTO orchestrator_turns (id, thread_id, role, text, task_id, created_at, card) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(turn.id, turn.threadId, turn.role, turn.text, turn.taskId, turn.createdAt, card ? JSON.stringify(card) : null)
  for (const fn of appendedListeners) {
    try { fn(turn) } catch { /* a listener never fails the write */ }
  }
  return turn
}

export function getTurn(id: string): Turn | null {
  const row = db.query("SELECT * FROM orchestrator_turns WHERE id = ?").get(id) as TurnRow | null
  return row ? toTurn(row) : null
}

/** Merge fields into a turn's card (brain voice take → audioId). Null when the turn has no card. */
export function setTurnCard(id: string, patch: Partial<TurnCard>): Turn | null {
  const turn = getTurn(id)
  if (!turn?.card) return null
  const card: TurnCard = { ...turn.card, ...patch }
  db.query("UPDATE orchestrator_turns SET card = ? WHERE id = ?").run(JSON.stringify(card), id)
  return { ...turn, card }
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

/** Turns of one thread whose text contains `q` (case-insensitive), newest first (the brain's bin/thread). */
export function searchThread(threadId: string, q: string, limit = 20): Turn[] {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = db
    .query("SELECT * FROM orchestrator_turns WHERE thread_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(threadId, like, limit) as TurnRow[]
  return rows.map(toTurn)
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

// Propose-confirm (Phase 2): the brain proposes a dispatch; approve files it to
// Turso (markFiled).
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

export function getTaskByDispatchId(dispatchTaskId: string): Task | null {
  const row = db.query("SELECT * FROM orchestrator_tasks WHERE dispatch_task_id = ?").get(dispatchTaskId) as TaskRow | null
  return row ? toTask(row) : null
}

export function getTask(taskId: string): Task | null {
  const row = db.query("SELECT * FROM orchestrator_tasks WHERE task_id = ?").get(taskId) as TaskRow | null
  return row ? toTask(row) : null
}

export function setTaskStatus(taskId: string, status: TaskStatus): void {
  db.query("UPDATE orchestrator_tasks SET status = ?, updated_at = ? WHERE task_id = ?").run(status, Date.now(), taskId)
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

// Every pending proposal, any channel, oldest first (triage).
export function listProposals(limit = 200): Task[] {
  return (db.query("SELECT * FROM orchestrator_tasks WHERE status = 'proposed' ORDER BY created_at ASC LIMIT ?").all(limit) as TaskRow[]).map(toTask)
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
