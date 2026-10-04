// Travel log (trips CONTRACT §1, §3): the phone's upload shape and its
// validation, the Trip the phone reads (normalized from whatever the dashboard
// returns, snake_case or camelCase), and small geo / formatting helpers. Pure.

export type Classification = "business" | "personal" | "unclassified"
export type ClassifiedBy = "jev" | "rules" | "human"
export type VehicleKind = "carplay" | "bluetooth" | "none"

export interface TripPoint { lat: number; lon: number; label?: string }

export interface TripUpload {
  clientTripId: string
  startedAt: string
  endedAt: string
  start: TripPoint
  end: TripPoint
  km: number
  durationMin: number
  polyline?: string
  vehicle: { kind: VehicleKind; name?: string; mine: boolean }
  detection: { startedBy: "motion" | "carplay" | "manual"; endedBy: "stationary" | "carplay" | "manual"; confidence: number }
  appVersion: string
}

export interface Trip {
  id: string
  startedAt: string
  endedAt: string | null
  startLabel: string | null
  endLabel: string | null
  km: number | null
  durationMin: number | null
  classification: string
  clientSlug: string | null
  clientName?: string
  purpose: string | null
  ratePerKm: number | null
  reimbursement: number | null
  vehicle: { kind: string; name?: string; mine: boolean }
  source: "companion" | "shortcut" | "manual"
  status: string
  classifierConfidence?: number
  classifiedBy?: string
  hasPolyline: boolean
  polyline?: string
  /** The phone's dedupe key, when the dashboard sends it (companion rows). */
  clientTripId?: string
}

export const POLYLINE_MAX = 40_000
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const LABEL_MAX = 200
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

export type Validated = { ok: true; trip: TripUpload } | { ok: false; field: string; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const clean = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined
  const t = v.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max)
  return t || undefined
}

function point(v: unknown): TripPoint | null {
  if (!isObj(v) || !finite(v.lat) || !finite(v.lon)) return null
  if (Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) return null
  if (v.label !== undefined && v.label !== null && typeof v.label !== "string") return null
  const label = clean(v.label, LABEL_MAX)
  return { lat: v.lat, lon: v.lon, ...(label ? { label } : {}) }
}

const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === "string" && (set as readonly string[]).includes(v)

/** The phone's body → a TripUpload, or the first bad field. */
export function validateUpload(body: unknown): Validated {
  const bad = (field: string, message: string): Validated => ({ ok: false, field, message })
  if (!isObj(body)) return bad("body", "JSON object required")
  if (typeof body.clientTripId !== "string" || !ID_RE.test(body.clientTripId)) return bad("clientTripId", "8–128 chars [A-Za-z0-9._:-]")
  for (const f of ["startedAt", "endedAt"] as const) {
    const v = body[f]
    if (typeof v !== "string" || !ISO_WITH_OFFSET.test(v) || !Number.isFinite(Date.parse(v))) return bad(f, "ISO 8601 with offset")
  }
  const t0 = Date.parse(body.startedAt as string)
  const t1 = Date.parse(body.endedAt as string)
  if (t1 < t0) return bad("endedAt", "before startedAt")
  if (t1 - t0 > 24 * 3_600_000) return bad("endedAt", "trip longer than 24 h")
  const start = point(body.start)
  if (!start) return bad("start", "{lat, lon, label?}")
  const end = point(body.end)
  if (!end) return bad("end", "{lat, lon, label?}")
  if (!finite(body.km) || body.km < 0 || body.km > 3000) return bad("km", "0–3000")
  if (!finite(body.durationMin) || body.durationMin < 0 || body.durationMin > 1440) return bad("durationMin", "0–1440")
  if (body.polyline !== undefined && body.polyline !== null && (typeof body.polyline !== "string" || body.polyline.length > POLYLINE_MAX)) {
    return bad("polyline", `string ≤ ${POLYLINE_MAX} chars`)
  }
  const v = body.vehicle
  if (!isObj(v) || !oneOf(v.kind, ["carplay", "bluetooth", "none"] as const) || typeof v.mine !== "boolean") return bad("vehicle", "{kind, name?, mine}")
  const d = body.detection
  if (!isObj(d) || !oneOf(d.startedBy, ["motion", "carplay", "manual"] as const) || !oneOf(d.endedBy, ["stationary", "carplay", "manual"] as const) || !finite(d.confidence)) {
    return bad("detection", "{startedBy, endedBy, confidence}")
  }
  const appVersion = clean(body.appVersion, 40)
  if (!appVersion) return bad("appVersion", "required")
  const name = clean(v.name, 80)
  return {
    ok: true,
    trip: {
      clientTripId: body.clientTripId, startedAt: body.startedAt as string, endedAt: body.endedAt as string,
      start, end, km: Math.round(body.km * 10) / 10, durationMin: Math.round(body.durationMin),
      ...(typeof body.polyline === "string" && body.polyline ? { polyline: body.polyline } : {}),
      vehicle: { kind: v.kind, mine: v.mine, ...(name ? { name } : {}) },
      detection: { startedBy: d.startedBy, endedBy: d.endedBy, confidence: Math.min(1, Math.max(0, d.confidence)) },
      appVersion,
    },
  }
}

