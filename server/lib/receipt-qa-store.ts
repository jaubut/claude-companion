import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { companionDbPath } from "./db-path"

// Receipt QA queue (`receipt_qa` in the shared Companion sqlite, see
// db-path.ts). One row per saved expense. The row is the queue: the worker
// (lib/receipt-qa-worker.ts) picks `queued` and `to_review` rows whose
// next_attempt_at has passed, so a restart resumes where it stopped.
//
//   queued → jev_ok | to_review
//   to_review → sonnet_fixed | needs_human
//   needs_human (or any) → human_done   (phone resolve / accept)
//
// `fields` is our snapshot of the expense as saved (and as patched since); the
// dashboard row stays the source of truth for the books.

export const QA_STATUSES = ["queued", "jev_ok", "to_review", "sonnet_fixed", "needs_human", "human_done"] as const
export type QaStatus = typeof QA_STATUSES[number]

export interface QaIssue { field: string; problem: string; suggestion?: string }
export interface QaChange { field: string; from: string; to: string; by: "jev" | "sonnet" | "human" }
export type ExpenseFields = Record<string, string>

export interface QaItem {
  expense_id: string
  merchant: string
  total: string
  date: string
  category: string
  category_code: string
  purpose: string
  status: QaStatus
  issues: QaIssue[]
  changes: QaChange[]
  created_at: string
  updated_at: string
}

