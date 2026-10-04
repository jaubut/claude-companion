import { randomUUID } from "node:crypto"
import { readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Task, TaskStatus } from "./orchestrator-chat"
import type { ExecFn, QueryFn, Row, SqlArg } from "./turso"

// Turso `tasks` as the one work queue (orchestrator-one-queue). P1 = read path:
// the dispatch task model, the shared task DTO (local + Turso), and the named
// read queries. P2 = the only Companion writes: file, cancel, requeue, unblock —
// each a guarded compare-and-set plus one agent_activity row. Every function
// takes its QueryFn / ExecFn so tests inject a fake.
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
  /** Local proposals only: the Turso id it was filed as (status "filed"). */
  dispatchTaskId?: string | null
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
  const proposal = t.status === "proposed" || t.status === "rejected" || t.status === "filed"
  // Spread first: every field the local frame carried before stays (additive).
  return {
    ...t,
    source: proposal ? "proposal" : "local", dispatchStatus: null, agent: t.agent ?? null, noteId: t.noteId ?? null,
    projectTitle: null, prUrl: null, resultRef: null, blocker: null, dispatchTaskId: t.dispatchTaskId ?? null,
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

// ── writes (P2) ──────────────────────────────────────────────────────────────
// State machine (dispatch.sh semantics): cancel queued|blocked|failed → cancelled
// (done=1); requeue blocked|failed|cancelled|completed-not-done → queued (done=0,
// run fields cleared); unblock blocked → queued with the answer appended to
// description. A running task is never touched here (it belongs to its runner).

/** Skill names dispatch-run de-aliases (dispatch-run.ts AGENT_ALIASES). */
export const AGENT_ALIASES: Readonly<Record<string, string>> = {
  build: "builder", "frontend-design": "builder", "seo-audit": "claude", "business-profiler": "claude",
}
export const DEFAULT_AGENT = "builder"
export const ANSWER_MAX = 4000
export const TITLE_MAX = 120

function agentsDir(): string {
  return process.env.COMPANION_AGENTS_DIR || join(process.env.HOME || homedir(), ".claude", "agents")
}

/** Agents dispatch-run can start: ~/.claude/agents/*.md plus the catch-all `claude`. */
export function agentAllowlist(dir: string = agentsDir()): Set<string> {
  const set = new Set(["claude"])
  try {
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) set.add(f.slice(0, -3))
  } catch { /* no agents dir on this host */ }
  return set
}

/** "agent:Builder" / "build" → "builder"; null when dispatch-run could not start it. */
export function resolveAgent(raw: string | null | undefined, allow: ReadonlySet<string> = agentAllowlist()): string | null {
  const bare = (raw ?? "").trim().toLowerCase().replace(/^(agent:)+/, "")
  const slug = AGENT_ALIASES[bare] ?? bare
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) && allow.has(slug) ? slug : null
}

/** A fresh Turso task id: 32 lowercase hex, disjoint from the 8-char local ids. */
export function newDispatchId(): string {
  return randomUUID().replace(/-/g, "")
}

/** A Turso task id: 32-hex (Companion, dispatch tools) or a dashed UUID (dashboard). Local ids are 8 chars. */
export const DISPATCH_ID = /^[A-Za-z0-9-]{16,64}$/

export interface WriteCtx {
  exec: ExecFn
  cols: DispatchColumns
  host: string
  /** Channel the command came from (ledger meta). */
  channel: string | null
  now?: () => number
  log?: (msg: string) => void
}

export type WriteOutcome =
  | { ok: true; task: DispatchTask }
  | { ok: false; error: "no_such_task" }
  /** Refused or lost the compare-and-set: `task` is the current, unchanged row. */
  | { ok: false; error: "conflict" | "running"; task: DispatchTask }

const readVia = (exec: ExecFn): QueryFn => async (sql, args) => (await exec(sql, args)).rows

// Append-only ledger row. A failed insert is logged and never undoes the
// transition (dispatch.sh behaves the same).
async function ledger(ctx: WriteCtx, t: Pick<DispatchTask, "id" | "agent">, to: string, summary: string, extra: Record<string, unknown> = {}): Promise<void> {
  const meta = JSON.stringify({ source: "companion", host: ctx.host, channel: ctx.channel, ...extra })
  try {
    await ctx.exec(
      "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [t.agent ?? "unknown", `dispatch:${to}`, "task", t.id, summary.slice(0, 200), meta],
    )
  } catch (err) {
    ctx.log?.(`[dispatch] ledger insert failed for ${t.id.slice(0, 8)} (${(err as Error)?.message ?? "error"})`)
  }
}

export interface FileInput { id: string; noteId: string; agent: string; title: string; description: string }

/**
 * Insert a queued agent task under a pre-generated id. INSERT OR IGNORE: a
 * replay with the same id is a no-op (inserted=false) and writes no ledger row.
 */