// ── dashboard row → Trip ─────────────────────────────────────────────────────

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
  return null
}
const numOrNull = (v: unknown): number | null => {
  if (finite(v)) return v
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null)

export function tripSource(raw: unknown): Trip["source"] {
  const s = typeof raw === "string" ? raw.toLowerCase() : ""
  if (s === "companion") return "companion"
  if (s.includes("carplay") || s.includes("shortcut")) return "shortcut"
  return "manual"
}

/** One dashboard trip row (snake_case today, contract camelCase later) → the phone's Trip. null without an id. */
export function normalizeTrip(raw: unknown, withPolyline = false): Trip | null {
  if (!isObj(raw)) return null
  const id = strOrNull(raw.id)
  const startedAt = strOrNull(pick(raw, "startedAt", "started_at"))
  if (!id || !startedAt) return null
  const veh = isObj(raw.vehicle) ? raw.vehicle : {}
  const vehicleName = strOrNull(pick(veh, "name") ?? pick(raw, "vehicle_name", "vehicleName"))
  const mineRaw = pick(veh, "mine") ?? pick(raw, "vehicle_mine", "vehicleMine")
  const polyline = strOrNull(raw.polyline)
  const conf = numOrNull(pick(raw, "classifierConfidence", "classifier_confidence"))
  const by = strOrNull(pick(raw, "classifiedBy", "classified_by"))
  const clientName = strOrNull(pick(raw, "clientName", "client_name"))
  const hasPoly = pick(raw, "hasPolyline", "has_polyline")
  const clientTripId = strOrNull(pick(raw, "clientTripId", "client_trip_id"))
  const trip: Trip = {
    id, startedAt,
    endedAt: strOrNull(pick(raw, "endedAt", "ended_at")),
    startLabel: strOrNull(pick(raw, "startLabel", "start_label")),
    endLabel: strOrNull(pick(raw, "endLabel", "end_label")),
    km: numOrNull(raw.km),
    durationMin: numOrNull(pick(raw, "durationMin", "duration_min")),
    classification: strOrNull(raw.classification) ?? "unclassified",
    clientSlug: strOrNull(pick(raw, "clientSlug", "client_slug")),
    ...(clientName ? { clientName } : {}),
    purpose: strOrNull(raw.purpose),
    ratePerKm: numOrNull(pick(raw, "ratePerKm", "rate_per_km")),
    reimbursement: numOrNull(raw.reimbursement),
    vehicle: {
      kind: strOrNull(pick(veh, "kind") ?? pick(raw, "vehicle_kind", "vehicleKind")) ?? "none",
      ...(vehicleName ? { name: vehicleName } : {}),
      mine: mineRaw === true || mineRaw === 1 || mineRaw === "1",
    },
    source: tripSource(raw.source),
    status: strOrNull(raw.status) ?? "closed",
    ...(conf !== null ? { classifierConfidence: conf } : {}),
    ...(by ? { classifiedBy: by } : {}),
    hasPolyline: !!polyline || hasPoly === true || hasPoly === 1,
    ...(clientTripId ? { clientTripId } : {}),
  }
  if (withPolyline && polyline) trip.polyline = polyline
  return trip
}

/** A trip the server holds but the dashboard has not confirmed yet (shown as `queued`). */
export function queuedTrip(u: TripUpload, r: { classification: string; clientSlug: string | null; confidence: number }): Trip {
  return {
    id: `local:${u.clientTripId}`, startedAt: u.startedAt, endedAt: u.endedAt,
    startLabel: u.start.label ?? null, endLabel: u.end.label ?? null, km: u.km, durationMin: u.durationMin,
    classification: r.classification, clientSlug: r.clientSlug, purpose: null, ratePerKm: null, reimbursement: null,
    vehicle: { kind: u.vehicle.kind, ...(u.vehicle.name ? { name: u.vehicle.name } : {}), mine: u.vehicle.mine },
    source: "companion", status: "queued", classifierConfidence: r.confidence, hasPolyline: !!u.polyline, clientTripId: u.clientTripId,
  }
}

// ── geo + text ───────────────────────────────────────────────────────────────