export interface QaRow extends QaItem {
  fields: ExpenseFields
  receipt_file: string
  image_path: string
  attempts: number
  next_attempt_at: number
  jev: Record<string, unknown> | null
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS receipt_qa (
    expense_id      TEXT PRIMARY KEY,
    status          TEXT NOT NULL,
    fields_json     TEXT NOT NULL DEFAULT '{}',
    receipt_file    TEXT NOT NULL DEFAULT '',
    image_path      TEXT NOT NULL DEFAULT '',
    issues_json     TEXT NOT NULL DEFAULT '[]',
    changes_json    TEXT NOT NULL DEFAULT '[]',
    jev_json        TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_receipt_qa_status ON receipt_qa(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_receipt_qa_updated ON receipt_qa(updated_at);
`

export const LIST_MAX = 200
const LIST_DEFAULT = 50

let db: Database | null = null

function open(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const d = new Database(path)
  d.exec("PRAGMA busy_timeout = 3000")
  d.exec(SCHEMA)
  return d
}


function store(): Database {
  if (!db) db = open(companionDbPath())
  return db
}

/** Test seam: (re)open on `path` — a restart is a reopen on the same file. */
export function useReceiptQaDb(path: string): void {
  try { db?.close() } catch { /* ignore */ }
  db = open(path)
}

type Listener = (item: QaItem) => void
const listeners = new Set<Listener>()

/** Every status change (incl. the first `queued`). */
export function onReceiptQa(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(id: string): void {
  const row = getQaRow(id)
  if (!row) return
  const item = toItem(row)
  for (const fn of listeners) {
    try { fn(item) } catch { /* a listener never breaks the queue */ }
  }
}

function parse<T>(raw: unknown, fallback: T): T {
  try { return raw == null ? fallback : JSON.parse(String(raw)) as T } catch { return fallback }
}

interface RawRow {
  expense_id: string; status: string; fields_json: string; receipt_file: string; image_path: string
  issues_json: string; changes_json: string; jev_json: string | null; attempts: number; next_attempt_at: number
  created_at: string; updated_at: string
}

function fromRaw(r: RawRow): QaRow {
  const fields = parse<ExpenseFields>(r.fields_json, {})
  const f = (k: string): string => String(fields[k] ?? "")
  return {
    expense_id: r.expense_id,
    merchant: f("merchant"), total: f("total"), date: f("date"), category: f("category"),
    category_code: f("category_code"), purpose: f("purpose"),
    status: r.status as QaStatus,
    issues: parse<QaIssue[]>(r.issues_json, []),
    changes: parse<QaChange[]>(r.changes_json, []),
    created_at: r.created_at, updated_at: r.updated_at,
    fields, receipt_file: r.receipt_file, image_path: r.image_path,
    attempts: r.attempts, next_attempt_at: r.next_attempt_at,
    jev: parse<Record<string, unknown> | null>(r.jev_json, null),
  }
}

export function toItem(r: QaRow): QaItem {
  const { fields: _f, receipt_file: _r, image_path: _i, attempts: _a, next_attempt_at: _n, jev: _j, ...item } = r
  return item
}

export function getQaRow(id: string): QaRow | null {
  const r = store().query("SELECT * FROM receipt_qa WHERE expense_id = ?").get(id) as RawRow | null
  return r ? fromRaw(r) : null
}

export function insertQueued(input: { expense_id: string; fields: ExpenseFields; receipt_file: string; image_path: string }): QaItem {
  const now = new Date().toISOString()
  store().query(
    `INSERT INTO receipt_qa (expense_id, status, fields_json, receipt_file, image_path, created_at, updated_at)
     VALUES (?, 'queued', ?, ?, ?, ?, ?)
     ON CONFLICT(expense_id) DO NOTHING`,
  ).run(input.expense_id, JSON.stringify(input.fields), input.receipt_file, input.image_path, now, now)
  emit(input.expense_id)
  return toItem(getQaRow(input.expense_id)!)
}

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return LIST_DEFAULT
  return Math.max(1, Math.min(LIST_MAX, Math.floor(raw)))
}

export function listQa(status: QaStatus | "all", limit?: number): QaItem[] {
  const n = clampLimit(limit)
  const rows = status === "all"
    ? store().query("SELECT * FROM receipt_qa ORDER BY updated_at DESC LIMIT ?").all(n)
    : store().query("SELECT * FROM receipt_qa WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, n)
  return (rows as RawRow[]).map((r) => toItem(fromRaw(r)))
}

/** Oldest due row the worker may process now. */
export function nextDue(nowMs: number): QaRow | null {
  const r = store().query(
    `SELECT * FROM receipt_qa WHERE status IN ('queued', 'to_review') AND next_attempt_at <= ?
     ORDER BY created_at ASC LIMIT 1`,
  ).get(nowMs) as RawRow | null
  return r ? fromRaw(r) : null
}

/** Earliest next_attempt_at among pending rows, or null when none. */
export function nextWakeAt(): number | null {
  const r = store().query(
    "SELECT MIN(next_attempt_at) AS t FROM receipt_qa WHERE status IN ('queued', 'to_review')",
  ).get() as { t: number | null }
  return r.t ?? null
}

export interface Transition {
  issues?: QaIssue[]
  changes?: QaChange[]
  fields?: ExpenseFields
  jev?: Record<string, unknown> | null
  image_path?: string
}

/** Move a row to `status`; resets the retry budget. Emits one change. */
export function transition(id: string, status: QaStatus, t: Transition = {}): boolean {
  const cur = getQaRow(id)
  if (!cur) return false
  store().query(
    `UPDATE receipt_qa SET status = ?, issues_json = ?, changes_json = ?, fields_json = ?, jev_json = ?,
       image_path = ?, attempts = 0, next_attempt_at = 0, last_error = NULL, updated_at = ?
     WHERE expense_id = ?`,
  ).run(
    status,
    JSON.stringify(t.issues ?? cur.issues),
    JSON.stringify(t.changes ?? cur.changes),
    JSON.stringify(t.fields ?? cur.fields),
    t.jev === undefined ? (cur.jev ? JSON.stringify(cur.jev) : null) : (t.jev ? JSON.stringify(t.jev) : null),
    t.image_path ?? cur.image_path,
    new Date().toISOString(),
    id,
  )
  emit(id)
  return true
}

/** Transient failure: keep the status, retry at `nextAt`. No emit (no change). */
export function defer(id: string, attempts: number, nextAt: number, error: string): void {
  store().query(
    "UPDATE receipt_qa SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE expense_id = ?",
  ).run(attempts, nextAt, error.slice(0, 200), id)
}

/** Where the worker cached the receipt for the Sonnet pass. No emit, retry budget kept. */
export function setImagePath(id: string, path: string): void {
  store().query("UPDATE receipt_qa SET image_path = ? WHERE expense_id = ?").run(path, id)
}
