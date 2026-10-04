import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import type { ClassifyResult } from "./trip-classify"
import type { IngestOutcome } from "./trip-dashboard"
import { type TripUpload, validateUpload } from "./trip-model"
import { backoffMs, createTripService, ingestPayload } from "./trip-service"
import { createTripStore } from "./trip-store"

const UPLOAD = {
  clientTripId: "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
  startedAt: "2026-10-06T09:10:00-04:00", endedAt: "2026-10-06T10:05:00-04:00",
  start: { lat: 45.4, lon: -72.73, label: "Home" }, end: { lat: 45.5017, lon: -73.5673 },
  km: 82.04, durationMin: 55.4, polyline: "_p~iF~ps|U_ulLnnqC",
  vehicle: { kind: "carplay", name: "Mazda", mine: true },
  detection: { startedBy: "carplay", endedBy: "carplay", confidence: 0.97 },
  appVersion: "1.4 (33)",
}

const upload = (id = UPLOAD.clientTripId): TripUpload => {
  const v = validateUpload({ ...UPLOAD, clientTripId: id })
  if (!v.ok) throw new Error("fixture")
  return v.trip
}

const RESULT: ClassifyResult = {
  classification: "business", clientSlug: "humance", clientName: "Humance", confidence: 0.93, decision: "filed",
  classifiedBy: "jev", rule: null, labels: { start: "Rue Principale, Granby", end: "Studio Humance, Montréal", startCity: "Granby", endCity: "Montréal" },
  altClient: null, evidenceLine: "Jev 95 % business", evidence: { km: 82 },
}

function rig(opts: { result?: ClassifyResult | "slow"; ingest?: () => IngestOutcome | Promise<IngestOutcome> } = {}) {
  let clock = 1_700_000_000_000
  const store = createTripStore(new Database(":memory:"))
  const pushed: Record<string, unknown>[] = []
  const patched: { id: string; body: Record<string, unknown> }[] = []
  let ingest = opts.ingest ?? ((): IngestOutcome => ({ kind: "ok", tripId: "trip_abc", duplicate: false }))
  const svc = createTripService({
    store, now: () => clock, budgetMs: 30,
    classifier: {
      threshold: 0.85,
      classify: async () => {
        if (opts.result === "slow") return new Promise<ClassifyResult>(() => {})
        return opts.result ?? RESULT
      },
    },
    ingest: async (p) => { pushed.push(p); return ingest() },
    patch: async (id, body) => { patched.push({ id, body }); return { status: 200, json: { ok: true, id } } },
    readRow: async (id) => ({ id, startedAt: "2026-09-01T09:00:00-04:00", endedAt: null, startLat: 45.4, startLon: -72.7, endLat: 45.5, endLon: -73.6, startLabel: null, endLabel: null, km: 80, durationMin: 50, classification: "unclassified", clientSlug: null, status: "closed" }),
  })
  return { svc, store, pushed, patched, tick: (ms: number) => { clock += ms }, setIngest: (f: typeof ingest) => { ingest = f } }
}

test("upload: stored, classified, ingested → 200 filed with the dashboard id", async () => {
  const r = rig()
  const res = await r.svc.upload(upload())
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true, tripId: "trip_abc", classification: "business", clientSlug: "humance", confidence: 0.93, status: "filed" })
  expect(r.pushed[0]).toMatchObject({ clientTripId: UPLOAD.clientTripId, source: "companion", classification: "business", clientSlug: "humance", classifierConfidence: 0.93, classifiedBy: "jev" })
  // Missing phone labels are filled from the geocoder before the push.
  expect((r.pushed[0]!.end as { label?: string }).label).toBe("Studio Humance, Montréal")
  const row = r.store.upload(UPLOAD.clientTripId)!
  expect(row.state).toBe("confirmed")
  expect(r.store.logRow(row.logId!)?.tripId).toBe("trip_abc")
})

test("needs_review goes in as unclassified; the phone still gets the guess", async () => {
  const r = rig({ result: { ...RESULT, confidence: 0.6, decision: "needs_review" } })
  const res = await r.svc.upload(upload())
  expect(res.body).toMatchObject({ classification: "business", confidence: 0.6, status: "needs_review" })
  expect(r.pushed[0]).toMatchObject({ classification: "unclassified", classifierConfidence: 0.6 })
  expect(r.pushed[0]!.clientSlug).toBeUndefined()
  expect(r.store.needsReview().map((u) => u.tripId)).toEqual(["trip_abc"])
})

test("dashboard down → 202 queued; the retry pushes it once it is back", async () => {
  const r = rig({ ingest: () => ({ kind: "retry", error: "dashboard_unreachable_0" }) })
  const res = await r.svc.upload(upload())
  expect(res.status).toBe(202)
  expect(res.body).toMatchObject({ ok: true, tripId: null, status: "queued", review: "filed", classification: "business" })
  expect(r.store.upload(UPLOAD.clientTripId)?.state).toBe("pending")
  expect(r.svc.queued().length).toBe(1)
  // Not due yet: nothing is pushed.
  expect(await r.svc.retryDue()).toBe(0)
  expect(r.pushed.length).toBe(1)
  r.setIngest(() => ({ kind: "ok", tripId: "trip_late", duplicate: false }))
  r.tick(backoffMs(0))
  expect(await r.svc.retryDue()).toBe(1)
  expect(r.store.upload(UPLOAD.clientTripId)).toMatchObject({ state: "confirmed", tripId: "trip_late" })
  expect(r.svc.queued().length).toBe(0)
})

