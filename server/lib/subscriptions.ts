// AI subscriptions' plan usage for the phone widget: Claude, ChatGPT (Codex), Gemini.
// Contract: docs/subscriptions-api.md. Every source is local and free — nothing
// here calls a model or an account API:
//   - claude:  the gauge's account limits (lib/gauge.ts, live) + the plan from
//              ~/.claude.json oauthAccount (no secrets in that block's fields we read).
//   - chatgpt: the newest `rate_limits` a Codex rollout logged (~/.codex/sessions,
//              located through ~/.codex/state_5.sqlite).
//   - gemini:  Antigravity (agy) keeps no quota or plan on disk; its quota lives
//              behind its OAuth token, which we don't use → always "unknown".
// File reads are cached CACHE_MS.

import { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import type { GaugeAccount } from "./gauge"

type Provider = "claude" | "chatgpt" | "gemini"
type WindowLabel = "5h" | "weekly" | "daily" | "monthly"
type SubStatus = "ok" | "near" | "limited" | "unknown"

interface SubWindow { label: WindowLabel; usedPct: number; resetsAt: string | null }
export interface Subscription {
  provider: Provider
  plan: string | null
  windows: SubWindow[]
  status: SubStatus
  updatedAt: string | null // when the source last measured; null = never
}

const CACHE_MS = 5 * 60_000
const NEAR_PCT = 80
const TAIL_BYTES = 512 * 1024
const ROLLOUTS_MAX = 8

// null for NaN or a ms value outside Date's range (toISOString would throw).
function iso(ms: number): string | null {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// A window whose reset already passed has rolled over: nothing used in it yet
// as far as this host knows.
function rolled(w: SubWindow, now: number): SubWindow {
  const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(t) && t <= now ? { label: w.label, usedPct: 0, resetsAt: null } : w
}

function statusOf(windows: SubWindow[], limited = false): SubStatus {
  if (limited) return "limited"
  if (windows.length === 0) return "unknown"
  const max = Math.max(...windows.map((w) => w.usedPct))
  return max >= 100 ? "limited" : max >= NEAR_PCT ? "near" : "ok"
}

function labelForMinutes(min: number): WindowLabel | null {
  if (min === 300) return "5h"
  if (min === 1440) return "daily"
  if (min === 10080) return "weekly"
  if (min >= 40320 && min <= 44640) return "monthly"
  return null
}

// ---- Claude ----

// oauthAccount.organizationRateLimitTier "default_claude_max_20x" → "Max 20x";
// else organizationType "claude_pro" → "Pro".
export function claudePlan(oauthAccount: unknown): string | null {
  if (!oauthAccount || typeof oauthAccount !== "object") return null
  const o = oauthAccount as Record<string, unknown>
  const tier = typeof o.organizationRateLimitTier === "string" ? o.organizationRateLimitTier : ""
  const m = /max_(\d+x)/.exec(tier)
  if (m) return `Max ${m[1]}`
  const type = typeof o.organizationType === "string" ? o.organizationType.replace(/^claude_/, "") : ""
  return type ? type[0]!.toUpperCase() + type.slice(1) : null
}

const CLAUDE_KINDS: Record<string, WindowLabel> = { five_hour: "5h", seven_day: "weekly" }

export function claudeSubscription(account: GaugeAccount | null, plan: string | null, now: number): Subscription {
  const windows: SubWindow[] = []
  for (const l of account?.limits ?? []) {
    const label = CLAUDE_KINDS[l.kind]
    if (label && l.percentUsed !== null) windows.push(rolled({ label, usedPct: l.percentUsed, resetsAt: l.resetsAt }, now))
  }
  // Older mods report only the flat fields.
  if (account && windows.length === 0) {
    if (account.fiveHourPercent !== null) windows.push(rolled({ label: "5h", usedPct: account.fiveHourPercent, resetsAt: account.fiveHourResetsAt }, now))
    if (account.sevenDayPercent !== null) windows.push({ label: "weekly", usedPct: account.sevenDayPercent, resetsAt: null })
  }
  return { provider: "claude", plan, windows, status: statusOf(windows), updatedAt: account && windows.length ? iso(account.at) : null }
}

// ---- ChatGPT / Codex ----

const CODEX_PLANS: Record<string, string> = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" }

const CODEX_SLOTS = ["primary", "secondary"] as const
type CodexSlot = (typeof CODEX_SLOTS)[number]

// One rollout event's rate limits as logged: windows not rolled over yet, so
// the "limit reached" flag can be judged against the current time on each read.
export interface CodexRead {
  plan: string | null
  slots: Partial<Record<CodexSlot, SubWindow>>
  reached: string | null // rate_limit_reached_type
  updatedAt: string | null
}

// The last `token_count` event carrying the account-wide `rate_limits` in a
// rollout JSONL chunk (a partial first line from a tail read is skipped). null = none in it.
export function parseCodexRollout(text: string): CodexRead | null {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"rate_limits"')) continue
    let ev: Record<string, unknown>
    try { ev = JSON.parse(line) } catch { continue }
    const p = ev.payload as Record<string, unknown> | undefined
    const rl = p?.rate_limits as Record<string, unknown> | null | undefined
    if (!rl || typeof rl !== "object") continue
    // Model-specific sub-limits (e.g. Spark buckets) aren't the plan's usage.
    if (typeof rl.limit_id === "string" && rl.limit_id !== "codex") continue
    const slots: CodexRead["slots"] = {}
    for (const k of CODEX_SLOTS) {
      const s = rl[k] as Record<string, unknown> | null | undefined
      if (!s || typeof s !== "object") continue
      const label = typeof s.window_minutes === "number" ? labelForMinutes(s.window_minutes) : null
      if (!label || typeof s.used_percent !== "number") continue
      const resetsAt = typeof s.resets_at === "number" ? iso(s.resets_at * 1000) : null
      slots[k] = { label, usedPct: s.used_percent, resetsAt }
    }
    const reached = typeof rl.rate_limit_reached_type === "string" ? rl.rate_limit_reached_type : null
    if (!slots.primary && !slots.secondary && reached === null) continue
    const planType = typeof rl.plan_type === "string" ? rl.plan_type : null
    const ts = typeof ev.timestamp === "string" && Number.isFinite(Date.parse(ev.timestamp)) ? new Date(ev.timestamp).toISOString() : null
    return { plan: planType ? CODEX_PLANS[planType] ?? planType : null, slots, reached, updatedAt: ts }
  }
  return null
}

// Windows rolled over at `now`. A "limit reached" flag ends once its window
// resets: the named slot's ("primary" / "secondary"), else any window's.
export function chatgptSubscription(r: CodexRead | null, now: number): Subscription {
  if (!r) return { provider: "chatgpt", plan: null, windows: [], status: "unknown", updatedAt: null }
  const named = (r.reached === "primary" || r.reached === "secondary") && r.slots[r.reached] ? r.reached : null
  const windows: SubWindow[] = []
  let limited = r.reached !== null
  for (const k of CODEX_SLOTS) {
    const w = r.slots[k]
    if (!w) continue
    const cur = rolled(w, now)
    if (cur !== w && (named === null || named === k)) limited = false
    windows.push(cur)
  }
  return { provider: "chatgpt", plan: r.plan, windows, status: statusOf(windows, limited), updatedAt: r.updatedAt }
}

function tail(path: string): string {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString("utf8")
  } finally {
    closeSync(fd)
  }
}

