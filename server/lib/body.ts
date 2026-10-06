import type { QueryFn, Row } from "./turso"

// The "Body" read model (living-system nervous system). Collectors on each host
// write three Turso tables; this module only READS them:
//   body_components(id, host, kind, name, schedule_s, criticality, depends_on JSON,
//                   notes, first_seen, last_seen, retired)
//   body_vitals(component_id, observed_at, state, last_exit, last_run_at,
//               last_ok_at, runs_total, runs_delta, consecutive_failures, detail)
//   body_events(id, component_id, at, kind, from_state, to_state, detail)
// Filtering (retired), dependents and the summary are computed here, not in
// SQL, so they are testable against plain fake rows. Contract: docs/body-api.md.

export const BODY_CHANNEL = "body"
export const BODY_CHANNEL_NAME = "Body"
export const BODY_CACHE_TTL_MS = 30_000
export const EVENTS_LIMIT = 50
export const DIGEST_MAX = 800

// "warning" = token-burn spike etc. Shown amber; never a failure (not a
// problem state, no auto-investigation, not counted in `problems`).
export const BODY_STATES = ["ok", "warning", "failing", "dead", "crash_loop", "dormant", "stopped", "unknown"] as const
export type BodyState = (typeof BODY_STATES)[number]
export type BodySummary = Record<BodyState, number> & { total: number }

type Cell = string | number | null

export interface BodyComponent {
  id: string
  host: Cell
  kind: Cell
  name: Cell
  criticality: Cell
  state: BodyState
  last_run_at: Cell
  last_ok_at: Cell
  last_exit: Cell
  consecutive_failures: number
  detail: Cell
  depends_on: string[]
  dependents_count: number
}

export interface BodyEvent {
  id: Cell
  component_id: string
  at: Cell
  kind: Cell
  from_state: Cell
  to_state: Cell
  detail: Cell
}

export interface BodyResponse {
  ok: true
  generated_at: string
  summary: BodySummary
  components: BodyComponent[]
  recent_events: BodyEvent[]
}

// Latest vitals row per component (correlated MAX keeps it one index seek per
// component whether body_vitals is an upsert table or a history).
const COMPONENTS_SQL =
  "SELECT c.id, c.host, c.kind, c.name, c.criticality, c.depends_on, c.retired, " +
  "v.state, v.last_run_at, v.last_ok_at, v.last_exit, v.consecutive_failures, v.detail " +
  "FROM body_components c LEFT JOIN body_vitals v ON v.component_id = c.id " +
  "AND v.observed_at = (SELECT MAX(observed_at) FROM body_vitals WHERE component_id = c.id) " +
  "ORDER BY c.id"
const EVENTS_SQL =
  "SELECT id, component_id, at, kind, from_state, to_state, detail FROM body_events ORDER BY at DESC, id DESC LIMIT ?"
const COMPONENT_SQL =
  "SELECT id, host, kind, name, schedule_s, criticality, depends_on, notes, first_seen, last_seen, retired " +
  "FROM body_components WHERE id = ?"
const DEPENDS_SQL = "SELECT id, depends_on, retired FROM body_components"
const VITALS_SQL =
  "SELECT component_id, observed_at, state, last_exit, last_run_at, last_ok_at, runs_total, runs_delta, " +
  "consecutive_failures, detail FROM body_vitals WHERE component_id = ? ORDER BY observed_at DESC LIMIT 1"
const COMPONENT_EVENTS_SQL =
  "SELECT id, component_id, at, kind, from_state, to_state, detail FROM body_events " +
  "WHERE component_id = ? ORDER BY at DESC, id DESC LIMIT ?"

// ── Row helpers ──────────────────────────────────────────────────────────────

const cell = (v: Row[string] | undefined): Cell => (v === undefined ? null : v)

/**
 * A collector may store its vitals detail as JSON (tokens:burn writes
 * `{"warning":…,"today_total":…,"top_sessions":[…]}`); every client shows
 * `detail` as text. JSON carrying a `warning` and/or `error` string becomes
 * that text; anything else (plain text, JSON without them) passes unchanged.
 */
