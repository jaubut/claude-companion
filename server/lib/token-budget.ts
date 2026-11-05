import { TOP_LIMIT, localDay, rangeSince } from "./body-tokens"
import type { GaugeAccount } from "./gauge"
import { unpricedRowSql, usdRowSql } from "./model-prices"
import type { QueryFn, Row } from "./turso"

// Weekly budget view (GET /api/body/budget): where the Claude weekly limit goes.
// Reads the same collector tables as body-tokens.ts. Percent used is Claude
// Code's own `seven_day` rate limit (gauge mod); there is no other real source,
// so without a report it stays null and only the configured USD budget applies.
// Contract: docs/body-api.md.

export const WEIGHTING =
  "Weighted = API list price per model: input and output at full rate, cache writes at about 1.25x input, " +
  "cache reads at about 0.05-0.1x input. Anthropic does not publish how the weekly limit weighs tokens, " +
  "so this ranks spenders; it is not the limit's own formula."
export const ALERT_THRESHOLDS = [50, 75, 90] as const
export const STALE_HOST_MS = 60 * 60_000
const WEEK_MS = 7 * 24 * 60 * 60_000
const RELAY_OWNER = "companion:relay:"

export type SessionRole = "brain" | "manager" | "dispatch" | "shepherd" | "scheduled" | "interactive" | "unknown"

export interface Spend {
  sessions: number
  input: number
  output: number
  cache_read: number
  cache_creation: number
  usd: number
  unpriced_tokens: number
}

export interface BudgetFigure {
  /** Claude Code's seven_day percent, null when no session reported one. */
  percent_used: number | null
  source: "claude_code_rate_limit" | null
  resets_at: string | null
  reported_at: string | null
  /** COMPANION_WEEKLY_BUDGET_USD, null when unset. */
  weekly_budget_usd: number | null
  percent_of_budget: number | null
}

export interface BudgetResponse extends Spend {
  ok: true
  generated_at: string
  since: string
  weighting: string
  budget: BudgetFigure
  by_role: (Spend & { role: SessionRole })[]
  by_repo: (Spend & { repo: string | null })[]
  by_task: (Spend & { task_id: string; title: string })[]
  by_model: (Spend & { model: string })[]
  top_sessions: (Spend & { session_id: string; host: string; name: string | null; role: SessionRole; repo: string | null; task_id: string | null })[]
  /** Shepherd sessions: PR babysitting, CI repair and review follow-ups. */
  rework: Spend & { share: number }
  /** Hosts with no collector write for over an hour: their recent spend is missing. */
  stale_hosts: { host: string; last_seen: string }[]
}

// Longest first. Worktrees are `<repo>-<branch>`, so a repo is only a prefix.
const REPOS = ["claude-companion-ios", "claude-companion", "tls-dashboard-v2", "tls-review"]

function repoOf(dir: string): string {
  const base = dir.replace(/\/+$/, "").split("/").pop()!.replace(/^-+/, "").replace(/\s+/g, "-")
  if (base === ".claude") return "claude-config"
  if (base === ".claude-companion") return "claude-companion"
  const repo = REPOS.find((r) => base === r || base.startsWith(`${r}-`))
  if (repo) return repo
  return dir.includes("/apps/wt/") && base.startsWith("claude-") ? "claude-config" : base
}

/** cwd → who spent it. Dispatch builders and their reviewers share one worktree shape, so they stay one role. */
export function classifySession(cwd: string | null, name: string | null): { role: SessionRole; repo: string | null } {
  if (!cwd) return { role: "unknown", repo: null }
  if (/\/dispatch-[^/]+\/wt/.test(cwd)) return { role: "dispatch", repo: null }
  if (/\/pr-shepherd-[^/]+/.test(cwd)) return { role: "shepherd", repo: null }
  if (/\/\.claude-companion\/investigate/.test(cwd) || /^(\/private)?\/tmp\/?$/.test(cwd) || /^\/private\/var\/folders\/[^/]+\/[^/]+\/T\/?$/.test(cwd)) {
    return { role: "scheduled", repo: null }
  }
  if (/\/brain\/?$/.test(cwd)) return { role: "brain", repo: "claude-companion" }
  if (/^manager-/.test(name ?? "")) return { role: "manager", repo: repoOf(cwd) }
  if (/^\/(home|Users)\/[^/]+\/?$/.test(cwd)) return { role: "interactive", repo: null }
  return { role: "interactive", repo: repoOf(cwd) }
}

const sessionCol = (col: "name" | "cwd"): string =>
  `(SELECT ${col} FROM token_sessions s WHERE s.host = t.host AND s.session_id = t.session_id ` +
  `AND TRIM(COALESCE(s.${col}, '')) <> '' ORDER BY s.last_seen DESC LIMIT 1) AS ${col}`
