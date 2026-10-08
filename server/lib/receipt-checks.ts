import type { ExpenseFields, QaIssue } from "./receipt-qa-store"

// Deterministic receipt checks (the code half of the Jev pass) + the books
// rules and the expense chart the model passes are given. Pure: no I/O except
// through the injected `DupQuery`. Arithmetic, dates and tax rates live here,
// never in a model question (jev-1.13 jaggedness sheet: arithmetic → code).

export const TPS_RATE = 0.05
export const TVQ_RATE = 0.09975
const SUM_TOLERANCE = 0.02
const TAX_TOLERANCE = 0.03
export const MAX_AGE_DAYS = 120
const MAX_SANE_TOTAL = 10_000
const CURRENCIES = new Set(["", "CAD", "USD", "EUR"])

// Always-personal grocers (memory feedback_groceries_personal, same list as
// tls-dashboard-v2 scripts/receipt-sweep.ts ALWAYS_PERSONAL). Jev's noul
// catches the rest.
export const ALWAYS_PERSONAL = /\b(flashfood|maxi|iga|provigo|metro plus|super ?c|loblaws)\b/i

/** Expense accounts actually in use (tls-dashboard-v2 chart-of-accounts.ts favourites). `coa` names override. */
export const BASE_CHART: ReadonlyArray<{ code: string; name: string }> = [
  { code: "5783", name: "Frais informatique" },
  { code: "5215", name: "Telephone / Mobility Expenses" },
  { code: "5221", name: "Frais Internet" },
  { code: "5200", name: "Indirect Expenses" },
  { code: "5615", name: "Publicité & promotions" },
  { code: "5612", name: "Honoraires Professionnels" },
  { code: "5700", name: "Fourniture de Bureau" },
  { code: "5776", name: "Frais de représentation" },
  { code: "5216", name: "Travel Expenses" },
  { code: "5685", name: "Assurance" },
  { code: "5690", name: "Intérêt & frais bancaires" },
  { code: "5209", name: "Office Rent" },
  { code: "5217", name: "Utility Expenses" },
  { code: "5208", name: "Office Maintenance Expenses" },
  { code: "5774", name: "Frais de Formation" },
  { code: "5777", name: "Pourboires" },
  { code: "5225", name: "Miscellaneous Expenses" },
  { code: "5695", name: "Pénalité et frais payé au gouvernement" },
]

export const BOOKS_RULES = [
  "TLS books rules (Tech Lab Studio, Québec):",
  "- Groceries are ALWAYS personal (Flashfood, Maxi, IGA, Provigo, Metro Plus, Super C, Loblaws and any supermarket): purpose \"Personal — not a business expense\", reimbursable \"no\", category \"Other\". Never a business GL code.",
  "- Meals: a meal eaten MORE than 50 km from the TLS office (Granby) is a travel expense → 5216 Travel Expenses. Within 50 km it is client entertainment → 5776 Frais de représentation (50% deductible). A meal needs the trip or the client in `purpose`; if the receipt does not show where/why, it cannot be resolved without a human.",
  "- Taxes: TPS/GST 5% and TVQ/QST 9.975% of the pre-tax subtotal. `subtotal` in the books is the amount BEFORE taxes and tip; subtotal + tps + tvq + tip = total.",
  "- Credit cards 2400/2401/2110/2160 and tax accounts 1200/1210/2310/2320 are never an expense category_code. Only 5xxx expense codes from the chart.",
  "- Two same-price purchases on the same day can be legitimate; a suspected duplicate is never deleted automatically.",
  "- Mileage is billed through trip_entries (tiered per-km rate), never from a fuel receipt.",
  "- A void cheque (spécimen de chèque) is never needed — ignore any mention.",
].join("\n")

/** "$1 234,56", "24,35 $", "$24.35", "-3.00" → number. null if not money. */
export function parseMoney(raw: unknown): number | null {
  let s = String(raw ?? "").replace(/[^\d,.\-]/g, "")
  if (!s || !/\d/.test(s)) return null
  const lastComma = s.lastIndexOf(",")
  const lastDot = s.lastIndexOf(".")
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "")
  } else if (lastComma >= 0) {
    s = /,\d{1,2}$/.test(s) ? s.replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "") : s.replace(/,/g, "")
  }
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

const money = (n: number): string => n.toFixed(2)
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol + 1e-9

export interface Amounts { total: number | null; subtotal: number | null; tps: number; tvq: number; tip: number }

export function amountsOf(f: ExpenseFields): Amounts {
  return {
    total: parseMoney(f.total),
    subtotal: parseMoney(f.subtotal),
    tps: parseMoney(f.tps) ?? 0,
    tvq: parseMoney(f.tvq) ?? 0,
    tip: parseMoney(f.tip) ?? 0,
  }
}

/** subtotal + tps + tvq + tip ≈ total; detects a tax-inclusive subtotal. */
export function checkArithmetic(f: ExpenseFields): QaIssue[] {
  const a = amountsOf(f)
  if (a.total === null) return [{ field: "total", problem: "total missing or unreadable" }]
  if (a.total <= 0) return [{ field: "total", problem: `total ${money(a.total)} is not a positive amount` }]
  if (a.subtotal === null) return []
  if (near(a.subtotal + a.tps + a.tvq + a.tip, a.total, SUM_TOLERANCE)) return []
  const preTax = a.subtotal - a.tps - a.tvq
  if ((a.tps || a.tvq) && near(a.subtotal + a.tip, a.total, SUM_TOLERANCE)) {
    return [{ field: "subtotal", problem: "subtotal includes taxes (books expect the pre-tax amount)", suggestion: money(preTax) }]
  }
  return [{
    field: "total",
    problem: `subtotal ${money(a.subtotal)} + tps ${money(a.tps)} + tvq ${money(a.tvq)} + tip ${money(a.tip)} = ${money(a.subtotal + a.tps + a.tvq + a.tip)} ≠ total ${money(a.total)}`,
  }]
}

