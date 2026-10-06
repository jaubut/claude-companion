import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { QueryFn, Row } from "./turso"
import { PRICING_AS_OF } from "./model-prices"
import { buildTokens, createTokensSnapshot, liveSessionNames, localDay, parseRange, rangeSince } from "./body-tokens"

// Real SQL against an in-memory sqlite through the QueryFn seam (the aggregation
// lives in SQL, so fake row matching would test nothing). ROWS use bare aliases
// ("opus", "sonnet") that have no price, so their USD is null and every token is
// unpriced; the USD describe block below uses real model ids.

const NOW = new Date(2026, 9, 5, 15, 0, 0).getTime() // local 2026-10-05 15:00
const D = (back: number) => localDay(NOW, back)

interface U { host: string; back: number; session: string; source: string; model?: string; input?: number; output?: number; cache_read?: number; cache_creation?: number }

function sqliteQuery(rows: U[] | null): { query: QueryFn; calls: string[] } {
  const db = new Database(":memory:")
  if (rows) {
    db.run(
      "CREATE TABLE token_usage (host TEXT, day TEXT, session_id TEXT, source TEXT, model TEXT, input INTEGER, output INTEGER, " +
      "cache_read INTEGER, cache_creation INTEGER, turns INTEGER, PRIMARY KEY (host, day, session_id, source, model))",
    )
    const ins = db.prepare("INSERT INTO token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
    for (const r of rows) ins.run(r.host, D(r.back), r.session, r.source, r.model ?? "opus", r.input ?? 0, r.output ?? 0, r.cache_read ?? 0, r.cache_creation ?? 0)
  }
  const calls: string[] = []
  const query: QueryFn = async (sql, args) => {
    calls.push(sql)
    return db.query(sql).all(...args) as Row[]
  }
  return { query, calls }
}

const ROWS: U[] = [
  // today
  { host: "mac", back: 0, session: "s-a", source: "main", input: 100, output: 50, cache_read: 1000, cache_creation: 10 },
  { host: "mac", back: 0, session: "s-a", source: "main", model: "sonnet", input: 5 },
  { host: "mac", back: 0, session: "s-a", source: "agent:builder", input: 200, cache_read: 300 },
  { host: "mac", back: 0, session: "s-a", source: "skill:today", output: 40 },
  { host: "zettlab", back: 0, session: "s-b", source: "main", input: 10, cache_read: 2000 },
  { host: "zettlab", back: 0, session: "s-b", source: "agent:researcher", input: 900 },
  // 3 days ago (in 7d, 30d)
  { host: "mac", back: 3, session: "s-c", source: "main", input: 5000 },
  { host: "mac", back: 3, session: "s-c", source: "skill:po", output: 700 },
  // 6 days ago — last day inside 7d
  { host: "zettlab", back: 6, session: "s-d", source: "agent:builder", input: 50 },
  // 7 days ago — outside 7d, inside 30d
  { host: "mac", back: 7, session: "s-e", source: "main", input: 90_000 },
  // 30 days ago — outside 30d
  { host: "mac", back: 30, session: "s-f", source: "main", input: 1_000_000 },
]

const names = async () => new Map([["s-a", "tls-dashboard"]])

describe("token range helpers", () => {
  test("parseRange defaults to today and rejects junk", () => {
    expect(parseRange(null)).toBe("today")
    expect(parseRange("7d")).toBe("7d")
    expect(parseRange("30d")).toBe("30d")
    expect(parseRange("1y")).toBeNull()
  })
  test("rangeSince is inclusive local days", () => {
    expect(rangeSince("today", NOW)).toBe("2026-10-05")
    expect(rangeSince("7d", NOW)).toBe("2026-09-29")
    expect(rangeSince("30d", NOW)).toBe("2026-09-06")
  })
})

describe("GET /api/body/tokens read model", () => {
  test("missing table → empty view, no aggregate queries", async () => {
    const { query, calls } = sqliteQuery(null)
    const body = await buildTokens(query, "7d", { now: () => NOW, sessionNames: names })
    expect(body).toEqual({
      ok: true, generated_at: new Date(NOW).toISOString(), range: "7d", since: "2026-09-29", pricing_as_of: PRICING_AS_OF,
      totals: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, usd: null, unpriced_tokens: 0 },
      by_host: [], by_day: [], top_sessions: [], top_agents: [], top_skills: [],
    })
    expect(calls).toHaveLength(1)
  })

  test("empty table → zero totals and empty lists", async () => {
    const { query } = sqliteQuery([])
    const body = await buildTokens(query, "30d", { now: () => NOW, sessionNames: names })
    expect(body.totals).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, usd: null, unpriced_tokens: 0 })
    expect([body.by_host, body.by_day, body.top_sessions, body.top_agents, body.top_skills]).toEqual([[], [], [], [], []])
  })

  test("today: totals, by_host, by_day, top lists with names and prefixes stripped", async () => {
    const { query } = sqliteQuery(ROWS)
    const body = await buildTokens(query, "today", { now: () => NOW, sessionNames: names })
    expect(body.totals).toEqual({ input: 1215, output: 90, cache_read: 3300, cache_creation: 10, total: 4615, usd: null, unpriced_tokens: 4615 })
    expect(body.by_host).toEqual([
      { host: "zettlab", input: 910, output: 0, cache_read: 2000, cache_creation: 0, total: 2910, usd: null, unpriced_tokens: 2910 },
      { host: "mac", input: 305, output: 90, cache_read: 1300, cache_creation: 10, total: 1705, usd: null, unpriced_tokens: 1705 },
    ])
    expect(body.by_day).toEqual([{ day: "2026-10-05", input: 1215, output: 90, cache_read: 3300, cache_creation: 10, total: 4615, usd: null, unpriced_tokens: 4615 }])
    expect(body.top_sessions).toEqual([
      { session_id: "s-b", name: null, host: "zettlab", total: 2910, usd: null, unpriced_tokens: 2910 },
      { session_id: "s-a", name: "tls-dashboard", host: "mac", total: 1705, usd: null, unpriced_tokens: 1705 },
    ])
    expect(body.top_agents).toEqual([{ name: "researcher", total: 900, usd: null, unpriced_tokens: 900 }, { name: "builder", total: 500, usd: null, unpriced_tokens: 500 }])
    expect(body.top_skills).toEqual([{ name: "today", total: 40, usd: null, unpriced_tokens: 40 }])
  })

  test("range filter: 7d includes day -6 not -7; 30d includes -7 not -30", async () => {
    const { query } = sqliteQuery(ROWS)
    const week = await buildTokens(query, "7d", { now: () => NOW, sessionNames: names })
    expect(week.totals.total).toBe(4615 + 5700 + 50)
    expect(week.by_day.map((d) => d.day)).toEqual([D(6), D(3), D(0)])
    expect(week.top_sessions.map((s) => s.session_id)).toEqual(["s-c", "s-b", "s-a", "s-d"])
    expect(week.top_agents).toEqual([{ name: "researcher", total: 900, usd: null, unpriced_tokens: 900 }, { name: "builder", total: 550, usd: null, unpriced_tokens: 550 }])
    expect(week.top_skills).toEqual([{ name: "po", total: 700, usd: null, unpriced_tokens: 700 }, { name: "today", total: 40, usd: null, unpriced_tokens: 40 }])

    const month = await buildTokens(query, "30d", { now: () => NOW, sessionNames: names })
    expect(month.totals.total).toBe(4615 + 5700 + 50 + 90_000)
    expect(month.top_sessions[0]).toEqual({ session_id: "s-e", name: null, host: "mac", total: 90_000, usd: null, unpriced_tokens: 90_000 })
    expect(month.top_sessions.some((s) => s.session_id === "s-f")).toBe(false)
  })

  test("ordering: descending total, ties by key, capped at 10", async () => {
    const many: U[] = Array.from({ length: 14 }, (_, i) => ({ host: "mac", back: 0, session: `s-${String(i).padStart(2, "0")}`, source: `agent:a${String(i).padStart(2, "0")}`, input: i < 2 ? 500 : i * 10 }))
    const { query } = sqliteQuery(many)
    const body = await buildTokens(query, "today", { now: () => NOW, sessionNames: names })
    expect(body.top_sessions).toHaveLength(10)
    expect(body.top_sessions.slice(0, 3).map((s) => [s.session_id, s.total])).toEqual([["s-00", 500], ["s-01", 500], ["s-13", 130]])
    expect(body.top_sessions.at(-1)!.session_id).toBe("s-06") // s-00, s-01, then s-13 … s-06
    expect(body.top_agents).toHaveLength(10)
    expect(body.top_agents.slice(0, 3).map((a) => a.name)).toEqual(["a00", "a01", "a13"])
    for (const list of [body.top_sessions, body.top_agents]) {
      for (let i = 1; i < list.length; i++) expect(list[i - 1]!.total).toBeGreaterThanOrEqual(list[i]!.total)
    }
  })

  test("session-name lookup failure never fails the view", async () => {
    const { query } = sqliteQuery(ROWS)
    const body = await buildTokens(query, "today", { now: () => NOW, sessionNames: async () => { throw new Error("EACCES") } })
    expect(body.top_sessions.every((s) => s.name === null)).toBe(true)
  })
})

