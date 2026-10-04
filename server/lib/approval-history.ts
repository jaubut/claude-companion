import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir, hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { redactSecrets } from "./secret-redact"
import { summarize } from "./tool-format"
import type { ApprovalRequest } from "./pty-manager"
import type { QuestionAnswer, QuestionRequest } from "./questions"

// Approval history — a permanent record of every approval and question that
// reached the phone, with how it ended (the `→ phone` path, this file), plus an
// audit trail of every automatic decision (SUPER, auto-judge, learned, read-only
// MCP) written in batches by lib/approval-history-auto.ts as `auto_allowed` /
// `auto_denied` rows. Auto rows are kept COMPANION_HISTORY_AUTO_DAYS (30) days;
// phone rows are permanent. The default list (`state=all`) is phone rows only.
//
// One row per id: a question re-asked under the same id (PreToolUse →
// PermissionRequest, lib/question-hook.ts) is an upsert back to `pending`.
// A resolution only ever moves a row OUT of `pending`, so a late exit (e.g. an
// expiry racing a phone allow) cannot overwrite the first outcome.
//
// Storage: the shared companion.db (COMPANION_DB_PATH honoured), opened lazily.
// Opening it IS the boot reconciliation: rows still `pending` belong to a
// previous process whose hooks are gone, so they end `expired` / `server_restart`.

export type HistoryKind = "approval" | "question"
export type PhoneState = "pending" | "allowed" | "denied" | "expired" | "elsewhere" | "answered"
export type AutoState = "auto_allowed" | "auto_denied"
export type HistoryState = PhoneState | AutoState
export const PHONE_STATES: readonly PhoneState[] = ["pending", "allowed", "denied", "expired", "elsewhere", "answered"]
export const AUTO_STATES: readonly AutoState[] = ["auto_allowed", "auto_denied"]
export const HISTORY_STATES: readonly HistoryState[] = [...PHONE_STATES, ...AUTO_STATES]

export interface HistoryItem {
  id: string
  kind: HistoryKind
  state: HistoryState
  tool: string
  summary: string
  cwd: string
  session_key: string
  session_id: string
  decided_via: string | null
  created_at: string
  resolved_at: string | null
}

export interface HistoryDetail extends HistoryItem {
  host: string
  device_claimed: string | null
  detail: unknown
}

