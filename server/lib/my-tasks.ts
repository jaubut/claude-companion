import type { ExecFn, QueryFn, Row } from "./turso"

// Jeremie's own tasks as a cascade: urgency section → project (the task's note)
// → task → subtasks (PRJ-CT4M WP1). Turso `tasks` is the only store; the phone
// never holds the token. "Mine" = the human assignees below (bare `human` is the
// pre-2026-06 form of human:jeremie). The dashboard stores "no date" and "no
// parent" as '' (never NULL) — both are normalized here. Days are local to
// TASKS_TZ (America/Toronto): a task due today is "today" until local midnight.
// Contract: docs/tasks-api.md.

export const MINE: readonly string[] = (process.env.COMPANION_TASK_ASSIGNEES || "human:jeremie,human")
  .split(",").map((s) => s.trim()).filter(Boolean)
export const TASKS_TZ = (): string => process.env.COMPANION_TASKS_TZ || "America/Toronto"
export const MINE_LIMIT = 500
/** "This week" = the 6 days after today. */
export const WEEK_DAYS = 6

export type SectionKey = "overdue" | "today" | "week" | "later" | "none"
export const SECTIONS: readonly { key: SectionKey; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
  { key: "none", label: "No date" },
]

export interface MyTask {
  id: string
  text: string
  description: string | null
  /** YYYY-MM-DD or null. */
  due: string | null
  children: MyTask[]
}

export interface MyProject {
  noteId: string
  title: string
  ref: string | null
  folder: string | null
  tasks: MyTask[]
}

export interface MySection {
  key: SectionKey
  label: string
  /** Top-level tasks + their subtasks. */
  count: number
  projects: MyProject[]
}

export interface MyTasksResponse {
  generatedAt: string
  today: string
  tz: string
  total: number
  sections: MySection[]
}

/** A raw open task row joined with its note. */
export interface TaskRow {
  id: string
  noteId: string
  parentId: string | null
  text: string
  description: string | null
  due: string | null
  position: number
  noteTitle: string | null
  noteRef: string | null
  noteFolder: string | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null)

/** '' / garbage → null; "2026-10-07T12:00…" → "2026-10-07". */
export function normDate(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const d = s.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  // Round-trip: Feb 31 must not roll over to Mar 3.
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d ? d : null
}

/** The local calendar day (YYYY-MM-DD) of an instant in `tz`. */
export function localDay(ms: number, tz = TASKS_TZ()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
}

/** `day` + n calendar days (pure date math, no zone). */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

export function sectionFor(due: string | null, today: string): SectionKey {
  if (!due) return "none"
  if (due < today) return "overdue"
  if (due === today) return "today"
  if (due <= addDays(today, WEEK_DAYS)) return "week"
  return "later"
}

export function fromRow(r: Row): TaskRow {
  return {
    id: String(r.id),
    noteId: str(r.note_id) ?? "",
    parentId: str(r.parent_id),
    text: str(r.text) ?? "",
    description: str(r.description),
    due: normDate(r.due_date),
    position: Number(r.position ?? 0) || 0,
    noteTitle: str(r.note_title),
    noteRef: str(r.note_ref),
    noteFolder: str(r.note_folder),
  }
}

const byDueThenPos = (a: TaskRow, b: TaskRow): number =>
  (a.due ?? "9999") < (b.due ?? "9999") ? -1 : (a.due ?? "9999") > (b.due ?? "9999") ? 1 : a.position - b.position || (a.id < b.id ? -1 : 1)

/**
 * Pure: rows → cascade. A subtask whose parent is also open and mine nests under
 * it (any depth) and follows the parent's section; an orphan subtask (parent done,
 * gone or someone else's) or a parent cycle stands on its own. Projects inside a section: soonest
 * due first, then title. Every section is always present (empty ones too).
 */
export function buildCascade(rows: TaskRow[], today: string, nowMs: number, tz = TASKS_TZ()): MyTasksResponse {
  const ids = new Set(rows.map((r) => r.id))
  const kids = new Map<string, TaskRow[]>()
  const roots: TaskRow[] = []
  for (const r of rows) {
    if (r.parentId && r.parentId !== r.id && ids.has(r.parentId)) {
      const list = kids.get(r.parentId) ?? []
      list.push(r)
      kids.set(r.parentId, list)
    } else roots.push(r)
  }

  // Cycle-safe tree build: a row is placed once.
  const placed = new Set<string>()
  const toTask = (r: TaskRow): MyTask => {
    placed.add(r.id)
    const children = (kids.get(r.id) ?? []).filter((c) => !placed.has(c.id)).sort(byDueThenPos).map(toTask)
    return { id: r.id, text: r.text, description: r.description, due: r.due, children }
  }
  const size = (t: MyTask): number => 1 + t.children.reduce((n, c) => n + size(c), 0)

  const bySection = new Map<SectionKey, Map<string, { row: TaskRow; tasks: { row: TaskRow; task: MyTask }[] }>>()
  const addRoot = (r: TaskRow) => {
    const key = sectionFor(r.due, today)
    const projects = bySection.get(key) ?? new Map()
    const p = projects.get(r.noteId) ?? { row: r, tasks: [] }
    p.tasks.push({ row: r, task: toTask(r) })
    projects.set(r.noteId, p)
    bySection.set(key, projects)
  }
  // Roots first; then whatever a parent cycle left unreachable, so no task ever vanishes.
  for (const r of [...roots].sort(byDueThenPos)) if (!placed.has(r.id)) addRoot(r)
  for (const r of [...rows].sort(byDueThenPos)) if (!placed.has(r.id)) addRoot(r)

  let total = 0
  const sections = SECTIONS.map(({ key, label }): MySection => {
    const projects = [...(bySection.get(key)?.values() ?? [])]
      .map((p) => ({
        soonest: p.tasks[0]?.row.due ?? "9999",
        project: {
          noteId: p.row.noteId,
          title: p.row.noteTitle ?? (p.row.noteId || "No project"),
          ref: p.row.noteRef,
          folder: p.row.noteFolder,
          tasks: p.tasks.map((t) => t.task),
        } satisfies MyProject,
      }))
      .sort((a, b) => (a.soonest < b.soonest ? -1 : a.soonest > b.soonest ? 1 : a.project.title.localeCompare(b.project.title)))
      .map((x) => x.project)
    const count = projects.reduce((n, p) => n + p.tasks.reduce((m, t) => m + size(t), 0), 0)
    total += count
    return { key, label, count, projects }
  })

  return { generatedAt: new Date(nowMs).toISOString(), today, tz, total, sections }
}

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ")

