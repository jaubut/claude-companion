import type { Database } from "bun:sqlite"

// Notify gate (RES-6TV5): one front door for producer notifications, so the
// phone is pinged only when something needs Jeremie. Contract: docs/notify-api.md.
//
// Decision order (first match wins):
//   1. duplicate (source, dedupKey) seen in the last 24 h      → drop
//   2. severity urgent + actionable                            → now
//   3. outside waking hours (08:00–21:00 America/Toronto)      → brief
//   4. the notify-prefs note, judged by Haiku                  → its verdict
//      no note                                                 → hard-rule baseline
//      model error / timeout / bad JSON / prefs unreadable     → baseline, reason "fallback"
// Baseline: urgent (not actionable) / normal → checkin, low → brief. The model
// never drops silently: a drop verdict must carry a reason, else it is a fallback.
//
// Modes (COMPANION_NOTIFY_GATE, kill file ~/.claude/.notify-gate-disabled = off):
//   off     passthrough — every event pushed, no gating (still logged)
//   shadow  decide + log; push only `now`, exactly like /api/push/broadcast
//   live    same delivery as shadow today; check-in / brief delivery is a later phase

export type Severity = "urgent" | "normal" | "low"
export type Decision = "now" | "checkin" | "brief" | "drop"
export type GateMode = "shadow" | "live" | "off"
export type Origin = "rule" | "model" | "fallback" | "off"

export const DECISIONS: readonly Decision[] = ["now", "checkin", "brief", "drop"]
export const DEDUP_WINDOW_MS = 24 * 60 * 60_000
export const EVENT_TTL_MS = 30 * 24 * 60 * 60_000
export const WAKING_START_HOUR = 8
export const WAKING_END_HOUR = 21
export const GATE_TZ = "America/Toronto"
export const REASON_FALLBACK = "fallback"

export interface NotifyInput {
  source: string
  severity: Severity
  title: string
  body: string
  dedupKey: string
  actionable: boolean
  url?: string
}

export interface Verdict { decision: Decision; reason: string }

export interface NotifyEvent extends NotifyInput {
  id: number
  decision: Decision
  reason: string
  origin: Origin
  mode: GateMode
  delivered: boolean
  createdAt: number
}

// ── Validation ──────────────────────────────────────────────────────────────

const SEVERITIES = new Set<Severity>(["urgent", "normal", "low"])

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null

/** The POST body → a NotifyInput, or the name of the first bad field. */
export function parseNotify(raw: unknown): { ok: true; input: NotifyInput } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "body_must_be_object" }
  const o = raw as Record<string, unknown>
  const source = str(o.source, 80)
  if (!source) return { ok: false, error: "bad_source" }
  if (typeof o.severity !== "string" || !SEVERITIES.has(o.severity as Severity)) return { ok: false, error: "bad_severity" }
  const title = str(o.title, 200)
  if (!title) return { ok: false, error: "bad_title" }
  const body = str(o.body, 4000)
  if (!body) return { ok: false, error: "bad_body" }
  const dedupKey = str(o.dedupKey, 200)
  if (!dedupKey) return { ok: false, error: "bad_dedupKey" }
  if (typeof o.actionable !== "boolean") return { ok: false, error: "bad_actionable" }
  let url: string | undefined
  if (o.url !== undefined && o.url !== null) {
    const u = str(o.url, 2000)
    if (!u || !/^https?:\/\//i.test(u)) return { ok: false, error: "bad_url" }
    url = u
  }
  return { ok: true, input: { source, severity: o.severity as Severity, title, body, dedupKey, actionable: o.actionable, url } }
}

// ── Pure rules ──────────────────────────────────────────────────────────────

