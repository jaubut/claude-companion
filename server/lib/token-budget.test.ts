import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { GaugeAccount } from "./gauge"
import { localDay } from "./body-tokens"
import { type BudgetAlertState, type BudgetResponse, budgetTick, buildBudget, classifySession, dailyLine } from "./token-budget"
import type { QueryFn, Row } from "./turso"

const NOW = Date.parse("2026-11-05T15:00:00Z")
const MODEL = "claude-opus-5-5"

function fixture(): QueryFn {
  const db = new Database(":memory:")
  db.run("CREATE TABLE token_usage (host TEXT, day TEXT, session_id TEXT, source TEXT, model TEXT, input INT, output INT, cache_read INT, cache_creation INT, turns INT)")
  db.run("CREATE TABLE token_sessions (host TEXT, session_id TEXT, name TEXT, tmux TEXT, cwd TEXT, first_seen TEXT, last_seen TEXT)")
  db.run("CREATE TABLE tasks (id TEXT, text TEXT, dispatch_owner TEXT, dispatch_started_at TEXT)")
  const usage = db.prepare("INSERT INTO token_usage VALUES ('mac', ?, ?, ?, ?, 0, ?, ?, 0, 1)")
  const session = db.prepare("INSERT INTO token_sessions VALUES ('mac', ?, ?, NULL, ?, '', ?)")
  const today = localDay(NOW)
  usage.run(today, "b", "main", MODEL, 1_000_000, 0) // $20
  usage.run(today, "b", "agent:x", MODEL, 0, 10_000_000) // $2, same session
  usage.run(today, "s", "main", MODEL, 500_000, 0) // $10
  usage.run(today, "n", "main", "mystery", 100, 0) // unpriced
  usage.run(localDay(NOW, 30), "b", "main", MODEL, 9_000_000, 0) // out of the week
  session.run("b", "claude-companion-token-budget-d6", "/home/aubut/apps/wt/claude-companion-token-budget", new Date(NOW).toISOString())
  session.run("s", "wt-98", "/tmp/pr-shepherd-abc/wt", new Date(NOW).toISOString())
  db.run("INSERT INTO tasks VALUES ('t1', 'Budget', 'companion:relay:claude-companion-token-budget-d6', ?)", [today])
  return async (sql, args = []) => db.query(sql).all(...(args as string[])) as Row[]
}

const account = (percentUsed: number): GaugeAccount => ({
  fiveHourPercent: null, fiveHourResetsAt: null, sevenDayPercent: null, at: NOW,
  limits: [{ kind: "seven_day", percentUsed, resetsAt: "2026-11-08T00:00:00Z" }],
})

describe("classifySession", () => {
  test.each([
    ["/tmp/dispatch-I9y9V8/wt", "dispatch", null],
    ["/private/var/folders/03/x/T/pr-shepherd-abc/wt", "shepherd", null],
    ["/private/var/folders/03/x/T", "scheduled", null],
    ["/home/aubut/claude-companion/brain", "brain", "claude-companion"],
    ["/home/aubut/apps/wt/claude-companion-ios-swipe-close", "interactive", "claude-companion-ios"],
    ["/home/aubut/apps/wt/claude-skill-loop", "interactive", "claude-config"],
    ["/home/aubut/apps/wt/-claude-final-edit-skill", "interactive", "claude-config"],
    ["/Users/jeremieaubut/apps/claude companion", "interactive", "claude-companion"],
    ["/home/aubut/.claude", "interactive", "claude-config"],
    ["/home/aubut", "interactive", null],
  ])("%s", (cwd, role, repo) => {
    expect(classifySession(cwd, null)).toEqual({ role: role as "brain", repo })
  })
  test("no cwd is unknown, a manager comes from its name", () => {
    expect(classifySession(null, "x").role).toBe("unknown")
    expect(classifySession("/home/aubut/tls-vault", "manager-vault").role).toBe("manager")
  })
})

describe("buildBudget", () => {
  test("every grouping sums to the raw table, the week excludes older days", async () => {
    const r = await buildBudget(fixture(), { now: () => NOW })
    expect([r.output, r.cache_read, r.usd, r.unpriced_tokens]).toEqual([1_500_100, 10_000_000, 32, 100])
    for (const rows of [r.by_role, r.by_repo]) {
      expect(rows.reduce((n, g) => n + g.output, 0)).toBe(r.output)
      expect(rows.reduce((n, g) => n + g.sessions, 0)).toBe(r.sessions)
    }
  })

  test("attributes repo, role, task and rework", async () => {
    const r = await buildBudget(fixture(), { now: () => NOW })
    expect(r.by_repo[0]).toMatchObject({ repo: "claude-companion", usd: 22, output: 1_000_000, cache_read: 10_000_000 })
    expect(r.by_task).toMatchObject([{ task_id: "t1", title: "Budget", usd: 22 }])
    expect(r.rework).toMatchObject({ usd: 10, share: 0.313 })
    expect(r.by_role.find((g) => g.role === "unknown")?.unpriced_tokens).toBe(100)
  })

  test("the percent is Claude Code's own, never estimated", async () => {
    const none = await buildBudget(fixture(), { now: () => NOW, weeklyBudgetUsd: 100 })
    expect(none.budget).toMatchObject({ percent_used: null, source: null, percent_of_budget: 32 })
    const real = await buildBudget(fixture(), { now: () => NOW, account: () => account(31) })
    expect(real.budget).toMatchObject({ percent_used: 31, source: "claude_code_rate_limit", resets_at: "2026-11-08T00:00:00Z" })
  })

  test("flags a host that stopped writing", async () => {
    const r = await buildBudget(fixture(), { now: () => NOW + 2 * 3_600_000 })
    expect(r.stale_hosts.map((h) => h.host)).toEqual(["mac"])
    expect(dailyLine(r)).toContain("Missing data from mac")
  })

  test("no collector tables is an empty view", async () => {
    const r = await buildBudget(async () => [], { now: () => NOW })
    expect(r).toMatchObject({ usd: 0, by_repo: [], stale_hosts: [] })
  })
})

describe("budgetTick", () => {
  const start: BudgetAlertState = { day: "", week: "", fired: [] }
  const at = (pct: number | null): Promise<BudgetResponse> =>
    buildBudget(fixture(), { now: () => NOW, ...(pct === null ? {} : { account: () => account(pct) }) })

  test("one line a day", async () => {
    const r = await at(10)
    const first = budgetTick(r, start, NOW)
    expect(first.posts).toHaveLength(1)
    expect(first.posts[0]).toContain("10% of the weekly limit")
    expect(budgetTick(r, first.state, NOW + 60_000).posts).toEqual([])
    expect(budgetTick(r, first.state, NOW + 86_400_000).posts).toHaveLength(1)
  })

  test("each threshold alerts once, a jump fires only the highest, a new week rearms", async () => {
    const first = budgetTick(await at(80), start, NOW)
    expect(first.posts[0]).toContain("past 75%")
    expect(first.state.fired).toEqual([50, 75])
    expect(budgetTick(await at(80), first.state, NOW + 60_000).posts).toEqual([])
    const next = budgetTick(await at(91), first.state, NOW + 60_000)
    expect(next.posts[0]).toContain("past 90%")
    expect(budgetTick(await at(80), { ...next.state, week: "older" }, NOW + 60_000).state.fired).toEqual([50, 75])
  })

  test("no percent means no alert", async () => {
    const out = budgetTick(await at(null), start, NOW)
    expect(out.state.fired).toEqual([])
    expect(out.posts[0]).toContain("weekly limit unknown")
  })
})
