import { Database } from "bun:sqlite"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { resetIdempotency } from "../lib/idempotency"
import type { ClassifyResult } from "../lib/trip-classify"
import { fetchClients, getTrip, ingestTrip, listTrips, patchTrip, tripSummary } from "../lib/trip-dashboard"
import { createTripService } from "../lib/trip-service"
import { createTripStore } from "../lib/trip-store"
import { recordPeer } from "../lib/vault-guard"
import type { TripsRouteDeps } from "./trips"

const UPLOAD = {
  clientTripId: "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
  startedAt: "2026-10-06T09:10:00-04:00", endedAt: "2026-10-06T10:05:00-04:00",
  start: { lat: 45.4, lon: -72.73, label: "Home" }, end: { lat: 45.5017, lon: -73.5673 },
  km: 82.04, durationMin: 55.4, polyline: "_p~iF~ps|U_ulLnnqC",
  vehicle: { kind: "carplay", name: "Mazda", mine: true },
  detection: { startedBy: "carplay", endedBy: "carplay", confidence: 0.97 },
  appVersion: "1.4 (33)",
}

// /api/trips* against a fake tls-dashboard-v2 that answers like #175 (ingest
// 201 / 409 duplicate / 400 invalid; camelCase + snake_case reads; GET/PATCH on
// /api/trips/:id) and a fake upstream Companion for the Mac's forwarding.

// routes/trips → wiring/trips → orchestrator-db opens companion.db at import: isolate it first.
process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-trips-")), "companion.db")
const { createTripsHandler, tripIdFrom, tripsLimiter } = await import("./trips")
process.env.COMPANION_AUTH_TOKEN = process.env.COMPANION_AUTH_TOKEN || "trips-test-token-0123456789"
const TOKEN = getAuthToken()
const DASH_KEY = "dash-SECRET-trips-key-987"
const savedEnv = { ...process.env }

interface Hit { method: string; path: string; key: string | null; body: string }
let hits: Hit[] = []
let dashDown = false
let ingested = new Map<string, Record<string, unknown>>()
let dash: ReturnType<typeof Bun.serve>
let upstream: ReturnType<typeof Bun.serve>
let upHits: { path: string; hop: string | null; body: string }[] = []
let home = ""
let deps: TripsRouteDeps
let store: ReturnType<typeof createTripStore>

const ROW = {
  id: "trip_1", startedAt: "2026-10-01T07:10:33-04:00", started_at: "2026-10-01T07:10:33-04:00", endedAt: "2026-10-01T07:30:00-04:00",
  startLabel: "Granby", endLabel: "Montréal", km: 82, durationMin: 55, classification: "business", clientSlug: "humance", client_slug: "humance",
  purpose: null, ratePerKm: 0.73, reimbursement: 59.86, vehicle: { kind: "carplay", mine: true }, source: "shortcut", status: "closed", hasPolyline: false,
}

const RESULT: ClassifyResult = {
  classification: "business", clientSlug: "humance", clientName: "Humance", confidence: 0.93, decision: "filed", classifiedBy: "jev", rule: null,
  labels: { start: "Granby", end: "Montréal", startCity: "Granby", endCity: "Montréal" }, altClient: null, evidenceLine: "", evidence: {},
}