/** Hour (0–23) on the wall clock in America/Toronto. */
export function torontoHour(nowMs: number): number {
  const h = new Intl.DateTimeFormat("en-CA", { timeZone: GATE_TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(nowMs))
  return Number(h) % 24
}

export function inWakingHours(nowMs: number): boolean {
  const h = torontoHour(nowMs)
  return h >= WAKING_START_HOUR && h < WAKING_END_HOUR
}

const isUrgentActionable = (i: NotifyInput): boolean => i.severity === "urgent" && i.actionable

/** The hard-rule result without preferences (also the fail-open target). */
export function baseline(i: NotifyInput): Verdict {
  if (isUrgentActionable(i)) return { decision: "now", reason: "urgent + actionable" }
  if (i.severity === "low") return { decision: "brief", reason: "low severity" }
  return { decision: "checkin", reason: `${i.severity}${i.actionable ? "" : ", not actionable"}` }
}

/** The model's raw text → a verdict, or null when unusable (fence-tolerant). */
export function parseVerdict(raw: string | null): Verdict | null {
  if (!raw) return null
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
  let o: unknown
  try { o = JSON.parse(text) } catch { return null }
  if (typeof o !== "object" || o === null) return null
  const { decision, reason } = o as { decision?: unknown; reason?: unknown }
  if (typeof decision !== "string" || !DECISIONS.includes(decision as Decision)) return null
  const why = typeof reason === "string" ? reason.trim().slice(0, 300) : ""
  if (!why) return null // never accept an unexplained verdict — least of all a drop
  return { decision: decision as Decision, reason: why }
}

export function judgePrompt(prefs: string, i: NotifyInput, hour: number): string {
  return [
    "You gate phone notifications for Jeremie. Decide when this event should reach him, using his preferences below.",
    "Return ONLY minified JSON: {\"decision\":\"now|checkin|brief|drop\",\"reason\":\"<one short sentence>\"}",
    "now = push immediately · checkin = the next hourly check-in · brief = the daily brief · drop = not worth his attention at all.",
    "When unsure, prefer checkin over now and brief over drop.",
    "",
    "Preferences (his words):",
    prefs.trim().slice(0, 4000),
    "",
    `Local time in Toronto: ${String(hour).padStart(2, "0")}h`,
    "Event:",
    JSON.stringify({ source: i.source, severity: i.severity, actionable: i.actionable, title: i.title, body: i.body.slice(0, 1500), url: i.url ?? null }),
  ].join("\n")
}

// ── Store (companion.db, injected Database so tests use :memory:) ─────────

export interface ReportRow { source: string; decision: Decision; count: number }

export interface NotifyStore {
  /** A previous event with this (source, dedupKey) at or after `since`. */
  seenSince(source: string, dedupKey: string, since: number): boolean
  insert(e: Omit<NotifyEvent, "id">): number
  markDelivered(id: number): void
  get(id: number): NotifyEvent | null
  report(since: number): ReportRow[]
  prune(now: number): void
}

interface EventRaw {
  id: number; source: string; severity: Severity; title: string; body: string; dedup_key: string; actionable: number; url: string | null
  decision: Decision; reason: string; origin: Origin; mode: GateMode; delivered: number; created_at: number
}

export function createNotifyStore(db: Database): NotifyStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      dedup_key TEXT NOT NULL, actionable INTEGER NOT NULL, url TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL,
      origin TEXT NOT NULL, mode TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notify_events_dedup ON notify_events (source, dedup_key, created_at);
    CREATE INDEX IF NOT EXISTS notify_events_created ON notify_events (created_at);
  `)
  return {
    seenSince(source, dedupKey, since) {
      return !!db.query("SELECT 1 FROM notify_events WHERE source = ? AND dedup_key = ? AND created_at >= ? LIMIT 1").get(source, dedupKey, since)
    },
    insert(e) {
      const res = db.query(
        `INSERT INTO notify_events (source, severity, title, body, dedup_key, actionable, url, decision, reason, origin, mode, delivered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.source, e.severity, e.title, e.body, e.dedupKey, e.actionable ? 1 : 0, e.url ?? null, e.decision, e.reason, e.origin, e.mode, e.delivered ? 1 : 0, e.createdAt)
      return Number(res.lastInsertRowid)
    },
    markDelivered(id) {
      db.query("UPDATE notify_events SET delivered = 1 WHERE id = ?").run(id)
    },
    get(id) {
      const r = db.query("SELECT * FROM notify_events WHERE id = ?").get(id) as EventRaw | null
      if (!r) return null
      return {
        id: r.id, source: r.source, severity: r.severity, title: r.title, body: r.body, dedupKey: r.dedup_key, actionable: !!r.actionable,
        url: r.url ?? undefined, decision: r.decision, reason: r.reason, origin: r.origin, mode: r.mode, delivered: !!r.delivered, createdAt: r.created_at,
      }
    },
    report(since) {
      return db.query(
        "SELECT source, decision, COUNT(*) AS count FROM notify_events WHERE created_at >= ? GROUP BY source, decision ORDER BY source, decision",
      ).all(since) as ReportRow[]
    },
    prune(now) {
      db.query("DELETE FROM notify_events WHERE created_at < ?").run(now - EVENT_TTL_MS)
    },
  }
}

