import { createHash } from "node:crypto"
import { normDate } from "./my-tasks"
import type { ExecFn, Row, SqlArg } from "./turso"

// One row version for every Tasks-agent write (PRJ-CT4M WP5). The agent only
// ever acts on a task as it was when it decided (a proposal, a draft, a chat
// card, an undo snapshot). That is checked in ONE way, here, for every field
// the agent reads or decides on, so a write can never pin "some" fields:
//   - rowVersion: a hash of the raw tracked values (JSON, no normalization);
//   - rowGuard: the same raw values compared column by column, NULL-safe, for the
//     compare-and-set INSIDE the transaction (`WHERE id = ? AND text IS ? AND …`);
//   - guardedWrite: read the row, refuse (409 stale) if its version is not the one
//     the decision was made on, then hand the fresh row to the write.
// One raw-value source (toRawTask) feeds both. To track one more column, add it to ROW_COLUMNS.

/** A tracked column's value exactly as the database holds it (NULL stays null: no trimming, no normalization). */
export type RawValue = string | number | null

/** The tracked columns, in the order the version is built and the guard compares them. */
export const ROW_COLUMNS = ["text", "description", "note_id", "parent_id", "due_date", "done", "assignee"] as const
export type RowColumn = (typeof ROW_COLUMNS)[number]
export type RowRaw = Record<RowColumn, RawValue>

export interface RawTask {
  id: string
  noteId: string
  parentId: string | null
  text: string
  description: string
  done: boolean
  dueRaw: string
  due: string | null
  assigneeRaw: string
  assignee: string | null
  position: number
  /** The raw values of ROW_COLUMNS: the ONE source of the version and of the SQL guard. */
  raw: RowRaw
}

const rawValue = (v: unknown): RawValue => (typeof v === "string" || typeof v === "number" ? v : null)

/** The client-facing version: a hash of an unambiguous encoding (JSON array of the raw values, ROW_COLUMNS order). */
export const rowVersion = (raw: RowRaw): string =>
  createHash("sha1").update(JSON.stringify(ROW_COLUMNS.map((c) => raw[c]))).digest("hex").slice(0, 16)

/**
 * The in-transaction guard: every tracked column compared with its raw value, NULL-safe (`IS`), no string building
 * on either side. `alias` = "" or e.g. "p.". Args are the raw values in ROW_COLUMNS order.
 */
export function rowGuard(raw: RowRaw, alias = ""): { sql: string; args: SqlArg[] } {
  return { sql: ROW_COLUMNS.map((c) => `${alias}${c} IS ?`).join(" AND "), args: ROW_COLUMNS.map((c) => raw[c]) }
}

export const TASK_COLUMNS = "id, note_id, parent_id, text, description, done, due_date, assignee, position"

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null)

/** The one mapper from a tasks row (columns of TASK_COLUMNS) to a RawTask. */
export function toRawTask(r: Row): RawTask {
  const raw = Object.fromEntries(ROW_COLUMNS.map((c) => [c, rawValue(r[c])])) as RowRaw
  return {
    id: String(r.id), noteId: typeof r.note_id === "string" ? r.note_id : "", parentId: str(r.parent_id), text: typeof r.text === "string" ? r.text : "",
    description: typeof r.description === "string" ? r.description : "", done: Number(r.done ?? 0) === 1,
    dueRaw: typeof r.due_date === "string" ? r.due_date : "", due: normDate(r.due_date),
    assigneeRaw: typeof r.assignee === "string" ? r.assignee : "", assignee: str(r.assignee), position: Number(r.position ?? 0) || 0, raw,
  }
}

export const versionOf = (t: RawTask): string => rowVersion(t.raw)

export async function readTask(exec: ExecFn, id: string): Promise<RawTask | null> {
  const { rows } = await exec(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, [id])
  return rows[0] ? toRawTask(rows[0]) : null
}

export async function readTasks(exec: ExecFn, ids: string[]): Promise<Map<string, RawTask>> {
  const out = new Map<string, RawTask>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { rows } = await exec(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id IN (${chunk.map(() => "?").join(", ")})`, chunk)
    for (const r of rows) out.set(String(r.id), toRawTask(r))
  }
  return out
}

/** `fresh` = the row as it is now, when there is one. */
export type StaleOutcome = { ok: false; status: 409; error: "changed_since" | "stale"; fresh?: RawTask }

/**
 * Read the task, refuse (409 `stale`) if its version is not the one `expected` was decided on, then run
 * the write on the fresh row. Every write pins that same row inside its transaction (ROW_KEY_SQL), so the
 * version holds from the read to the commit. Missing task → 409 `changed_since`.
 */
export async function guardedWrite<R extends { ok: boolean }>(
  exec: ExecFn, id: string, expected: string | undefined, write: (fresh: RawTask) => Promise<R>,
): Promise<R | StaleOutcome> {
  const t = await readTask(exec, id)
  if (!t) return { ok: false, status: 409, error: "changed_since" }
  if (expected !== undefined && versionOf(t) !== expected) return { ok: false, status: 409, error: "stale", fresh: t }
  return write(t)
}

/** A client's echoed `rowVersions` body field: undefined = absent, null = malformed, else {taskId: version}. */
export function parseRowVersions(v: unknown): Record<string, string> | null | undefined {
  if (v === undefined) return undefined
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string" || !x) return null
    out[k] = x
  }
  return out
}
