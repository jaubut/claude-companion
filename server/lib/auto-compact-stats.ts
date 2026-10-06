import type { Database } from "bun:sqlite"

// Auto-compactions this server completed (one row per compact_boundary that
// answered our /compact), for the Token burn card's "compactions N · saved X"
// (GET /api/body/tokens → `compactions`). companion.db, this host only.

export interface CompactionRow {
  at: number
  sessionKey: string
  name: string
  trigger: string
  preTokens: number
  postTokens: number
}

export interface CompactionStats {
  count: number
  pre_tokens: number
  post_tokens: number
  /** Σ(pre − post): context tokens no longer re-sent on every turn. */
  saved: number
}

export function ensureCompactionLog(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger TEXT NOT NULL,
      pre_tokens INTEGER NOT NULL,
      post_tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_compactions_at ON auto_compactions (at);
  `)
}

export function insertCompaction(db: Database, r: CompactionRow): void {
  db.query("INSERT INTO auto_compactions (at, session_key, name, trigger, pre_tokens, post_tokens) VALUES (?, ?, ?, ?, ?, ?)")
    .run(r.at, r.sessionKey, r.name, r.trigger, r.preTokens, r.postTokens)
}

export function compactionStats(db: Database, sinceMs: number): CompactionStats {
  const r = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(pre_tokens),0) AS pre, COALESCE(SUM(post_tokens),0) AS post FROM auto_compactions WHERE at >= ?")
    .get(sinceMs) as { n: number; pre: number; post: number }
  return { count: r.n, pre_tokens: r.pre, post_tokens: r.post, saved: Math.max(0, r.pre - r.post) }
}

/** Local midnight of a YYYY-MM-DD day (the tokens view's `since`). */
export function localDayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1).getTime()
}
