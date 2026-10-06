import { beforeEach, describe, expect, test } from "bun:test"
import {
  EMIT_MIN_MS, type GaugeFrame, GaugeStore, MOD_FRESH_MS, type ModReport, STALE_MS,
  parseModReport, percentOf, windowFor,
} from "./gauge"

// Fake clock + manual timers: everything the store does on time is driven here.
let now: number
let timers: Array<{ at: number; fn: () => void; dead: boolean }>
let frames: GaugeFrame[]
let keys: Map<string, string>
let store: GaugeStore

function advance(ms: number): void {
  const until = now + ms
  for (;;) {
    const next = timers.filter((t) => !t.dead && t.at <= until).sort((a, b) => a.at - b.at)[0]
    if (!next) break
    now = next.at
    next.dead = true
    next.fn()
  }
  now = until
}

beforeEach(() => {
  now = 1_000_000
  timers = []
  frames = []
  keys = new Map([["sid-a", "claude:tty:/dev/ttys001"], ["sid-b", "claude:tty:/dev/ttys002"]])
  store = new GaugeStore({
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, dead: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as { dead: boolean }).dead = true },
    resolveKey: (sid, hint) => keys.get(sid) ?? (hint || null),
    emit: (f) => frames.push(f),
  })
})

function mod(over: Partial<ModReport> = {}): ModReport {
  return {
    sessionId: "sid-a", cwd: "/w", ctxTokens: 412_000, ctxWindow: 1_000_000, ctxPercent: 41,
    fiveHourPercent: 23.5, fiveHourResetsAt: "2026-10-06T19:00:00Z", sevenDayPercent: 12, at: now,
    ...over,
  }
}

describe("parseModReport", () => {
  test("full body maps every field", () => {
    expect(parseModReport({
      session_id: "u1", cwd: "/abs", ctx_tokens: 412000, ctx_window: 1000000, ctx_percent: 41,
      five_hour_percent: 23.5, five_hour_resets_at: "2026-10-06T19:00:00Z", seven_day_percent: 12, at: 1791230000000,
    })).toEqual({
      sessionId: "u1", cwd: "/abs", ctxTokens: 412000, ctxWindow: 1000000, ctxPercent: 41,
      fiveHourPercent: 23.5, fiveHourResetsAt: "2026-10-06T19:00:00Z", sevenDayPercent: 12, at: 1791230000000,
    })
  })

  test("only session_id is required; null, missing and mistyped fields are absent", () => {
    expect(parseModReport({ session_id: "u1", ctx_tokens: null, ctx_percent: "41", five_hour_percent: -1, ctx_window: 0, five_hour_resets_at: 5 }))
      .toEqual({
        sessionId: "u1", cwd: null, ctxTokens: null, ctxWindow: null, ctxPercent: null,
        fiveHourPercent: null, fiveHourResetsAt: null, sevenDayPercent: null, at: null,
      })
  })

  test("unusable bodies", () => {
    for (const b of [null, "x", [], {}, { session_id: "" }, { session_id: 7 }, { session_id: "x".repeat(201) }]) {
      expect(parseModReport(b)).toBeNull()
    }
  })
})

describe("window rule", () => {
  test("1M on [1m] or > 200k, else 200k; percent rounded", () => {
    expect(windowFor(150_000, "claude-opus-5-5[1m]")).toBe(1_000_000)
    expect(windowFor(200_001)).toBe(1_000_000)
    expect(windowFor(200_000, "claude-opus-5-5")).toBe(200_000)
    expect(percentOf(83_000, 200_000)).toBe(42)
  })
})

