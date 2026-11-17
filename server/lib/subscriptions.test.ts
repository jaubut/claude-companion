import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import type { GaugeAccount } from "./gauge"
import { chatgptSubscription, claudePlan, claudeSubscription, parseCodexRollout, resetSubscriptionsCache, subscriptions, type Subscription } from "./subscriptions"

// Parsers run on captured fixtures (docs/fixtures/subscriptions/); the
// assembled shape is checked against the iOS contract fixture.

const FIX = join(import.meta.dir, "../../docs/fixtures/subscriptions")
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8")
const NOW = Date.parse("2026-11-17T10:30:00Z")

const account = (limits: GaugeAccount["limits"], at = NOW - 60_000): GaugeAccount =>
  ({ fiveHourPercent: null, fiveHourResetsAt: null, sevenDayPercent: null, limits, at })

describe("claude", () => {
  test("plan from oauthAccount (captured)", () => {
    expect(claudePlan(JSON.parse(fixture("claude-oauth-account.json")))).toBe("Max 20x")
    expect(claudePlan({ organizationType: "claude_pro", organizationRateLimitTier: "default_claude_pro" })).toBe("Pro")
    expect(claudePlan(null)).toBeNull()
  })

  test("gauge limits → 5h + weekly; other kinds skipped", () => {
    const s = claudeSubscription(account([
      { kind: "five_hour", percentUsed: 82, resetsAt: "2026-11-17T14:00:00Z" },
      { kind: "seven_day", percentUsed: 64, resetsAt: "2026-11-20T13:00:00Z" },
      { kind: "seven_day_opus", percentUsed: 99, resetsAt: null },
    ]), "Max 20x", NOW)
    expect(s).toEqual({
      provider: "claude", plan: "Max 20x", status: "near", updatedAt: "2026-11-17T10:29:00.000Z",
      windows: [{ label: "5h", usedPct: 82, resetsAt: "2026-11-17T14:00:00Z" }, { label: "weekly", usedPct: 64, resetsAt: "2026-11-20T13:00:00Z" }],
    })
  })

  test("a passed reset rolls the window to 0", () => {
    const s = claudeSubscription(account([{ kind: "five_hour", percentUsed: 100, resetsAt: "2026-11-17T10:00:00Z" }]), null, NOW)
    expect(s.windows).toEqual([{ label: "5h", usedPct: 0, resetsAt: null }])
    expect(s.status).toBe("ok")
  })

  test("out-of-range gauge `at` → updatedAt null, no throw", () => {
    const s = claudeSubscription(account([{ kind: "five_hour", percentUsed: 10, resetsAt: null }], 1e17), null, NOW)
    expect(s.updatedAt).toBeNull()
    expect(s.status).toBe("ok")
  })

  test("no gauge report → unknown, plan kept", () => {
    expect(claudeSubscription(null, "Max 20x", NOW)).toEqual({ provider: "claude", plan: "Max 20x", windows: [], status: "unknown", updatedAt: null })
  })
})

