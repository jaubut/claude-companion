import type { Database } from "bun:sqlite"
import type { TakeoverHost } from "./takeover"

// Takeover runs on the host that runs the session (companion.db `takeovers`).
// One open run per task (partial UNIQUE on task_id and on name while starting |
// active | finishing): a replayed choose or a retried forward finds the run that
// already exists instead of starting a second session. A finished run keeps its
// row (audit); a later takeover of the same task reuses the name. Every status
// move is a compare-and-set on the current status. Mutated only by
// wiring/takeover.ts.

export type TakeoverStatus = "starting" | "active" | "finishing" | "done" | "ended" | "failed"
export const OPEN_STATUSES: readonly TakeoverStatus[] = ["starting", "active", "finishing"]

export interface TakeoverRow {
  id: number
  name: string
  taskId: string
  host: TakeoverHost
  repo: string
  cwd: string
  branch: string
  status: TakeoverStatus
  origBlocker: string
  taskVersion: string
  prUrl: string | null
  /** JSON of the outcome a `finishing` run still has to write to Turso; afterwards the last word. */
  outcome: string | null
  /** A finished run whose worktree / workspace waits for its session to end (never removed under a live one). */
  cleanupPending: boolean
  createdAt: number
  updatedAt: number
  endedAt: number | null
}

export type NewTakeover = Pick<TakeoverRow, "name" | "taskId" | "host" | "repo" | "cwd" | "branch" | "origBlocker" | "taskVersion">

export interface TakeoverStore {
  /** created=false: an open run for this task (or name) exists; `row` is that run. */
  create(input: NewTakeover, now: number): { row: TakeoverRow; created: boolean }
  /** The open run with this name, else its newest finished one. */
  get(name: string): TakeoverRow | null
  openFor(taskId: string): TakeoverRow | null
  listOpen(): TakeoverRow[]
  /** CAS: moves the open run `name` from one of `from` to `to`; false when it was not in `from`. */
  move(name: string, from: readonly TakeoverStatus[], to: TakeoverStatus, now: number, patch?: { prUrl?: string | null; outcome?: string | null }): boolean
  /** Mark / clear the newest run of `name` as waiting for cleanup. */
  setCleanup(name: string, pending: boolean, now: number): void
  /** Finished runs still waiting for cleanup, oldest first. */
  listCleanup(): TakeoverRow[]
}

const OPEN_SQL = "('starting', 'active', 'finishing')"

interface Raw {
  id: number; name: string; task_id: string; host: string; repo: string; cwd: string; branch: string; status: string
  orig_blocker: string; task_version: string; pr_url: string | null; outcome: string | null; cleanup_pending: number
  created_at: number; updated_at: number; ended_at: number | null
}

const toRow = (r: Raw): TakeoverRow => ({
  id: r.id, name: r.name, taskId: r.task_id, host: r.host as TakeoverHost, repo: r.repo, cwd: r.cwd, branch: r.branch,
  status: r.status as TakeoverStatus, origBlocker: r.orig_blocker, taskVersion: r.task_version, prUrl: r.pr_url,
  outcome: r.outcome, cleanupPending: r.cleanup_pending === 1, createdAt: r.created_at, updatedAt: r.updated_at, endedAt: r.ended_at,
})

export function createTakeoverStore(db: Database): TakeoverStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS takeovers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, task_id TEXT NOT NULL, host TEXT NOT NULL, repo TEXT NOT NULL,
      cwd TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL, orig_blocker TEXT NOT NULL, task_version TEXT NOT NULL,
      pr_url TEXT, outcome TEXT, cleanup_pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS takeovers_open_task ON takeovers (task_id) WHERE status IN ${OPEN_SQL};
    CREATE UNIQUE INDEX IF NOT EXISTS takeovers_open_name ON takeovers (name) WHERE status IN ${OPEN_SQL};
  `)
  const openBy = (col: "task_id" | "name", v: string): TakeoverRow | null => {
    const r = db.query(`SELECT * FROM takeovers WHERE ${col} = ? AND status IN ${OPEN_SQL} LIMIT 1`).get(v) as Raw | null
    return r ? toRow(r) : null
  }
  return {
    create(input, now) {
      const r = db.query(
        "INSERT OR IGNORE INTO takeovers (name, task_id, host, repo, cwd, branch, status, orig_blocker, task_version, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)",
      ).run(input.name, input.taskId, input.host, input.repo, input.cwd, input.branch, input.origBlocker, input.taskVersion, now, now)
      const row = openBy("task_id", input.taskId) ?? openBy("name", input.name)!
      return { row, created: r.changes > 0 }
    },
    get(name) {
      const r = db.query(`SELECT * FROM takeovers WHERE name = ? ORDER BY (status IN ${OPEN_SQL}) DESC, id DESC LIMIT 1`).get(name) as Raw | null
      return r ? toRow(r) : null
    },
    openFor: (taskId) => openBy("task_id", taskId),
    listOpen() {
      return (db.query(`SELECT * FROM takeovers WHERE status IN ${OPEN_SQL} ORDER BY id`).all() as Raw[]).map(toRow)
    },
    move(name, from, to, now, patch = {}) {
      if (!from.length) return false
      const sets = ["status = ?", "updated_at = ?"]
      const args: (string | number | null)[] = [to, now]
      if (patch.prUrl !== undefined) { sets.push("pr_url = ?"); args.push(patch.prUrl) }
      if (patch.outcome !== undefined) { sets.push("outcome = ?"); args.push(patch.outcome) }
      if (!OPEN_STATUSES.includes(to)) { sets.push("ended_at = ?"); args.push(now) }
      const r = db.query(
        `UPDATE takeovers SET ${sets.join(", ")} WHERE name = ? AND status IN ${OPEN_SQL} AND status IN (${from.map(() => "?").join(", ")})`,
      ).run(...args, name, ...from)
      return r.changes > 0
    },
    setCleanup(name, pending, now) {
      db.query("UPDATE takeovers SET cleanup_pending = ?, updated_at = ? WHERE id = (SELECT id FROM takeovers WHERE name = ? ORDER BY id DESC LIMIT 1)")
        .run(pending ? 1 : 0, now, name)
    },
    listCleanup() {
      return (db.query(`SELECT * FROM takeovers WHERE cleanup_pending = 1 AND status NOT IN ${OPEN_SQL} ORDER BY id`).all() as Raw[]).map(toRow)
    },
  }
}
