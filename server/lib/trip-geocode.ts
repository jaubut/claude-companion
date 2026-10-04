import type { GeoEntry, TripStore } from "./trip-store"

// Reverse geocoding for the trip classifier: OpenStreetMap Nominatim, per its
// usage policy (identifying User-Agent, at most 1 request per second, results
// cached). Cache key = coords rounded to 3 decimals (~110 m), in companion.db.
// Never throws: a failure is null (not cached, so it is retried next time).

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
export const NOMINATIM_UA = "claude-companion-trips/1.0 (+https://github.com/jaubut/claude-companion)"
export const MIN_GAP_MS = 1_100
const TIMEOUT_MS = 6_000

export interface GeocodeDeps {
  store: Pick<TripStore, "geocode" | "saveGeocode">
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Off (null for every uncached point) with COMPANION_TRIP_GEOCODE=0. */
  enabled?: boolean
}

export const geoKey = (lat: number, lon: number): string => `${lat.toFixed(3)},${lon.toFixed(3)}`

type O = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/** A Nominatim jsonv2 body → a short label ("Place, City"), the city, and the OSM category ("shop=supermarket"). */
export function parseNominatim(body: unknown): GeoEntry | null {
  if (!body || typeof body !== "object") return null
  const o = body as O
  const a = (o.address && typeof o.address === "object" ? o.address : {}) as O
  const city = str(a.city) ?? str(a.town) ?? str(a.village) ?? str(a.municipality) ?? str(a.hamlet) ?? str(a.suburb)
  const name = str(o.name)
  const road = str(a.road) ? `${str(a.house_number) ? `${str(a.house_number)} ` : ""}${str(a.road)}` : null
  const head = name ?? road ?? str(a.neighbourhood) ?? str(a.suburb)
  const label = [head, city].filter((x): x is string => !!x).join(", ") || str(o.display_name)?.split(",").slice(0, 2).join(",").trim() || null
  if (!label) return null
  const cls = str(o.category) ?? str(o.class)
  const type = str(o.type)
  return { label: label.slice(0, 120), city, category: cls && type ? `${cls}=${type}` : null }
}

export function createGeocoder(deps: GeocodeDeps) {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const enabled = deps.enabled ?? process.env.COMPANION_TRIP_GEOCODE?.trim() !== "0"
  let chain: Promise<unknown> = Promise.resolve()
  let last = 0
  const inflight = new Map<string, Promise<GeoEntry | null>>()

  async function call(lat: number, lon: number): Promise<GeoEntry | null> {
    const wait = last + MIN_GAP_MS - now()
    if (wait > 0) await sleep(wait)
    last = now()
    const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=1&zoom=18&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`
    try {
      const res = await doFetch(url, { headers: { "User-Agent": NOMINATIM_UA, Accept: "application/json", "Accept-Language": "fr,en" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) return null
      return parseNominatim(await res.json())
    } catch {
      return null
    }
  }

  /** Cached label for a point; serialized so two callers never break the 1 req/s rule. */
  function reverse(lat: number, lon: number): Promise<GeoEntry | null> {
    const key = geoKey(lat, lon)
    const hit = deps.store.geocode(key, now())
    if (hit) return Promise.resolve(hit)
    if (!enabled) return Promise.resolve(null)
    const running = inflight.get(key)
    if (running) return running
    const p = chain.then(() => call(Number(key.split(",")[0]), Number(key.split(",")[1]))).then((e) => {
      if (e) deps.store.saveGeocode(key, e, now())
      return e
    }).finally(() => inflight.delete(key))
    chain = p.catch(() => null)
    inflight.set(key, p)
    return p
  }

  return { reverse }
}

export type Geocoder = ReturnType<typeof createGeocoder>