const SUMS =
  "COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cache_read),0) AS cache_read, " +
  `COALESCE(SUM(cache_creation),0) AS cache_creation, COALESCE(SUM(${usdRowSql()}),0) AS usd, COALESCE(SUM(${unpricedRowSql()}),0) AS unpriced_tokens`
const SESSIONS_SQL = `SELECT host, session_id, ${SUMS} FROM token_usage WHERE day >= ? GROUP BY host, session_id`
const JOINED_SQL = `SELECT t.*, ${sessionCol("name")}, ${sessionCol("cwd")} FROM (${SESSIONS_SQL}) t`
const MODELS_SQL = `SELECT model, COUNT(DISTINCT host || session_id) AS sessions, ${SUMS} FROM token_usage WHERE day >= ? GROUP BY model`
const TASKS_SQL = `SELECT id, text, dispatch_owner FROM tasks WHERE dispatch_owner LIKE '${RELAY_OWNER}%' AND dispatch_started_at >= ?`
const HOSTS_SQL = "SELECT host, MAX(last_seen) AS last_seen FROM token_sessions GROUP BY host"
const TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('token_usage', 'token_sessions', 'tasks')"

const zero = (): Spend => ({ sessions: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, usd: 0, unpriced_tokens: 0 })

function spendOf(r: Row): Spend {
  const n = (k: string): number => Number(r[k]) || 0
  return { sessions: n("sessions") || 1, input: n("input"), output: n("output"), cache_read: n("cache_read"), cache_creation: n("cache_creation"), usd: n("usd"), unpriced_tokens: n("unpriced_tokens") }
}

function add(into: Spend, s: Spend): void {
  into.sessions += s.sessions
  into.input += s.input
  into.output += s.output
  into.cache_read += s.cache_read
  into.cache_creation += s.cache_creation
  into.usd += s.usd
  into.unpriced_tokens += s.unpriced_tokens
}

const money = <T extends Spend>(s: T): T => ({ ...s, usd: Math.round(s.usd * 100) / 100 })
const byUsd = (a: Spend, b: Spend): number => b.usd - a.usd

function grouped<K>(rows: { key: K; spend: Spend }[]): { key: K; spend: Spend }[] {
  const out = new Map<K, Spend>()
  for (const { key, spend } of rows) {
    const cur = out.get(key) ?? zero()
    add(cur, spend)
    out.set(key, cur)
  }
  return [...out].map(([key, spend]) => ({ key, spend })).sort((a, b) => byUsd(a.spend, b.spend))
}

/** The session a relay builder ran as: its exact name, or its worktree plus the `-<hex>` name suffix. */
function ownerKeys(name: string | null, cwd: string | null): string[] {
  const base = cwd?.replace(/\/+$/, "").split("/").pop()
  return [name, name?.replace(/-[0-9a-f]+$/, ""), base].filter((k): k is string => !!k)
}

export function budgetFigure(account: GaugeAccount | null, weeklyBudgetUsd: number | null, usd: number): BudgetFigure {
  const seven = account?.limits.find((l) => l.kind === "seven_day")
  const percent = seven?.percentUsed ?? account?.sevenDayPercent ?? null
  return {
    percent_used: percent,
    source: percent === null ? null : "claude_code_rate_limit",
    resets_at: seven?.resetsAt ?? null,
    reported_at: percent === null || !account ? null : new Date(account.at).toISOString(),
    weekly_budget_usd: weeklyBudgetUsd,
    percent_of_budget: weeklyBudgetUsd ? Math.round((usd / weeklyBudgetUsd) * 1000) / 10 : null,
  }
}

export interface BuildBudgetOpts {
  now?: () => number
  account?: () => GaugeAccount | null
  weeklyBudgetUsd?: number | null
}

/** The limit's own week when Claude Code reported its reset, else the rolling 7 days. */
function weekStart(account: GaugeAccount | null, now: number): string {
  const resets = Date.parse(account?.limits.find((l) => l.kind === "seven_day")?.resetsAt ?? "")
  return Number.isFinite(resets) ? localDay(Math.min(resets - WEEK_MS, now)) : rangeSince("7d", now)
}

