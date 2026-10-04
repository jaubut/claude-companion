import type { Database } from "bun:sqlite"
import type { TripUpload } from "./trip-model"

// Travel log persistence (companion.db, injected Database so tests use :memory:):
//   trip_uploads       every upload the server accepted, until the dashboard confirms it
//                      (the server owns a trip from the moment it is stored here)
//   trip_geocode       Nominatim reverse-geocode cache by rounded coords
//   trip_classify_log  one row per classifier decision (+ the human's later answer)
//   trip_history       human overrides with their coords (classifier history)

export type UploadState = "pending" | "confirmed" | "rejected"
export type Review = "filed" | "needs_review"

export interface UploadRow {
  clientTripId: string
  upload: TripUpload
  state: UploadState
  tripId: string | null
  classification: string
  clientSlug: string | null
  confidence: number
  review: Review
  classifiedBy: string
  logId: number | null
  attempts: number
  nextAttemptAt: number
  lastError: string | null
  resolvedAt: number | null
  createdAt: number
}

export interface UploadResult { classification: string; clientSlug: string | null; confidence: number; review: Review; classifiedBy: string; logId: number | null }

export interface GeoEntry { label: string; city: string | null; category: string | null }

export interface LogEntry {
  tripKey: string
  tripId: string | null
  mode: "upload" | "backfill" | "triage" | "smoke"
  classification: string
  clientSlug: string | null
  confidence: number
  decision: Review
  classifiedBy: string
  rule: string | null
  evidence: Record<string, unknown>
}

export interface LogRow extends LogEntry { id: number; at: number; humanClassification: string | null; humanClientSlug: string | null; humanAt: number | null }

export interface HistoryRow { tripId: string; startLat: number; startLon: number; endLat: number; endLon: number; classification: string; clientSlug: string | null; startedAt: string; at: number }

export const CONFIRMED_TTL_MS = 90 * 24 * 60 * 60_000
export const GEOCODE_TTL_MS = 180 * 24 * 60 * 60_000

type R = Record<string, unknown>
const s = (v: unknown): string | null => (typeof v === "string" ? v : null)

function toUpload(r: R): UploadRow | null {
  let upload: TripUpload
  try { upload = JSON.parse(String(r.payload_json)) as TripUpload } catch { return null }
  return {
    clientTripId: String(r.client_trip_id), upload, state: r.state as UploadState, tripId: s(r.trip_id),
    classification: String(r.classification), clientSlug: s(r.client_slug), confidence: Number(r.confidence),
    review: r.review as Review, classifiedBy: String(r.classified_by), logId: r.log_id == null ? null : Number(r.log_id),
    attempts: Number(r.attempts), nextAttemptAt: Number(r.next_attempt_at), lastError: s(r.last_error),
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at), createdAt: Number(r.created_at),
  }
}

function toLog(r: R): LogRow {
  let evidence: Record<string, unknown> = {}
  try { evidence = JSON.parse(String(r.evidence_json)) as Record<string, unknown> } catch { /* keep {} */ }
  return {
    id: Number(r.id), at: Number(r.at), tripKey: String(r.trip_key), tripId: s(r.trip_id), mode: r.mode as LogEntry["mode"],
    classification: String(r.classification), clientSlug: s(r.client_slug), confidence: Number(r.confidence),
    decision: r.decision as Review, classifiedBy: String(r.classified_by), rule: s(r.rule), evidence,
    humanClassification: s(r.human_classification), humanClientSlug: s(r.human_client_slug), humanAt: r.human_at == null ? null : Number(r.human_at),
  }
}

/** Classify log rows since `since` (ms), without touching the schema (read-only `trip-report`). Throws when the table is absent. */
export function readLogSince(db: Database, since: number): LogRow[] {
  return (db.query("SELECT * FROM trip_classify_log WHERE at >= ? AND mode != 'smoke' ORDER BY id").all(since) as R[]).map(toLog)
}

