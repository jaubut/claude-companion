import { DashboardKeyMissing, DashboardUnreachable, dashboardJson, dashboardValue, encodeIdPath } from "./dashboard-client"
import type { ClientInfo } from "./trip-classify"
import { type Trip, normalizeTrip } from "./trip-model"
import type { QueryFn, Row } from "./turso"

// Travel log ↔ tls-dashboard-v2. Writes and phone-facing reads go through the
// dashboard API with the server-held key (lib/dashboard-client.ts). The
// classifier and triage read `trip_entries` read-only from Turso (history, home
// learning, backfill, stale checks), like the triage PR source.
// Dashboard endpoints (tls-dashboard-v2 #175, CONTRACT §2/§3): POST /api/trips/ingest
// (201 {ok,id,trip,superseded[]} · 409 {error:"duplicate",trip} · 400 {error:"invalid",details[]}),
// GET /api/trips (camelCase + legacy snake_case in one object, totals = current year),
// GET|PATCH /api/trips/:id, GET /api/trips/clients. Fallbacks for an older dashboard:
// PATCH /api/trip/:id, GET /api/clients, a list scan for one trip, /api/trips/summary for totals.
// Key: TLS_DASHBOARD_API_KEY is the dashboard's TRIPS_API_KEY (admin; verified equal by hash 2026-10-04).

export type IngestOutcome =
  | { kind: "ok"; tripId: string; duplicate: boolean }
  | { kind: "retry"; error: string }
  | { kind: "rejected"; error: string }

const idOf = (j: Record<string, unknown> | null): string | null => {
  if (!j) return null
  const trip = j.trip && typeof j.trip === "object" ? j.trip as Record<string, unknown> : null
  for (const v of [j.tripId, j.id, trip?.id]) if ((typeof v === "string" && v) || typeof v === "number") return String(v)
  return null
}

function retryable(e: unknown): IngestOutcome {
  if (e instanceof DashboardKeyMissing) return { kind: "retry", error: "dashboard_key_missing" }
  if (e instanceof DashboardUnreachable) return { kind: "retry", error: `dashboard_unreachable_${e.status}` }
  throw e
}

/** POST /api/trips/ingest. 404/405/401/403 = not deployed or key not accepted yet → retry later, never dropped. */
export async function ingestTrip(payload: Record<string, unknown>): Promise<IngestOutcome> {
  let r
  try { r = await dashboardJson("POST", "/api/trips/ingest", payload) } catch (e) { return retryable(e) }
  const id = idOf(r.json)
  if (r.status === 409) return id ? { kind: "ok", tripId: id, duplicate: true } : { kind: "retry", error: "duplicate_without_id" }
  if (r.status >= 200 && r.status < 300) {
    if (!id || r.json?.ok === false) return { kind: "retry", error: "no_trip_id" }
    return { kind: "ok", tripId: id, duplicate: r.json?.duplicate === true }
  }
  if ([401, 403, 404, 405, 408].includes(r.status)) return { kind: "retry", error: `http_${r.status}` }
  // 400 {error:"invalid", details[]}: the payload itself is refused; retrying will not help.
  const details = Array.isArray(r.json?.details) ? (r.json!.details as unknown[]).filter((d) => typeof d === "string").slice(0, 3).join("; ") : ""
  const why = [typeof r.json?.error === "string" ? r.json.error : "", details].filter(Boolean).join(": ")
  return { kind: "rejected", error: `http_${r.status}${why ? `: ${why.slice(0, 160)}` : ""}` }
}

export interface ListQuery { from?: string | null; to?: string | null; limit?: number | null; classification?: string | null }

function qs(q: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined && v !== "") p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ""
}

/** GET /api/trips → normalized trips + the dashboard's totals when it sends them. Throws DashboardUnreachable / KeyMissing. */
export async function listTrips(q: ListQuery): Promise<{ status: number; trips: Trip[]; totals: Record<string, unknown> | null }> {
  const r = await dashboardJson("GET", `/api/trips${qs({ from: q.from, to: q.to, limit: q.limit, classification: q.classification })}`)
  const rows = Array.isArray(r.json?.trips) ? r.json!.trips as unknown[] : []
  const totals = r.json?.totals && typeof r.json.totals === "object" ? r.json.totals as Record<string, unknown> : null
  return { status: r.status, trips: rows.map((x) => normalizeTrip(x)).filter((t): t is Trip => !!t), totals }
}

/** GET /api/trips/summary?year= (today's dashboard) → YTD business km + reimbursement. */
export async function tripSummary(year: number): Promise<Record<string, unknown> | null> {
  const r = await dashboardJson("GET", `/api/trips/summary?year=${year}`)
  return r.status === 200 ? r.json : null
}

/** GET /api/trips/:id (with polyline); 404 → a list scan (no polyline) → null. */
export async function getTrip(id: string): Promise<Trip | null> {
  const r = await dashboardJson("GET", `/api/trips/${encodeIdPath(id)}`)
  if (r.status === 200 && r.json) {
    const t = normalizeTrip(r.json.trip ?? r.json, true)
    if (t) return t
  }
  if (r.status !== 404 && r.status !== 200) return null
  const list = await listTrips({ limit: 1000 })
  return list.trips.find((t) => t.id === id) ?? null
}

/** PATCH /api/trips/:id, falling back to today's PATCH /api/trip/:id on 404. */
export async function patchTrip(id: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const r = await dashboardJson("PATCH", `/api/trips/${encodeIdPath(id)}`, body)
  if (r.status !== 404 && r.status !== 405) return r
  return dashboardJson("PATCH", `/api/trip/${encodeIdPath(id)}`, body)
}