export async function fileTask(ctx: WriteCtx, input: FileInput): Promise<{ id: string; inserted: boolean }> {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX)
  const { affected } = await ctx.exec(
    "INSERT OR IGNORE INTO tasks (id, note_id, text, description, done, position, assignee, dispatch_status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 0, (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE note_id = ?), ?, 'queued', datetime('now'), datetime('now'))",
    [input.id, input.noteId, title, input.description, input.noteId, `agent:${input.agent}`],
  )
  const inserted = affected > 0
  if (inserted) await ledger(ctx, { id: input.id, agent: input.agent }, "queued", `→queued: ${title}`, { op: "file", note: input.noteId })
  return { id: input.id, inserted }
}

// Requeue resets exactly what dispatch.sh's `queued` resets; the P0 columns only when present.
function requeueSets(cols: DispatchColumns): string[] {
  return [
    "dispatch_status = 'queued'", "updated_at = datetime('now')", "done = 0", "dispatch_run_id = NULL",
    "dispatch_started_at = NULL", "dispatch_completed_at = NULL", "dispatch_blocker = NULL", "dispatch_owner = NULL",
    ...(cols.resultRef ? ["dispatch_result_ref = NULL"] : []),
    ...(cols.prUrl ? ["dispatch_pr_url = NULL"] : []),
  ]
}

interface Transition {
  to: DispatchStatus
  /** Pure pre-check on the current row (the SQL guard below is the real CAS). */
  allowed: (t: DispatchTask) => boolean
  guard: string
  guardArgs: SqlArg[]
  sets: string[]
  setArgs: SqlArg[]
  summary: (t: DispatchTask) => string
  meta?: Record<string, unknown>
}

async function transition(ctx: WriteCtx, id: string, tr: Transition): Promise<WriteOutcome> {
  const query = readVia(ctx.exec)
  const before = await getDispatchTask(query, ctx.cols, id)
  if (!before) return { ok: false, error: "no_such_task" }
  if (before.task.status === "running") return { ok: false, error: "running", task: before.task }
  if (!tr.allowed(before.task)) return { ok: false, error: "conflict", task: before.task }
  const { affected } = await ctx.exec(
    `UPDATE tasks SET ${tr.sets.join(", ")} WHERE id = ? AND (${tr.guard})`,
    [...tr.setArgs, id, ...tr.guardArgs],
  )
  const after = await getDispatchTask(query, ctx.cols, id)
  if (!after) return { ok: false, error: "no_such_task" }
  // 0 rows: another writer (dispatch-run, dispatch.sh, a second phone) moved it first.
  if (affected === 0) return { ok: false, error: after.task.status === "running" ? "running" : "conflict", task: after.task }
  await ledger(ctx, before.task, tr.to, tr.summary(before.task), { from: before.task.status, ...tr.meta })
  return { ok: true, task: after.task }
}

const CANCELLABLE: readonly string[] = ["queued", "blocked", "failed"]
const REQUEUEABLE: readonly string[] = ["blocked", "failed", "cancelled"]

/** queued | blocked | failed → cancelled (done=1). Running → `running` (its runner owns it). */
export function cancelDispatchTask(ctx: WriteCtx, id: string): Promise<WriteOutcome> {
  return transition(ctx, id, {
    to: "cancelled",
    allowed: (t) => !!t.status && CANCELLABLE.includes(t.status),
    guard: "dispatch_status IN ('queued', 'blocked', 'failed')", guardArgs: [],
    sets: ["dispatch_status = 'cancelled'", "updated_at = datetime('now')", "done = 1", "dispatch_completed_at = datetime('now')"],
    setArgs: [],
    summary: (t) => `→cancelled: ${t.title}`,
  })
}

const requeueAllowed = (t: DispatchTask) => (!!t.status && REQUEUEABLE.includes(t.status)) || (t.status === "completed" && !t.done)
const REQUEUE_GUARD = "dispatch_status IN ('blocked', 'failed', 'cancelled') OR (dispatch_status = 'completed' AND done = 0)"

/** blocked | failed | cancelled | completed-not-done → queued, done=0, run fields cleared. */
export function requeueTask(ctx: WriteCtx, id: string): Promise<WriteOutcome> {
  return transition(ctx, id, {
    to: "queued", allowed: requeueAllowed, guard: REQUEUE_GUARD, guardArgs: [],
    sets: requeueSets(ctx.cols), setArgs: [],
    summary: (t) => `→queued: ${t.title}`, meta: { op: "requeue" },
  })
}

/** The text appended to `description`; dispatch-run puts description into the worker's brief. */
export function unblockMarker(answer: string, nowMs: number): string {
  return `\n\n[unblock ${new Date(nowMs).toISOString().slice(0, 10)}] ${answer.trim()}`
}

/** blocked → queued, with the answer appended to description in one guarded UPDATE. */
export function unblockTask(ctx: WriteCtx, id: string, answer: string): Promise<WriteOutcome> {
  const marker = unblockMarker(answer, (ctx.now ?? Date.now)())
  return transition(ctx, id, {
    to: "queued",
    allowed: (t) => t.status === "blocked",
    guard: "dispatch_status = 'blocked'", guardArgs: [],
    sets: ["description = COALESCE(description, '') || ?", ...requeueSets(ctx.cols)], setArgs: [marker],
    summary: () => `→queued (unblock): ${answer.trim()}`,
    meta: { op: "unblock" },
  })
}