describe("GaugeStore", () => {
  test("mod report → session item + account copy, frame emitted", () => {
    store.reportMod(mod())
    const snap = store.snapshot()
    expect(snap).toEqual({
      ok: true,
      account: { fiveHourPercent: 23.5, fiveHourResetsAt: "2026-10-06T19:00:00Z", sevenDayPercent: 12, at: now },
      sessions: [{ sessionKey: "claude:tty:/dev/ttys001", ctxTokens: 412_000, ctxWindow: 1_000_000, ctxPercent: 41, source: "mod", at: now }],
    })
    expect(frames).toEqual([{ type: "gauge", ...snap.sessions[0]!, account: snap.account }])
  })

  test("partial mod: tokens only derives window + percent; 5h only updates the account", () => {
    store.reportMod(mod({ ctxWindow: null, ctxPercent: null, ctxTokens: 50_000, fiveHourPercent: null, fiveHourResetsAt: null, sevenDayPercent: null }))
    expect(store.snapshot().sessions[0]).toMatchObject({ ctxTokens: 50_000, ctxWindow: 200_000, ctxPercent: 25 })
    expect(store.snapshot().account).toBeNull()
    advance(EMIT_MIN_MS)
    store.reportMod(mod({ sessionId: "sid-b", ctxTokens: null, ctxWindow: null, ctxPercent: null, sevenDayPercent: null, fiveHourResetsAt: null }))
    const snap = store.snapshot()
    expect(snap.sessions).toHaveLength(1) // sid-b carried no ctx → no session item
    expect(snap.account).toMatchObject({ fiveHourPercent: 23.5, fiveHourResetsAt: null, sevenDayPercent: null })
  })

  test("mod wins over the transcript fallback while fresh; fallback takes over after 10 min", () => {
    store.reportMod(mod({ ctxTokens: 412_000, ctxPercent: 41 }))
    advance(60_000)
    store.reportTranscript("sid-a", "", 90_000, "")
    expect(store.snapshot().sessions[0]).toMatchObject({ source: "mod", ctxTokens: 412_000 })
    expect(store.modFreshFor("sid-a")).toBe(true)
    advance(MOD_FRESH_MS)
    expect(store.modFreshFor("sid-a")).toBe(false)
    store.reportTranscript("sid-a", "", 90_000, "")
    expect(store.snapshot().sessions[0]).toMatchObject({ source: "transcript", ctxTokens: 90_000, ctxWindow: 200_000, ctxPercent: 45 })
    // A new mod report wins again at once.
    store.reportMod(mod({ ctxTokens: 100_000, ctxPercent: 10 }))
    expect(store.snapshot().sessions[0]).toMatchObject({ source: "mod", ctxTokens: 100_000 })
  })

  test("transcript-only session: 1M by model id, 5h unknown", () => {
    store.reportTranscript("sid-b", "", 150_000, "claude-opus-5-5[1m]")
    const snap = store.snapshot()
    expect(snap.account).toBeNull()
    expect(snap.sessions).toEqual([{ sessionKey: "claude:tty:/dev/ttys002", ctxTokens: 150_000, ctxWindow: 1_000_000, ctxPercent: 15, source: "transcript", at: now }])
  })

  test("account = freshest report from any session; an older report never overwrites it", () => {
    store.reportMod(mod({ sessionId: "sid-a", fiveHourPercent: 30, at: now }))
    store.reportMod(mod({ sessionId: "sid-b", fiveHourPercent: 10, at: now - 5_000 }))
    expect(store.snapshot().account?.fiveHourPercent).toBe(30)
    advance(1_000)
    store.reportMod(mod({ sessionId: "sid-b", fiveHourPercent: 31, at: now }))
    expect(store.snapshot().account).toMatchObject({ fiveHourPercent: 31, at: now })
  })

  test("stale after 30 min without a report → dropped, clear frame sent", () => {
    store.reportMod(mod())
    advance(STALE_MS - 1)
    expect(store.snapshot().sessions).toHaveLength(1)
    advance(60_001)
    expect(store.snapshot().sessions).toHaveLength(0)
    const last = frames.at(-1)!
    expect(last).toMatchObject({ type: "gauge", sessionKey: "claude:tty:/dev/ttys001", ctxTokens: null, ctxWindow: null, ctxPercent: null, source: null })
    // Account survives: it is account-wide, not per session.
    expect(store.snapshot().account).not.toBeNull()
  })

  test("a report keeps the session fresh; the sweep timer drops it without any read", () => {
    store.reportMod(mod())
    advance(20 * 60_000)
    store.reportMod(mod())
    advance(20 * 60_000)
    expect(store.snapshot().sessions).toHaveLength(1)
    const before = frames.length
    advance(11 * 60_000)
    expect(frames.length).toBe(before + 1) // timer-driven clear frame
    expect(frames.at(-1)!.source).toBeNull()
  })

  test("session end drops at once with a clear frame", () => {
    store.reportMod(mod())
    advance(EMIT_MIN_MS)
    expect(store.drop("sid-a")).toBe(true)
    expect(store.drop("sid-a")).toBe(false)
    expect(store.snapshot().sessions).toHaveLength(0)
    expect(frames.at(-1)).toMatchObject({ sessionKey: "claude:tty:/dev/ttys001", source: null, ctxPercent: null })
  })

  test("frames throttled to 1 / 2 s per session, trailing frame carries the latest value", () => {
    store.reportMod(mod({ ctxPercent: 40 }))
    store.reportMod(mod({ ctxPercent: 41 }))
    store.reportMod(mod({ ctxPercent: 42 }))
    store.reportMod(mod({ sessionId: "sid-b", ctxPercent: 7 })) // other session: own budget
    expect(frames.map((f) => [f.sessionKey, f.ctxPercent])).toEqual([
      ["claude:tty:/dev/ttys001", 40],
      ["claude:tty:/dev/ttys002", 7],
    ])
    advance(EMIT_MIN_MS - 1)
    expect(frames).toHaveLength(2)
    advance(1)
    expect(frames).toHaveLength(3)
    expect(frames[2]).toMatchObject({ sessionKey: "claude:tty:/dev/ttys001", ctxPercent: 42 })
    advance(10 * EMIT_MIN_MS)
    expect(frames).toHaveLength(3) // nothing new → nothing sent
  })

  test("unresolvable session id: no frame, not listed; listed once the registry knows it", () => {
    store.reportMod(mod({ sessionId: "sid-new" }))
    expect(frames).toHaveLength(0)
    expect(store.snapshot().sessions).toHaveLength(0)
    keys.set("sid-new", "claude:tty:/dev/ttys009")
    expect(store.snapshot().sessions[0]?.sessionKey).toBe("claude:tty:/dev/ttys009")
  })

  test("unchanged transcript size does not re-emit", () => {
    store.reportTranscript("sid-a", "", 90_000, "")
    advance(EMIT_MIN_MS * 3)
    store.reportTranscript("sid-a", "", 90_000, "")
    expect(frames).toHaveLength(1)
  })
})
