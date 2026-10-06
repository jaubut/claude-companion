import type { Database } from "bun:sqlite"

// Tasks agent local state (companion.db, per host):
//   tasks_agent_seen       device → the agent_activity id seen at the last open (digest baseline)
//   tasks_agent_decisions  proposal id → accept / dismiss + the proposal version it applied to
// Turso stays the only task store; this is UI bookkeeping only.

/** A GET more than this after the device's previous one is a new "open": the digest baseline moves. */
export const OPEN_GAP_MS = 30 * 60_000

export interface Decision { id: string; decision: "accept" | "dismiss"; version: string; at: number }

export function createTasksAgentStore(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks_agent_seen (
      device TEXT PRIMARY KEY,
      seen_id INTEGER NOT NULL,
      prev_id INTEGER,
      last_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks_agent_decisions (
      id TEXT PRIMARY KEY,
      decision TEXT NOT NULL,
      version TEXT NOT NULL,
      at INTEGER NOT NULL
    );
  `)

  /**
   * Record an open by `device` with the newest activity id `maxId`. Returns the
   * digest baseline: the id seen at the previous open (rows after it are new), or
   * null on the device's first open(s) (caller falls back to the last 24 h).
   * GETs within OPEN_GAP_MS of each other are one open: the baseline holds.
   */
  function open(device: string, maxId: number, now: number): number | null {
    const row = db.query("SELECT seen_id, prev_id, last_at FROM tasks_agent_seen WHERE device = ?").get(device) as
      { seen_id: number; prev_id: number | null; last_at: number } | null
    if (!row) {
      db.query("INSERT INTO tasks_agent_seen (device, seen_id, prev_id, last_at) VALUES (?, ?, NULL, ?)").run(device, maxId, now)
      return null
    }
    const baseline = now - row.last_at > OPEN_GAP_MS ? row.seen_id : row.prev_id
    db.query("UPDATE tasks_agent_seen SET seen_id = ?, prev_id = ?, last_at = ? WHERE device = ?").run(Math.max(maxId, row.seen_id), baseline, now, device)
    return baseline
  }

  function decide(d: Decision): void {
    db.query("INSERT INTO tasks_agent_decisions (id, decision, version, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET decision = excluded.decision, version = excluded.version, at = excluded.at")
      .run(d.id, d.decision, d.version, d.at)
  }

  function decisions(): Map<string, Decision> {
    const rows = db.query("SELECT id, decision, version, at FROM tasks_agent_decisions").all() as Decision[]
    return new Map(rows.map((r) => [r.id, r]))
  }

  return { open, decide, decisions }
}

export type TasksAgentStore = ReturnType<typeof createTasksAgentStore>