function toClient(v: unknown): ClientInfo | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const slug = typeof o.slug === "string" ? o.slug.trim() : ""
  if (!slug) return null
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : slug
  const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null)
  return { slug, name, address: s(o.address), city: s(o.city) }
}

/** GET /api/trips/clients, else GET /api/clients. Sorted by name. Throws when the dashboard is unreachable. */
export async function fetchClients(): Promise<ClientInfo[]> {
  const usable = (v: unknown) => Array.isArray(v) || (!!v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).clients))
  let r = await dashboardValue("GET", "/api/trips/clients")
  // An older dashboard answers 404, or 200 with its SPA page: use the general client list.
  if (r.status === 404 || r.status === 405 || (r.status === 200 && !usable(r.value))) r = await dashboardValue("GET", "/api/clients")
  if (r.status !== 200) throw new DashboardUnreachable(r.status, `clients http ${r.status}`)
  const v = r.value as unknown
  const arr = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).clients) ? (v as Record<string, unknown>).clients as unknown[] : []
  return arr.map(toClient).filter((c): c is ClientInfo => !!c).sort((a, b) => a.name.localeCompare(b.name, "fr"))
}

// ── Turso, read-only ─────────────────────────────────────────────────────────

export interface TripRow {
  id: string; startedAt: string; endedAt: string | null
  startLat: number; startLon: number; endLat: number; endLon: number
  startLabel: string | null; endLabel: string | null
  km: number | null; durationMin: number | null
  classification: string; clientSlug: string | null; status: string | null
}

const COLS = "id, started_at, ended_at, start_lat, start_lon, end_lat, end_lon, start_label, end_label, km, duration_min, classification, client_slug, status"
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const sv = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

export function toTripRow(r: Row): TripRow | null {
  const [a, b, c, d] = [n(r.start_lat), n(r.start_lon), n(r.end_lat), n(r.end_lon)]
  if (a === null || b === null || c === null || d === null || !sv(r.started_at)) return null
  return {
    id: String(r.id), startedAt: String(r.started_at), endedAt: sv(r.ended_at), startLat: a, startLon: b, endLat: c, endLon: d,
    startLabel: sv(r.start_label), endLabel: sv(r.end_label), km: n(r.km), durationMin: n(r.duration_min),
    classification: sv(r.classification) ?? "unclassified", clientSlug: sv(r.client_slug), status: sv(r.status),
  }
}

const rows = (list: Row[]): TripRow[] => list.map(toTripRow).filter((t): t is TripRow => !!t)

/** Trips with both ends located (history + home learning), newest first. */
export async function readLocatedTrips(query: QueryFn, limit = 3000): Promise<TripRow[]> {
  return rows(await query(
    `SELECT ${COLS} FROM trip_entries WHERE start_lat IS NOT NULL AND end_lat IS NOT NULL AND (status IS NULL OR status != 'superseded') ORDER BY started_at DESC LIMIT ?`,
    [limit],
  ))
}

/** The review backlog: unclassified, closed, located, ≥ minKm, since `sinceIso`, oldest first. */
export async function readBackfill(query: QueryFn, sinceIso: string, limit: number, minKm: number): Promise<TripRow[]> {
  return rows(await query(
    `SELECT ${COLS} FROM trip_entries WHERE classification = 'unclassified' AND status = 'closed' AND started_at >= ? AND km >= ? AND start_lat IS NOT NULL AND end_lat IS NOT NULL ORDER BY started_at ASC LIMIT ?`,
    [sinceIso, minKm, limit],
  ))
}

export async function readTrip(query: QueryFn, id: string): Promise<{ row: TripRow | null; classification: string | null }> {
  const list = await query(`SELECT ${COLS} FROM trip_entries WHERE id = ?`, [id])
  const r = list[0]
  return r ? { row: toTripRow(r), classification: sv(r.classification) ?? "unclassified" } : { row: null, classification: null }
}

export interface BandCount { minKm: number; maxKm: number; business: number; personal: number }
export const KM_BANDS: [number, number][] = [[0, 10], [10, 40], [40, 100_000]]

/** Business / personal counts per distance band over every classified trip (mileage imports included). */
export async function readBandCounts(query: QueryFn): Promise<BandCount[]> {
  const list = await query(
    "SELECT CASE WHEN km < 10 THEN 0 WHEN km < 40 THEN 1 ELSE 2 END AS band, " +
      "SUM(CASE WHEN classification IN ('business', 'billable') THEN 1 ELSE 0 END) AS business, " +
      "SUM(CASE WHEN classification = 'personal' THEN 1 ELSE 0 END) AS personal " +
      "FROM trip_entries WHERE km IS NOT NULL AND classification IN ('business', 'billable', 'personal') AND (status IS NULL OR status != 'superseded') GROUP BY 1",
    [],
  )
  return list.map((r) => {
    const [minKm, maxKm] = KM_BANDS[Number(r.band)] ?? KM_BANDS[2]!
    return { minKm, maxKm, business: Number(r.business) || 0, personal: Number(r.personal) || 0 }
  })
}

/** Current classification per id (ids missing from the table are absent from the map). */
export async function readClassifications(query: QueryFn, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  const list = await query(`SELECT id, classification FROM trip_entries WHERE id IN (${ids.map(() => "?").join(", ")})`, ids)
  for (const r of list) out.set(String(r.id), sv(r.classification) ?? "unclassified")
  return out
}
