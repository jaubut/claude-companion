import { describe, expect, test } from "bun:test"
import { buildLoad, busyHoursByDay, createCalendarBusy, eventIntervals, zonedDayStart } from "./tasks-agent-load"

const TZ = "America/Toronto"
const at = (iso: string) => Date.parse(iso)

describe("zoned days", () => {
  test("Toronto midnight, both sides of the DST change (2026-11-01)", () => {
    expect(new Date(zonedDayStart("2026-10-06", TZ)).toISOString()).toBe("2026-10-06T04:00:00.000Z")
    expect(new Date(zonedDayStart("2026-11-02", TZ)).toISOString()).toBe("2026-11-02T05:00:00.000Z")
  })

  test("busy hours: overlaps merged, clipped at local midnight", () => {
    const busy = busyHoursByDay([
      { start: at("2026-10-06T13:00:00Z"), end: at("2026-10-06T16:00:00Z") }, // 9-12 local
      { start: at("2026-10-06T15:00:00Z"), end: at("2026-10-06T17:00:00Z") }, // overlaps → 9-13
      { start: at("2026-10-07T02:00:00Z"), end: at("2026-10-07T06:00:00Z") }, // 22:00 → 02:00 next day
    ], ["2026-10-06", "2026-10-07"], TZ)
    expect(busy.get("2026-10-06")).toBe(6)
    expect(busy.get("2026-10-07")).toBe(2)
  })
})

describe("buildLoad", () => {
  test("14 days from today; > 4 tasks or > 6 busy hours flags the day", () => {
    const dues = ["2026-10-06", "2026-10-07", "2026-10-07", "2026-10-07", "2026-10-07", "2026-10-07", "2026-10-01", null, "2026-10-30"]
    const busy = new Map([["2026-10-08", 6.5], ["2026-10-06", 6]])
    const l = buildLoad(dues, "2026-10-06", busy)
    expect(l.days.length).toBe(14)
    expect([l.from, l.to, l.calendar]).toEqual(["2026-10-06", "2026-10-19", "ok"])
    expect(l.days[0]).toEqual({ day: "2026-10-06", tasks: 1, busyHours: 6, overbooked: false, reasons: [] })
    expect(l.days[1]).toMatchObject({ tasks: 5, overbooked: true, reasons: ["tasks"] })
    expect(l.days[2]).toMatchObject({ tasks: 0, busyHours: 6.5, overbooked: true, reasons: ["busy"] })
    expect(l.days[3]!.busyHours).toBe(0)
  })

  test("calendar unavailable → busyHours null, task flags still work", () => {
    const l = buildLoad(Array(5).fill("2026-10-06"), "2026-10-06", null)
    expect(l.calendar).toBe("unavailable")
    expect(l.days[0]).toMatchObject({ busyHours: null, overbooked: true, reasons: ["tasks"] })
  })
})

describe("calendar reader (read-only)", () => {
  test("only timed, opaque, non-task events count", () => {
    const iv = eventIntervals([
      { start: { dateTime: "2026-10-06T09:00:00-04:00" }, end: { dateTime: "2026-10-06T10:00:00-04:00" } },
      { start: { date: "2026-10-06" }, end: { date: "2026-10-07" } },
      { transparency: "transparent", start: { dateTime: "2026-10-06T11:00:00-04:00" }, end: { dateTime: "2026-10-06T12:00:00-04:00" } },
      { status: "cancelled", start: { dateTime: "2026-10-06T11:00:00-04:00" }, end: { dateTime: "2026-10-06T12:00:00-04:00" } },
      { extendedProperties: { private: { tlsTaskId: "x" } }, start: { dateTime: "2026-10-06T13:00:00-04:00" }, end: { dateTime: "2026-10-06T14:00:00-04:00" } },
    ])
    expect(iv.length).toBe(1)
  })

  test("refreshes an expired token in memory (never written), reads events, caches 10 min", async () => {
    const calls: string[] = []
    let now = at("2026-10-06T15:00:00Z")
    const cal = createCalendarBusy({
      now: () => now,
      readToken: () => JSON.stringify({ token: "old", expiry: "2026-10-01T00:00:00Z", refresh_token: "r", client_id: "c", client_secret: "s" }),
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`)
        if (url.includes("oauth2")) {
          expect(String(init?.body)).toContain("grant_type=refresh_token")
          return Response.json({ access_token: "fresh", expires_in: 3600 })
        }
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer fresh")
        return Response.json({ items: [{ start: { dateTime: "2026-10-06T09:00:00-04:00" }, end: { dateTime: "2026-10-06T16:30:00-04:00" } }] })
      },
    })
    const busy = await cal.busy(["2026-10-06", "2026-10-07"], TZ)
    expect(busy?.get("2026-10-06")).toBe(7.5)
    expect(calls).toEqual(["POST https://oauth2.googleapis.com/token", "GET https://www.googleapis.com/calendar/v3/calendars/primary/events"])
    now += 60_000
    await cal.busy(["2026-10-06", "2026-10-07"], TZ)
    expect(calls.length).toBe(2)
  })

  test("no token file / API error → null (unavailable), never throws", async () => {
    const none = createCalendarBusy({ readToken: () => { throw new Error("ENOENT") } })
    expect(await none.busy(["2026-10-06"], TZ)).toBeNull()
    const bad = createCalendarBusy({
      readToken: () => JSON.stringify({ token: "t", expiry: "2099-01-01T00:00:00Z" }),
      fetch: async () => new Response("nope", { status: 403 }),
    })
    expect(await bad.busy(["2026-10-06"], TZ)).toBeNull()
  })
})