describe("liveSessionNames", () => {
  test("maps sessionId → name, skips junk and nameless files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sessions-"))
    writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "s-a", name: " tls-dashboard " }))
    writeFileSync(join(dir, "2.json"), JSON.stringify({ pid: 2, sessionId: "s-b" }))
    writeFileSync(join(dir, "3.json"), "{not json")
    writeFileSync(join(dir, "3.abc.key"), "x")
    expect([...(await liveSessionNames(dir))]).toEqual([["s-a", "tls-dashboard"]])
    expect((await liveSessionNames(join(dir, "missing"))).size).toBe(0)
  })
})

describe("tokens snapshot cache", () => {
  test("30 s cache per range, fresh bypasses, expiry refetches", async () => {
    const { query, calls } = sqliteQuery(ROWS)
    let t = NOW
    const snap = createTokensSnapshot(query, { now: () => t, sessionNames: names })
    const count = () => calls.filter((s) => s.includes("sqlite_master")).length
    await snap.get("today")
    await snap.get("today")
    expect(count()).toBe(1)
    await snap.get("7d")
    expect(count()).toBe(2)
    await snap.get("today", { fresh: true })
    expect(count()).toBe(3)
    t += 30_000
    await snap.get("today")
    expect(count()).toBe(4)
  })
})

