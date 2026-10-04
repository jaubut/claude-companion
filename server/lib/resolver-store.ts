import type { Database } from "bun:sqlite"
import type { Autonomy } from "./resolver"
import type { Phrase, ResolverOutcome, Severity } from "./triage"

// Opus resolver persistence (companion.db, injected Database so tests use :memory:):
//   resolver_runs     one row per run of an item (item id + resolver key); the newest row for
//                     (item, key) is the item's resolver state; started_at's local day is the budget
//   resolver_meta     key/value (the last digest day)
//   resolver_created  proposals the resolver created itself (never resolved again)
//   resolver_attempts one row per action Opus ran on an item ref (error NULL = it went through): the loop guard
// Boot: running rows a restart interrupted → failed (the item falls through); queued rows (never started) →
// skipped "restart" (the next render queues the item again).

export type RunStatus = "queued" | "running" | "resolved" | "prepared" | "failed" | "skipped"

export interface RunRow {
  id: number
  itemId: string
  rkey: string
  /** The triage version when the run was queued (a resolved item back on a new version = a recurrence). */
  version: string
  source: string
  refKey: string
  status: RunStatus
  autonomy: Autonomy
  instruction: string | null
  model: string
  summary: string
  phrase: Phrase | null
  severity: Severity | null
  /** What ran: answer | close_pr | fix | … | prepared | failed. */
  action: string | null
  reason: string | null
  /** Finished runs: what the run ended with (resolver.outcome on the wire). */
  outcome?: ResolverOutcome | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  day: string | null
}

export interface NewRun { itemId: string; rkey: string; version: string; source: string; refKey: string; autonomy: Autonomy; instruction: string | null; model: string }
export type RunPatch = Partial<Pick<RunRow, "status" | "summary" | "phrase" | "severity" | "action" | "reason" | "outcome" | "startedAt" | "finishedAt" | "day">>

/** Loop-guard key for an error: case, numbers and hashes do not make two failures different. */
export function errorKey(error: string): string {
  return error.toLowerCase().replace(/\b[0-9a-f]{7,40}\b/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200)
}

/** Identical failures older than this no longer stop a re-run. */
export const GUARD_WINDOW_MS = 24 * 60 * 60_000

export interface ResolverStore {
  insert(run: NewRun, now: number): RunRow
  update(id: number, patch: RunPatch): RunRow | null
  get(id: number): RunRow | null
  /** Newest run for this item + key. */
  latest(itemId: string, rkey: string): RunRow | null
  /** Runs started on a local day (YYYY-MM-DD). */
  startedOn(day: string): number
  queued(): RunRow[]
  /** Finished actions on a day, by action (digest). */
  countsOn(day: string): Record<string, number>
  /** Has this PR / item ref had an action of this kind before (any key)? */
  hadAction(refKey: string, action: string): boolean
  markCreated(taskId: string, now: number): void
  isCreated(taskId: string): boolean
  meta(key: string): string | null
  setMeta(key: string, value: string): void
  /** running rows → failed "interrupted by restart", queued → skipped "restart"; returns how many. */
  closeInterrupted(now: number): number
  /** Loop guard: one attempt of `action` on an item ref (error null = it went through). */
  attempt(refKey: string, action: string, error: string | null, now: number): void
  /** Loop guard: the newest attempts of `action` since `since`, counted while they failed with the newest one's error. */
  failures(refKey: string, action: string, since: number): { count: number; error: string } | null
  prune(before: number): void
}

interface Raw {
  id: number; item_id: string; rkey: string; version: string; source: string; ref_key: string; status: RunStatus; autonomy: Autonomy
  instruction: string | null; model: string; summary: string; phrase_json: string | null; severity: Severity | null
  action: string | null; reason: string | null; outcome: ResolverOutcome | null; created_at: number; started_at: number | null; finished_at: number | null; day: string | null
}

function toRow(r: Raw): RunRow {
  let phrase: Phrase | null = null
  try { phrase = r.phrase_json ? JSON.parse(r.phrase_json) as Phrase : null } catch { phrase = null }
  return {
    id: r.id, itemId: r.item_id, rkey: r.rkey, version: r.version, source: r.source, refKey: r.ref_key, status: r.status, autonomy: r.autonomy,
    instruction: r.instruction, model: r.model, summary: r.summary, phrase, severity: r.severity, action: r.action, reason: r.reason,
    outcome: r.outcome ?? null, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, day: r.day,
  }
}

const COLS: Record<keyof RunPatch, string> = {
  status: "status", summary: "summary", phrase: "phrase_json", severity: "severity", action: "action", reason: "reason", outcome: "outcome",
  startedAt: "started_at", finishedAt: "finished_at", day: "day",
}

