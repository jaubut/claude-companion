import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  type GateDeps, type GateMode, type NotifyInput,
  DEDUP_WINDOW_MS, EVENT_TTL_MS, REASON_FALLBACK,
  createNotifyGate, createNotifyStore, inWakingHours, parseNotify, parseVerdict, reportCounts, resolveMode,
} from "./notify-gate"
import { createNotifyRoute, createPrefsReader, PREFS_TTL_MS } from "../routes/notify"

const DAY = Date.parse("2026-10-22T15:00:00Z") // 11:00 Toronto (EDT)
const NIGHT = Date.parse("2026-10-22T06:00:00Z") // 02:00 Toronto

const ev = (over: Partial<NotifyInput> = {}): NotifyInput => ({
  source: "body", severity: "normal", title: "t", body: "b", dedupKey: "k1", actionable: false, ...over,
})

function setup(over: Partial<GateDeps> & { mode?: () => GateMode } = {}) {
  const store = createNotifyStore(new Database(":memory:"))
  const pushed: NotifyInput[] = []
  let clock = over.now?.() ?? DAY
  const deps: GateDeps = {
    store,
    mode: () => "shadow",
    prefs: async () => "Only ping me for prod outages.",
    judge: async () => '{"decision":"checkin","reason":"not an outage"}',
    push: async (i) => { pushed.push(i) },
    ...over,
    now: () => clock,
  }
  return { store, pushed, notify: createNotifyGate(deps), setClock: (t: number) => { clock = t } }
}

describe("notify gate", () => {
  test("urgent + actionable → now, pushed, model not consulted", async () => {
    let judged = 0
    const g = setup({ judge: async () => { judged++; return null } })
    const r = await g.notify(ev({ severity: "urgent", actionable: true }))
    expect(r.decision).toBe("now")
    expect(r.origin).toBe("rule")
    expect(r.delivered).toBe(true)
    expect(g.pushed).toHaveLength(1)
    expect(judged).toBe(0)
  })

  test("duplicate within 24 h → drop; after 24 h it is new again", async () => {
    const g = setup()
    await g.notify(ev({ severity: "urgent", actionable: true }))
    const dup = await g.notify(ev({ severity: "urgent", actionable: true }))
    expect(dup.decision).toBe("drop")
    expect(dup.reason).toContain("duplicate")
    expect(g.pushed).toHaveLength(1)
    // a different source with the same key is not a duplicate
    expect((await g.notify(ev({ source: "other", severity: "urgent", actionable: true }))).decision).toBe("now")
    g.setClock(DAY + DEDUP_WINDOW_MS + 1000)
    expect((await g.notify(ev({ severity: "urgent", actionable: true }))).decision).toBe("now")
  })

  test("night normal → brief, not pushed; night urgent+actionable still now", async () => {
    const g = setup({ now: () => NIGHT })
    const r = await g.notify(ev())
    expect(r.decision).toBe("brief")
    expect(r.delivered).toBe(false)
    expect((await g.notify(ev({ dedupKey: "k2", severity: "urgent", actionable: true }))).decision).toBe("now")
    expect(g.pushed).toHaveLength(1)
  })

  test("model verdict is used during waking hours", async () => {
    const g = setup({ judge: async () => '```json\n{"decision":"brief","reason":"FYI only"}\n```' })
    const r = await g.notify(ev())
    expect(r).toMatchObject({ decision: "brief", reason: "FYI only", origin: "model" })
  })

  test("model failure → hard-rule result, logged reason fallback", async () => {
    for (const judge of [async () => null, async () => { throw new Error("boom") }, async () => "not json", async () => '{"decision":"drop"}']) {
      const g = setup({ judge })
      const normal = await g.notify(ev())
      expect(normal).toMatchObject({ decision: "checkin", reason: REASON_FALLBACK, origin: "fallback" })
      const low = await g.notify(ev({ dedupKey: "k2", severity: "low" }))
      expect(low).toMatchObject({ decision: "brief", reason: REASON_FALLBACK })
      expect(g.store.get(normal.id)?.reason).toBe(REASON_FALLBACK)
    }
  })

  test("unreadable prefs → fallback; no prefs note → baseline", async () => {
    const broken = setup({ prefs: async () => { throw new Error("turso down") } })
    expect((await broken.notify(ev())).reason).toBe(REASON_FALLBACK)
    const none = setup({ prefs: async () => null })
    const r = await none.notify(ev({ severity: "low" }))
    expect(r).toMatchObject({ decision: "brief", origin: "rule" })
  })

  test("shadow mode still pushes now items, holds the rest", async () => {
    const g = setup({ mode: () => "shadow" })
    expect((await g.notify(ev({ severity: "urgent", actionable: true }))).delivered).toBe(true)
    expect((await g.notify(ev({ dedupKey: "k2", severity: "low" }))).delivered).toBe(false)
    expect(g.pushed.map((p) => p.dedupKey)).toEqual(["k1"])
  })

  test("off → passthrough push for everything, even duplicates and night", async () => {
    const g = setup({ mode: () => "off", now: () => NIGHT })
    const a = await g.notify(ev({ severity: "low" }))
    const b = await g.notify(ev({ severity: "low" }))
    expect(a).toMatchObject({ decision: "now", origin: "off", delivered: true })
    expect(b.delivered).toBe(true)
    expect(g.pushed).toHaveLength(2)
  })

  test("a push failure is logged, not thrown", async () => {
    const g = setup({ push: async () => { throw new Error("apns") } })
    const r = await g.notify(ev({ severity: "urgent", actionable: true }))
    expect(r).toMatchObject({ decision: "now", delivered: false })
  })

  test("every event is stored; pruned after 30 d", async () => {
    const g = setup()
    const r = await g.notify(ev())
    expect(g.store.get(r.id)).toMatchObject({ source: "body", decision: "checkin", mode: "shadow" })
    g.setClock(DAY + EVENT_TTL_MS + 1000)
    await g.notify(ev({ dedupKey: "k9" }))
    expect(g.store.get(r.id)).toBeNull()
  })
})