/** The WHERE fragment of "open and his" (listMine's SQL); `openMine` below is the same rule on a row already read. */
export const OPEN_MINE_SQL = `t.done = 0 AND t.assignee IN (${MINE.map(() => "?").join(", ")})`

/** Same eligibility as OPEN_MINE_SQL, for re-checking a task read a second time (a snapshot). Keep the two in step. */
export const openMine = (t: { done: boolean; assignee: string | null }): boolean => !t.done && !!t.assignee && MINE.includes(t.assignee)

export async function listMine(query: QueryFn): Promise<TaskRow[]> {
  const rows = await query(
    "SELECT t.id, t.note_id, t.parent_id, t.text, t.description, t.due_date, t.position, " +
      "n.title AS note_title, n.ref_code AS note_ref, n.folder AS note_folder " +
      `FROM tasks t LEFT JOIN notes n ON n.id = t.note_id WHERE ${OPEN_MINE_SQL} ` +
      "ORDER BY t.note_id, t.position LIMIT ?",
    [...MINE, MINE_LIMIT],
  )
  return rows.map(fromRow)
}

/** Fingerprint of the open set for the change watcher (ids + text + due + parent). */
export function fingerprint(rows: TaskRow[]): string {
  return rows.map((r) => `${r.id}|${r.due ?? ""}|${r.parentId ?? ""}|${r.text}`).sort().join("\n")
}

// ── writes ───────────────────────────────────────────────────────────────────
// Guarded on the assignee: this API only ever touches Jeremie's own tasks, never
// an agent's (those belong to dispatch). One agent_activity row per change,
// same vocabulary as the dashboard's toggle (status_changed / due_changed).

export type WriteResult = { ok: true; done: boolean; due: string | null } | { ok: false; error: "no_such_task" }

async function ledger(exec: ExecFn, id: string, action: string, summary: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await exec(
      "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      ["companion", action, "task", id, summary.slice(0, 200), JSON.stringify({ source: "companion", ...meta })],
    )
  } catch { /* observability only — never undo the write */ }
}

/** The task as it is now, only if it is still his (null otherwise). */
export async function readBack(exec: ExecFn, id: string): Promise<{ done: boolean; due: string | null; text: string } | null> {
  const { rows } = await exec(`SELECT done, due_date, text FROM tasks WHERE id = ? AND assignee IN (${marks(MINE.length)})`, [id, ...MINE])
  const r = rows[0]
  return r ? { done: Number(r.done ?? 0) === 1, due: normDate(r.due_date), text: str(r.text) ?? "" } : null
}

export async function setDone(exec: ExecFn, id: string, done: boolean): Promise<WriteResult> {
  const { affected } = await exec(
    `UPDATE tasks SET done = ?, updated_at = datetime('now') WHERE id = ? AND assignee IN (${marks(MINE.length)}) AND done <> ?`,
    [done ? 1 : 0, id, ...MINE, done ? 1 : 0],
  )
  const after = await readBack(exec, id)
  if (!after) return { ok: false, error: "no_such_task" }
  if (affected > 0) await ledger(exec, id, "status_changed", done ? `marked done: ${after.text}` : `reopened: ${after.text}`, { from: done ? "open" : "done", to: done ? "done" : "open" })
  return { ok: true, done: after.done, due: after.due }
}

/** `due` = YYYY-MM-DD, or null to drop the date (stored as '' like the dashboard). */
export async function setDue(exec: ExecFn, id: string, due: string | null): Promise<WriteResult> {
  const before = await readBack(exec, id)
  if (!before) return { ok: false, error: "no_such_task" }
  const { affected } = await exec(
    `UPDATE tasks SET due_date = ?, updated_at = datetime('now') WHERE id = ? AND assignee IN (${marks(MINE.length)})`,
    [due ?? "", id, ...MINE],
  )
  const after = await readBack(exec, id)
  if (!after) return { ok: false, error: "no_such_task" }
  if (affected > 0 && before.due !== after.due) {
    await ledger(exec, id, "due_changed", `due ${before.due ?? "none"} → ${after.due ?? "none"}: ${after.text}`, { from: before.due, to: after.due })
  }
  return { ok: true, done: after.done, due: after.due }
}
