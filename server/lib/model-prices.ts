// Claude API list prices, USD per million tokens — what token usage would cost
// at first-party API rates (the account is on a subscription; this is the
// API-equivalent value, not what is billed). Source: the claude-api skill's
// Pricing reference, https://platform.claude.com/docs/en/about-claude/pricing,
// read on PRICING_AS_OF. Standard rates only: no batch discount, fast mode or
// inference_geo multiplier. Cache creation is priced at the 5-minute write
// rate (token_usage does not split 5m / 1h writes). 4.6+ models bill the full
// 1M window at these rates.
//
// Keyed by model id. A stored model matches an id when it equals it or adds a
// date snapshot (`-20251001…`), a variant (`[1m]`) or a version (`@…`) — so
// `claude-opus-4` never swallows `claude-opus-4-5`, and an unknown
// `claude-opus-4-9` stays unpriced. Unpriced tokens are counted, never $0.

export const PRICING_AS_OF = "2026-10-06"

export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
}

const p = (input: number, cacheWrite5m: number, cacheRead: number, output: number): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite5m })

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": p(10, 12.5, 0.25, 50),
  "claude-mythos-5-1": p(10, 12.5, 0.25, 50),
  "claude-fable-5": p(10, 12.5, 1, 50),
  "claude-mythos-5": p(10, 12.5, 1, 50),
  "claude-opus-5-5": p(4, 5, 0.2, 20),
  "claude-opus-5": p(5, 6.25, 0.5, 25),
  "claude-opus-4-8": p(5, 6.25, 0.5, 25),
  "claude-opus-4-7": p(5, 6.25, 0.5, 25),
  "claude-opus-4-6": p(5, 6.25, 0.5, 25),
  "claude-opus-4-5": p(5, 6.25, 0.5, 25),
  "claude-opus-4-1": p(15, 18.75, 1.5, 75),
  "claude-opus-4": p(15, 18.75, 1.5, 75),
  "claude-sonnet-5-5": p(2, 2.5, 0.2, 10),
  "claude-sonnet-5": p(2, 2.5, 0.2, 10),
  "claude-sonnet-4-6": p(3, 3.75, 0.3, 15),
  "claude-sonnet-4-5": p(3, 3.75, 0.3, 15),
  "claude-sonnet-4": p(3, 3.75, 0.3, 15),
  "claude-haiku-4-5": p(1, 1.25, 0.1, 5),
  "claude-3-5-haiku": p(0.8, 1, 0.08, 4),
}

const IDS = Object.keys(MODEL_PRICES)
const SUFFIX = /^(-\d{8}|\[|@)/

export function priceFor(model: string): ModelPrice | null {
  for (const id of IDS) {
    if (model === id || (model.startsWith(id) && SUFFIX.test(model.slice(id.length)))) return MODEL_PRICES[id]!
  }
  return null
}

export interface TokenCounts {
  input: number
  output: number
  cache_read: number
  cache_creation: number
}

/** USD for one model's counts, or null when the model is unpriced. */
export function usdFor(model: string, t: TokenCounts): number | null {
  const pr = priceFor(model)
  if (!pr) return null
  return (t.input * pr.input + t.output * pr.output + t.cache_read * pr.cacheRead + t.cache_creation * pr.cacheWrite5m) / 1_000_000
}

// ── SQL ──────────────────────────────────────────────────────────────────────
// The same match as priceFor, as a CASE over the `model` column, so the
// aggregation stays in SQL (and keeps its ORDER BY … LIMIT). GLOB is
// case-sensitive like priceFor. Ids are fixed literals from the table above.

function matchSql(id: string): string {
  return `(model = '${id}' OR model GLOB '${id}-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*' OR model GLOB '${id}[[]*' OR model GLOB '${id}@*')`
}

/** Per-row USD expression; NULL for an unpriced model (SUM skips it). */
export function usdRowSql(): string {
  const whens = IDS.map((id) => {
    const pr = MODEL_PRICES[id]!
    return `WHEN ${matchSql(id)} THEN (input * ${pr.input} + output * ${pr.output} + cache_read * ${pr.cacheRead} + cache_creation * ${pr.cacheWrite5m}) / 1000000.0`
  })
  return `CASE ${whens.join(" ")} ELSE NULL END`
}

/** Per-row tokens of an unpriced model, 0 for a priced one. */
export function unpricedRowSql(): string {
  return `CASE WHEN ${IDS.map(matchSql).join(" OR ")} THEN 0 ELSE input + output + cache_read + cache_creation END`
}