export async function buildBudget(query: QueryFn, opts: BuildBudgetOpts = {}): Promise<BudgetResponse> {
  const now = (opts.now ?? Date.now)()
  const account = opts.account?.() ?? null
  const since = weekStart(account, now)
  const tables = new Set((await query(TABLE_SQL, [])).map((r) => String(r.name)))
  const hasSessions = tables.has("token_sessions")
  const [rows, models, tasks, hosts] = tables.has("token_usage")
    ? await Promise.all([
        query(hasSessions ? JOINED_SQL : SESSIONS_SQL, [since]),
        query(MODELS_SQL, [since]),
        tables.has("tasks") ? query(TASKS_SQL, [since]) : Promise.resolve<Row[]>([]),
        hasSessions ? query(HOSTS_SQL, []) : Promise.resolve<Row[]>([]),
      ])
    : [[], [], [], []]

  const taskOf = new Map<string, { id: string; title: string }>()
  for (const t of tasks) {
    taskOf.set(String(t.dispatch_owner).slice(RELAY_OWNER.length), { id: String(t.id), title: String(t.text ?? "") })
  }
  const sessions = rows.map((r) => {
    const name = typeof r.name === "string" ? r.name : null
    const cwd = typeof r.cwd === "string" ? r.cwd : null
    const task = ownerKeys(name, cwd).map((k) => taskOf.get(k)).find(Boolean) ?? null
    return { session_id: String(r.session_id), host: String(r.host), name, ...classifySession(cwd, name), task_id: task?.id ?? null, title: task?.title ?? null, spend: spendOf(r) }
  })

  const total = zero()
  for (const s of sessions) add(total, s.spend)
  const rework = grouped(sessions.filter((s) => s.role === "shepherd").map((s) => ({ key: "", spend: s.spend })))[0]?.spend ?? zero()
  const titles = new Map(sessions.map((s) => [s.task_id, s.title]))
  return {
    ok: true,
    generated_at: new Date(now).toISOString(),
    since,
    weighting: WEIGHTING,
    ...money(total),
    budget: budgetFigure(account, opts.weeklyBudgetUsd ?? null, total.usd),
    by_role: grouped(sessions.map((s) => ({ key: s.role, spend: s.spend }))).map((g) => ({ role: g.key, ...money(g.spend) })),
    by_repo: grouped(sessions.map((s) => ({ key: s.repo, spend: s.spend }))).map((g) => ({ repo: g.key, ...money(g.spend) })),
    by_task: grouped(sessions.flatMap((s) => (s.task_id ? [{ key: s.task_id, spend: s.spend }] : [])))
      .map((g) => ({ task_id: g.key, title: titles.get(g.key) ?? "", ...money(g.spend) })),
    by_model: models.map((r) => ({ model: String(r.model), ...money(spendOf(r)) })).sort(byUsd),
    top_sessions: [...sessions].sort((a, b) => byUsd(a.spend, b.spend)).slice(0, TOP_LIMIT)
      .map(({ spend, title: _title, ...s }) => ({ ...s, ...money(spend) })),
    rework: { ...money(rework), share: total.usd ? Math.round((rework.usd / total.usd) * 1000) / 1000 : 0 },
    stale_hosts: hosts.map((h) => ({ host: String(h.host), last_seen: String(h.last_seen) }))
      .filter((h) => now - Date.parse(h.last_seen) > STALE_HOST_MS),
  }
}

// ── Brain thread: one line a day, one alert per threshold per week ───────────

const percentOf = (b: BudgetFigure): number | null => b.percent_used ?? b.percent_of_budget

export function dailyLine(r: BudgetResponse): string {
  const pct = r.budget.percent_used !== null
    ? `${Math.round(r.budget.percent_used)}% of the weekly limit used`
    : r.budget.percent_of_budget !== null
      ? `${Math.round(r.budget.percent_of_budget)}% of the configured weekly budget`
      : "weekly limit unknown (no Claude Code report yet)"
  const top = r.by_repo.filter((g) => g.repo).slice(0, 3).map((g) => `${g.repo} $${Math.round(g.usd)}`).join(", ")
  const stale = r.stale_hosts.length ? ` Missing data from ${r.stale_hosts.map((h) => h.host).join(", ")}.` : ""
  return `Tokens: ${pct}. $${Math.round(r.usd)} API value since ${r.since}. Top: ${top || "none"}; shepherd rework ${Math.round(r.rework.share * 100)}%.${stale}`
}

export interface BudgetAlertState {
  day: string
  week: string
  fired: number[]
}

/** What to post now, and the state to keep. A jump past several thresholds fires only the highest. */
export function budgetTick(r: BudgetResponse, state: BudgetAlertState, now: number): { posts: string[]; state: BudgetAlertState } {
  const day = localDay(now)
  const week = r.budget.resets_at ?? r.since
  const fired = week === state.week ? state.fired : []
  const pct = percentOf(r.budget)
  const crossed = pct === null ? [] : ALERT_THRESHOLDS.filter((t) => pct >= t && !fired.includes(t))
  const posts: string[] = []
  if (crossed.length) posts.push(`Token budget alert: ${Math.round(pct!)}% used, past ${crossed.at(-1)}%. ${dailyLine(r)}`)
  else if (day !== state.day) posts.push(dailyLine(r))
  return { posts, state: { day, week, fired: [...fired, ...crossed] } }
}