describe("chatgpt (codex rollout)", () => {
  const chatgpt = (text: string, now = NOW): Subscription => chatgptSubscription(parseCodexRollout(text), now)
  const event = (rl: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: "2026-11-17T09:00:00.000Z", payload: { type: "token_count", rate_limits: rl } })

  test("captured tail: last rate_limits wins, partial first line skipped", () => {
    expect(chatgpt(fixture("codex-rollout-tail.jsonl"))).toEqual({
      provider: "chatgpt", plan: "Pro Lite", status: "ok", updatedAt: "2026-11-17T10:20:26.343Z",
      windows: [{ label: "weekly", usedPct: 55, resetsAt: "2026-11-18T15:30:13.000Z" }],
    })
  })

  test("5h + weekly, limit reached → limited", () => {
    const s = chatgpt(fixture("codex-rollout-limited.jsonl"))
    expect(s.plan).toBe("Plus")
    expect(s.status).toBe("limited")
    expect(s.windows.map((w) => [w.label, w.usedPct])).toEqual([["5h", 91.5], ["weekly", 100]])
  })

  test("limit reached ends when its window resets, not another's", () => {
    const text = fixture("codex-rollout-limited.jsonl") // reached: secondary (weekly, resets 2026-11-18T15:30:13Z)
    const afterPrimary = chatgpt(text, Date.parse("2026-11-18T14:30:00Z"))
    expect(afterPrimary.windows.map((w) => [w.label, w.usedPct])).toEqual([["5h", 0], ["weekly", 100]])
    expect(afterPrimary.status).toBe("limited")
    const afterAll = chatgpt(text, Date.parse("2026-11-26T00:00:00Z"))
    expect(afterAll.windows).toEqual([{ label: "5h", usedPct: 0, resetsAt: null }, { label: "weekly", usedPct: 0, resetsAt: null }])
    expect(afterAll.status).toBe("ok")
  })

  test("unnamed limit reached ends when any window resets", () => {
    const text = event({ primary: { used_percent: 40, window_minutes: 300, resets_at: 1795010400 }, rate_limit_reached_type: "workspace" })
    expect(chatgpt(text).status).toBe("limited")
    expect(chatgpt(text, Date.parse("2026-11-18T14:30:00Z")).status).toBe("ok")
  })

  test("model sub-limits and empty rate_limits don't shadow the plan's", () => {
    const text = [
      fixture("codex-rollout-limited.jsonl").trim(),
      event({ limit_id: "codex_spark", primary: { used_percent: 5, window_minutes: 300 }, plan_type: "plus" }),
      event({ limit_id: "codex", primary: null, secondary: null, plan_type: "plus", rate_limit_reached_type: null }),
    ].join("\n")
    expect(chatgpt(text).windows.map((w) => w.usedPct)).toEqual([91.5, 100])
  })

  test("out-of-range resets_at → resetsAt null, no throw", () => {
    const s = chatgpt(event({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1e17 } }))
    expect(s.windows).toEqual([{ label: "5h", usedPct: 10, resetsAt: null }])
  })

  test("no rate_limits → null / unknown", () => {
    expect(parseCodexRollout('{"type":"event_msg","payload":{"type":"agent_message"}}\n')).toBeNull()
    expect(chatgptSubscription(null, NOW)).toEqual({ provider: "chatgpt", plan: null, windows: [], status: "unknown", updatedAt: null })
  })
})

describe("subscriptions()", () => {
  test("reads a fake home: state db → rollout; claude.json plan; gemini unknown; matches the contract shape", () => {
    resetSubscriptionsCache()
    const home = mkdtempSync(join(tmpdir(), "subs-"))
    mkdirSync(join(home, ".codex"))
    const rollout = join(home, "rollout.jsonl")
    writeFileSync(rollout, fixture("codex-rollout-tail.jsonl"))
    const db = new Database(join(home, ".codex", "state_5.sqlite"))
    db.run("create table threads (rollout_path text, updated_at integer, updated_at_ms integer)")
    db.run("insert into threads values ('', 9, null), (?, 1, null)", [rollout])
    db.close()
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: JSON.parse(fixture("claude-oauth-account.json")) }))

    const subs = subscriptions(account([{ kind: "seven_day", percentUsed: 64, resetsAt: "2026-11-20T13:00:00Z" }]), NOW, home)
    expect(subs.map((s) => [s.provider, s.plan, s.status])).toEqual([["claude", "Max 20x", "ok"], ["chatgpt", "Pro Lite", "ok"], ["gemini", null, "unknown"]])

    // Cached: the rollout is not re-read within CACHE_MS.
    writeFileSync(rollout, "")
    expect(subscriptions(null, NOW + 60_000, home)[1]!.plan).toBe("Pro Lite")

    const contract = JSON.parse(readFileSync(join(import.meta.dir, "../../contracts/subscriptions/api.json"), "utf8")) as { ok: true; subscriptions: Subscription[] }
    const keys = (s: Subscription): string[] => Object.keys(s).sort()
    for (const s of contract.subscriptions) expect(keys(s)).toEqual(keys(subs[0]!))
    expect(Object.keys(contract.subscriptions[0]!.windows[0]!).sort()).toEqual(Object.keys(subs[0]!.windows[0]!).sort())
    resetSubscriptionsCache()
  })
})