export function createTripStore(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trip_uploads (
      client_trip_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, state TEXT NOT NULL, trip_id TEXT,
      classification TEXT NOT NULL DEFAULT 'unclassified', client_slug TEXT, confidence REAL NOT NULL DEFAULT 0,
      review TEXT NOT NULL DEFAULT 'needs_review', classified_by TEXT NOT NULL DEFAULT 'rules', log_id INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      resolved_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trip_uploads_state ON trip_uploads (state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_trip_uploads_trip ON trip_uploads (trip_id);
    CREATE TABLE IF NOT EXISTS trip_geocode (key TEXT PRIMARY KEY, label TEXT NOT NULL, city TEXT, category TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS trip_classify_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trip_key TEXT NOT NULL, trip_id TEXT, mode TEXT NOT NULL, at INTEGER NOT NULL,
      classification TEXT NOT NULL, client_slug TEXT, confidence REAL NOT NULL, decision TEXT NOT NULL,
      classified_by TEXT NOT NULL, rule TEXT, evidence_json TEXT NOT NULL,
      human_classification TEXT, human_client_slug TEXT, human_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_trip_log_trip ON trip_classify_log (trip_id, id);
    CREATE INDEX IF NOT EXISTS idx_trip_log_key ON trip_classify_log (trip_key, id);
    CREATE TABLE IF NOT EXISTS trip_history (
      trip_id TEXT PRIMARY KEY, start_lat REAL NOT NULL, start_lon REAL NOT NULL, end_lat REAL NOT NULL, end_lon REAL NOT NULL,
      classification TEXT NOT NULL, client_slug TEXT, started_at TEXT NOT NULL, at INTEGER NOT NULL
    );
  `)

  const one = (sql: string, ...args: (string | number | null)[]): R | null => db.query(sql).get(...args) as R | null
  const all = (sql: string, ...args: (string | number | null)[]): R[] => db.query(sql).all(...args) as R[]
  const uploads = (rows: R[]): UploadRow[] => rows.map(toUpload).filter((u): u is UploadRow => !!u)

  return {
    upload(clientTripId: string): UploadRow | null {
      const r = one("SELECT * FROM trip_uploads WHERE client_trip_id = ?", clientTripId)
      return r ? toUpload(r) : null
    },
    /** false = already stored (the caller replays it). */
    insertUpload(u: TripUpload, now: number): boolean {
      const res = db.query("INSERT OR IGNORE INTO trip_uploads (client_trip_id, payload_json, state, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)")
        .run(u.clientTripId, JSON.stringify(u), now, now)
      return res.changes > 0
    },
    setResult(clientTripId: string, r: UploadResult, now: number): void {
      db.query("UPDATE trip_uploads SET classification = ?, client_slug = ?, confidence = ?, review = ?, classified_by = ?, log_id = ?, updated_at = ? WHERE client_trip_id = ?")
        .run(r.classification, r.clientSlug, r.confidence, r.review, r.classifiedBy, r.logId, now, clientTripId)
    },
    updatePayload(u: TripUpload, now: number): void {
      db.query("UPDATE trip_uploads SET payload_json = ?, updated_at = ? WHERE client_trip_id = ?").run(JSON.stringify(u), now, u.clientTripId)
    },
    confirm(clientTripId: string, tripId: string, now: number): void {
      db.query("UPDATE trip_uploads SET state = 'confirmed', trip_id = ?, last_error = NULL, attempts = attempts + 1, updated_at = ? WHERE client_trip_id = ?")
        .run(tripId, now, clientTripId)
    },
    /** A failed push: retry at `retryAt`, or `rejected` (no automatic retry) when null. */
    fail(clientTripId: string, error: string, retryAt: number | null, now: number): void {
      db.query("UPDATE trip_uploads SET state = ?, last_error = ?, attempts = attempts + 1, next_attempt_at = ?, updated_at = ? WHERE client_trip_id = ?")
        .run(retryAt === null ? "rejected" : "pending", error.slice(0, 200), retryAt ?? 0, now, clientTripId)
    },
    due(now: number, limit = 20): UploadRow[] {
      return uploads(all("SELECT * FROM trip_uploads WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?", now, limit))
    },
    /** Everything the dashboard does not have yet (GET /api/trips merges these in). */
    unconfirmed(): UploadRow[] {
      return uploads(all("SELECT * FROM trip_uploads WHERE state != 'confirmed' ORDER BY created_at DESC LIMIT 200"))
    },
    needsReview(): UploadRow[] {
      return uploads(all("SELECT * FROM trip_uploads WHERE state = 'confirmed' AND review = 'needs_review' AND resolved_at IS NULL AND trip_id IS NOT NULL ORDER BY created_at LIMIT 50"))
    },
    byTripId(tripId: string): UploadRow | null {
      const r = one("SELECT * FROM trip_uploads WHERE trip_id = ?", tripId)
      return r ? toUpload(r) : null
    },
    resolve(tripId: string, now: number): void {
      db.query("UPDATE trip_uploads SET resolved_at = ?, updated_at = ? WHERE trip_id = ? AND resolved_at IS NULL").run(now, now, tripId)
    },

    geocode(key: string, now: number): GeoEntry | null {
      const r = one("SELECT label, city, category, at FROM trip_geocode WHERE key = ?", key)
      if (!r || now - Number(r.at) > GEOCODE_TTL_MS) return null
      return { label: String(r.label), city: s(r.city), category: s(r.category) }
    },
    saveGeocode(key: string, e: GeoEntry, now: number): void {
      db.query("INSERT OR REPLACE INTO trip_geocode (key, label, city, category, at) VALUES (?, ?, ?, ?, ?)").run(key, e.label, e.city, e.category, now)
    },

    log(e: LogEntry, now: number): number {
      const res = db.query(
        "INSERT INTO trip_classify_log (trip_key, trip_id, mode, at, classification, client_slug, confidence, decision, classified_by, rule, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(e.tripKey, e.tripId, e.mode, now, e.classification, e.clientSlug, e.confidence, e.decision, e.classifiedBy, e.rule, JSON.stringify(e.evidence))
      return Number(res.lastInsertRowid)
    },
    attachTripId(logId: number, tripId: string): void {
      db.query("UPDATE trip_classify_log SET trip_id = ? WHERE id = ?").run(tripId, logId)
    },
    logRow(id: number): LogRow | null {
      const r = one("SELECT * FROM trip_classify_log WHERE id = ?", id)
      return r ? toLog(r) : null
    },
    latestLog(tripId: string): LogRow | null {
      const r = one("SELECT * FROM trip_classify_log WHERE trip_id = ? AND mode != 'smoke' ORDER BY id DESC LIMIT 1", tripId)
      return r ? toLog(r) : null
    },
    /** Record the human's answer on the trip's latest decision (none → a `triage` row with no guess). */
    markHuman(tripId: string, classification: string, clientSlug: string | null, now: number): void {
      const latest = one("SELECT id FROM trip_classify_log WHERE trip_id = ? AND mode != 'smoke' ORDER BY id DESC LIMIT 1", tripId)
      if (latest) {
        db.query("UPDATE trip_classify_log SET human_classification = ?, human_client_slug = ?, human_at = ? WHERE id = ?").run(classification, clientSlug, now, Number(latest.id))
        return
      }
      db.query(
        "INSERT INTO trip_classify_log (trip_key, trip_id, mode, at, classification, client_slug, confidence, decision, classified_by, rule, evidence_json, human_classification, human_client_slug, human_at) VALUES (?, ?, 'triage', ?, 'unclassified', NULL, 0, 'needs_review', 'none', 'no_guess', '{}', ?, ?, ?)",
      ).run(tripId, tripId, now, classification, clientSlug, now)
    },
    logSince: (since: number): LogRow[] => readLogSince(db, since),

    saveHistory(h: HistoryRow): void {
      db.query("INSERT OR REPLACE INTO trip_history (trip_id, start_lat, start_lon, end_lat, end_lon, classification, client_slug, started_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(h.tripId, h.startLat, h.startLon, h.endLat, h.endLon, h.classification, h.clientSlug, h.startedAt, h.at)
    },
    history(): HistoryRow[] {
      return all("SELECT * FROM trip_history ORDER BY at DESC LIMIT 2000").map((r) => ({
        tripId: String(r.trip_id), startLat: Number(r.start_lat), startLon: Number(r.start_lon), endLat: Number(r.end_lat), endLon: Number(r.end_lon),
        classification: String(r.classification), clientSlug: s(r.client_slug), startedAt: String(r.started_at), at: Number(r.at),
      }))
    },

    prune(now: number): void {
      db.query("DELETE FROM trip_uploads WHERE state = 'confirmed' AND updated_at < ?").run(now - CONFIRMED_TTL_MS)
      db.query("DELETE FROM trip_geocode WHERE at < ?").run(now - GEOCODE_TTL_MS)
    },
  }
}

export type TripStore = ReturnType<typeof createTripStore>