beforeAll(() => {
  dash = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      const body = await req.text()
      hits.push({ method: req.method, path: u.pathname + u.search, key: req.headers.get("x-api-key"), body })
      if (req.headers.get("x-api-key") !== DASH_KEY) return Response.json({ error: "Unauthorized" }, { status: 401 })
      if (dashDown) return new Response("bad gateway", { status: 502 })
      if (u.pathname === "/api/trips/ingest") {
        const p = JSON.parse(body) as Record<string, unknown>
        if (typeof p.km !== "number") return Response.json({ error: "invalid", details: ["km"] }, { status: 400 })
        const id = String(p.clientTripId)
        if (ingested.has(id)) return Response.json({ error: "duplicate", trip: { id: `trip_${id.slice(0, 4)}` } }, { status: 409 })
        ingested.set(id, p)
        return Response.json({ ok: true, id: `trip_${id.slice(0, 4)}`, trip: { id: `trip_${id.slice(0, 4)}` }, superseded: [] }, { status: 201 })
      }
      if (u.pathname === "/api/trips" && req.method === "GET") return Response.json({ trips: [ROW], totals: { ytdBusinessKm: 1200, ytdReimbursement: 876, tier: 1, tierRemainingKm: 3800 } })
      if (u.pathname === "/api/trips/clients") return Response.json([{ slug: "humance", name: "Humance", address: "x" }, { slug: "brp", name: "BRP" }])
      if (u.pathname === "/api/trips/trip_1" && req.method === "GET") return Response.json({ ...ROW, polyline: "abc", hasPolyline: true })
      if (u.pathname === "/api/trips/trip_1" && req.method === "PATCH") {
        const p = JSON.parse(body) as Record<string, unknown>
        if (p.classification === "billable") return Response.json({ error: "bad classification" }, { status: 400 })
        return Response.json({ ok: true, id: "trip_1", reimbursement: 59.86 })
      }
      return Response.json({ error: "Not found" }, { status: 404 })
    },
  })
  upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      upHits.push({ path: u.pathname + u.search, hop: req.headers.get("x-companion-vault-hop"), body: await req.text() })
      return Response.json({ ok: true, tripId: "trip_up", status: "filed" })
    },
  })
})
afterAll(() => {
  dash.stop(true)
  upstream.stop(true)
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trips-"))
  process.env.TLS_SECRETS_FILE = join(home, "secrets.env")
  writeFileSync(process.env.TLS_SECRETS_FILE, `TLS_DASHBOARD_API_KEY='${DASH_KEY}'\n`)
  process.env.COMPANION_DASHBOARD_URL = `http://127.0.0.1:${dash.port}`
  delete process.env.COMPANION_VAULT_UPSTREAM
  hits = []
  upHits = []
  dashDown = false
  ingested = new Map()
  tripsLimiter.reset()
  resetIdempotency()
  store = createTripStore(new Database(":memory:"))
  const service = createTripService({
    store, budgetMs: 50,
    classifier: { threshold: 0.85, classify: async () => RESULT },
    ingest: ingestTrip, patch: patchTrip, readRow: async () => null,
  })
  deps = {
    upload: (u) => service.upload(u), override: (id, c) => service.override(id, c),
    queued: () => service.queued(), local: (id) => store.upload(id),
    list: listTrips, get: getTrip, summary: tripSummary, clients: fetchClients,
  }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const handler = () => createTripsHandler(() => deps)

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const req = new Request(`http://localhost:4245${path}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  recordPeer(req, "127.0.0.1")
  const res = (await handler()(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null, text, headers: res.headers }
}

test("POST: ingested with the server-held key → 200 filed; the key never reaches the reply", async () => {
  const r = await call("POST", "/api/trips", UPLOAD, { "idempotency-key": UPLOAD.clientTripId })
  expect(r.status).toBe(200)
  expect(r.json).toMatchObject({ ok: true, tripId: "trip_3F25", classification: "business", clientSlug: "humance", status: "filed" })
  const ing = hits.find((h) => h.path === "/api/trips/ingest")!
  expect(ing.key).toBe(DASH_KEY)
  expect(JSON.parse(ing.body)).toMatchObject({ source: "companion", classification: "business", clientSlug: "humance", classifiedBy: "jev", appVersion: "1.4 (33)" })
  expect(r.text).not.toContain(DASH_KEY)
})

test("POST: the same Idempotency-Key replays without a second push; a new key gets 409 duplicate", async () => {
  await call("POST", "/api/trips", UPLOAD, { "idempotency-key": UPLOAD.clientTripId })
  const replay = await call("POST", "/api/trips", UPLOAD, { "idempotency-key": UPLOAD.clientTripId })
  expect(replay.status).toBe(200)
  expect(replay.headers.get("idempotent-replayed")).toBe("true")
  const dup = await call("POST", "/api/trips", UPLOAD)
  expect(dup.status).toBe(409)
  expect(dup.json).toMatchObject({ error: "duplicate", tripId: "trip_3F25" })
  expect(hits.filter((h) => h.path === "/api/trips/ingest").length).toBe(1)
})

test("POST: the dashboard already has it (lost local db) → 409 with its id", async () => {
  ingested.set(UPLOAD.clientTripId, {})
  const r = await call("POST", "/api/trips", UPLOAD)
  expect(r.status).toBe(409)
  expect(r.json.tripId).toBe("trip_3F25")
})

test("POST: dashboard down → 202 queued, listed as queued, pushed by the retry later", async () => {
  dashDown = true
  const r = await call("POST", "/api/trips", UPLOAD, { "idempotency-key": UPLOAD.clientTripId })
  expect(r.status).toBe(202)
  expect(r.json).toMatchObject({ ok: true, status: "queued", tripId: null })
  dashDown = false
  const list = await call("GET", "/api/trips?limit=10")
  expect(list.json.trips.map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([[`local:${UPLOAD.clientTripId}`, "queued"], ["trip_1", "closed"]])
  const local = await call("GET", `/api/trips/${encodeURIComponent(`local:${UPLOAD.clientTripId}`)}`)
  expect(local.json).toMatchObject({ status: "queued", polyline: UPLOAD.polyline })
  expect((await call("PATCH", `/api/trips/${encodeURIComponent(`local:${UPLOAD.clientTripId}`)}`, { classification: "personal" })).status).toBe(409)
})

test("POST: missing key on this host → still owned and queued (202), never lost", async () => {
  writeFileSync(process.env.TLS_SECRETS_FILE!, "OTHER=1\n")
  const r = await call("POST", "/api/trips", UPLOAD)
  expect(r.status).toBe(202)
  expect(store.upload(UPLOAD.clientTripId)?.lastError).toBe("dashboard_key_missing")
})

test("POST: invalid body → 400 with the field; a dashboard 400 → 502 dashboard_rejected", async () => {
  const bad = await call("POST", "/api/trips", { ...UPLOAD, km: "far" })
  expect(bad.status).toBe(400)
  expect(bad.json).toMatchObject({ error: "invalid", field: "km" })
  deps = { ...deps, upload: async () => ({ status: 502, body: { ok: false, error: "dashboard_rejected" } }) }
  expect((await call("POST", "/api/trips", UPLOAD)).status).toBe(502)
  expect(hits.length).toBe(0)
})

test("GET list: normalized trips + the dashboard's totals; bad args → 400", async () => {
  const r = await call("GET", "/api/trips?from=2026-01-01&limit=5")
  expect(r.status).toBe(200)
  expect(r.json.trips[0]).toMatchObject({ id: "trip_1", clientSlug: "humance", source: "shortcut", vehicle: { kind: "carplay", mine: true } })
  expect(r.json.totals).toEqual({ ytdBusinessKm: 1200, ytdReimbursement: 876, tier: 1, tierRemainingKm: 3800 })
  expect(hits[0]!.path).toBe("/api/trips?from=2026-01-01&limit=5")
  expect((await call("GET", "/api/trips?from=yesterday")).status).toBe(400)
  expect((await call("GET", "/api/trips?limit=0")).status).toBe(400)
  dashDown = true
  expect((await call("GET", "/api/trips")).json).toEqual({ ok: false, error: "dashboard_unreachable" })
})

test("GET one (with polyline) and the client picker", async () => {
  const t = await call("GET", "/api/trips/trip_1")
  expect(t.json).toMatchObject({ id: "trip_1", polyline: "abc", hasPolyline: true })
  expect((await call("GET", "/api/trips/trip_9")).status).toBe(404)
  const c = await call("GET", "/api/trips/clients")
  expect(c.json).toEqual([{ slug: "brp", name: "BRP" }, { slug: "humance", name: "Humance" }])
})

test("PATCH: validated, sent as human, passed back; dashboard 400 → 422", async () => {
  const r = await call("PATCH", "/api/trips/trip_1", { classification: "business", clientSlug: "brp", purpose: "Tournage" })
  expect(r.status).toBe(200)
  expect(r.json).toMatchObject({ ok: true, id: "trip_1", classifiedBy: "human", reimbursement: 59.86 })
  expect(JSON.parse(hits.at(-1)!.body)).toMatchObject({ classification: "business", clientSlug: "brp", client_slug: "brp", classified_by: "human", purpose: "Tournage" })
  expect(store.latestLog("trip_1")).toMatchObject({ humanClassification: "business", humanClientSlug: "brp" })
  expect((await call("PATCH", "/api/trips/trip_1", { classification: "billable" })).status).toBe(400)
  expect((await call("PATCH", "/api/trips/trip_1", {})).json.error).toBe("nothing_to_change")
  expect((await call("PATCH", "/api/trips/trip_1", { clientSlug: 3 })).json.error).toBe("bad_client")
  expect((await call("PATCH", "/api/trips/trip_9", { classification: "personal" })).status).toBe(404)
})

test("upstream (the Mac): everything forwarded with the hop header; Zettlab down → 503 so the phone keeps it", async () => {
  process.env.COMPANION_VAULT_UPSTREAM = `http://127.0.0.1:${upstream.port}`
  const r = await call("POST", "/api/trips", UPLOAD)
  expect(r.status).toBe(200)
  expect(upHits[0]).toMatchObject({ path: "/api/trips", hop: "1" })
  expect(JSON.parse(upHits[0]!.body).clientTripId).toBe(UPLOAD.clientTripId)
  await call("GET", "/api/trips?limit=3")
  expect(upHits[1]!.path).toBe("/api/trips?limit=3")
  expect(hits.length).toBe(0)
  const looped = await call("GET", "/api/trips", undefined, { "x-companion-vault-hop": "1" })
  expect(looped.status).toBe(508)
  process.env.COMPANION_VAULT_UPSTREAM = "http://127.0.0.1:1"
  const down = await call("POST", "/api/trips", { ...UPLOAD, clientTripId: "another-trip-0001" })
  expect(down.status).toBe(503)
})

test("tripIdFrom: decoded, no slashes or traversal", () => {
  expect(tripIdFrom("/api/trips/trip_1")).toBe("trip_1")
  expect(tripIdFrom("/api/trips/local%3Aabc")).toBe("local:abc")
  expect(tripIdFrom("/api/trips/a%2Fb")).toBeNull()
  expect(tripIdFrom("/api/trips/a/b")).toBeNull()
  expect(tripIdFrom("/api/trips/%E0%A4%A")).toBeNull()
})

test("other paths are not ours", async () => {
  const req = new Request("http://localhost:4245/api/tripsx")
  expect(await handler()(req, new URL(req.url))).toBeNull()
})