// ── Gate ────────────────────────────────────────────────────────────────────

export interface GateDeps {
  store: NotifyStore
  mode: () => GateMode
  /** The plain-words notify-prefs body; null = no note. Throws when unreadable. */
  prefs: () => Promise<string | null>
  /** The model's raw text, or null on failure / timeout. */
  judge: (prompt: string) => Promise<string | null>
  push: (i: NotifyInput, id: number) => Promise<unknown>
  now?: () => number
  log?: (line: string) => void
}

export interface GateResult { id: number; decision: Decision; reason: string; origin: Origin; mode: GateMode; delivered: boolean }

async function decide(deps: GateDeps, i: NotifyInput, now: number): Promise<Verdict & { origin: Origin }> {
  if (deps.store.seenSince(i.source, i.dedupKey, now - DEDUP_WINDOW_MS)) return { decision: "drop", reason: "duplicate within 24 h", origin: "rule" }
  const base = baseline(i)
  if (isUrgentActionable(i)) return { ...base, origin: "rule" }
  if (!inWakingHours(now)) return { decision: "brief", reason: "outside waking hours", origin: "rule" }
  let prefs: string | null
  try {
    prefs = await deps.prefs()
  } catch {
    return { decision: base.decision, reason: REASON_FALLBACK, origin: "fallback" }
  }
  if (!prefs?.trim()) return { ...base, reason: `no notify-prefs note — ${base.reason}`, origin: "rule" }
  let raw: string | null = null
  try { raw = await deps.judge(judgePrompt(prefs, i, torontoHour(now))) } catch { raw = null }
  const v = parseVerdict(raw)
  if (!v) return { decision: base.decision, reason: REASON_FALLBACK, origin: "fallback" }
  return { ...v, origin: "model" }
}

/** Decide, log one notify_events row, and push when the decision (or `off`) says so. */
export function createNotifyGate(deps: GateDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  return async function notify(i: NotifyInput): Promise<GateResult> {
    const t = now()
    const mode = deps.mode()
    const v = mode === "off"
      ? { decision: "now" as Decision, reason: "gate off — passthrough", origin: "off" as Origin }
      : await decide(deps, i, t)
    deps.store.prune(t)
    const id = deps.store.insert({ ...i, ...v, mode, delivered: false, createdAt: t })
    let delivered = false
    if (v.decision === "now") {
      try {
        await deps.push(i, id)
        deps.store.markDelivered(id)
        delivered = true
      } catch (err) {
        log(`notify push failed id=${id} — ${(err as Error)?.message ?? String(err)}`)
      }
    }
    log(`notify ${mode} ${i.source} ${i.severity}${i.actionable ? "+act" : ""} → ${v.decision} (${v.origin}: ${v.reason})${delivered ? " pushed" : ""}`)
    return { id, decision: v.decision, reason: v.reason, origin: v.origin, mode, delivered }
  }
}

/** Mode from env + kill file (the file wins: present = off). */
export function resolveMode(env: string | undefined, killFileExists: boolean): GateMode {
  if (killFileExists) return "off"
  const m = (env ?? "").trim().toLowerCase()
  return m === "live" || m === "off" ? m : "shadow"
}

/** Report rows → { source: { now, checkin, brief, drop, total } }. */
export function reportCounts(rows: ReportRow[]): Record<string, Record<Decision | "total", number>> {
  const out: Record<string, Record<Decision | "total", number>> = {}
  for (const r of rows) {
    const s = (out[r.source] ??= { now: 0, checkin: 0, brief: 0, drop: 0, total: 0 })
    if (DECISIONS.includes(r.decision)) s[r.decision] += r.count
    s.total += r.count
  }
  return out
}
