import type { Task, TaskStatus } from "./orchestrator-chat"
import type { QueryFn, Row } from "./turso"

// Turso `tasks` as the one work queue (orchestrator-one-queue). P1 = read path:
// the dispatch task model, the shared task DTO (local + Turso), and the named
// read queries. Every function takes the QueryFn so tests inject a fake.
// Writes (file/cancel/requeue/unblock) arrive in P2, here, guarded.
// Contract: docs/orchestrator-dispatch-api.md.

export type DispatchStatus = "queued" | "running" | "blocked" | "pr" | "completed" | "failed" | "cancelled"
export type TaskSource = "dispatch" | "local" | "proposal"
export type TaskMode = "headless" | "live"

/** One Turso agent task, as read. `status` is the raw Turso state (never "pr"). */
export interface DispatchTask {
  id: string
  noteId: string
  title: string
  agent: string | null
  status: DispatchStatus | null
  done: boolean
  blocker: string | null
  owner: string | null
  prUrl: string | null
  resultRef: string | null
  projectTitle: string | null
  projectRef: string | null
  createdAt: number
  updatedAt: number
  /** Turso's updated_at text, verbatim — the dedupe key uses it, not the parsed ms. */
  updatedAtRaw: string
}

/** The one task shape on the wire: `orchestrator_task` frames and `/thread` tasks[]. */
export interface TaskDto {
  taskId: string
  threadId: string
  prompt: string
  cwd: string
  reasoning: string | null
  status: TaskStatus
  logTail: string | null
  sessionKey: string | null
  tmuxSession: string | null
  createdAt: number
  updatedAt: number
  source: TaskSource
  dispatchStatus: DispatchStatus | null
  agent: string | null
  noteId: string | null
  projectTitle: string | null
  prUrl: string | null
  resultRef: string | null
  blocker: string | null
  done: boolean
  owner: string | null
  mode: TaskMode
  /** Local tasks only: the tmux server holding tmuxSession. */
  tmuxSocket?: string | null
}

/** Optional Turso columns (added by P0); absent on an older schema. */
export interface DispatchColumns {
  prUrl: boolean
  resultRef: boolean
}

const KNOWN: readonly string[] = ["queued", "running", "blocked", "completed", "failed", "cancelled"]
export const BLOCKER_STATES: readonly DispatchStatus[] = ["blocked", "failed"]

// ── mapping ──────────────────────────────────────────────────────────────────

/** "pr" = completed with a PR URL; everything else is the Turso state as-is. */
export function effectiveStatus(t: Pick<DispatchTask, "status" | "prUrl">): DispatchStatus | null {
  return t.status === "completed" && t.prUrl ? "pr" : t.status
}

/** Legacy `status` the shipped iOS build understands. */
export function legacyStatus(s: DispatchStatus | null): TaskStatus {
  switch (s) {
    case "running": return "running"
    case "completed":
    case "pr": return "done"
    case "blocked":
    case "failed": return "error"
    case "cancelled": return "cancelled"
    default: return "queued"
  }
}

/**
 * Announce phase: what a turn/push is keyed on. done=1 outranks the dispatch
 * state (merged / accepted), except a cancel, which also sets done=1.
 */
export function phaseOf(t: DispatchTask): string {
  if (t.done && t.status !== "cancelled") return "done"
  return effectiveStatus(t) ?? "none"
}

/** Announce-cursor value: (dispatch_status, updated_at, done, pr_url). */
export function seenKey(t: DispatchTask): string {
  return JSON.stringify([t.status, t.updatedAtRaw, t.done, t.prUrl])
}

/** Turso datetime('now') text ("YYYY-MM-DD HH:MM:SS", UTC) or ISO → epoch ms. */
export function parseTs(raw: unknown): number {
  if (typeof raw !== "string" || !raw) return 0
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.replace(" ", "T") + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? "" : "Z") : raw
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null
}

