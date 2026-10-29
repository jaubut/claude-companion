import { db } from "./orchestrator-db"
import { type DispatchTask, phaseOf } from "./dispatch-tasks"

// brain-v2 trace rows (docs/brain-api.md): the brain thread rendered as a
// trace — turn → repo → agent → pr, approvals and questions beside them.
// Server-owned records with a stable id, a parent id and a monotonic `seq`;
// written only through upsertRow(), which bumps seq. Transitions go
// pending → running → done | error, and a terminal row never reopens (a retry
// is a new id). wiring/brain.ts announces every changed row in a `brain_trace` frame.

db.exec(`
  CREATE TABLE IF NOT EXISTS brain_trace (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    turn_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    ref TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    seq INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_brain_trace_seq ON brain_trace (seq);
`)

export type TraceKind = "turn" | "repo" | "agent" | "pr" | "approval" | "question" | "voice" | "lead" | "step" | "todo" | "worker"
export type TraceStatus = "pending" | "running" | "done" | "error"

export interface TraceRef {
  taskId?: string
  prUrl?: string
  approvalId?: string
  questionId?: string
  host?: string
  sessionKey?: string
  audioId?: string
  /** A step row: what the brain is doing (BrainActivityKind), for the line's icon. */
  step?: string
  /** A worker row: the herdr workspace the brain-workers reaper closed. */
  workspaceId?: string
}

export interface TraceRow {
  id: string
  parentId: string | null
  turnId: string | null
  kind: TraceKind
  status: TraceStatus
  title: string
  detail: string | null
  ref: TraceRef
  startedAt: number
  endedAt: number | null
  seq: number
}

export interface RowInput {
  id: string
  parentId?: string | null
  turnId?: string | null
  kind: TraceKind
  status: TraceStatus
  title: string
  detail?: string | null
  ref?: TraceRef
}

/** Parent of an approval / question no agent row claims: the client groups these under "Needs you". */
export const NEEDS_YOU = "needs-you"
const TITLE_MAX = 160
const DETAIL_MAX = 500

/** The id scheme — stable, so a later write for the same thing updates the same row. */
export const rowId = {
  turn: (turnId: string): string => `turn:${turnId}`,
  repo: (turnId: string, repo: string): string => `repo:${turnId}:${repo}`,
  /** `taskId` = the Companion proposal id (8 chars); ref.taskId carries the Turso id once filed. */
  agent: (taskId: string): string => `agent:${taskId}`,
  pr: (taskId: string): string => `pr:${taskId}`,
  approval: (id: string): string => `appr:${id}`,
  question: (id: string): string => `q:${id}`,
  voice: (turnId: string): string => `voice:${turnId}`,
  lead: (name: string, turnId: string): string => `lead:${name}:${turnId}`,
  step: (toolUseId: string): string => `step:${toolUseId}`,
  worker: (proposalId: string): string => `worker:${proposalId}`,
}

const TERMINAL = new Set<TraceStatus>(["done", "error"])

interface Row {
  id: string; parent_id: string | null; turn_id: string | null; kind: TraceKind; status: TraceStatus
  title: string; detail: string | null; ref: string | null; started_at: number; ended_at: number | null; seq: number
}

function parseRef(raw: string | null): TraceRef {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === "object" && !Array.isArray(v) ? v as TraceRef : {}
  } catch {
    return {}
  }
}

function toRow(r: Row): TraceRow {
  return {
    id: r.id, parentId: r.parent_id, turnId: r.turn_id, kind: r.kind, status: r.status, title: r.title,
    detail: r.detail, ref: parseRef(r.ref), startedAt: r.started_at, endedAt: r.ended_at, seq: r.seq,
  }
}

