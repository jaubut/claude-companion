import { BASE_CHART, groceryByName, isPersonalPurpose } from "./receipt-checks"
import type { ExpenseFields, QaIssue, QaStatus } from "./receipt-qa-store"
import { readSecretValue } from "./secret-store"

// Jev (TypeSafe System One) half of the first QA pass: typed decisions only —
// a GL `choice` over the expense chart and three nouls (grocery, meal, trip
// context). Combined with the code checks in `decideJev`, which is pure.
// Key: TYPESAFE_API_KEY in the vault store. Endpoint override COMPANION_JEV_URL
// (tests point it at a fake). Any failure → null → `jev_unavailable`.

export const JEV_AGREE_MIN = 0.9
const NOUL_YES = 0.5
const JEV_TIMEOUT_MS = 10_000
const CHART_TTL_MS = 60 * 60_000
export const PERSONAL_OPTION = "personal"

export interface ChartEntry { code: string; name: string }
export type ChartQuery = (sql: string, args: Array<string | number | null>) => Promise<Array<Record<string, string | number | null>>>

export interface JevVerdict {
  code: string
  confidence: number
  grocery: number
  meal: number
  trip: number
}

function jevUrl(): string {
  return (process.env.COMPANION_JEV_URL || "https://api.typesafe.ai/v1/systemone").trim()
}

// ── Chart: Turso `coa` 5xxx expense rows (names win) ∪ the in-use base chart ──

let chartCache: { at: number; chart: ChartEntry[] } | null = null

export function resetChartCache(): void { chartCache = null }

function expenseCode(code: string): boolean {
  return /^5\d{3}$/.test(code) && !code.startsWith("54") && !code.startsWith("51")
}

export async function loadChart(query: ChartQuery, now = Date.now()): Promise<ChartEntry[]> {
  if (chartCache && now - chartCache.at < CHART_TTL_MS) return chartCache.chart
  const byCode = new Map(BASE_CHART.map((e) => [e.code, e.name]))
  try {
    const rows = await query("SELECT code, name FROM coa", [])
    for (const r of rows) {
      const code = String(r.code ?? "").match(/^\s*(\d+)/)?.[1] ?? ""
      if (expenseCode(code) && r.name) byCode.set(code, String(r.name))
    }
  } catch { /* coa unreachable: the base chart still answers */ }
  const chart = [...byCode].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code))
  chartCache = { at: now, chart }
  return chart
}

const HINTS: Record<string, string> = {
  "5216": "travel: hotels, transport, parking, and restaurant meals eaten MORE than 50 km from the office during a trip/shoot",
  "5776": "client entertainment: restaurant meals within 50 km of the office with a client (50% deductible)",
  "5783": "software, SaaS, cloud hosting, computer hardware",
  "5700": "office supplies, small tools, stationery",
}

export function jevQuestions(chart: ChartEntry[]): Record<string, unknown> {
  const criteria: Record<string, string> = {}
  for (const e of chart) criteria[e.code] = HINTS[e.code] ? `${e.name} — ${HINTS[e.code]}` : e.name
  criteria[PERSONAL_OPTION] = "Personal purchase, not a business expense (groceries, household)"
  return {
    gl_code: { type: "choice", instructions: "Which general-ledger expense account should this receipt be booked to?", criteria },
    is_grocery: {
      type: "noul",
      instructions: "Is this a purchase at a grocery store or supermarket (food or household goods for home)?",
      criteria: { true: "Supermarket / grocery store / food for home", false: "Restaurant, café, hardware, software, gear, travel or any other store" },
    },
    is_meal: {
      type: "noul",
      instructions: "Is this a restaurant, café, bar or fast-food meal?",
      criteria: { true: "Prepared food or drinks bought to eat (restaurant, café, bar, fast food)", false: "Anything else, including groceries" },
    },
    trip_context: {
      type: "noul",
      instructions: "Does the `purpose` field state the business trip/shoot location or the client/meeting this expense was for?",
      criteria: { true: "purpose names a trip, a shoot location, a client or a meeting", false: "purpose is empty, generic (e.g. 'meal', 'lunch', 'business expense') or names no trip or client" },
    },
  }
}