describe("helpers", () => {
  test("waking hours are 08:00–21:00 Toronto", () => {
    expect(inWakingHours(DAY)).toBe(true)
    expect(inWakingHours(NIGHT)).toBe(false)
    expect(inWakingHours(Date.parse("2026-10-22T12:00:00Z"))).toBe(true) // 08:00
    expect(inWakingHours(Date.parse("2026-10-23T01:00:00Z"))).toBe(false) // 21:00
  })

  test("resolveMode: default shadow, kill file wins", () => {
    expect(resolveMode(undefined, false)).toBe("shadow")
    expect(resolveMode("bogus", false)).toBe("shadow")
    expect(resolveMode("live", false)).toBe("live")
    expect(resolveMode("off", false)).toBe("off")
    expect(resolveMode("live", true)).toBe("off")
  })

  test("parseNotify validates fields", () => {
    expect(parseNotify(ev()).ok).toBe(true)
    expect(parseNotify({ ...ev(), severity: "high" })).toEqual({ ok: false, error: "bad_severity" })
    expect(parseNotify({ ...ev(), actionable: "yes" })).toEqual({ ok: false, error: "bad_actionable" })
    expect(parseNotify({ ...ev(), url: "javascript:x" })).toEqual({ ok: false, error: "bad_url" })
    expect(parseNotify(null).ok).toBe(false)
  })

  test("parseVerdict needs a known decision and a reason", () => {
    expect(parseVerdict('{"decision":"now","reason":"x"}')).toEqual({ decision: "now", reason: "x" })
    expect(parseVerdict('{"decision":"later","reason":"x"}')).toBeNull()
    expect(parseVerdict('{"decision":"drop","reason":""}')).toBeNull()
  })

  test("prefs reader caches 10 min", async () => {
    let calls = 0
    let t = 0
    const read = createPrefsReader(async () => { calls++; return [{ body: "prefs" }] }, () => t)
    expect(await read()).toBe("prefs")
    t = PREFS_TTL_MS - 1
    await read()
    expect(calls).toBe(1)
    t = PREFS_TTL_MS + 1
    await read()
    expect(calls).toBe(2)
  })

  test("reportCounts folds rows", () => {
    expect(reportCounts([{ source: "a", decision: "now", count: 2 }, { source: "a", decision: "brief", count: 1 }]))
      .toEqual({ a: { now: 2, checkin: 0, brief: 1, drop: 0, total: 3 } })
  })
})

describe("routes", () => {
  test("POST /api/notify + GET /api/notify/report", async () => {
    const store = createNotifyStore(new Database(":memory:"))
    const pushed: string[] = []
    const route = createNotifyRoute({
      store, mode: () => "shadow", prefs: async () => null, judge: async () => null,
      push: async (i) => { pushed.push(i.title) }, now: () => DAY, log: () => {},
    })
    const post = (body: unknown) => route(
      new Request("http://x/api/notify", { method: "POST", body: JSON.stringify(body) }), new URL("http://x/api/notify"),
    )
    const urgent = await (await post(ev({ title: "prod down", severity: "urgent", actionable: true })))!.json()
    expect(urgent).toMatchObject({ ok: true, decision: "now", delivered: true })
    const low = await (await post(ev({ dedupKey: "k2", title: "fyi", severity: "low" })))!.json()
    expect(low).toMatchObject({ ok: true, decision: "brief", delivered: false })
    expect(typeof low.id).toBe("number")
    expect(pushed).toEqual(["prod down"])
    expect((await post({ source: "x" }))!.status).toBe(400)

    const rep = await route(new Request("http://x/api/notify/report?days=1"), new URL("http://x/api/notify/report?days=1"))
    const body = await rep!.json()
    expect(body.counts.body).toMatchObject({ now: 1, brief: 1, total: 2 })
    const bad = await route(new Request("http://x/api/notify/report?days=0"), new URL("http://x/api/notify/report?days=0"))
    expect(bad!.status).toBe(400)
  })
})