export function fromRow(r: Row): DispatchTask {
  const raw = str(r.dispatch_status)
  const assignee = str(r.assignee) ?? ""
  return {
    id: String(r.id),
    noteId: str(r.note_id) ?? "",
    title: str(r.text) ?? "",
    agent: assignee.startsWith("agent:") ? assignee.slice(6) : assignee || null,
    status: raw && KNOWN.includes(raw) ? (raw as DispatchStatus) : null,
    done: Number(r.done ?? 0) === 1,
    blocker: str(r.dispatch_blocker),
    owner: str(r.dispatch_owner),
    prUrl: str(r.dispatch_pr_url),
    resultRef: str(r.dispatch_result_ref),
    projectTitle: str(r.note_title),
    projectRef: str(r.note_ref),
    createdAt: parseTs(r.created_at),
    updatedAt: parseTs(r.updated_at),
    updatedAtRaw: str(r.updated_at) ?? "",
  }
}

// "PR <url> · <verdict>" — completed rows keep the review verdict in dispatch_blocker.
function prSummary(t: DispatchTask): string | null {
  if (!t.prUrl) return null
  const verdict = t.status === "completed" && t.blocker ? ` · ${t.blocker}` : ""
  return `PR ${t.prUrl}${verdict}`
}

export function dispatchToDto(t: DispatchTask, threadId: string): TaskDto {
  const ds = effectiveStatus(t)
  return {
    taskId: t.id, threadId, prompt: t.title, cwd: t.projectTitle ?? t.noteId, reasoning: null,
    status: legacyStatus(ds), logTail: prSummary(t), sessionKey: null, tmuxSession: null,
    createdAt: t.createdAt, updatedAt: t.updatedAt || t.createdAt,
    source: "dispatch", dispatchStatus: ds, agent: t.agent, noteId: t.noteId || null,
    projectTitle: t.projectTitle, prUrl: t.prUrl, resultRef: t.resultRef,
    blocker: t.status && BLOCKER_STATES.includes(t.status) ? t.blocker : null,
    done: t.done, owner: t.owner, mode: t.owner?.startsWith("companion:") ? "live" : "headless",
  }
}