test("retry stops the round at the first still-down push, with growing backoff", async () => {
  const r = rig({ ingest: () => ({ kind: "retry", error: "down" }) })
  await r.svc.upload(upload("trip-aaaa-0001"))
  await r.svc.upload(upload("trip-aaaa-0002"))
  r.tick(backoffMs(0))
  r.pushed.length = 0
  await r.svc.retryDue()
  expect(r.pushed.length).toBe(1)
  const row = r.store.upload("trip-aaaa-0001")!
  expect(row.attempts).toBe(2)
  expect(backoffMs(1)).toBe(120_000)
  expect(backoffMs(20)).toBe(30 * 60_000)
})

test("a second upload of a confirmed trip → 409 duplicate with the stored result, no new push", async () => {
  const r = rig()
  await r.svc.upload(upload())
  const again = await r.svc.upload(upload())
  expect(again.status).toBe(409)
  expect(again.body).toMatchObject({ ok: false, error: "duplicate", tripId: "trip_abc", status: "filed" })
  expect(r.pushed.length).toBe(1)
})

test("the dashboard already had it → 409 duplicate, confirmed locally", async () => {
  const r = rig({ ingest: () => ({ kind: "ok", tripId: "trip_old", duplicate: true }) })
  const res = await r.svc.upload(upload())
  expect(res.status).toBe(409)
  expect(res.body.tripId).toBe("trip_old")
  expect(r.store.upload(UPLOAD.clientTripId)?.state).toBe("confirmed")
})

test("concurrent uploads of one trip share one run", async () => {
  const r = rig()
  const [a, b] = await Promise.all([r.svc.upload(upload()), r.svc.upload(upload())])
  expect(a).toEqual(b)
  expect(r.pushed.length).toBe(1)
})

test("a refusal the dashboard will repeat → 502, kept as rejected; the phone's retry re-pushes it", async () => {
  const r = rig({ ingest: () => ({ kind: "rejected", error: "http_400" }) })
  expect((await r.svc.upload(upload())).status).toBe(502)
  expect(r.store.upload(UPLOAD.clientTripId)?.state).toBe("rejected")
  r.tick(backoffMs(5))
  expect(await r.svc.retryDue()).toBe(0) // rejected rows are not auto-retried
  r.setIngest(() => ({ kind: "ok", tripId: "trip_fixed", duplicate: false }))
  expect((await r.svc.upload(upload())).status).toBe(200)
})

test("classifier past its budget → needs_review, logged as a timeout", async () => {
  const r = rig({ result: "slow" })
  const res = await r.svc.upload(upload())
  expect(res.body).toMatchObject({ status: "needs_review", classification: "unclassified", confidence: 0 })
  const row = r.store.upload(UPLOAD.clientTripId)!
  expect(r.store.logRow(row.logId!)).toMatchObject({ rule: "timeout", classifiedBy: "none", decision: "needs_review" })
})

test("override: PATCH as human, then log + history + review resolved", async () => {
  const r = rig({ result: { ...RESULT, confidence: 0.6, decision: "needs_review" } })
  await r.svc.upload(upload())
  let changed = 0
  r.svc.onChange(() => changed++)
  const res = await r.svc.override("trip_abc", { classification: "business", clientSlug: "brp" })
  expect(res.status).toBe(200)
  expect(r.patched[0]).toEqual({ id: "trip_abc", body: { classified_by: "human", classifiedBy: "human", classification: "business", client_slug: "brp", clientSlug: "brp" } })
  expect(r.store.latestLog("trip_abc")).toMatchObject({ humanClassification: "business", humanClientSlug: "brp" })
  expect(r.store.history()).toEqual([expect.objectContaining({ tripId: "trip_abc", startLat: 45.4, classification: "business", clientSlug: "brp" })])
  expect(r.store.needsReview()).toEqual([])
  expect(changed).toBe(1)
})

test("override of a dashboard-only trip takes its coords from the row; personal drops the client", async () => {
  const r = rig()
  await r.svc.override("trip_shortcut", { classification: "personal", clientSlug: "brp" })
  expect(r.store.history()[0]).toMatchObject({ tripId: "trip_shortcut", startLat: 45.4, endLon: -73.6, classification: "personal", clientSlug: null })
  expect(r.store.latestLog("trip_shortcut")).toMatchObject({ mode: "triage", humanClassification: "personal", humanClientSlug: null })
})

test("ingestPayload: classifiedBy is jev or rules, never none", () => {
  const r = rig()
  r.store.insertUpload(upload(), 1)
  r.store.setResult(UPLOAD.clientTripId, { classification: "unclassified", clientSlug: null, confidence: 0, review: "needs_review", classifiedBy: "none", logId: null }, 1)
  expect(ingestPayload(r.store.upload(UPLOAD.clientTripId)!)).toMatchObject({ classification: "unclassified", classifiedBy: "rules", source: "companion" })
})
