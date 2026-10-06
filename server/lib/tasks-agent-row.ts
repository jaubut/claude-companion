import { createHash } from "node:crypto"
import { normDate } from "./my-tasks"
import type { ExecFn, Row } from "./turso"

// One row version for every Tasks-agent write (PRJ-CT4M WP5). The agent only
// ever acts on a task as it was when it decided (a proposal, a draft, a chat
// card, an undo snapshot). That is checked in ONE way, here, for every field
// the agent reads or decides on, so a write can never pin "some" fields:
//   - rowKey / rowVersion: the same canonical string / hash of the tracked fields;
//   - ROW_KEY_SQL: the same string as a SQL expression, for the compare-and-set
//     INSIDE the transaction (`WHERE <ROW_KEY_SQL> = ?`);
//   - guardedWrite: read the row, refuse (409 stale) if its version is not the one
//     the decision was made on, then hand the fresh row to the write.
// To track one more field, add it to ROW_FIELDS below (JS and SQL both follow).

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
}

/** The tracked fields, in the order the key is built: [JS value, SQL column]. */
const ROW_FIELDS: { js: (t: RowFields) => string; col: string }[] = [
  { js: (t) => t.text, col: "COALESCE(@text, '')" },
  { js: (t) => t.description, col: "COALESCE(@description, '')" },
  { js: (t) => t.noteId, col: "COALESCE(@note_id, '')" },
  { js: (t) => t.parentRaw, col: "COALESCE(@parent_id, '')" },
  { js: (t) => t.dueRaw, col: "COALESCE(@due_date, '')" },
  { js: (t) => (t.done ? "1" : "0"), col: "CAST(COALESCE(@done, 0) AS TEXT)" },
  { js: (t) => t.assigneeRaw, col: "COALESCE(@assignee, '')" },
]

/** What the key is built from (raw column values, '' for NULL). */
export interface RowFields { text: string; description: string; noteId: string; parentRaw: string; dueRaw: string; done: boolean; assigneeRaw: string }

const SEP = "\u001f"

export const rowKey = (t: RowFields): string => ROW_FIELDS.map((f) => f.js(t)).join(SEP)
export const rowVersion = (t: RowFields): string => createHash("sha1").update(rowKey(t)).digest("hex").slice(0, 16)

/** The task row's key as a SQL expression (`alias` = "" or e.g. "p."). */
export const rowKeySql = (alias = ""): string =>
  `(${ROW_FIELDS.map((f) => f.col.replace(/@(\w+)/g, (_, c: string) => `${alias}${c}`)).join(` || char(31) || `)})`

export const TASK_COLUMNS = "id, note_id, parent_id, text, description, done, due_date, assignee, position"

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null)

export function toRawTask(r: Row): RawTask {
  return {
    id: String(r.id), noteId: str(r.note_id) ?? "", parentId: str(r.parent_id), text: str(r.text) ?? "", description: typeof r.description === "string" ? r.description : "",
    done: Number(r.done ?? 0) === 1, dueRaw: typeof r.due_date === "string" ? r.due_date : "", due: normDate(r.due_date),
    assigneeRaw: typeof r.assignee === "string" ? r.assignee : "", assignee: str(r.assignee), position: Number(r.position ?? 0) || 0,
  }
}

/** A RawTask as the key sees it. */
export const fieldsOf = (t: RawTask): RowFields => ({
  text: t.text, description: t.description, noteId: t.noteId, parentRaw: t.parentId ?? "", dueRaw: t.dueRaw, done: t.done, assigneeRaw: t.assigneeRaw,
})
export const versionOf = (t: RawTask): string => rowVersion(fieldsOf(t))
export const keyOf = (t: RawTask): string => rowKey(fieldsOf(t))

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