export function jevState(f: ExpenseFields): Record<string, string> {
  const pick = ["merchant", "address", "date", "total", "category", "purpose", "payment", "items"]
  return Object.fromEntries(pick.map((k) => [k, String(f[k] ?? "").slice(0, 600)]))
}

interface RawAnswer { type?: string; noul?: number; choice?: string; confidence?: number }

/** One System One call. null on no key / HTTP error / malformed answer. */
export async function askJev(f: ExpenseFields, chart: ChartEntry[]): Promise<JevVerdict | null> {
  const key = readSecretValue("TYPESAFE_API_KEY")
  if (!key) return null
  try {
    const res = await fetch(jevUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: jevState(f), model: "jev-latest", questions: jevQuestions(chart) }),
      redirect: "manual",
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    })
    if (!res.ok) { void res.body?.cancel(); return null }
    const body = await res.json() as { answers?: Record<string, RawAnswer> }
    const a = body?.answers
    const gl = a?.gl_code
    const nouls = [a?.is_grocery?.noul, a?.is_meal?.noul, a?.trip_context?.noul]
    if (typeof gl?.choice !== "string" || typeof gl.confidence !== "number" || nouls.some((n) => typeof n !== "number")) return null
    return { code: gl.choice, confidence: gl.confidence, grocery: nouls[0]!, meal: nouls[1]!, trip: nouls[2]! }
  } catch {
    return null
  }
}

// ── Decision (pure) ──

export interface JevDecision { status: Extract<QaStatus, "jev_ok" | "to_review">; issues: QaIssue[] }

const fmt = (p: number): string => p.toFixed(2)

/**
 * All code checks pass AND Jev agrees with the saved code at ≥ 0.9 AND no
 * books-rule flag → jev_ok. Anything else → to_review with every issue found.
 */
export function decideJev(f: ExpenseFields, checkIssues: QaIssue[], jev: JevVerdict | null): JevDecision {
  const issues = [...checkIssues]
  if (!jev) {
    issues.push({ field: "jev", problem: "jev_unavailable" })
    return { status: "to_review", issues }
  }
  // A personal purchase carries no GL code: Jev picking `personal` agrees with it.
  const saved = String(f.category_code ?? "").trim() || (isPersonalPurpose(f) ? PERSONAL_OPTION : "")
  const grocery = groceryByName(f) || jev.grocery >= NOUL_YES
  if (grocery && !isPersonalPurpose(f)) {
    issues.push({ field: "purpose", problem: "grocery purchase booked as business (groceries are always personal)", suggestion: "Personal — not a business expense" })
  }
  if (!grocery && jev.meal >= NOUL_YES && jev.trip < NOUL_YES) {
    issues.push({ field: "purpose", problem: "meal without trip or client context (50 km rule: >50 km → 5216, ≤50 km → 5776)" })
  }
  const suggestion = jev.code !== PERSONAL_OPTION ? jev.code : undefined
  if (!saved) {
    issues.push({ field: "category_code", problem: `GL code missing; Jev suggests ${jev.code} (conf ${fmt(jev.confidence)})`, ...(suggestion ? { suggestion } : {}) })
  } else if (jev.code !== saved) {
    issues.push({ field: "category_code", problem: `Jev picks ${jev.code} (conf ${fmt(jev.confidence)}) over saved ${saved}`, ...(suggestion ? { suggestion } : {}) })
  } else if (jev.confidence < JEV_AGREE_MIN) {
    issues.push({ field: "category_code", problem: `Jev agrees with ${saved} but only at conf ${fmt(jev.confidence)}` })
  }
  return { status: issues.length ? "to_review" : "jev_ok", issues }
}
