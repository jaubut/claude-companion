import { Database } from "bun:sqlite"
import type { ExecFn, QueryFn, Row, SqlArg, TxFn } from "./turso"
import { TursoUnreachable } from "./turso"

// Test-only: a real SQLite (bun:sqlite, in memory) with the Turso `tasks`,
// `notes` and `agent_activity` schemas, exposed as QueryFn / ExecFn — so the
// tasks agent's SQL (json_extract, RETURNING, CAS updates) runs for real.

export interface TaskSeed {
  id: string
  note_id?: string
  parent_id?: string
  text?: string
  description?: string
  done?: number
  due_date?: string
  position?: number
  assignee?: string | null
}

export function testDb() {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, ref_code TEXT, folder TEXT, status TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_id TEXT DEFAULT '', text TEXT NOT NULL, description TEXT DEFAULT '',
      done INTEGER DEFAULT 0, due_date TEXT DEFAULT '', position INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), assignee TEXT, dispatch_status TEXT
    );
    CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT,
      target_id TEXT, summary TEXT, meta TEXT, ts TEXT NOT NULL DEFAULT (datetime('now')));
  `)
  let down = false
  const run = (sql: string, args: SqlArg[]): { rows: Row[]; affected: number } => {
    if (down) throw new TursoUnreachable("down")
    const stmt = db.query(sql)
    if (/^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const rows = stmt.all(...args) as Row[]
      return { rows, affected: rows.length }
    }
    const r = stmt.run(...args)
    return { rows: [], affected: Number(r.changes) }
  }
  const query: QueryFn = async (sql, args) => run(sql, args).rows
  const exec: ExecFn = async (sql, args) => run(sql, args)

  const note = (id: string, title: string) => db.query("INSERT OR IGNORE INTO notes (id, title, folder) VALUES (?, ?, 'projects')").run(id, title)
  const task = (t: TaskSeed) => {
    note(t.note_id ?? "projects/p1", `Title ${t.note_id ?? "projects/p1"}`)
    db.query("INSERT INTO tasks (id, note_id, parent_id, text, description, done, due_date, position, assignee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      t.id, t.note_id ?? "projects/p1", t.parent_id ?? "", t.text ?? `task ${t.id}`, t.description ?? "", t.done ?? 0, t.due_date ?? "", t.position ?? 0,
      t.assignee === undefined ? "human:jeremie" : t.assignee,
    )
  }
  const activity = (a: { agent: string; action: string; target: string; meta?: unknown; summary?: string; ts?: string }): number => {
    const r = db.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta, ts) VALUES (?, ?, 'task', ?, ?, ?, COALESCE(?, datetime('now'))) RETURNING id")
      .get(a.agent, a.action, a.target, a.summary ?? "", a.meta === undefined ? null : JSON.stringify(a.meta), a.ts ?? null) as { id: number }
    return r.id
  }
  const get = (id: string) => db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null
  const activities = () => db.query("SELECT * FROM agent_activity ORDER BY id").all() as Record<string, unknown>[]
  return { db, query, exec, tx: txOver(exec), note, task, activity, get, activities, setDown: (v: boolean) => { down = v } }
}

/** A TxFn over an ExecFn on one SQLite connection (BEGIN … COMMIT, ROLLBACK + rethrow on any failure), like tursoTx. */
export function txOver(exec: ExecFn): TxFn {
  return async (stmts) => {
    await exec("BEGIN", [])
    try {
      const out: { rows: Row[]; affected: number }[] = []
      for (const s of stmts) out.push(await exec(s.sql, s.args))
      await exec("COMMIT", [])
      return out
    } catch (err) {
      await exec("ROLLBACK", []).catch(() => { /* already rolled back */ })
      throw err
    }
  }
}

export const tid = (n: number | string): string => `t${String(n).padStart(9, "0")}`