/** Pre-tax base for the rate check: the subtotal when consistent, else implied. */
function preTaxBase(a: Amounts): number | null {
  if (a.total === null) return null
  const implied = a.total - a.tip - a.tps - a.tvq
  if (a.subtotal !== null && near(a.subtotal + a.tps + a.tvq + a.tip, a.total, SUM_TOLERANCE)) return a.subtotal
  return implied > 0 ? implied : null
}

/** QC rates: TPS 5 %, TVQ 9.975 % of the pre-tax subtotal (±0.03), when present. */
export function checkTaxRates(f: ExpenseFields): QaIssue[] {
  const a = amountsOf(f)
  const base = preTaxBase(a)
  if (base === null) return []
  const out: QaIssue[] = []
  if (a.tps && !near(a.tps, base * TPS_RATE, TAX_TOLERANCE)) {
    out.push({ field: "tps", problem: `TPS ${money(a.tps)} is not 5% of ${money(base)}`, suggestion: money(base * TPS_RATE) })
  }
  if (a.tvq && !near(a.tvq, base * TVQ_RATE, TAX_TOLERANCE)) {
    out.push({ field: "tvq", problem: `TVQ ${money(a.tvq)} is not 9.975% of ${money(base)}`, suggestion: money(base * TVQ_RATE) })
  }
  return out
}

/** YYYY-MM-DD in Montréal time. */
export function todayMontreal(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Toronto" })
}

function validIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === v
}

export function checkDate(f: ExpenseFields, now: Date = new Date()): QaIssue[] {
  const date = String(f.date ?? "")
  if (!validIsoDate(date)) return [{ field: "date", problem: "date missing or not YYYY-MM-DD" }]
  const today = todayMontreal(now)
  if (date > today) return [{ field: "date", problem: `date ${date} is in the future` }]
  const ageDays = (Date.parse(today) - Date.parse(date)) / 86_400_000
  if (ageDays > MAX_AGE_DAYS) return [{ field: "date", problem: `date ${date} is ${Math.round(ageDays)} days old (> ${MAX_AGE_DAYS})` }]
  return []
}

export function checkCurrency(f: ExpenseFields): QaIssue[] {
  const cur = String(f.currency ?? "").trim().toUpperCase()
  const out: QaIssue[] = []
  if (!CURRENCIES.has(cur)) out.push({ field: "currency", problem: `unexpected currency "${cur.slice(0, 8)}"` })
  const foreign = /US\$|USD|€|EUR|£/i.test(String(f.total ?? ""))
  if (foreign && (cur === "" || cur === "CAD")) out.push({ field: "currency", problem: "total looks foreign but is booked in CAD" })
  const total = parseMoney(f.total)
  if (total !== null && total > MAX_SANE_TOTAL) out.push({ field: "total", problem: `total ${money(total)} is unusually large for a receipt` })
  return out
}

/** Every sync check, in a stable order. */
export function codeChecks(f: ExpenseFields, now: Date = new Date()): QaIssue[] {
  return [...checkArithmetic(f), ...checkTaxRates(f), ...checkDate(f, now), ...checkCurrency(f)]
}

// ── Duplicate check (read-only Turso query, injected) ──

export type DupQuery = (date: string, excludeId: string) => Promise<Array<{ id: string; merchant: string; total: string }>>

export function normMerchant(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "")
}

export async function checkDuplicate(id: string, f: ExpenseFields, query: DupQuery): Promise<QaIssue[]> {
  const total = parseMoney(f.total)
  const merchant = normMerchant(String(f.merchant ?? ""))
  if (total === null || !merchant || !f.date) return []
  const rows = await query(String(f.date), id)
  const dup = rows.find((r) => normMerchant(r.merchant) === merchant && parseMoney(r.total) === total)
  return dup ? [{ field: "total", problem: `possible duplicate of ${dup.id} (same merchant, date and total)` }] : []
}

// ── Books-rule helpers used by the Jev decision ──

export function isPersonalPurpose(f: ExpenseFields): boolean {
  return /\b(personal|personnel|perso)\b/i.test(String(f.purpose ?? "")) && String(f.reimbursable ?? "").toLowerCase() !== "yes"
}

export function groceryByName(f: ExpenseFields): boolean {
  return ALWAYS_PERSONAL.test(String(f.merchant ?? ""))
}

// ── Meal GL rule: distance from the Granby office decides, never a model ──

export const MEAL_TRAVEL_KM = 50
export const MEAL_TRAVEL_CODE = "5216"
export const MEAL_LOCAL_CODE = "5776"
export const MEAL_ADDRESS_UNRESOLVED = "meal address unresolved"
const MEAL_CATEGORY = /\b(meals?|restaurants?|repas|resto|restauration)\b/i

export function mealByCategory(f: ExpenseFields): boolean {
  return MEAL_CATEGORY.test(String(f.category ?? ""))
}

/** km > 50 → 5216 Travel; km ≤ 50 → 5776 Représentation. */
export function mealCodeForKm(km: number): string {
  return km > MEAL_TRAVEL_KM ? MEAL_TRAVEL_CODE : MEAL_LOCAL_CODE
}