export function humanDetail(v: Row[string] | undefined): Cell {
  if (typeof v !== "string") return cell(v)
  const t = v.trim()
  if (!t.startsWith("{")) return v
  try {
    const o = JSON.parse(t) as Record<string, unknown>
    const parts = ["warning", "error"].map((k) => o[k]).filter((x): x is string => typeof x === "string" && x.trim() !== "")
    return parts.length ? parts.join("; ") : v
  } catch {
    return v
  }
}

export function toState(v: Row[string] | undefined): BodyState {
  const s = typeof v === "string" ? v.trim().toLowerCase() : ""
  return (BODY_STATES as readonly string[]).includes(s) ? (s as BodyState) : "unknown"
}

export function isRetired(v: Row[string] | undefined): boolean {
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") return v !== "" && v !== "0" && v.toLowerCase() !== "false"
  return false
}

/** depends_on is a JSON array of component ids; anything else reads as []. */
export function parseDependsOn(v: Row[string] | undefined): string[] {
  if (typeof v !== "string" || !v.trim()) return []
  try {
    const parsed: unknown = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0) : []
  } catch {
    return []
  }
}

/** id → ids of live (non-retired) components that list it in depends_on. */
export function dependentsIndex(rows: Row[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const r of rows) {
    if (isRetired(r.retired)) continue
    for (const dep of new Set(parseDependsOn(r.depends_on))) {
      const list = index.get(dep) ?? []
      list.push(String(r.id))
      index.set(dep, list)
    }
  }
  return index
}

function toEvent(r: Row): BodyEvent {
  return {
    id: cell(r.id), component_id: String(r.component_id ?? ""), at: cell(r.at), kind: cell(r.kind),
    from_state: cell(r.from_state), to_state: cell(r.to_state), detail: humanDetail(r.detail),
  }
}

export function emptySummary(): BodySummary {
  return { ok: 0, warning: 0, failing: 0, dead: 0, crash_loop: 0, dormant: 0, stopped: 0, unknown: 0, total: 0 }
}

// ── GET /api/body ────────────────────────────────────────────────────────────

export async function buildBody(query: QueryFn, opts: { all?: boolean; now?: () => number } = {}): Promise<BodyResponse> {
  const now = opts.now ?? Date.now
  const rows = await query(COMPONENTS_SQL, [])
  const events = await query(EVENTS_SQL, [EVENTS_LIMIT])
  const dependents = dependentsIndex(rows)
  const summary = emptySummary()
  const seen = new Set<string>()
  const components: BodyComponent[] = []
  for (const r of rows) {
    const id = String(r.id)
    if (seen.has(id)) continue // two vitals rows sharing the MAX observed_at
    seen.add(id)
    if (!opts.all && isRetired(r.retired)) continue
    const state = toState(r.state)
    summary[state]++
    summary.total++
    components.push({
      id, host: cell(r.host), kind: cell(r.kind), name: cell(r.name), criticality: cell(r.criticality), state,
      last_run_at: cell(r.last_run_at), last_ok_at: cell(r.last_ok_at), last_exit: cell(r.last_exit),
      consecutive_failures: Number(r.consecutive_failures) || 0, detail: humanDetail(r.detail),
      depends_on: parseDependsOn(r.depends_on), dependents_count: dependents.get(id)?.length ?? 0,
    })
  }
  return {
    ok: true, generated_at: new Date(now()).toISOString(), summary, components,
    recent_events: events.slice(0, EVENTS_LIMIT).map(toEvent),
  }
}

// ── GET /api/body/component/:id ──────────────────────────────────────────────

export interface BodyComponentDetail {
  ok: true
  generated_at: string
  component: {
    id: string
    host: Cell
    kind: Cell
    name: Cell
    schedule_s: Cell
    criticality: Cell
    depends_on: string[]
    notes: Cell
    first_seen: Cell
    last_seen: Cell
    retired: boolean
    dependents: string[]
    dependents_count: number
  }
  vitals: {
    component_id: string
    observed_at: Cell
    state: BodyState
    last_exit: Cell
    last_run_at: Cell
    last_ok_at: Cell
    runs_total: Cell
    runs_delta: Cell
    consecutive_failures: number
    detail: Cell
  } | null
  events: BodyEvent[]
}

