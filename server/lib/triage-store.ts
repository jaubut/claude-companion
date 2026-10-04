import type { Database } from "bun:sqlite"
import type { Phrase, Severity } from "./triage"

// Triage persistence (companion.db, injected Database so tests use :memory:):
//   triage_phrases  one phrased item per id, valid for one underlying version;
//                   a fallback row is retried after FALLBACK_RETRY_MS
//   triage_snoozes  hidden until `until`
//   triage_choices  the result of a choose per (item, Idempotency-Key), replayed
// prune() drops expired snoozes, choices after 7 days, phrases after 30.

export const FALLBACK_RETRY_MS = 10 * 60_000
export const CHOICE_TTL_MS = 7 * 24 * 60 * 60_000
export const PHRASE_TTL_MS = 30 * 24 * 60 * 60_000

export type PhraseOrigin = "model" | "fallback"

export interface CachedPhrase { version: string; phrase: Phrase; severity: Severity; origin: PhraseOrigin; createdAt: number }

export interface ChoiceRecord { itemId: string; idemKey: string; optionId: string; result: Record<string, unknown>; createdAt: number }

export interface TriageStore {
  /** The cached phrase for this exact version; a stale fallback reads as a miss. */
  phrase(itemId: string, version: string, now: number): CachedPhrase | null
  savePhrase(itemId: string, entry: CachedPhrase): void
  snoozedUntil(itemId: string, now: number): number | null
  snooze(itemId: string, until: number): void
  choice(itemId: string, idemKey: string): ChoiceRecord | null
  saveChoice(rec: ChoiceRecord): void
  prune(now: number): void
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
  `)
  return {
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
    prune(now) {
      db.query("DELETE FROM triage_snoozes WHERE until <= ?").run(now)
      db.query("DELETE FROM triage_choices WHERE created_at < ?").run(now - CHOICE_TTL_MS)
      db.query("DELETE FROM triage_phrases WHERE created_at < ?").run(now - PHRASE_TTL_MS)
    },
  }
}
