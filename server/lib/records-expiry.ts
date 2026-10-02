import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { companionLog } from "./log"
import { pushToAll } from "./push"
import { type IdRecord, type RecordType, atomicWriteJson, readRecords, recordsDir } from "./records-store"
import { vaultUpstream } from "./vault-upstream"

// Expiry alerts for ID records — store host only (COMPANION_VAULT_UPSTREAM
// unset). Checked at startup and every 24 h (setTimeout chain, unref'd).
//   window opens: passport ≤ 300 days left, driver_license ≤ 60 days
//   in window:    alert, then every 30 days; daily in the last 14 days
//   expired:      one alert on crossing, then weekly
// Last alerts persist in records-alerts.json so a restart doesn't re-spam.
// The push carries the label + expiry date only — never numbers or DOB. The
// log line carries the id + type only.

const DAY_MS = 86_400_000
// A 24 h timer can fire a little early; don't let that skip a daily alert.
const SLACK_MS = 3_600_000
const WINDOW_DAYS: Record<RecordType, number> = { passport: 300, driver_license: 60 }

export interface AlertState { expiry_date: string; last_alert_at: string; last_days_left: number }
interface AlertsDoc { version: 1; alerts: Record<string, AlertState> }

/** Test seams: the clock and the push sender. */
export const expiryDeps: { now: () => number; push: typeof pushToAll } = { now: () => Date.now(), push: pushToAll }

export const alertsPath = (): string => join(recordsDir(), "records-alerts.json")

/** Whole days from `now`'s local calendar date to `expiry` (YYYY-MM-DD). */
export function daysUntil(expiry: string, now: number): number {
  const d = new Date(now)
  const today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const [y, m, day] = expiry.split("-").map(Number)
  return Math.round((Date.UTC(y!, m! - 1, day!) - today) / DAY_MS)
}

/** Pure schedule: should this record alert now, given its last alert? */
export function alertDue(type: RecordType, expiry: string, last: AlertState | undefined, now: number): boolean {
  const left = daysUntil(expiry, now)
  if (left > WINDOW_DAYS[type]) return false
  // A renewed document (new expiry date) starts its schedule over.
  if (!last || last.expiry_date !== expiry) return true
  if (left < 0 && last.last_days_left >= 0) return true
  const every = left < 0 ? 7 : left <= 14 ? 1 : 30
  return now - Date.parse(last.last_alert_at) >= every * DAY_MS - SLACK_MS
}

export function alertBody(label: string, expiry: string, now: number): string {
  const left = daysUntil(expiry, now)
  if (left > 1) return `${label} expires in ${left} days (${expiry})`
  if (left === 1) return `${label} expires tomorrow (${expiry})`
  if (left === 0) return `${label} expires today (${expiry})`
  return `${label} expired ${-left} day${left === -1 ? "" : "s"} ago (${expiry})`
}

function readAlerts(): Record<string, AlertState> {
  const path = alertsPath()
  if (!existsSync(path)) return {}
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<AlertsDoc>
    return doc.alerts && typeof doc.alerts === "object" ? doc.alerts : {}
  } catch {
    return {}
  }
}

async function alertOne(rec: IdRecord, expiry: string, now: number): Promise<boolean> {
  const r = await expiryDeps.push({
    title: "Document expiry",
    body: alertBody(rec.label, expiry, now),
    category: "briefing",
    collapseId: `record-${rec.id}`,
    userInfo: { kind: "record_expiry", id: rec.id },
  }).catch(() => ({ sent: 0, pruned: 0, total: -1 }))
  companionLog(`records alert ${rec.id} ${rec.type} sent=${r.sent}`)
  return r.sent > 0
}

/**
 * One pass over the store. Returns the ids alerted. Only a delivered push
 * (≥ 1 device) is recorded, so an undelivered alert is retried next pass.
 */
export async function checkRecordExpiry(): Promise<string[]> {
  if (vaultUpstream()) return []
  const records = readRecords()
  if (!records) {
    companionLog("records expiry skipped: store_unreadable")
    return []
  }
  const now = expiryDeps.now()
  const before = readAlerts()
  const alerts: Record<string, AlertState> = {}
  const sent: string[] = []
  for (const rec of records) {
    const expiry = rec.fields.expiry_date
    if (!expiry) continue
    const last = before[rec.id]
    if (last) alerts[rec.id] = last
    if (!alertDue(rec.type, expiry, last, now)) continue
    if (!(await alertOne(rec, expiry, now))) continue
    alerts[rec.id] = { expiry_date: expiry, last_alert_at: new Date(now).toISOString(), last_days_left: daysUntil(expiry, now) }
    sent.push(rec.id)
  }
  // Deleted records drop out; rewrite only on change.
  if (JSON.stringify(alerts) !== JSON.stringify(before)) atomicWriteJson(alertsPath(), { version: 1, alerts })
  return sent
}

/** Start the daily check. Inert in upstream mode. Returns a stop function. */
export function startRecordsExpiry(intervalMs = DAY_MS): () => void {
  if (vaultUpstream()) return () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const tick = (): void => {
    void checkRecordExpiry().catch(() => companionLog("records expiry check failed")).finally(() => {
      if (stopped) return
      timer = setTimeout(tick, intervalMs)
      timer.unref?.()
    })
  }
  tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
