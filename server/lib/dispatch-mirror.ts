import { db } from "./orchestrator-db"
import { type DispatchTask, phaseOf, seenKey } from "./dispatch-tasks"

export { seenKey }

// Announce cursor for the Turso dispatch poller: the last value seen per task,
// persisted in sqlite `dispatch_seen` so a restart never re-announces a
// transition. The diff is keyed on the value tuple (dispatch_status,
// updated_at, done, pr_url), never on counts.

export interface Seen {
  phase: string
  updatedAt: string
  key: string
}

export function lastSeen(taskId: string): Seen | null {
  const row = db
    .query("SELECT status, updated_at, seen_key FROM dispatch_seen WHERE task_id = ?")
    .get(taskId) as { status: string; updated_at: string; seen_key: string } | null
  return row ? { phase: row.status, updatedAt: row.updated_at, key: row.seen_key } : null
}

export function markSeen(t: DispatchTask, now: number = Date.now()): void {
  db.query(
    "INSERT INTO dispatch_seen (task_id, status, updated_at, seen_key, seen_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, " +
      "seen_key = excluded.seen_key, seen_at = excluded.seen_at",
  ).run(t.id, phaseOf(t), t.updatedAtRaw, seenKey(t), now)
}

export function seenCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM dispatch_seen").get() as { n: number }).n
}

/** Forget tasks that left the poll window and have not changed for `maxAgeMs`. */
export function pruneSeen(keep: ReadonlySet<string>, maxAgeMs: number, now: number = Date.now()): number {
  const stale = db
    .query("SELECT task_id FROM dispatch_seen WHERE seen_at < ?")
    .all(now - maxAgeMs) as { task_id: string }[]
  let n = 0
  for (const r of stale) {
    if (keep.has(r.task_id)) continue
    db.query("DELETE FROM dispatch_seen WHERE task_id = ?").run(r.task_id)
    n++
  }
  return n
}
