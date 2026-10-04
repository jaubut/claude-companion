import { DashboardKeyMissing, DashboardUnreachable } from "../lib/dashboard-client"
import { withIdempotency } from "../lib/idempotency"
import { companionLog } from "../lib/log"
import type { ClientInfo } from "../lib/trip-classify"
import { getTrip, listTrips, tripSummary } from "../lib/trip-dashboard"
import { type Trip, type TripTotals, type TripUpload, normalizeTotals, queuedTrip, validateUpload } from "../lib/trip-model"
import type { Reply } from "../lib/trip-service"
import type { UploadRow } from "../lib/trip-store"
import { createLimiter } from "../lib/vault-guard"
import { HOP_HEADER, forwardVault, vaultUpstream } from "../lib/vault-upstream"
import { tripsLive } from "../wiring/trips"

// Travel log (trips CONTRACT §1, §3), behind the standard /api bearer gate:
//   POST  /api/trips              TripUpload + Idempotency-Key → 200 | 202 queued | 409 duplicate | 400 | 502 | 503
//   GET   /api/trips?from&to&limit                             → {ok, trips: Trip[], totals}
//   GET   /api/trips/clients                                   → [{slug, name}]
//   GET   /api/trips/:id                                       → Trip (incl. polyline)
//   PATCH /api/trips/:id          {classification?, clientSlug?, purpose?} → {ok, ...}  (classifiedBy human)
// The server owns an upload once stored (lib/trip-service.ts). Upstream mode
// (COMPANION_VAULT_UPSTREAM, the Mac): everything is forwarded to the store host.
// Never logged: coordinates, labels, the key.

const BASE = "/api/trips"
const CLIENTS = "/api/trips/clients"
const ID_MAX = 200
const LIMIT_DEFAULT = 100
const LIMIT_MAX = 500
const PURPOSE_MAX = 500

export const tripsLimiter = createLimiter(60, 60_000)

export interface TripsRouteDeps {
  upload: (u: TripUpload) => Promise<Reply>
  override: (id: string, change: { classification?: string; clientSlug?: string | null; purpose?: string }) => Promise<{ status: number; json: Record<string, unknown> | null }>
  queued: () => UploadRow[]
  local: (clientTripId: string) => UploadRow | null
  list: typeof listTrips
  get: (id: string) => Promise<Trip | null>
  summary: (year: number) => Promise<Record<string, unknown> | null>
  clients: () => Promise<ClientInfo[]>
}

function liveDeps(): TripsRouteDeps {
  const t = tripsLive()
  return {
    upload: (u) => t.service.upload(u), override: (id, c) => t.service.override(id, c),
    queued: () => t.service.queued(), local: (id) => t.store.upload(id),
    list: listTrips, get: getTrip, summary: tripSummary, clients: t.clients,
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response => json({ ok: false, error, ...extra }, status)

function dashboardError(e: unknown): Response {
  if (e instanceof DashboardKeyMissing) return fail(503, "dashboard_key_missing")
  if (e instanceof DashboardUnreachable) return fail(503, "dashboard_unreachable")
  throw e
}

function device(req: Request): string {
  return (req.headers.get("x-companion-device") || req.headers.get("user-agent") || "unknown").replace(/[^\x20-\x7e]/g, "").slice(0, 64)
}

/** `/api/trips/<id>` → the decoded id; null when malformed. */
export function tripIdFrom(pathname: string): string | null {
  const raw = pathname.slice(BASE.length + 1)
  if (!raw || raw.includes("/")) return null
  let id: string
  try { id = decodeURIComponent(raw) } catch { return null }
  return id && id.length <= ID_MAX && !id.includes("/") && !id.includes("..") && !/[\x00-\x1f\x7f]/.test(id) ? id : null
}

const dateArg = (v: string | null): string | null | false => (v === null || v === "" ? null : Number.isFinite(Date.parse(v)) && v.length <= 40 ? v : false)

async function list(url: URL, deps: TripsRouteDeps): Promise<Response> {
  const from = dateArg(url.searchParams.get("from"))
  const to = dateArg(url.searchParams.get("to"))
  if (from === false) return fail(400, "bad_from")
  if (to === false) return fail(400, "bad_to")
  const rawLimit = url.searchParams.get("limit")
  const limit = rawLimit === null ? LIMIT_DEFAULT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1) return fail(400, "bad_limit")
  let res: Awaited<ReturnType<typeof listTrips>>
  let summary: Record<string, unknown> | null = null
  try {
    res = await deps.list({ from, to, limit: Math.min(limit, LIMIT_MAX) })
    if (res.status !== 200) return fail(502, "dashboard_error", { upstreamStatus: res.status })
    if (!res.totals) summary = await deps.summary(new Date().getFullYear()).catch(() => null)
  } catch (e) {
    return dashboardError(e)
  }
  const inRange = (iso: string) => (!from || Date.parse(iso) >= Date.parse(from)) && (!to || Date.parse(iso) <= Date.parse(to))
  const known = new Set(res.trips.map((t) => t.clientTripId).filter(Boolean))
  const queued = deps.queued().filter((u) => inRange(u.upload.startedAt) && !known.has(u.clientTripId)).map((u) => queuedTrip(u.upload, u))
  const trips = [...queued, ...res.trips].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, Math.min(limit, LIMIT_MAX))
  const totals: TripTotals | null = normalizeTotals(res.totals, summary)
  return json({ ok: true, trips, totals })
}

