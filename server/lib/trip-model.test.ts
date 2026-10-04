import { expect, test } from "bun:test"
import { atPlace, haversineM, learnHomes, normalizeTotals, normalizeTrip, parseHomes, queuedTrip, shortWhen, validateUpload } from "./trip-model"

const UPLOAD = {
  clientTripId: "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
  startedAt: "2026-10-06T09:10:00-04:00", endedAt: "2026-10-06T10:05:00-04:00",
  start: { lat: 45.4, lon: -72.73, label: "Home" }, end: { lat: 45.5017, lon: -73.5673 },
  km: 82.04, durationMin: 55.4, polyline: "_p~iF~ps|U_ulLnnqC",
  vehicle: { kind: "carplay", name: "Mazda", mine: true },
  detection: { startedBy: "carplay", endedBy: "carplay", confidence: 0.97 },
  appVersion: "1.4 (33)",
}

test("validateUpload accepts the contract shape and rounds km / minutes", () => {
  const v = validateUpload(UPLOAD)
  expect(v.ok).toBe(true)
  if (!v.ok) return
  expect(v.trip.km).toBe(82)
  expect(v.trip.durationMin).toBe(55)
  expect(v.trip.start.label).toBe("Home")
  expect(v.trip.end.label).toBeUndefined()
  expect(v.trip.vehicle).toEqual({ kind: "carplay", name: "Mazda", mine: true })
})

test("validateUpload names the first bad field", () => {
  const bad = (patch: Record<string, unknown>) => {
    const v = validateUpload({ ...UPLOAD, ...patch })
    return v.ok ? null : v.field
  }
  expect(bad({ clientTripId: "x" })).toBe("clientTripId")
  expect(bad({ startedAt: "2026-10-06 09:10" })).toBe("startedAt")
  expect(bad({ endedAt: "2026-10-06T08:00:00-04:00" })).toBe("endedAt")
  expect(bad({ start: { lat: 95, lon: 0 } })).toBe("start")
  expect(bad({ end: { lat: 45 } })).toBe("end")
  expect(bad({ km: -1 })).toBe("km")
  expect(bad({ durationMin: "55" })).toBe("durationMin")
  expect(bad({ polyline: 12 })).toBe("polyline")
  expect(bad({ vehicle: { kind: "boat", mine: true } })).toBe("vehicle")
  expect(bad({ detection: { startedBy: "motion", endedBy: "x", confidence: 1 } })).toBe("detection")
  expect(bad({ appVersion: "" })).toBe("appVersion")
  expect(validateUpload([]).ok).toBe(false)
})

test("normalizeTrip reads today's snake_case rows and the contract's camelCase", () => {
  const snake = normalizeTrip({ id: "trip_1", started_at: "2026-10-01T07:10:33-04:00", ended_at: null, start_label: null, end_label: "X", km: "8.52", duration_min: 12, classification: "unclassified", client_slug: null, rate_per_km: null, reimbursement: null, status: "closed", source: "carplay-shortcut" })
  expect(snake).toMatchObject({ id: "trip_1", km: 8.52, durationMin: 12, endLabel: "X", source: "shortcut", hasPolyline: false, vehicle: { kind: "none", mine: false } })
  const camel = normalizeTrip({ id: 7, startedAt: "2026-10-01T07:10:33-04:00", classification: "business", clientSlug: "brp", clientName: "BRP", source: "companion", vehicle: { kind: "carplay", name: "Mazda", mine: true }, polyline: "abc", classifierConfidence: 0.9, classifiedBy: "jev" }, true)
  expect(camel).toMatchObject({ id: "7", clientName: "BRP", source: "companion", vehicle: { kind: "carplay", name: "Mazda", mine: true }, hasPolyline: true, polyline: "abc", classifierConfidence: 0.9, classifiedBy: "jev" })
  expect(normalizeTrip({ id: "x", started_at: "2026-10-01", polyline: "abc" })?.polyline).toBeUndefined()
  expect(normalizeTrip({ started_at: "2026-10-01" })).toBeNull()
})

test("queuedTrip is a local, queued companion trip", () => {
  const v = validateUpload(UPLOAD)
  if (!v.ok) throw new Error("fixture")
  const t = queuedTrip(v.trip, { classification: "business", clientSlug: "brp", confidence: 0.9 })
  expect(t).toMatchObject({ id: `local:${UPLOAD.clientTripId}`, status: "queued", source: "companion", hasPolyline: true, clientSlug: "brp" })
})

test("geo helpers: haversine, homes, atPlace", () => {
  expect(Math.round(haversineM(45.39, -72.73, 45.5017, -73.5673) / 1000)).toBe(66)
  const homes = parseHomes("45.39,-72.73,1500; bad; 45.5,-73.6", 300)
  expect(homes).toEqual([{ lat: 45.39, lon: -72.73, radiusM: 1500 }, { lat: 45.5, lon: -73.6, radiusM: 300 }])
  expect(atPlace(45.395, -72.735, homes)).toBe(true)
  expect(atPlace(45.42, -72.73, homes)).toBe(false)
})

test("learnHomes: the most common evening trip ends, at least 5 times each", () => {
  const since = Date.parse("2026-08-01T00:00:00Z")
  const end = (iso: string, lat = 45.4021, lon = -72.7271) => ({ endedAt: iso, endLat: lat, endLon: lon })
  const ends = [
    ...["01", "02", "03", "04", "05"].map((d) => end(`2026-09-${d}T21:30:00-04:00`)),
    ...["01", "02", "03", "04", "05", "06"].map((d) => end(`2026-09-${d}T10:00:00-04:00`, 45.5, -73.6)), // daytime: ignored
    end("2026-07-01T22:00:00-04:00", 45.5, -73.6), // before the window
  ]
  const h = learnHomes(ends, since, 5, 300, 2, "America/Toronto")
  expect(h.length).toBe(1)
  expect(h[0]!.lat).toBeCloseTo(45.4021, 4)
  expect(h[0]!.radiusM).toBe(300)
  expect(learnHomes(ends.slice(0, 4), since, 5, 300, 2, "America/Toronto")).toEqual([])
  const second = [...ends, ...["01", "02", "03", "04", "05"].map((d) => end(`2026-09-${d}T23:00:00-04:00`, 45.49, -73.6))]
  expect(learnHomes(second, since, 5, 300, 2, "America/Toronto").length).toBe(2)
  expect(learnHomes(second, since, 5, 300, 1, "America/Toronto").length).toBe(1)
})

test("shortWhen in the trip timezone", () => {
  expect(shortWhen("2026-10-06T09:10:00-04:00", "America/Toronto")).toBe("Tue 9:10")
})

test("normalizeTotals: the dashboard's totals, else today's summary with the 5,000 km tier", () => {
  expect(normalizeTotals({ ytdBusinessKm: 5200, ytdReimbursement: 3784, tier: 2, tierRemainingKm: 0 }, null)).toEqual({ ytdBusinessKm: 5200, ytdReimbursement: 3784, tier: 2, tierRemainingKm: 0 })
  const sum = { total_business_km: 1234.56, buckets: { Q1: { reimbursement: 100.1 }, Q2: { reimbursement: 800.9 }, Q3: { reimbursement: 0 }, Q4: { reimbursement: 0 } } }
  expect(normalizeTotals(null, sum)).toEqual({ ytdBusinessKm: 1234.6, ytdReimbursement: 901, tier: 1, tierRemainingKm: 3765.4 })
  expect(normalizeTotals(null, { total_business_km: 6000, buckets: {} })?.tier).toBe(2)
  expect(normalizeTotals(null, null)).toBeNull()
})
