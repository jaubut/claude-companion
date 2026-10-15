import type { Database } from "bun:sqlite"
import type { Phrase, Severity } from "./triage"
import type { RepoRun, RepoRunResult, RepoRunStatus } from "./triage-repos"

// Triage persistence (companion.db, injected Database so tests use :memory:):
//   triage_phrases  one phrased item per id, valid for one underlying version;
//                   a fallback row is retried after FALLBACK_RETRY_MS
//   triage_snoozes  hidden until `until`
//   triage_choices  the result of a choose per (item, Idempotency-Key), replayed
//   triage_expired  a card auto-dismissed after CARD_TTL_MS idle, for that version only
//   triage_repo_runs one Yes / No on a repo card (lib/triage-repos.ts), UNIQUE (repo_key, idem_key):
//                   the Idempotency-Key replay; mutated only by wiring/triage-repos.ts
// prune() drops expired snoozes, choices and finished repo runs after 7 days, phrases after 30.

export const FALLBACK_RETRY_MS = 10 * 60_000
export const CHOICE_TTL_MS = 7 * 24 * 60 * 60_000
export const PHRASE_TTL_MS = 30 * 24 * 60 * 60_000

export type PhraseOrigin = "model" | "fallback"

export interface CachedPhrase { version: string; phrase: Phrase; severity: Severity; origin: PhraseOrigin; createdAt: number }

export interface ExpiredCard { itemId: string; version: string; title: string; at: number }

export interface ChoiceRecord { itemId: string; idemKey: string; optionId: string; result: Record<string, unknown>; createdAt: number }

interface NewRepoRun { repoKey: string; cardVersion: string; decision: "yes" | "no"; note: string | null; idemKey: string }
type RepoRunPatch = Partial<{ status: RepoRunStatus; results: RepoRunResult[]; summary: string | null; finishedAt: number | null }>

export interface TriageStore {
  /** The cached phrase for this exact version; a stale fallback reads as a miss. */
  phrase(itemId: string, version: string, now: number): CachedPhrase | null
  savePhrase(itemId: string, entry: CachedPhrase): void
  snoozedUntil(itemId: string, now: number): number | null
  snooze(itemId: string, until: number): void
  choice(itemId: string, idemKey: string): ChoiceRecord | null
  saveChoice(rec: ChoiceRecord): void
  /** This exact version was auto-dismissed (a new version = activity, the card comes back). */
  expired(itemId: string, version: string): boolean
  expire(card: ExpiredCard): void
  /** Cards dismissed since `since` (the daily digest). */
  expiredSince(since: number): ExpiredCard[]
  /** The run stored for this (repo, Idempotency-Key), whatever its status. */
  repoRun(repoKey: string, idemKey: string): RepoRun | null
  /** A new `running` row; null when (repo, key) already has one (replay it instead). */
  insertRun(run: NewRepoRun, now: number): RepoRun | null
  updateRun(id: number, patch: RepoRunPatch): RepoRun | null
  /** The repo's run in progress (one at a time). */
  runningRun(repoKey: string): RepoRun | null
  /** The newest run per repo key (the cards' `run`). */
  latestRuns(): Map<string, RepoRun>
  prune(now: number): void
}

interface RunRaw {
  id: number; repo_key: string; card_version: string; decision: "yes" | "no"; note: string | null; idem_key: string; status: RepoRunStatus
  results_json: string; summary: string | null; created_at: number; finished_at: number | null
}

function toRun(r: RunRaw): RepoRun {
  let results: RepoRunResult[] = []
  try { results = JSON.parse(r.results_json) as RepoRunResult[] } catch { results = [] }
  return {
    id: r.id, repoKey: r.repo_key, cardVersion: r.card_version, decision: r.decision, note: r.note, idemKey: r.idem_key, status: r.status,
    results, summary: r.summary, createdAt: r.created_at, finishedAt: r.finished_at,
  }
}

interface PhraseRow { version: string; phrase_json: string; severity: Severity; origin: PhraseOrigin; created_at: number }

