import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { MIN_GAP_MS, NOMINATIM_UA, createGeocoder, geoKey, parseNominatim } from "./trip-geocode"
import { createTripStore } from "./trip-store"

const BODY = {
  name: "Studio Humance", category: "office", type: "company",
  address: { house_number: "1", road: "Rue du Studio", city: "Montréal" },
  display_name: "Studio Humance, 1, Rue du Studio, Montréal, Québec",
}

function rig(reply: (url: string) => Response | Promise<Response> = () => Response.json(BODY)) {
  let clock = 1_000_000
  const sleeps: number[] = []
  const calls: { url: string; ua: string | null; at: number }[] = []
  const store = createTripStore(new Database(":memory:"))
  const geo = createGeocoder({
    store, enabled: true, now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, ua: new Headers(init?.headers).get("user-agent"), at: clock })
      return reply(url)
    }) as unknown as typeof fetch,
  })
  return { geo, store, calls, sleeps, tick: (ms: number) => { clock += ms } }
}

test("parseNominatim: short label, city, OSM category", () => {
  expect(parseNominatim(BODY)).toEqual({ label: "Studio Humance, Montréal", city: "Montréal", category: "office=company" })
  expect(parseNominatim({ address: { road: "Rang 2", town: "Shefford" }, class: "highway", type: "residential" })).toEqual({ label: "Rang 2, Shefford", city: "Shefford", category: "highway=residential" })
  expect(parseNominatim({ error: "Unable to geocode" })).toBeNull()
})

test("identifying User-Agent, rounded-coords cache, no second request", async () => {
  const r = rig()
  const a = await r.geo.reverse(45.53012, -73.60004)
  const b = await r.geo.reverse(45.53041, -73.59979) // same 3-decimal cell
  expect(a).toEqual(b)
  expect(r.calls.length).toBe(1)
  expect(r.calls[0]!.ua).toBe(NOMINATIM_UA)
  expect(r.calls[0]!.url).toContain("format=jsonv2")
  expect(r.store.geocode(geoKey(45.53, -73.6), 1_000_000)?.label).toBe("Studio Humance, Montréal")
})

test("at most one request per second, even for concurrent callers", async () => {
  const r = rig()
  await Promise.all([r.geo.reverse(45.1, -72.1), r.geo.reverse(45.2, -72.2), r.geo.reverse(45.3, -72.3)])
  expect(r.calls.length).toBe(3)
  for (let i = 1; i < r.calls.length; i++) expect(r.calls[i]!.at - r.calls[i - 1]!.at).toBeGreaterThanOrEqual(MIN_GAP_MS)
})

test("concurrent requests for one cell share a call; a failure is not cached", async () => {
  let fail = true
  const r = rig(() => (fail ? new Response("busy", { status: 429 }) : Response.json(BODY)))
  const [a, b] = await Promise.all([r.geo.reverse(45.53, -73.6), r.geo.reverse(45.53, -73.6)])
  expect(a).toBeNull()
  expect(b).toBeNull()
  expect(r.calls.length).toBe(1)
  fail = false
  r.tick(5_000)
  expect((await r.geo.reverse(45.53, -73.6))?.city).toBe("Montréal")
  expect(r.calls.length).toBe(2)
})

test("disabled: cache only, never the network", async () => {
  const store = createTripStore(new Database(":memory:"))
  store.saveGeocode(geoKey(45.4, -72.7), { label: "Cached", city: "Granby", category: null }, Date.now())
  let called = 0
  const geo = createGeocoder({ store, enabled: false, fetch: (async () => { called++; return Response.json(BODY) }) as unknown as typeof fetch })
  expect((await geo.reverse(45.4, -72.7))?.label).toBe("Cached")
  expect(await geo.reverse(46, -71)).toBeNull()
  expect(called).toBe(0)
})