async function one(id: string, deps: TripsRouteDeps): Promise<Response> {
  if (id.startsWith("local:")) {
    const u = deps.local(id.slice("local:".length))
    if (!u || u.state === "confirmed") return fail(404, "not_found")
    return json({ ...queuedTrip(u.upload, u), ...(u.upload.polyline ? { polyline: u.upload.polyline } : {}) })
  }
  try {
    const t = await deps.get(id)
    return t ? json(t) : fail(404, "not_found")
  } catch (e) {
    return dashboardError(e)
  }
}

async function patch(req: Request, id: string, deps: TripsRouteDeps): Promise<Response> {
  if (id.startsWith("local:")) return fail(409, "not_ingested_yet")
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_json")
  const change: { classification?: string; clientSlug?: string | null; purpose?: string } = {}
  if (body.classification !== undefined) {
    if (body.classification !== "business" && body.classification !== "personal" && body.classification !== "unclassified") return fail(400, "bad_classification")
    change.classification = body.classification
  }
  if (body.clientSlug !== undefined) {
    if (body.clientSlug !== null && (typeof body.clientSlug !== "string" || !body.clientSlug.trim() || body.clientSlug.length > 120)) return fail(400, "bad_client")
    change.clientSlug = body.clientSlug === null ? null : body.clientSlug.trim()
  }
  if (body.purpose !== undefined) {
    if (typeof body.purpose !== "string" || body.purpose.length > PURPOSE_MAX) return fail(400, "bad_purpose")
    change.purpose = body.purpose.replace(/[\x00-\x1f\x7f]/g, " ").trim()
  }
  if (!Object.keys(change).length) return fail(400, "nothing_to_change")
  try {
    const r = await deps.override(id, change)
    if (r.status === 404) return fail(404, "not_found")
    if (r.status < 200 || r.status >= 300 || r.json?.ok === false) return fail(r.status >= 400 && r.status < 500 ? 422 : 502, "dashboard_refused", { upstreamStatus: r.status })
    companionLog(`[trips] ${id} classified by Jeremie${change.classification ? ` → ${change.classification}` : ""}`)
    return json({ ...(r.json ?? {}), ok: true, id, classifiedBy: "human" })
  } catch (e) {
    return dashboardError(e)
  }
}

async function forward(req: Request, url: URL, body?: Record<string, unknown>): Promise<Response> {
  const up = vaultUpstream()!
  const r = await forwardVault(up, req.method, url.pathname + url.search, device(req), body, { pull: false })
  // Zettlab down: the phone must keep the trip queued.
  if (r.status === 502 && r.json?.error === "upstream_unreachable") return fail(503, "upstream_unreachable")
  return new Response(r.text, { status: r.status, headers: { "Cache-Control": "no-store", "content-type": r.json ? "application/json" : "text/plain;charset=utf-8" } })
}

export function createTripsHandler(getDeps: () => TripsRouteDeps = liveDeps) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const p = url.pathname
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return null
    const up = vaultUpstream()
    if (up && req.headers.get(HOP_HEADER)) return fail(508, "upstream_loop")

    if (p === BASE && req.method === "POST") {
      const wait = tripsLimiter.take()
      if (wait !== null) return json({ ok: false, error: "rate_limited", retry_after: wait }, 429, { "Retry-After": String(wait) })
      const body = await req.json().catch(() => null) as unknown
      const v = validateUpload(body)
      if (!v.ok) return fail(400, "invalid", { field: v.field, message: v.message })
      return withIdempotency(req, "trips-upload", async () => {
        if (up) return forward(req, url, body as Record<string, unknown>)
        const r = await getDeps().upload(v.trip)
        return json(r.body, r.status)
      })
    }
    if (p === BASE) return req.method === "GET" ? (up ? forward(req, url) : list(url, getDeps())) : fail(405, "method_not_allowed")
    if (p === CLIENTS) {
      if (req.method !== "GET") return fail(405, "method_not_allowed")
      if (up) return forward(req, url)
      const list = await getDeps().clients().catch(() => null)
      return list && list.length ? json(list.map((c) => ({ slug: c.slug, name: c.name }))) : fail(503, "dashboard_unreachable")
    }
    const id = tripIdFrom(p)
    if (!id) return fail(404, "not_found")
    if (req.method === "GET") return up ? forward(req, url) : one(id, getDeps())
    if (req.method === "PATCH") {
      if (up) {
        const body = await req.json().catch(() => null) as Record<string, unknown> | null
        return body && typeof body === "object" && !Array.isArray(body) ? forward(req, url, body) : fail(400, "bad_json")
      }
      return patch(req, id, getDeps())
    }
    return fail(405, "method_not_allowed")
  }
}

export const handleTripsRoute = createTripsHandler()