export function createResolverStore(db: Database): ResolverStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resolver_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, rkey TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, ref_key TEXT NOT NULL,
      status TEXT NOT NULL, autonomy TEXT NOT NULL, instruction TEXT, model TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      phrase_json TEXT, severity TEXT, action TEXT, reason TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, day TEXT
    );
    CREATE INDEX IF NOT EXISTS resolver_runs_item ON resolver_runs (item_id, rkey, id);
    CREATE INDEX IF NOT EXISTS resolver_runs_day ON resolver_runs (day);
    CREATE TABLE IF NOT EXISTS resolver_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resolver_created (task_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS resolver_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref_key TEXT NOT NULL, action TEXT NOT NULL, error TEXT, error_key TEXT, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resolver_attempts_ref ON resolver_attempts (ref_key, action, id);
  `)
  // Additive column on a companion.db from before resolver.outcome.
  const cols = db.query("PRAGMA table_info(resolver_runs)").all() as { name: string }[]
  if (!cols.some((c) => c.name === "outcome")) db.exec("ALTER TABLE resolver_runs ADD COLUMN outcome TEXT")
  const one = (sql: string, ...args: (string | number)[]): RunRow | null => {
    const r = db.query(sql).get(...args) as Raw | null
    return r ? toRow(r) : null
  }
  const store: ResolverStore = {
    insert(run, now) {
      const r = db.query(
        "INSERT INTO resolver_runs (item_id, rkey, version, source, ref_key, status, autonomy, instruction, model, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) RETURNING id",
      ).get(run.itemId, run.rkey, run.version, run.source, run.refKey, run.autonomy, run.instruction, run.model, now) as { id: number }
      return store.get(r.id)!
    },
    update(id, patch) {
      const sets: string[] = []
      const args: (string | number | null)[] = []
      for (const [k, v] of Object.entries(patch) as [keyof RunPatch, unknown][]) {
        if (v === undefined) continue
        sets.push(`${COLS[k]} = ?`)
        args.push(k === "phrase" ? (v === null ? null : JSON.stringify(v)) : (v as string | number | null))
      }
      if (sets.length) db.query(`UPDATE resolver_runs SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
      return store.get(id)
    },
    get: (id) => one("SELECT * FROM resolver_runs WHERE id = ?", id),
    latest: (itemId, rkey) => one("SELECT * FROM resolver_runs WHERE item_id = ? AND rkey = ? ORDER BY id DESC LIMIT 1", itemId, rkey),
    startedOn(day) {
      return (db.query("SELECT COUNT(*) AS n FROM resolver_runs WHERE day = ? AND started_at IS NOT NULL AND autonomy = 'normal'").get(day) as { n: number }).n
    },
    queued() {
      return (db.query("SELECT * FROM resolver_runs WHERE status = 'queued' ORDER BY (autonomy = 'elevated') DESC, id ASC").all() as Raw[]).map(toRow)
    },
    countsOn(day) {
      const rows = db.query("SELECT action, COUNT(*) AS n FROM resolver_runs WHERE day = ? AND action IS NOT NULL GROUP BY action").all(day) as { action: string; n: number }[]
      return Object.fromEntries(rows.map((r) => [r.action, r.n]))
    },
    hadAction(refKey, action) {
      return !!db.query("SELECT 1 FROM resolver_runs WHERE ref_key = ? AND action = ? LIMIT 1").get(refKey, action)
    },
    markCreated(taskId, now) {
      db.query("INSERT OR IGNORE INTO resolver_created (task_id, created_at) VALUES (?, ?)").run(taskId, now)
    },
    isCreated: (taskId) => !!db.query("SELECT 1 FROM resolver_created WHERE task_id = ?").get(taskId),
    meta: (key) => (db.query("SELECT value FROM resolver_meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null,
    setMeta(key, value) {
      db.query("INSERT OR REPLACE INTO resolver_meta (key, value) VALUES (?, ?)").run(key, value)
    },
    closeInterrupted(now) {
      const running = db.query(
        "UPDATE resolver_runs SET status = 'failed', action = 'failed', outcome = 'failed', summary = 'interrupted by a server restart', finished_at = ? WHERE status = 'running'",
      ).run(now).changes
      const queued = db.query(
        "UPDATE resolver_runs SET status = 'skipped', reason = 'restart', summary = 'lost its place in the queue (restart)', finished_at = ? WHERE status = 'queued'",
      ).run(now).changes
      return running + queued
    },
    attempt(refKey, action, error, now) {
      db.query("INSERT INTO resolver_attempts (ref_key, action, error, error_key, at) VALUES (?, ?, ?, ?, ?)")
        .run(refKey, action, error, error === null ? null : errorKey(error), now)
    },
    failures(refKey, action, since) {
      const rows = db.query("SELECT error, error_key FROM resolver_attempts WHERE ref_key = ? AND action = ? AND at >= ? ORDER BY id DESC LIMIT 10")
        .all(refKey, action, since) as { error: string | null; error_key: string | null }[]
      const head = rows[0]
      if (!head || head.error_key === null) return null
      let count = 0
      for (const r of rows) {
        if (r.error_key !== head.error_key) break
        count++
      }
      return { count, error: head.error ?? "" }
    },
    prune(before) {
      db.query("DELETE FROM resolver_runs WHERE created_at < ? AND status NOT IN ('queued', 'running')").run(before)
      db.query("DELETE FROM resolver_created WHERE created_at < ?").run(before)
      db.query("DELETE FROM resolver_attempts WHERE at < ?").run(before)
    },
  }
  return store
}
