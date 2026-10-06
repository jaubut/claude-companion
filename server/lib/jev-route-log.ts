import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { INTENTS, type Intent } from "./jev-router"
import { redactSecrets } from "./secret-redact"

// Shadow log for the Jev front door: one row per user message — what Jev
// decided, what actually answered, and (when the old brain answered) what the
// old path did. `jev-report` turns it into the go-live numbers.

export type OldOutcome = "chat" | "task" | "error"

export interface RouteLogRow {
  at: number
  channel: string
  text: string
  mode: string
  intent: Intent | null
  intentConf: number | null
  project: string | null
  projectNoteId: string | null
  projectConf: number | null
  projectSource: string | null
  route: string
  oldOutcome: OldOutcome | null
  oldNoteId: string | null
  jevMs: number | null
  totalMs: number | null
  error: string | null
}

export const TEXT_MAX = 200

export function textHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16)
}

export function ensureRouteLog(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jev_route_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      channel TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      text TEXT NOT NULL,
      mode TEXT NOT NULL,
      intent TEXT,
      intent_conf REAL,
      project TEXT,
      project_note_id TEXT,
      project_conf REAL,
      project_source TEXT,
      route TEXT NOT NULL,
      old_outcome TEXT,
      old_note_id TEXT,
      jev_ms INTEGER,
      total_ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jev_route_log_at ON jev_route_log (at);
  `)
}

export function insertRouteLog(db: Database, r: RouteLogRow): void {
  db.query(
    `INSERT INTO jev_route_log (at, channel, text_hash, text, mode, intent, intent_conf, project, project_note_id, project_conf,
       project_source, route, old_outcome, old_note_id, jev_ms, total_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.at, r.channel, textHash(r.text), redactSecrets(r.text.replace(/\s+/g, " ").trim()).slice(0, TEXT_MAX), r.mode,
    r.intent, r.intentConf, r.project, r.projectNoteId, r.projectConf, r.projectSource, r.route, r.oldOutcome, r.oldNoteId,
    r.jevMs, r.totalMs, r.error,
  )
}

type Raw = Record<string, string | number | null>

export function readRouteLog(db: Database, sinceMs: number): RouteLogRow[] {
  const rows = db.query("SELECT * FROM jev_route_log WHERE at >= ? ORDER BY at").all(sinceMs) as Raw[]
  const s = (v: unknown) => (typeof v === "string" ? v : null)
  const n = (v: unknown) => (typeof v === "number" ? v : null)
  return rows.map((r) => ({
    at: Number(r.at), channel: String(r.channel), text: String(r.text), mode: String(r.mode),
    intent: (INTENTS as readonly string[]).includes(String(r.intent)) ? (r.intent as Intent) : null,
    intentConf: n(r.intent_conf), project: s(r.project), projectNoteId: s(r.project_note_id), projectConf: n(r.project_conf),
    projectSource: s(r.project_source), route: String(r.route),
    oldOutcome: r.old_outcome === "chat" || r.old_outcome === "task" || r.old_outcome === "error" ? r.old_outcome : null,
    oldNoteId: s(r.old_note_id), jevMs: n(r.jev_ms), totalMs: n(r.total_ms), error: s(r.error),
  }))
}

// ── Report math (pure) ───────────────────────────────────────────────────────
// The old path only knows chat vs task, so it is a valid label only where it
// could have said what Jev said: a Jev status / quick_look / body against an
// old "chat" is a new capability, not a disagreement, and is left out.
// quick_look ↔ old task agrees: a repo question was a worker task before.

export const GO_LIVE_MIN_CONFIDENT = 20
export const GO_LIVE_MIN_AGREEMENT = 0.75

export function comparable(r: RouteLogRow): boolean {
  if (!r.intent || (r.oldOutcome !== "chat" && r.oldOutcome !== "task")) return false
  return !(r.oldOutcome === "chat" && (r.intent === "status" || r.intent === "quick_look" || r.intent === "body" || r.intent === "my_tasks"))
}

export function agrees(r: RouteLogRow): boolean {
  if (r.oldOutcome === "task") return r.intent === "task" || r.intent === "quick_look"
  return r.oldOutcome === "chat" && r.intent === "chat"
}

export interface IntentStats { confident: number; comparable: number; agree: number; precision: number | null }

export interface RouteReport {
  total: number
  errors: number
  confident: number
  comparable: number
  agree: number
  agreement: number | null
  perIntent: Record<Intent, IntentStats>
  projectChecked: number
  projectAgree: number
  meanJevMs: number | null
  goLive: boolean
  minConf: number
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

export function buildReport(rows: RouteLogRow[], minConf: number): RouteReport {
  const confident = rows.filter((r) => r.intent && (r.intentConf ?? 0) >= minConf)
  const comp = confident.filter(comparable)
  const agree = comp.filter(agrees).length
  const perIntent = Object.fromEntries(INTENTS.map((i) => {
    const c = confident.filter((r) => r.intent === i)
    const cc = c.filter(comparable)
    const a = cc.filter(agrees).length
    return [i, { confident: c.length, comparable: cc.length, agree: a, precision: ratio(a, cc.length) }]
  })) as Record<Intent, IntentStats>
  const proj = confident.filter((r) => r.oldOutcome === "task" && r.oldNoteId && r.projectNoteId)
  const jevMs = rows.map((r) => r.jevMs).filter((v): v is number => v !== null)
  const agreement = ratio(agree, comp.length)
  return {
    total: rows.length, errors: rows.filter((r) => !r.intent).length, confident: confident.length, comparable: comp.length, agree,
    agreement, perIntent, projectChecked: proj.length, projectAgree: proj.filter((r) => r.oldNoteId === r.projectNoteId).length,
    meanJevMs: jevMs.length ? Math.round(jevMs.reduce((a, b) => a + b, 0) / jevMs.length) : null,
    goLive: confident.length >= GO_LIVE_MIN_CONFIDENT && agreement !== null && agreement >= GO_LIVE_MIN_AGREEMENT,
    minConf,
  }
}

const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`)

export function formatReport(r: RouteReport, days: number): string {
  const lines = [
    `Jev front door — last ${days} day(s), min confidence ${r.minConf}`,
    `messages ${r.total} · Jev errors ${r.errors} · confident ${r.confident} · mean Jev latency ${r.meanJevMs ?? "—"} ms`,
    `intent agreement with the old path (comparable ${r.comparable}): ${r.agree}/${r.comparable} = ${pct(r.agreement)}`,
    "per intent (confident · comparable · agree · precision):",
    ...INTENTS.map((i) => {
      const s = r.perIntent[i]
      return `  ${i.padEnd(10)} ${String(s.confident).padStart(4)} ${String(s.comparable).padStart(4)} ${String(s.agree).padStart(4)}  ${pct(s.precision)}`
    }),
    `project agreement on old-path tasks: ${r.projectAgree}/${r.projectChecked}`,
    `go-live bar (≥ ${GO_LIVE_MIN_CONFIDENT} confident, ≥ ${GO_LIVE_MIN_AGREEMENT * 100}% agreement): ${r.goLive ? "MET — set COMPANION_JEV_ROUTER=live" : "not met"}`,
  ]
  return lines.join("\n")
}