export function getRow(id: string): TraceRow | null {
  const r = db.query("SELECT * FROM brain_trace WHERE id = ?").get(id) as Row | null
  return r ? toRow(r) : null
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/**
 * Insert or update one row, bumping `seq`. Returns the row as written, or null
 * when nothing changed — including any write to a terminal row (never reopens).
 * Fields left undefined keep their stored value.
 */
export function upsertRow(input: RowInput, now = Date.now()): TraceRow | null {
  const prev = getRow(input.id)
  if (prev && TERMINAL.has(prev.status)) return null
  const next = {
    parentId: input.parentId !== undefined ? input.parentId : prev?.parentId ?? null,
    turnId: input.turnId !== undefined ? input.turnId : prev?.turnId ?? null,
    title: clip(input.title, TITLE_MAX),
    detail: input.detail !== undefined ? (input.detail === null ? null : clip(input.detail, DETAIL_MAX)) : prev?.detail ?? null,
    ref: { ...(prev?.ref ?? {}), ...(input.ref ?? {}) },
  }
  if (prev && prev.status === input.status && prev.parentId === next.parentId && prev.title === next.title
    && prev.detail === next.detail && JSON.stringify(prev.ref) === JSON.stringify(next.ref)) return null
  const seq = (db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM brain_trace").get() as { n: number }).n
  const endedAt = TERMINAL.has(input.status) ? now : null
  const startedAt = prev?.startedAt ?? now
  db.query(
    "INSERT INTO brain_trace (id, parent_id, turn_id, kind, status, title, detail, ref, started_at, ended_at, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
    + "ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, turn_id = excluded.turn_id, status = excluded.status, title = excluded.title, "
    + "detail = excluded.detail, ref = excluded.ref, ended_at = excluded.ended_at, seq = excluded.seq, updated_at = excluded.updated_at",
  ).run(input.id, next.parentId, next.turnId, input.kind, input.status, next.title, next.detail, JSON.stringify(next.ref), startedAt, endedAt, seq, now)
  return { id: input.id, parentId: next.parentId, turnId: next.turnId, kind: input.kind, status: input.status, title: next.title, detail: next.detail, ref: next.ref, startedAt, endedAt, seq }
}

/** Rows with seq > `since`, in seq order (the snapshot and GET /api/brain/trace). */
export function rowsSince(since = 0, limit = 500): TraceRow[] {
  return (db.query("SELECT * FROM brain_trace WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(since, limit) as Row[]).map(toRow)
}

/** The newest `limit` rows in seq order: what a reconnecting socket gets. */
export function latestRows(limit = 300): TraceRow[] {
  return (db.query("SELECT * FROM brain_trace ORDER BY seq DESC LIMIT ?").all(limit) as Row[]).reverse().map(toRow)
}

function dispatchStatus(t: DispatchTask): { status: TraceStatus; detail: string | null } {
  const phase = phaseOf(t)
  if (phase === "running") return { status: "running", detail: t.owner ? `running on ${t.owner}` : "running" }
  if (phase === "blocked") return { status: "pending", detail: `blocked: ${t.blocker ?? "unspecified"}` }
  if (phase === "pr" || phase === "completed" || phase === "done") return { status: "done", detail: phase === "pr" ? "PR ready" : phase }
  if (phase === "failed" || phase === "cancelled") return { status: "error", detail: phase }
  return { status: "pending", detail: phase === "none" ? null : phase }
}

/**
 * A brain-proposed dispatch task moved: its agent row follows the Turso status
 * and a PR gets its own row under it. Only rows the brain created (an agent row
 * exists for the proposal) are traced; every other task stays off the trace.
 */
export function traceForDispatch(t: DispatchTask, proposalId: string, now = Date.now()): TraceRow[] {
  const agentId = rowId.agent(proposalId)
  const agent = getRow(agentId)
  if (!agent) return []
  const out: TraceRow[] = []
  const s = dispatchStatus(t)
  const a = upsertRow({ id: agentId, kind: "agent", status: s.status, title: agent.title, detail: s.detail, ref: { taskId: t.id } }, now)
  if (a) out.push(a)
  if (t.prUrl) {
    const pr = upsertRow({ id: rowId.pr(proposalId), parentId: agentId, turnId: agent.turnId, kind: "pr", status: "done", title: t.title, detail: t.prUrl, ref: { taskId: t.id, prUrl: t.prUrl } }, now)
    if (pr) out.push(pr)
  }
  return out
}

export interface ApprovalTrace {
  kind: "approval" | "question"
  id: string
  title: string
  detail?: string | null
  parentId: string | null
  sessionKey?: string
  /** Set once it ended: the decision / outcome word, shown as the row's detail. */
  ended?: string
}

/** An approval or question: pending while it waits, done once decided / answered / expired. */
export function traceForApproval(a: ApprovalTrace, now = Date.now()): TraceRow[] {
  const id = a.kind === "approval" ? rowId.approval(a.id) : rowId.question(a.id)
  const ref: TraceRef = a.kind === "approval" ? { approvalId: a.id } : { questionId: a.id }
  if (a.sessionKey) ref.sessionKey = a.sessionKey
  const row = a.ended
    ? upsertRow({ id, kind: a.kind, status: a.ended === "deny" || a.ended === "denied" ? "error" : "done", title: a.title, detail: a.ended, ref }, now)
    : upsertRow({ id, parentId: a.parentId ?? NEEDS_YOU, kind: a.kind, status: "pending", title: a.title, detail: a.detail ?? null, ref }, now)
  return row ? [row] : []
}
