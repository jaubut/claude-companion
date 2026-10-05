import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { BODY_CACHE_TTL_MS } from "./body"
import type { QueryFn, Row, SqlArg } from "./turso"

// Fleet token view (GET /api/body/tokens). The token-burn collector (claude-config
// tools/body/, every 5 min per host) upserts daily rollups into Turso; this
// module only READS them:
//   token_usage(host, day, session_id, source, model, input, output, cache_read,
//               cache_creation, turns, PRIMARY KEY(host, day, session_id, source, model))
// `day` is the collector host's local YYYY-MM-DD; `source` is `main`,
// `agent:<type>` or `skill:<name>`. Aggregation runs in SQL (30 days × hosts ×
// sessions is too many rows to ship), so tests use an in-memory sqlite.
// Contract: docs/body-api.md.

export const TOKEN_RANGES = ["today", "7d", "30d"] as const
export type TokenRange = (typeof TOKEN_RANGES)[number]
export const TOP_LIMIT = 10
const RANGE_DAYS: Record<TokenRange, number> = { today: 1, "7d": 7, "30d": 30 }

export interface TokenTotals {
  input: number
  output: number
  cache_read: number
  cache_creation: number
  total: number
}

export interface TokenSession {
  session_id: string
  /** Live session's name from ~/.claude/sessions/*.json on this host, else null. */
  name: string | null
  host: string
  total: number
}

export interface TokenSource {
  /** Agent type / skill name without the `agent:` / `skill:` prefix. */
  name: string
  total: number
}

export interface TokensResponse {
  ok: true
  generated_at: string
  range: TokenRange
  /** First day included (local YYYY-MM-DD, inclusive). */
  since: string
  totals: TokenTotals
  by_host: (TokenTotals & { host: string })[]
  by_day: (TokenTotals & { day: string })[]
  top_sessions: TokenSession[]
  top_agents: TokenSource[]
  top_skills: TokenSource[]
}

export function parseRange(v: string | null): TokenRange | null {
  if (v === null || v === "") return "today"
  return (TOKEN_RANGES as readonly string[]).includes(v) ? (v as TokenRange) : null
}

/** Local calendar day `back` days before `now`, as YYYY-MM-DD. */
export function localDay(now: number, back = 0): string {
  const d = new Date(now)
  d.setDate(d.getDate() - back)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function rangeSince(range: TokenRange, now: number): string {
  return localDay(now, RANGE_DAYS[range] - 1)
}

// ── SQL (parameterized; `day >= ?` uses the PK's day column) ─────────────────

const SUMS =
  "COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, " +
  "COALESCE(SUM(cache_read),0) AS cache_read, COALESCE(SUM(cache_creation),0) AS cache_creation"
const TOTAL = "COALESCE(SUM(input),0) + COALESCE(SUM(output),0) + COALESCE(SUM(cache_read),0) + COALESCE(SUM(cache_creation),0)"
const TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_usage'"
const TOTALS_SQL = `SELECT ${SUMS} FROM token_usage WHERE day >= ?`
const BY_HOST_SQL = `SELECT host, ${SUMS}, ${TOTAL} AS total FROM token_usage WHERE day >= ? GROUP BY host ORDER BY total DESC, host`
const BY_DAY_SQL = `SELECT day, ${SUMS} FROM token_usage WHERE day >= ? GROUP BY day ORDER BY day`
const TOP_SESSIONS_SQL =
  `SELECT session_id, MAX(host) AS host, ${TOTAL} AS total FROM token_usage WHERE day >= ? ` +
  "GROUP BY session_id ORDER BY total DESC, session_id LIMIT ?"
const TOP_SOURCE_SQL =
  `SELECT substr(source, ?) AS name, ${TOTAL} AS total FROM token_usage WHERE day >= ? AND source LIKE ? ` +
  "GROUP BY source ORDER BY total DESC, source LIMIT ?"

// ── Row helpers ──────────────────────────────────────────────────────────────

const num = (v: Row[string] | undefined): number => Number(v) || 0

function totalsOf(r: Row | undefined): TokenTotals {
  const t = { input: num(r?.input), output: num(r?.output), cache_read: num(r?.cache_read), cache_creation: num(r?.cache_creation) }
  return { ...t, total: t.input + t.output + t.cache_read + t.cache_creation }
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 }
}