/** null = no such component. */
export async function buildComponentDetail(query: QueryFn, id: string, now: () => number = Date.now): Promise<BodyComponentDetail | null> {
  const [c] = await query(COMPONENT_SQL, [id])
  if (!c) return null
  const [deps, vitals, events] = [await query(DEPENDS_SQL, []), await query(VITALS_SQL, [id]), await query(COMPONENT_EVENTS_SQL, [id, EVENTS_LIMIT])]
  const dependents = dependentsIndex(deps).get(id) ?? []
  const v = vitals[0]
  return {
    ok: true,
    generated_at: new Date(now()).toISOString(),
    component: {
      id: String(c.id), host: cell(c.host), kind: cell(c.kind), name: cell(c.name), schedule_s: cell(c.schedule_s),
      criticality: cell(c.criticality), depends_on: parseDependsOn(c.depends_on), notes: cell(c.notes),
      first_seen: cell(c.first_seen), last_seen: cell(c.last_seen), retired: isRetired(c.retired),
      dependents, dependents_count: dependents.length,
    },
    vitals: v
      ? {
          component_id: String(v.component_id ?? id), observed_at: cell(v.observed_at), state: toState(v.state),
          last_exit: cell(v.last_exit), last_run_at: cell(v.last_run_at), last_ok_at: cell(v.last_ok_at),
          runs_total: cell(v.runs_total), runs_delta: cell(v.runs_delta),
          consecutive_failures: Number(v.consecutive_failures) || 0, detail: humanDetail(v.detail),
        }
      : null,
    events: events.slice(0, EVENTS_LIMIT).map(toEvent),
  }
}

// ── 30 s snapshot cache (shared by the route and the brain digest) ───────────

export interface BodySnapshot {
  get(opts?: { all?: boolean; fresh?: boolean }): Promise<BodyResponse>
}

export function createBodySnapshot(query: QueryFn, now: () => number = Date.now, ttlMs = BODY_CACHE_TTL_MS): BodySnapshot {
  const slots = new Map<boolean, { at: number; body: BodyResponse; gen: number }>()
  let nextGen = 0
  return {
    async get(opts = {}) {
      const all = !!opts.all
      const hit = slots.get(all)
      if (!opts.fresh && hit && now() - hit.at < ttlMs) return hit.body
      // Numbered at START: a slow older fetch never overwrites a newer one.
      const gen = ++nextGen
      const body = await buildBody(query, { all, now })
      const cur = slots.get(all)
      if (!cur || gen > cur.gen) slots.set(all, { at: now(), body, gen })
      return body
    },
  }
}

// ── Brain digest + health intent (pure) ──────────────────────────────────────

const PROBLEM_STATES: readonly BodyState[] = ["dead", "crash_loop", "failing"]
const CRIT_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, normal: 2, low: 3 }
const critRank = (c: Cell): number => CRIT_RANK[String(c ?? "").toLowerCase()] ?? 2

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…"
}

function problemLine(c: BodyComponent): string {
  const crit = c.criticality ? ` [${c.criticality}]` : ""
  const fails = c.consecutive_failures ? `, ${c.consecutive_failures} fails` : ""
  const ok = c.last_ok_at ? `, last ok ${c.last_ok_at}` : ""
  const detail = c.detail ? ` — ${clip(String(c.detail), 80)}` : ""
  return `- ${c.id}${crit} ${c.state}${fails}${ok}${detail}`
}