export const SUMMARY_MAX = 500
export const DETAIL_MAX_BYTES = 8192
export const LIST_MAX = 200

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS approval_history (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    state          TEXT NOT NULL,
    tool           TEXT NOT NULL DEFAULT '',
    summary        TEXT NOT NULL DEFAULT '',
    detail_json    TEXT NOT NULL DEFAULT '{}',
    session_key    TEXT NOT NULL DEFAULT '',
    session_id     TEXT NOT NULL DEFAULT '',
    cwd            TEXT NOT NULL DEFAULT '',
    host           TEXT NOT NULL DEFAULT '',
    decided_via    TEXT,
    device_claimed TEXT,
    created_at     TEXT NOT NULL,
    resolved_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approval_history_created ON approval_history(created_at);
  CREATE INDEX IF NOT EXISTS idx_approval_history_state ON approval_history(state);
  CREATE INDEX IF NOT EXISTS idx_approval_history_state_created ON approval_history(state, created_at);
`

const LIST_COLS = "id, kind, state, tool, summary, cwd, session_key, session_id, decided_via, created_at, resolved_at"

let db: Database | null = null

function open(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const d = new Database(path)
  d.exec(SCHEMA)
  reconcileOnBoot(d)
  return d
}

// Under `bun test` with no COMPANION_DB_PATH, never fall through to the real
// ~/.claude-companion/companion.db: a throwaway file instead.
function defaultPath(): string {
  if (process.env.COMPANION_DB_PATH) return process.env.COMPANION_DB_PATH
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `approval-history-${process.pid}.db`)
  return join(homedir(), ".claude-companion", "companion.db")
}

function store(): Database {
  if (!db) db = open(defaultPath())
  return db
}

// The open store, for lib/approval-history-auto.ts (batched auto rows).
export function historyDb(): Database {
  return store()
}

// Test seam (and the explicit boot hook): reopen on `path`, reconciling it.
export function useApprovalHistoryDb(path: string): void {
  try { db?.close() } catch { /* ignore */ }
  db = open(path)
}

type Listener = (item: HistoryItem) => void
const listeners = new Set<Listener>()

export function onApprovalHistory(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(id: string): void {
  if (listeners.size === 0) return
  const item = getRow(id)
  if (!item) return
  for (const fn of listeners) {
    try { fn(item) } catch { /* ignore */ }
  }
}

const nowIso = (): string => new Date().toISOString()

function reconcileOnBoot(d: Database): number {
  const rows = d.query("SELECT id FROM approval_history WHERE state = 'pending'").all() as Array<{ id: string }>
  if (rows.length === 0) return 0
  d.query("UPDATE approval_history SET state = 'expired', decided_via = 'server_restart', resolved_at = ? WHERE state = 'pending'").run(nowIso())
  return rows.length
}

function truncateBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= max) return s
  return buf.subarray(0, max).toString("utf8").replace(/�+$/, "")
}

// Redacted, then capped: the cap can never leave half a secret behind.
export function capDetail(detail: unknown): string {
  const json = redactSecrets(JSON.stringify(detail ?? {}))
  if (Buffer.byteLength(json, "utf8") <= DETAIL_MAX_BYTES) return json
  const wrapped = (p: string): string => JSON.stringify({ truncated: true, preview: p })
  let preview = truncateBytes(json, DETAIL_MAX_BYTES - 64)
  while (Buffer.byteLength(wrapped(preview), "utf8") > DETAIL_MAX_BYTES) preview = preview.slice(0, Math.floor(preview.length * 0.9))
  return wrapped(preview)
}

export function capSummary(summary: string): string {
  return redactSecrets(summary ?? "").slice(0, SUMMARY_MAX)
}

export interface PendingEntry {
  id: string
  kind: HistoryKind
  tool: string
  summary: string
  detail: unknown
  sessionKey: string
  sessionId: string
  cwd: string
}

// Insert on escalation; a re-ask with the same id goes back to pending and
// keeps its created_at.
export function recordPending(e: PendingEntry): void {
  store().query(`
    INSERT INTO approval_history (id, kind, state, tool, summary, detail_json, session_key, session_id, cwd, host, created_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state = 'pending', tool = excluded.tool, summary = excluded.summary, detail_json = excluded.detail_json,
      session_key = excluded.session_key, session_id = excluded.session_id, cwd = excluded.cwd,
      decided_via = NULL, device_claimed = NULL, resolved_at = NULL
  `).run(e.id, e.kind, e.tool, capSummary(e.summary), capDetail(e.detail), e.sessionKey, e.sessionId, e.cwd, hostname(), nowIso())
  emit(e.id)
}

// ── Lifecycle → row mapping (wiring/events.ts calls these) ──

export function approvalEntry(req: ApprovalRequest): PendingEntry {
  return {
    id: req.id,
    kind: "approval",
    tool: req.tool,
    summary: summarize(req.tool, req.input) || req.tool,
    detail: {
      agent: req.agent ?? "claude",
      input: req.input,
      ...(req.reason ? { reason: req.reason } : {}),
      ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
    },
    sessionKey: req.sessionKey,
    sessionId: req.sessionId,
    cwd: req.cwd,
  }
}

export function questionEntry(req: QuestionRequest): PendingEntry {
  const agent = req.agent ?? "claude"
  return {
    id: req.id,
    kind: "question",
    tool: agent === "codex" ? "request_user_input" : "AskUserQuestion",
    summary: req.questions.map((q) => q.question).join(" · "),
    detail: { agent, questions: req.questions },
    sessionKey: req.sessionKey,
    sessionId: req.sessionId,
    cwd: req.cwd,
  }
}

// A question "answered" with no phone answer was answered in the terminal
// picker: that is `elsewhere` here; `answered` means the phone answered.
export function questionEndState(decision: "expired" | "answered"): "expired" | "elsewhere" {
  return decision === "answered" ? "elsewhere" : "expired"
}

export function answersPatch(answers: QuestionAnswer[]): Record<string, unknown> {
  return { answers }
}

export interface OutcomeOpts {
  device?: string
  // Merged into the stored detail (e.g. a question's chosen answers).
  detailPatch?: Record<string, unknown>
}

// Moves a pending row to its end state. False when there is no pending row.
export function recordOutcome(id: string, state: Exclude<PhoneState, "pending">, via: string, opts: OutcomeOpts = {}): boolean {
  const d = store()
  let detailJson: string | null = null
  if (opts.detailPatch) {
    const row = d.query("SELECT detail_json FROM approval_history WHERE id = ? AND state = 'pending'").get(id) as { detail_json: string } | null
    if (!row) return false
    detailJson = capDetail({ ...parseDetail(row.detail_json) as Record<string, unknown>, ...opts.detailPatch })
  }
  const res = d.query(`
    UPDATE approval_history
    SET state = ?, decided_via = ?, device_claimed = ?, resolved_at = ?, detail_json = COALESCE(?, detail_json)
    WHERE id = ? AND state = 'pending'
  `).run(state, via, opts.device || null, nowIso(), detailJson, id)
  if (res.changes === 0) return false
  emit(id)
  return true
}

function parseDetail(json: string): unknown {
  try { return JSON.parse(json) } catch { return {} }
}

function getRow(id: string): HistoryItem | null {
  return (store().query(`SELECT ${LIST_COLS} FROM approval_history WHERE id = ?`).get(id) as HistoryItem | null) ?? null
}

export function getHistoryItem(id: string): HistoryDetail | null {
  const row = store().query(`SELECT ${LIST_COLS}, host, device_claimed, detail_json FROM approval_history WHERE id = ?`).get(id) as
    (HistoryItem & { host: string; device_claimed: string | null; detail_json: string }) | null
  if (!row) return null
  const { detail_json, ...rest } = row
  return { ...rest, detail: parseDetail(detail_json) }
}

export interface HistoryQuery {
  // A HistoryState; "all" (default) = every PHONE state; "resolved" = phone
  // states but pending; "auto" = both auto states; "everything" = all rows.
  state?: string
  kind?: string
  q?: string
  limit?: number
  // Cursor: `next` from the previous page, verbatim (`<created_at>|<id>`); a
  // bare created_at is accepted too.
  before?: string
}

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 50
  return Math.max(1, Math.min(LIST_MAX, Math.floor(raw)))
}

export function listHistory(query: HistoryQuery): { items: HistoryItem[]; next: string | null } {
  const where: string[] = []
  const args: Array<string | number> = []
  const states = statesFor(query.state || "all")
  if (states) { where.push(`state IN (${states.map(() => "?").join(", ")})`); args.push(...states) }
  if (query.kind) { where.push("kind = ?"); args.push(query.kind) }
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push("(summary LIKE ? ESCAPE '\\' OR tool LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')")
    args.push(like, like, like)
  }
  if (query.before) {
    const [at, id] = splitCursor(query.before)
    if (id) { where.push("(created_at < ? OR (created_at = ? AND id < ?))"); args.push(at, at, id) }
    else { where.push("created_at < ?"); args.push(at) }
  }
  const limit = clampLimit(query.limit)
  const sql = `SELECT ${LIST_COLS} FROM approval_history ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`
  const rows = store().query(sql).all(...args, limit + 1) as HistoryItem[]
  const more = rows.length > limit
  const items = more ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return { items, next: more && last ? `${last.created_at}|${last.id}` : null }
}

// The state filter as a list of states; null = no filter ("everything").
function statesFor(filter: string): readonly string[] | null {
  if (filter === "everything") return null
  if (filter === "all") return PHONE_STATES
  if (filter === "resolved") return PHONE_STATES.filter((s) => s !== "pending")
  if (filter === "auto") return AUTO_STATES
  return [filter]
}

export type HistoryCounts = Record<HistoryState, number>

// Rows per state created at/after `sinceIso` (all time when empty). Every
// state is present, zero when none.
export function historyCounts(sinceIso = ""): HistoryCounts {
  const counts = Object.fromEntries(HISTORY_STATES.map((s) => [s, 0])) as HistoryCounts
  const sql = `SELECT state, COUNT(*) AS n FROM approval_history ${sinceIso ? "WHERE created_at >= ?" : ""} GROUP BY state`
  const rows = store().query(sql).all(...(sinceIso ? [sinceIso] : [])) as Array<{ state: string; n: number }>
  for (const r of rows) if (r.state in counts) counts[r.state as HistoryState] = r.n
  return counts
}

function splitCursor(cursor: string): [string, string] {
  const i = cursor.indexOf("|")
  return i < 0 ? [cursor, ""] : [cursor.slice(0, i), cursor.slice(i + 1)]
}

// Manual pruning: deletes resolved rows created before `beforeIso`. Pending
// rows are live cards and are never pruned.
export function pruneHistory(beforeIso: string): number {
  return store().query("DELETE FROM approval_history WHERE created_at < ? AND state != 'pending'").run(beforeIso).changes
}