/** sessionId → name for live sessions on this host (Claude Code ≥ 2.1 session files). */
export async function liveSessionNames(dir = join(homedir(), ".claude", "sessions")): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"))
  } catch {
    return names
  }
  await Promise.all(files.map(async (f) => {
    try {
      const j = JSON.parse(await readFile(join(dir, f), "utf-8")) as { sessionId?: unknown; name?: unknown }
      if (typeof j.sessionId === "string" && typeof j.name === "string" && j.name.trim()) names.set(j.sessionId, j.name.trim())
    } catch { /* half-written or foreign file */ }
  }))
  return names
}

// ── Build ────────────────────────────────────────────────────────────────────

export interface BuildTokensOpts {
  now?: () => number
  sessionNames?: () => Promise<Map<string, string>>
}

export async function buildTokens(query: QueryFn, range: TokenRange, opts: BuildTokensOpts = {}): Promise<TokensResponse> {
  const now = (opts.now ?? Date.now)()
  const since = rangeSince(range, now)
  const base = { ok: true as const, generated_at: new Date(now).toISOString(), range, since }
  // Collector not deployed yet → an empty view, not a 503.
  if ((await query(TABLE_SQL, [])).length === 0) {
    return { ...base, totals: emptyTotals(), by_host: [], by_day: [], top_sessions: [], top_agents: [], top_skills: [] }
  }
  const source = (prefix: string): [string, SqlArg[]] => [TOP_SOURCE_SQL, [prefix.length + 1, since, `${prefix}%`, TOP_LIMIT]]
  const [totals, byHost, byDay, sessions, agents, skills, names] = await Promise.all([
    query(TOTALS_SQL, [since]),
    query(BY_HOST_SQL, [since]),
    query(BY_DAY_SQL, [since]),
    query(TOP_SESSIONS_SQL, [since, TOP_LIMIT]),
    query(...source("agent:")),
    query(...source("skill:")),
    (opts.sessionNames ?? liveSessionNames)().catch(() => new Map<string, string>()),
  ])
  const toSource = (r: Row): TokenSource => ({ name: String(r.name ?? ""), total: num(r.total) })
  return {
    ...base,
    totals: totalsOf(totals[0]),
    by_host: byHost.map((r) => ({ host: String(r.host ?? ""), ...totalsOf(r) })),
    by_day: byDay.map((r) => ({ day: String(r.day ?? ""), ...totalsOf(r) })),
    top_sessions: sessions.map((r) => {
      const id = String(r.session_id ?? "")
      return { session_id: id, name: names.get(id) ?? null, host: String(r.host ?? ""), total: num(r.total) }
    }),
    top_agents: agents.map(toSource),
    top_skills: skills.map(toSource),
  }
}

// ── 30 s cache per range (same policy as the /api/body snapshot) ─────────────

export interface TokensSnapshot {
  get(range: TokenRange, opts?: { fresh?: boolean }): Promise<TokensResponse>
}

export function createTokensSnapshot(query: QueryFn, opts: BuildTokensOpts & { ttlMs?: number } = {}): TokensSnapshot {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? BODY_CACHE_TTL_MS
  const slots = new Map<TokenRange, { at: number; body: TokensResponse; gen: number }>()
  let nextGen = 0
  return {
    async get(range, { fresh = false } = {}) {
      const hit = slots.get(range)
      if (!fresh && hit && now() - hit.at < ttlMs) return hit.body
      // Numbered at START: a slow older fetch never overwrites a newer one.
      const gen = ++nextGen
      const body = await buildTokens(query, range, { now, sessionNames: opts.sessionNames })
      const cur = slots.get(range)
      if (!cur || gen > cur.gen) slots.set(range, { at: now(), body, gen })
      return body
    },
  }
}
