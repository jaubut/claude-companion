import type { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// A #Body card whose fix belongs to the Mac is recorded here with its owning
// host and cwd. Approving it files a `pending` Turso row tagged
// requires_host=mac (wiring/proposals.ts), so only the Mac's dispatch-run claims
// it (docs/one-stream-plan.md, Q1). Seams only: the store takes its Database.

export interface FixCard {
  taskId: string
  host: string
  componentId: string
  cwd: string
  noteId: string
  agent: string
  title: string
  investigationId: string
}

export interface BodyFixStore {
  /** Zettlab side: the card → its owning host + cwd. */
  recordCard(card: FixCard, now: number): void
  card(taskId: string): FixCard | null
}

interface CardRow {
  task_id: string; host: string; component_id: string; cwd: string; note_id: string; agent: string; title: string; investigation_id: string
}

export function createBodyFixStore(db: Database): BodyFixStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS body_fix_cards (
      task_id TEXT PRIMARY KEY, host TEXT NOT NULL, component_id TEXT NOT NULL, cwd TEXT NOT NULL,
      note_id TEXT NOT NULL, agent TEXT NOT NULL, title TEXT NOT NULL, investigation_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  return {
    recordCard(c, now) {
      db.query(
        "INSERT OR REPLACE INTO body_fix_cards (task_id, host, component_id, cwd, note_id, agent, title, investigation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(c.taskId, c.host, c.componentId, c.cwd, c.noteId, c.agent, c.title, c.investigationId, now)
    },
    card(taskId) {
      const r = db.query("SELECT * FROM body_fix_cards WHERE task_id = ?").get(taskId) as CardRow | null
      return r ? { taskId: r.task_id, host: r.host, componentId: r.component_id, cwd: r.cwd, noteId: r.note_id, agent: r.agent, title: r.title, investigationId: r.investigation_id } : null
    },
  }
}

/**
 * A fix's cwd as it exists on THIS host. Cards are written on Zettlab for Mac
 * components, so a path may carry `~` or the other host's home
 * (/home/aubut/… vs /Users/jeremieaubut/…): expand `~`, keep a path that exists,
 * else re-root a foreign home prefix onto this host's home.
 */
export function localizeCwd(cwd: string, home: string = process.env.HOME || homedir(), exists: (p: string) => boolean = existsSync): string {
  const c = cwd.trim()
  if (c === "~") return home
  if (c.startsWith("~/")) return join(home, c.slice(2))
  if (exists(c)) return c
  const m = c.match(/^\/(?:home|Users)\/[^/]+(\/.*)?$/)
  return m ? home + (m[1] ?? "") : c
}