export function createTriageStore(db: Database): TriageStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triage_phrases (
      item_id TEXT PRIMARY KEY, version TEXT NOT NULL, phrase_json TEXT NOT NULL,
      severity TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS triage_snoozes (item_id TEXT PRIMARY KEY, until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS triage_choices (
      item_id TEXT NOT NULL, idem_key TEXT NOT NULL, option_id TEXT NOT NULL, result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (item_id, idem_key)
    );
    CREATE TABLE IF NOT EXISTS triage_expired (item_id TEXT PRIMARY KEY, version TEXT NOT NULL, title TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS triage_repo_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo_key TEXT NOT NULL, card_version TEXT NOT NULL, decision TEXT NOT NULL, note TEXT,
      idem_key TEXT NOT NULL, status TEXT NOT NULL, results_json TEXT NOT NULL DEFAULT '[]', summary TEXT,
      created_at INTEGER NOT NULL, finished_at INTEGER, UNIQUE (repo_key, idem_key)
    );
    CREATE INDEX IF NOT EXISTS triage_repo_runs_repo ON triage_repo_runs (repo_key, id);
  `)
  const run = (sql: string, ...args: (string | number)[]): RepoRun | null => {
    const r = db.query(sql).get(...args) as RunRaw | null
    return r ? toRun(r) : null
  }
  const store: TriageStore = {
    phrase(itemId, version, now) {
      const r = db.query("SELECT version, phrase_json, severity, origin, created_at FROM triage_phrases WHERE item_id = ?").get(itemId) as PhraseRow | null
      if (!r || r.version !== version) return null
      if (r.origin === "fallback" && now - r.created_at >= FALLBACK_RETRY_MS) return null
      try {
        return { version: r.version, phrase: JSON.parse(r.phrase_json) as Phrase, severity: r.severity, origin: r.origin, createdAt: r.created_at }
      } catch {
        return null
      }
    },
    savePhrase(itemId, e) {
      db.query("INSERT OR REPLACE INTO triage_phrases (item_id, version, phrase_json, severity, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(itemId, e.version, JSON.stringify(e.phrase), e.severity, e.origin, e.createdAt)
    },
    snoozedUntil(itemId, now) {
      const r = db.query("SELECT until FROM triage_snoozes WHERE item_id = ?").get(itemId) as { until: number } | null
      return r && r.until > now ? r.until : null
    },
    snooze(itemId, until) {
      db.query("INSERT OR REPLACE INTO triage_snoozes (item_id, until) VALUES (?, ?)").run(itemId, until)
    },
    choice(itemId, idemKey) {
      const r = db.query("SELECT item_id, idem_key, option_id, result_json, created_at FROM triage_choices WHERE item_id = ? AND idem_key = ?")
        .get(itemId, idemKey) as { item_id: string; idem_key: string; option_id: string; result_json: string; created_at: number } | null
      if (!r) return null
      try {
        return { itemId: r.item_id, idemKey: r.idem_key, optionId: r.option_id, result: JSON.parse(r.result_json) as Record<string, unknown>, createdAt: r.created_at }
      } catch {
        return null
      }
    },
    saveChoice(c) {
      db.query("INSERT OR IGNORE INTO triage_choices (item_id, idem_key, option_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(c.itemId, c.idemKey, c.optionId, JSON.stringify(c.result), c.createdAt)
    },
    expired(itemId, version) {
      return !!db.query("SELECT 1 FROM triage_expired WHERE item_id = ? AND version = ?").get(itemId, version)
    },
    expire(c) {
      db.query("INSERT OR REPLACE INTO triage_expired (item_id, version, title, at) VALUES (?, ?, ?, ?)").run(c.itemId, c.version, c.title, c.at)
    },
    expiredSince(since) {
      return (db.query("SELECT item_id, version, title, at FROM triage_expired WHERE at >= ? ORDER BY at").all(since) as { item_id: string; version: string; title: string; at: number }[])
        .map((r) => ({ itemId: r.item_id, version: r.version, title: r.title, at: r.at }))
    },
    repoRun: (repoKey, idemKey) => run("SELECT * FROM triage_repo_runs WHERE repo_key = ? AND idem_key = ?", repoKey, idemKey),
    insertRun(r, now) {
      const res = db.query(
        "INSERT OR IGNORE INTO triage_repo_runs (repo_key, card_version, decision, note, idem_key, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
      ).run(r.repoKey, r.cardVersion, r.decision, r.note, r.idemKey, now)
      return res.changes ? store.repoRun(r.repoKey, r.idemKey) : null
    },
    updateRun(id, patch) {
      const sets: string[] = []
      const args: (string | number | null)[] = []
      if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status) }
      if (patch.results !== undefined) { sets.push("results_json = ?"); args.push(JSON.stringify(patch.results)) }
      if (patch.summary !== undefined) { sets.push("summary = ?"); args.push(patch.summary) }
      if (patch.finishedAt !== undefined) { sets.push("finished_at = ?"); args.push(patch.finishedAt) }
      if (sets.length) db.query(`UPDATE triage_repo_runs SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
      return run("SELECT * FROM triage_repo_runs WHERE id = ?", id)
    },
    runningRun: (repoKey) => run("SELECT * FROM triage_repo_runs WHERE repo_key = ? AND status = 'running' ORDER BY id DESC LIMIT 1", repoKey),
    latestRuns() {
      const rows = db.query("SELECT * FROM triage_repo_runs WHERE id IN (SELECT MAX(id) FROM triage_repo_runs GROUP BY repo_key)").all() as RunRaw[]
      return new Map(rows.map((r) => [r.repo_key, toRun(r)]))
    },
    prune(now) {
      db.query("DELETE FROM triage_snoozes WHERE until <= ?").run(now)
      db.query("DELETE FROM triage_choices WHERE created_at < ?").run(now - CHOICE_TTL_MS)
      db.query("DELETE FROM triage_phrases WHERE created_at < ?").run(now - PHRASE_TTL_MS)
      db.query("DELETE FROM triage_repo_runs WHERE created_at < ? AND status != 'running'").run(now - CHOICE_TTL_MS)
    },
  }
  return store
}
