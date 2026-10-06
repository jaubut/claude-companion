import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { addDays } from "./my-tasks"

// Tasks agent LOAD meter: per local day for the next LOAD_DAYS, Jeremie's dated
// open tasks vs Google Calendar busy hours, flagging overbooked days.
// Calendar = read-only. Token: mail-watcher's authorized-user file (the one
// tools/task-calendar uses; Zettlab only). The access token is refreshed in
// memory and never written back; no token, a refresh failure or an API error
// → busy hours null and `calendar: "unavailable"` (task counts still served).

export const LOAD_DAYS = 14
export const MAX_TASKS_PER_DAY = 4
export const MAX_BUSY_HOURS = 6
export const CAL_CACHE_MS = 10 * 60_000
const CAL_TIMEOUT_MS = 8_000
const MAX_PAGES = 5

export interface LoadDay {
  day: string
  tasks: number
  /** null when the calendar is unavailable. */
  busyHours: number | null
  overbooked: boolean
  reasons: ("tasks" | "busy")[]
}

export interface LoadResponse {
  from: string
  to: string
  calendar: "ok" | "unavailable"
  thresholds: { tasks: number; busyHours: number }
  days: LoadDay[]
}

// ── time zone math ───────────────────────────────────────────────────────────

/** UTC offset (ms) of `tz` at instant `ms`. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** The instant local midnight starts `day` in `tz` (DST-safe). */
export function zonedDayStart(day: string, tz: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`)
  const off = tzOffsetMs(guess, tz)
  const t = guess - off
  const off2 = tzOffsetMs(t, tz)
  return off2 === off ? t : guess - off2
}

export interface Interval { start: number; end: number }

/** Busy hours per local day: intervals merged (no double counting), clipped to each day. */
export function busyHoursByDay(intervals: Interval[], days: string[], tz: string): Map<string, number> {
  const merged: Interval[] = []
  for (const iv of [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end)
    else merged.push({ ...iv })
  }
  const out = new Map<string, number>()
  for (const day of days) {
    const s = zonedDayStart(day, tz)
    const e = zonedDayStart(addDays(day, 1), tz)
    let ms = 0
    for (const iv of merged) ms += Math.max(0, Math.min(iv.end, e) - Math.max(iv.start, s))
    out.set(day, Math.round((ms / 3_600_000) * 10) / 10)
  }
  return out
}

/** Pure: due dates + busy map → the meter. */
export function buildLoad(dues: (string | null)[], today: string, busy: Map<string, number> | null): LoadResponse {
  const days = Array.from({ length: LOAD_DAYS }, (_, i) => addDays(today, i))
  const counts = new Map<string, number>()
  for (const d of dues) if (d) counts.set(d, (counts.get(d) ?? 0) + 1)
  return {
    from: days[0]!, to: days[days.length - 1]!, calendar: busy ? "ok" : "unavailable",
    thresholds: { tasks: MAX_TASKS_PER_DAY, busyHours: MAX_BUSY_HOURS },
    days: days.map((day) => {
      const tasks = counts.get(day) ?? 0
      const busyHours = busy ? busy.get(day) ?? 0 : null
      const reasons: LoadDay["reasons"] = []
      if (tasks > MAX_TASKS_PER_DAY) reasons.push("tasks")
      if (busyHours !== null && busyHours > MAX_BUSY_HOURS) reasons.push("busy")
      return { day, tasks, busyHours, overbooked: reasons.length > 0, reasons }
    }),
  }
}

// ── Google Calendar (read-only) ──────────────────────────────────────────────

interface GEvent {
  status?: string
  transparency?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  extendedProperties?: { private?: Record<string, string> }
}

/**
 * Timed, opaque, confirmed events only. All-day events (incl. the task-calendar
 * `[TLS]` task events) are not busy time; neither is anything that sync wrote.
 */
export function eventIntervals(items: GEvent[]): Interval[] {
  const out: Interval[] = []
  for (const ev of items) {
    if (ev.status === "cancelled" || ev.transparency === "transparent") continue
    if (ev.extendedProperties?.private?.tlsSource || ev.extendedProperties?.private?.tlsTaskId) continue
    const s = Date.parse(ev.start?.dateTime ?? "")
    const e = Date.parse(ev.end?.dateTime ?? "")
    if (Number.isFinite(s) && Number.isFinite(e)) out.push({ start: s, end: e })
  }
  return out
}

export function gcalTokenPath(env: Record<string, string | undefined> = process.env): string {
  return env.COMPANION_GCAL_TOKEN_FILE || join(homedir(), ".config", "mail-watcher", "tokens", "jeremie.aubut@gmail.com.json")
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface CalendarDeps {
  fetch?: Fetch
  readToken?: () => string
  now?: () => number
  log?: (msg: string) => void
}

/** Busy-hours reader with a 10-minute cache. `busy(days, tz)` never throws: null = unavailable. */
export function createCalendarBusy(deps: CalendarDeps = {}) {
  const f: Fetch = deps.fetch ?? ((i, init) => fetch(i, init))
  const readToken = deps.readToken ?? (() => readFileSync(gcalTokenPath(), "utf8"))
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  let access: { token: string; until: number } | null = null
  let cache: { key: string; at: number; value: Map<string, number> | null } | null = null

  async function accessToken(): Promise<string | null> {
    if (access && access.until - 60_000 > now()) return access.token
    let file: Record<string, unknown>
    try { file = JSON.parse(readToken()) as Record<string, unknown> } catch { return null }
    const expiry = Date.parse(String(file.expiry ?? ""))
    if (typeof file.token === "string" && Number.isFinite(expiry) && expiry - 60_000 > now()) {
      access = { token: file.token, until: expiry }
      return file.token
    }
    if (typeof file.refresh_token !== "string" || typeof file.client_id !== "string" || typeof file.client_secret !== "string") return null
    const res = await f(typeof file.token_uri === "string" ? file.token_uri : "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: file.refresh_token, client_id: file.client_id, client_secret: file.client_secret }).toString(),
      signal: AbortSignal.timeout(CAL_TIMEOUT_MS),
    })
    if (!res.ok) { log(`[tasks-agent] calendar token refresh failed (http ${res.status})`); return null }
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) return null
    access = { token: body.access_token, until: now() + (body.expires_in ?? 3600) * 1000 }
    return access.token
  }

  async function events(token: string, timeMin: string, timeMax: string): Promise<GEvent[] | null> {
    const items: GEvent[] = []
    let page: string | undefined
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" })
      if (page) q.set("pageToken", page)
      const res = await f(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CAL_TIMEOUT_MS),
      })
      if (!res.ok) {
        if (res.status === 401) access = null
        log(`[tasks-agent] calendar read failed (http ${res.status})`)
        return null
      }
      const body = (await res.json()) as { items?: GEvent[]; nextPageToken?: string }
      items.push(...(body.items ?? []))
      if (!body.nextPageToken) break
      page = body.nextPageToken
    }
    return items
  }

  async function busy(days: string[], tz: string): Promise<Map<string, number> | null> {
    const key = `${tz}|${days[0]}|${days[days.length - 1]}`
    if (cache && cache.key === key && now() - cache.at < CAL_CACHE_MS) return cache.value
    let value: Map<string, number> | null = null
    try {
      const token = await accessToken()
      const items = token
        ? await events(token, new Date(zonedDayStart(days[0]!, tz)).toISOString(), new Date(zonedDayStart(addDays(days[days.length - 1]!, 1), tz)).toISOString())
        : null
      value = items ? busyHoursByDay(eventIntervals(items), days, tz) : null
    } catch (err) {
      log(`[tasks-agent] calendar unavailable (${(err as Error)?.name ?? "error"})`)
    }
    cache = { key, at: now(), value }
    return value
  }

  return { busy }
}

export type CalendarBusy = ReturnType<typeof createCalendarBusy>