/** A local sqlite task (proposal or legacy tmux worker) in the shared DTO. */
export function toTaskDto(t: Task): TaskDto {
  const proposal = t.status === "proposed" || t.status === "rejected"
  // Spread first: every field the local frame carried before stays (additive).
  return {
    ...t,
    source: proposal ? "proposal" : "local", dispatchStatus: null, agent: null, noteId: null,
    projectTitle: null, prUrl: null, resultRef: null, blocker: null,
    done: t.status === "done" || t.status === "cancelled", owner: null, mode: "live",
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

/** Which optional columns exist. Throws TursoUnreachable like any query. */
export async function detectColumns(query: QueryFn): Promise<DispatchColumns> {
  const rows = await query("SELECT name FROM pragma_table_info('tasks')", [])
  const names = new Set(rows.map((r) => String(r.name)))
  return { prUrl: names.has("dispatch_pr_url"), resultRef: names.has("dispatch_result_ref") }
}

// Column list built from a fixed vocabulary only — never from input.
function selectCols(cols: DispatchColumns): string {
  return [
    "t.id, t.note_id, t.text, t.assignee, t.done, t.created_at, t.updated_at",
    "t.dispatch_status, t.dispatch_blocker, t.dispatch_owner",
    ...(cols.prUrl ? ["t.dispatch_pr_url"] : []),
    ...(cols.resultRef ? ["t.dispatch_result_ref"] : []),
    "n.title AS note_title, n.ref_code AS note_ref",
  ].join(", ")
}

export const POLL_WINDOW_DAYS = 7
export const POLL_LIMIT = 300

/** Agent tasks touched in the last 7 days, plus every still-open one. Newest first. */
export async function listDispatchTasks(query: QueryFn, cols: DispatchColumns): Promise<DispatchTask[]> {
  const rows = await query(
    `SELECT ${selectCols(cols)} FROM tasks t LEFT JOIN notes n ON n.id = t.note_id ` +
      "WHERE t.assignee LIKE 'agent:%' AND t.dispatch_status IS NOT NULL " +
      "AND (t.updated_at >= datetime('now', ?) OR (t.done = 0 AND t.dispatch_status IN ('queued', 'running', 'blocked'))) " +
      "ORDER BY t.updated_at DESC LIMIT ?",
    [`-${POLL_WINDOW_DAYS} days`, POLL_LIMIT],
  )
  return rows.map(fromRow)
}

export async function getDispatchTask(
  query: QueryFn, cols: DispatchColumns, id: string,
): Promise<{ task: DispatchTask; description: string } | null> {
  const rows = await query(
    `SELECT ${selectCols(cols)}, t.description FROM tasks t LEFT JOIN notes n ON n.id = t.note_id WHERE t.id = ?`,
    [id],
  )
  const r = rows[0]
  return r ? { task: fromRow(r), description: str(r.description) ?? "" } : null
}

export interface ActivityItem { action: string; summary: string | null; ts: string }

export async function getTaskActivity(query: QueryFn, id: string): Promise<ActivityItem[]> {
  const rows = await query(
    "SELECT action, summary, ts FROM agent_activity WHERE target_kind = 'task' AND target_id = ? ORDER BY ts DESC, id DESC LIMIT 20",
    [id],
  )
  return rows.map((r) => ({ action: String(r.action ?? ""), summary: str(r.summary), ts: String(r.ts ?? "") }))
}

export const RESULT_EXCERPT_MAX = 4000

export interface TaskResult { ref: string; title: string; excerpt: string }

/**
 * The run's result note: by dispatch_result_ref when set, else (pre-P0 rows)
 * the newest dispatch-result note whose banner names this task.
 */
export async function getTaskResult(query: QueryFn, t: DispatchTask): Promise<TaskResult | null> {
  const rows = t.resultRef
    ? await query("SELECT ref_code, title, body FROM notes WHERE ref_code = ? LIMIT 1", [t.resultRef])
    : await query(
      "SELECT ref_code, title, body FROM notes WHERE type = 'dispatch-result' AND body LIKE ? ORDER BY updated_at DESC LIMIT 1",
      [`%from task \`${t.id}\`%`],
    )
  const r = rows[0]
  if (!r) return null
  return { ref: str(r.ref_code) ?? "", title: str(r.title) ?? "", excerpt: (str(r.body) ?? "").slice(0, RESULT_EXCERPT_MAX) }
}

export interface ProjectRef { noteId: string; ref: string | null; title: string; openAgentTasks: number }

/** Active projects/ notes with their open agent-task count, most recently touched first. */
export async function listProjects(query: QueryFn): Promise<ProjectRef[]> {
  const rows = await query(
    "SELECT n.id, n.ref_code, n.title, " +
      "(SELECT COUNT(*) FROM tasks t WHERE t.note_id = n.id AND t.done = 0 AND t.assignee LIKE 'agent:%') AS open_tasks " +
      "FROM notes n WHERE n.folder = 'projects' AND n.status = 'active' ORDER BY n.updated_at DESC LIMIT 200",
    [],
  )
  return rows.map((r) => ({
    noteId: String(r.id), ref: str(r.ref_code), title: str(r.title) ?? String(r.id), openAgentTasks: Number(r.open_tasks ?? 0),
  }))
}

export async function getNote(query: QueryFn, id: string): Promise<{ noteId: string; title: string | null; ref: string | null } | null> {
  const rows = await query("SELECT id, title, ref_code FROM notes WHERE id = ?", [id])
  const r = rows[0]
  return r ? { noteId: String(r.id), title: str(r.title), ref: str(r.ref_code) } : null
}