/** Great-circle distance in metres. */
export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLon = (bLon - aLon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface Place { lat: number; lon: number; radiusM: number }

/** `lat,lon[,radiusM]` entries separated by `;` (COMPANION_TRIP_HOME). Bad entries are skipped. */
export function parseHomes(raw: string | undefined, dfltRadius: number): Place[] {
  const out: Place[] = []
  for (const part of (raw ?? "").split(";")) {
    const [a, b, c] = part.split(",").map((x) => Number(x.trim()))
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a!) > 90 || Math.abs(b!) > 180) continue
    out.push({ lat: a!, lon: b!, radiusM: Number.isFinite(c) && c! > 0 ? c! : dfltRadius })
  }
  return out
}

export const atPlace = (lat: number, lon: number, places: Place[]): boolean => places.some((p) => haversineM(lat, lon, p.lat, p.lon) <= p.radiusM)

export const TRIP_TZ = (): string => process.env.COMPANION_TRIP_TZ || "America/Toronto"

/** "Tue 9:10" in the trip timezone. */
export function shortWhen(iso: string, tz = TRIP_TZ()): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23", timeZone: tz }).formatToParts(d)
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return `${part("weekday")} ${Number(part("hour")) % 24}:${part("minute")}`
}

/** Local hour 0–23 in the trip timezone. */
export function localHour(iso: string, tz = TRIP_TZ()): number | null {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  const h = Number(new Intl.DateTimeFormat("en-CA", { hour: "numeric", hour12: false, timeZone: tz }).format(d))
  return Number.isFinite(h) ? h % 24 : null
}

export const fmtKm = (km: number | null): string => (km === null ? "? km" : `${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`)

/**
 * Learned homes: the most common evening trip ends (19:00–04:00 local) since
 * `sinceMs`, each with at least `minCount` trips, at most `max`. Cells are
 * coords rounded to 3 decimals (~110 m); a place is the mean of its cell's points.
 */
export function learnHomes(ends: { endedAt: string | null; endLat: number; endLon: number }[], sinceMs: number, minCount = 5, radiusM = 300, max = 2, tz = TRIP_TZ()): Place[] {
  const cells = new Map<string, { n: number; lat: number; lon: number }>()
  for (const e of ends) {
    if (!e.endedAt || Date.parse(e.endedAt) < sinceMs) continue
    const h = localHour(e.endedAt, tz)
    if (h === null || (h >= 4 && h < 19)) continue
    const key = `${e.endLat.toFixed(3)},${e.endLon.toFixed(3)}`
    const c = cells.get(key) ?? { n: 0, lat: 0, lon: 0 }
    c.n++; c.lat += e.endLat; c.lon += e.endLon
    cells.set(key, c)
  }
  return [...cells.values()].sort((a, b) => b.n - a.n).filter((c) => c.n >= minCount).slice(0, max)
    .map((c) => ({ lat: c.lat / c.n, lon: c.lon / c.n, radiusM }))
}

export const TIER_KM = 5_000
export interface TripTotals { ytdBusinessKm: number; ytdReimbursement: number; tier: 1 | 2; tierRemainingKm: number }

const totalsOf = (km: number, reimb: number): TripTotals => ({
  ytdBusinessKm: Math.round(km * 10) / 10, ytdReimbursement: Math.round(reimb * 100) / 100,
  tier: km > TIER_KM ? 2 : 1, tierRemainingKm: Math.max(0, Math.round((TIER_KM - km) * 10) / 10),
})

/** The dashboard's `totals` (contract shape, camel or snake), else today's /api/trips/summary body. null when neither reads. */
export function normalizeTotals(totals: Record<string, unknown> | null, summary: Record<string, unknown> | null): TripTotals | null {
  if (totals) {
    const km = numOrNull(pick(totals, "ytdBusinessKm", "ytd_business_km"))
    const re = numOrNull(pick(totals, "ytdReimbursement", "ytd_reimbursement"))
    if (km !== null && re !== null) {
      const base = totalsOf(km, re)
      const tier = numOrNull(totals.tier)
      const rem = numOrNull(pick(totals, "tierRemainingKm", "tier_remaining_km"))
      return { ...base, ...(tier === 1 || tier === 2 ? { tier } : {}), ...(rem !== null ? { tierRemainingKm: rem } : {}) }
    }
  }
  if (!summary) return null
  const km = numOrNull(summary.total_business_km)
  if (km === null) return null
  let re = 0
  const buckets = summary.buckets && typeof summary.buckets === "object" ? Object.values(summary.buckets as Record<string, unknown>) : []
  for (const b of buckets) if (isObj(b)) re += numOrNull(b.reimbursement) ?? 0
  return totalsOf(km, re)
}
