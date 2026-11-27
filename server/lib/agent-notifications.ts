import { Database } from "bun:sqlite"
import { companionDbPath } from "./db-path"
import { db as defaultDb } from "./orchestrator-db"
import type { TelemetrySink } from "./orchestrator-telemetry"

export const NOTIFICATION_SEVERITIES = ["low", "medium", "high", "critical"] as const
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

const SEVERITY_SET: ReadonlySet<string> = new Set(NOTIFICATION_SEVERITIES)

export interface Notification {
  id: number
  source: string
  severity: NotificationSeverity
  summary: string
}

export interface InsertNotificationInput {
  source: string
  severity: NotificationSeverity
  summary: string
  payload?: Record<string, unknown> | null
}

export function ensureAgentNotificationsTable(sqlite: Database): void {
  try {
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  } catch { /* in-memory or readonly fallback */ }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
      summary TEXT NOT NULL,
      payload_json TEXT,
      surfaced_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_unsurfaced_notifications
      ON agent_notifications(severity, created_at)
      WHERE surfaced_at IS NULL;
  `)
}

ensureAgentNotificationsTable(defaultDb)

/** Open a dedicated WAL-mode SQLite connection for Lane B background workers so writes never share Lane A's handle. */
export function openIsolatedNotificationDb(path = companionDbPath()): Database {
  const conn = new Database(path)
  try {
    conn.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  } catch { /* in-memory or readonly fallback */ }
  ensureAgentNotificationsTable(conn)
  return conn
}

function isSqliteDb(sink: TelemetrySink): sink is Database {
  return typeof sink === "object" && sink !== null && "query" in sink && typeof sink.query === "function"
}

function sanitizeSummary(raw: string): string {
  return raw
    .replace(/^\s*\[event(?:\s+[^\]]+)?\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400)
}

export async function insertAgentNotification(
  sink: TelemetrySink,
  input: InsertNotificationInput,
): Promise<number | null> {
  const source = input.source.trim().slice(0, 64) || "background"
  const severity: NotificationSeverity = SEVERITY_SET.has(input.severity) ? input.severity : "medium"
  const summary = sanitizeSummary(input.summary)
  if (!summary) return null
  const payloadStr = input.payload ? JSON.stringify(input.payload) : ""

  if (isSqliteDb(sink)) {
    ensureAgentNotificationsTable(sink)
    const row = sink
      .query(
        `INSERT INTO agent_notifications (source, severity, summary, payload_json)
         VALUES (?, ?, ?, ?)
         RETURNING id`,
      )
      .get(source, severity, summary, payloadStr || null) as { id: number } | null
    return row ? Number(row.id) : null
  }

  const rows = await sink`
    INSERT INTO agent_notifications (source, severity, summary, payload_json)
    VALUES (${source}, ${severity}, ${summary}, ${payloadStr})
    RETURNING id;
  `
  if (Array.isArray(rows) && rows[0] && typeof (rows[0] as Record<string, unknown>).id !== "undefined") {
    return Number((rows[0] as Record<string, unknown>).id)
  }
  return null
}

interface RawNotificationRow {
  id: number | string
  source: string
  severity: string
  summary: string
}

/**
 * Lane A Notification Ingestion Bridge:
 * Atomically claim up to 3 unsurfaced `high` / `critical` notifications and format them
 * as a `### Background System Updates` block for the interactive turn suffix.
 */
export async function fetchAndMarkUnsurfacedNotifications(
  sink: TelemetrySink = defaultDb,
): Promise<string | null> {
  let rows: RawNotificationRow[] = []

  if (isSqliteDb(sink)) {
    ensureAgentNotificationsTable(sink)
    rows = sink
      .query(
        `UPDATE agent_notifications
         SET surfaced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id IN (
           SELECT id FROM agent_notifications
           WHERE surfaced_at IS NULL AND severity IN ('high', 'critical')
           ORDER BY created_at DESC, id DESC
           LIMIT 3
         )
         RETURNING id, source, severity, summary`,
      )
      .all() as RawNotificationRow[]
  } else {
    const res = await sink`
      UPDATE agent_notifications
      SET surfaced_at = NOW()
      WHERE id IN (
        SELECT id FROM agent_notifications
        WHERE surfaced_at IS NULL AND severity IN ('high', 'critical')
        ORDER BY created_at DESC LIMIT 3
      )
      RETURNING id, source, severity, summary;
    `
    if (Array.isArray(res)) {
      rows = res as RawNotificationRow[]
    }
  }

  if (rows.length === 0) return null

  const normalized: Notification[] = rows.map((r) => ({
    id: Number(r.id),
    source: String(r.source),
    severity: (SEVERITY_SET.has(String(r.severity)) ? String(r.severity) : "high") as NotificationSeverity,
    summary: sanitizeSummary(String(r.summary)),
  }))

  const items = normalized
    .map((r) => `- [${r.severity.toUpperCase()}] ${r.source}: ${r.summary}`)
    .join("\n")

  return `### Background System Updates\n${items}`
}

export function classifyBackgroundEventNotification(turn: {
  text: string
  cardKind?: string | null
}): { source: string; severity: NotificationSeverity; summary: string } {
  const clean = sanitizeSummary(turn.text)
  if (turn.cardKind === "worker_blocked" || /\b(blocked|crash_loop|fatal|failed|uncommitted)\b/i.test(clean)) {
    return { source: "worker-supervisor", severity: "critical", summary: clean }
  }
  if (/^\[from\s+([^\]]+)\]/i.test(clean)) {
    const sender = /^\[from\s+([^\]]+)\]/i.exec(clean)?.[1]?.trim() || "repo-lead"
    const body = clean.replace(/^\[from\s+[^\]]+\]\s*/i, "").trim()
    return { source: sender.slice(0, 64), severity: "high", summary: body || clean }
  }
  if (/^(?:stuck)\s+/i.test(clean)) {
    return { source: "pr-shepherd", severity: "high", summary: clean }
  }
  if (/^(?:green PR|CI green)\s+/i.test(clean)) {
    return { source: "ci-monitor", severity: "high", summary: clean }
  }
  if (/^Auto-deploy/i.test(clean)) {
    const isErr = /\b(fail|error|refused|rollback)\b/i.test(clean)
    return { source: "auto-deploy", severity: isErr ? "critical" : "low", summary: clean }
  }
  return { source: "ops-triage", severity: "high", summary: clean }
}
