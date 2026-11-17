import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import type { GaugeAccount } from "./gauge"
import { claudePlan, claudeSubscription, parseCodexRollout, resetSubscriptionsCache, subscriptions, type Subscription } from "./subscriptions"

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

  test("no gauge report → unknown, plan kept", () => {
    expect(claudeSubscription(null, "Max 20x", NOW)).toEqual({ provider: "claude", plan: "Max 20x", windows: [], status: "unknown", updatedAt: null })
  })
})

describe("chatgpt (codex rollout)", () => {
  test("captured tail: last rate_limits wins, partial first line skipped", () => {
    expect(parseCodexRollout(fixture("codex-rollout-tail.jsonl"), NOW)).toEqual({
      provider: "chatgpt", plan: "Pro Lite", status: "ok", updatedAt: "2026-11-17T10:20:26.343Z",
      windows: [{ label: "weekly", usedPct: 55, resetsAt: "2026-11-18T15:30:13.000Z" }],
    })
  })

  test("5h + weekly, limit reached → limited", () => {
    const s = parseCodexRollout(fixture("codex-rollout-limited.jsonl"), NOW)!
    expect(s.plan).toBe("Plus")
    expect(s.status).toBe("limited")
    expect(s.windows.map((w) => [w.label, w.usedPct])).toEqual([["5h", 91.5], ["weekly", 100]])
  })

  test("no rate_limits → null", () => {
    expect(parseCodexRollout('{"type":"event_msg","payload":{"type":"agent_message"}}\n', NOW)).toBeNull()
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
