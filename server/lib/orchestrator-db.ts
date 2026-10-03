import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Orchestrator sqlite store: the one connection, the schema and its migrations,
// and the seeded General channel. Turns/tasks live in orchestrator-chat.ts,
// channels in orchestrator-channels.ts; both read and write through `db`.
// Persisted to the same companion.db as push-tokens/learned-allow so the
// thread survives a server restart (PRJ-OR1T Phase 0 memory-proof gate).

const DB_DIR = join(homedir(), ".claude-companion")
// COMPANION_DB_PATH lets tests run against an isolated sqlite file; production
// uses the real companion.db (shared with push-tokens / learned-allow).
const DB_PATH = process.env.COMPANION_DB_PATH ?? join(DB_DIR, "companion.db")

mkdirSync(DB_DIR, { recursive: true })
export const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS orchestrator_turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL DEFAULT 'main',
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    task_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turns_thread ON orchestrator_turns (thread_id, created_at);

  CREATE TABLE IF NOT EXISTS orchestrator_tasks (
    task_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL DEFAULT 'main',
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL,
    session_key TEXT,
    tmux_session TEXT,
    reasoning TEXT,
    status TEXT NOT NULL DEFAULT 'dispatched',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_cwd ON orchestrator_tasks (cwd, status);

  CREATE TABLE IF NOT EXISTS orchestrator_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT,
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    auto_dispatch INTEGER NOT NULL DEFAULT 0
  );
`)
// Migrate dbs created before these columns existed. ALTER throws if the column
// is already present, so swallow that one case per column. tmux_socket is
// nullable with no default: every pre-existing row reads NULL = the default
// tmux server, which is where those workers were spawned.
function addColumn(table: string, col: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`)
  } catch {
    /* column already exists */
  }
}
// dispatch_task_id: the Turso tasks.id a proposal was filed as (orchestrator-one-queue P2).
for (const col of ["tmux_session TEXT", "reasoning TEXT", "log_tail TEXT", "tmux_socket TEXT", "dispatch_task_id TEXT"]) {
  addColumn("orchestrator_tasks", col)
}
// note_id links a channel to one Turso project note; title/ref are a display cache.
for (const col of ["auto_dispatch INTEGER NOT NULL DEFAULT 0", "note_id TEXT", "note_title TEXT", "note_ref TEXT"]) {
  addColumn("orchestrator_channels", col)
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_note ON orchestrator_channels (note_id)
    WHERE note_id IS NOT NULL AND archived = 0;

  -- Announce cursor for the Turso dispatch poller (lib/dispatch-mirror.ts):
  -- the last value seen per task, so a restart never re-announces.
  CREATE TABLE IF NOT EXISTS dispatch_seen (
    task_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    seen_key TEXT NOT NULL,
    seen_at INTEGER NOT NULL
  );
`)

// Default channel (PRJ-OR1T Phase 6). Was the single hardcoded thread id 'main';
// now the seeded catch-all channel that holds pre-Phase-6 history and any turn or
// task sent without an explicit channel.
export const GENERAL_CHANNEL = "general"

// Seed the General channel and fold the legacy single-thread 'main' history into
// it. Idempotent: INSERT OR IGNORE no-ops once General exists, and the backfill
// only rewrites rows still tagged 'main'.
db.query("INSERT OR IGNORE INTO orchestrator_channels (id, name, cwd, created_at) VALUES (?, 'General', NULL, ?)").run(
  GENERAL_CHANNEL,
  Date.now(),
)
db.query("UPDATE orchestrator_turns SET thread_id = ? WHERE thread_id = ?").run(GENERAL_CHANNEL, "main")
db.query("UPDATE orchestrator_tasks SET thread_id = ? WHERE thread_id = ?").run(GENERAL_CHANNEL, "main")