/** Compact (≤ 800 chars) health digest for the orchestrator brain's prompt. */
export function buildBodyDigest(body: BodyResponse, max = DIGEST_MAX): string {
  const s = body.summary
  const counts = BODY_STATES.filter((k) => s[k] > 0).map((k) => `${s[k]} ${k}`).join(", ") || "no components"
  const head = `Body monitor (as of ${body.generated_at}): ${s.total} components — ${counts}.`
  const problems = body.components
    .filter((c) => PROBLEM_STATES.includes(c.state))
    .sort((a, b) => critRank(a.criticality) - critRank(b.criticality) || PROBLEM_STATES.indexOf(a.state) - PROBLEM_STATES.indexOf(b.state) || a.id.localeCompare(b.id))
  const lines = [head, problems.length ? "Not ok:" : "Nothing failing, dead or crash-looping."]
  let used = lines.join("\n").length
  let shown = 0
  for (const p of problems) {
    const line = problemLine(p)
    if (used + line.length + 1 > max - 24) break
    lines.push(line)
    used += line.length + 1
    shown++
  }
  if (shown < problems.length) lines.push(`(+${problems.length - shown} more not ok)`)
  const recent = body.recent_events.slice(0, 3).map((e) => `- ${e.at} ${e.component_id} ${e.from_state ?? "?"}→${e.to_state ?? "?"}`)
  for (const line of ["Recent changes:", ...recent]) {
    if (!recent.length || used + line.length + 1 > max) break
    lines.push(line)
    used += line.length + 1
  }
  return clip2(lines.join("\n"), max)
}

// Hard cap that keeps newlines (clip() above flattens whitespace).
function clip2(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

// System/body-scoped phrasing only: a bare "status" ("status of project X",
// "the status on the Pelchat quote") is about work, not the machines.
const SYSTEM = "(system|systems|server|servers|body|machines?|hosts?|infra|infrastructure|fleet|services|zettlab|mac)"
const HEALTH_PATTERNS: RegExp[] = [
  /\b(how'?s|how is|check(ing)?)\s+(the\s+)?body\b/,
  /\bbody\s+(status|report|check|health)\b/,
  /\b(what'?s|what is|whats|anything|is anything|something|is something)\s+(broken|down|failing|dead|crashing|crashed)\b/,
  new RegExp(`\\b${SYSTEM}\\s+(status|health|check|uptime)\\b`),
  new RegExp(`\\b(status|health|state)\\s+(of|on)\\s+(the\\s+|my\\s+|our\\s+)?${SYSTEM}\\b`),
  new RegExp(`\\bis\\s+(the\\s+)?${SYSTEM}\\s+(ok|okay|up|running|fine|healthy|down)\\b`),
  /\bis\s+(everything|it all|all)\s+(ok|okay|up|running|fine|good)\b/,
  /\bhealth\s*check\b/,
  /\b(any|an)\s+outages?\b/,
  /qu'?est[- ]ce qui (est|a)\s+(brisé|brise|cassé|casse|planté|plante|en panne|down)/,
  /est[- ]ce que tout (roule|marche|fonctionne|va bien)/,
  /(état|etat|statut) (du|des) (système|systeme|systèmes|systemes|serveurs?|machines?)/,
  /\b(rien|quelque chose) (de )?(brisé|cassé|en panne)/,
]

export function isHealthIntent(text: string): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'")
  return HEALTH_PATTERNS.some((re) => re.test(t))
}

// ── #Body vitals header (thread payload, orchestrator-one-queue P3) ──────────

export interface BodyVitals {
  /** One display line, e.g. "43 components: 38 ok · 1 failing · 1 dead — 2 tasks blocked". */
  line: string
  summary: BodySummary
  /** Worst state present (dead > crash_loop > failing > warning > unknown > stopped > dormant > ok). */
  worst: BodyState
  /** dead + crash_loop + failing. */
  problems: number
  /** Agent tasks blocked across all projects (Turso dispatch queue). */
  blockedTasks: number
  generatedAt: string
}

const WORST_ORDER: readonly BodyState[] = ["dead", "crash_loop", "failing", "warning", "unknown", "stopped", "dormant", "ok"]

export function vitalsHeader(body: BodyResponse, blockedTasks: number): BodyVitals {
  const s = body.summary
  const parts = [`${s.ok} ok`, ...BODY_STATES.filter((k) => k !== "ok" && s[k] > 0).map((k) => `${s[k]} ${k}`)]
  const tasks = blockedTasks > 0 ? ` — ${blockedTasks} task${blockedTasks === 1 ? "" : "s"} blocked` : ""
  return {
    line: `${s.total} components: ${parts.join(" · ")}${tasks}`,
    summary: s,
    worst: WORST_ORDER.find((k) => s[k] > 0) ?? "ok",
    problems: s.dead + s.crash_loop + s.failing,
    blockedTasks,
    generatedAt: body.generated_at,
  }
}