describe("USD (API list price per model)", () => {
  // Opus 5.5: $4 in / $20 out / $0.20 cache read / $5 cache write (5m), per MTok.
  // Haiku 4.5 (dated id): $1 / $5 / $0.10 / $1.25.
  const PRICED: U[] = [
    { host: "mac", back: 0, session: "s-p", source: "main", model: "claude-opus-5-5", input: 1_000_000, output: 100_000, cache_read: 10_000_000, cache_creation: 200_000 },
    { host: "mac", back: 0, session: "s-p", source: "agent:explore", model: "claude-haiku-4-5-20251001", input: 2_000_000, output: 50_000, cache_read: 0, cache_creation: 0 },
    { host: "zettlab", back: 0, session: "s-u", source: "main", model: "claude-opus-9", input: 7_000 },
    { host: "zettlab", back: 0, session: "s-z", source: "agent:unknown", model: "<synthetic>", output: 3 },
  ]
  // opus 5.5: 4 + 2 + 2 + 1 = 9 ; haiku: 2 + 0.25 = 2.25
  test("totals mix priced models; unknown models counted in unpriced_tokens, not $0", async () => {
    const { query } = sqliteQuery(PRICED)
    const body = await buildTokens(query, "today", { now: () => NOW, sessionNames: names })
    expect(body.pricing_as_of).toBe(PRICING_AS_OF)
    expect(body.totals.usd).toBe(11.25)
    expect(body.totals.unpriced_tokens).toBe(7_003)
    expect(body.by_host).toEqual([
      expect.objectContaining({ host: "mac", usd: 11.25, unpriced_tokens: 0 }),
      expect.objectContaining({ host: "zettlab", usd: null, unpriced_tokens: 7_003 }),
    ])
    expect(body.by_day[0]).toMatchObject({ usd: 11.25, unpriced_tokens: 7_003 })
    expect(body.top_sessions.map((s) => [s.session_id, s.usd, s.unpriced_tokens])).toEqual([
      ["s-p", 11.25, 0],
      ["s-u", null, 7_000],
      ["s-z", null, 3],
    ])
    expect(body.top_agents).toEqual([
      { name: "explore", total: 2_050_000, usd: 2.25, unpriced_tokens: 0 },
      { name: "unknown", total: 3, usd: null, unpriced_tokens: 3 },
    ])
  })
})