function readCodex(home: string): CodexRead | null {
  const db = join(home, ".codex", "state_5.sqlite")
  if (!existsSync(db)) return null
  let paths: string[]
  try {
    const d = new Database(db, { readonly: true })
    try {
      paths = (d.query(`select rollout_path as p from threads where rollout_path != ''
        order by coalesce(updated_at_ms, updated_at * 1000) desc limit ?`).all(ROLLOUTS_MAX) as Array<{ p: string }>).map((r) => r.p)
    } finally { d.close() }
  } catch { return null }
  for (const p of paths) {
    try {
      const read = parseCodexRollout(tail(p))
      if (read) return read
    } catch { /* rotated / unreadable: next */ }
  }
  return null
}

// ---- assembly + cache ----

let cache: { at: number; claudePlan: string | null; chatgpt: CodexRead | null } | null = null

function readClaudePlan(home: string): string | null {
  try {
    return claudePlan((JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>).oauthAccount)
  } catch { return null }
}

export function subscriptions(account: GaugeAccount | null, now = Date.now(), home = homedir()): Subscription[] {
  if (!cache || now - cache.at >= CACHE_MS) {
    cache = { at: now, claudePlan: readClaudePlan(home), chatgpt: readCodex(home) }
  }
  return [
    claudeSubscription(account, cache.claudePlan, now),
    chatgptSubscription(cache.chatgpt, now),
    { provider: "gemini", plan: null, windows: [], status: "unknown", updatedAt: null },
  ]
}

export function resetSubscriptionsCache(): void { cache = null }
