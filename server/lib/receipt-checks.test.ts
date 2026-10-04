import { expect, test } from "bun:test"
import { checkArithmetic, checkCurrency, checkDate, checkDuplicate, checkTaxRates, codeChecks, parseMoney } from "./receipt-checks"

const NOW = new Date("2026-10-03T15:00:00Z")
// 100.00 pre-tax → TPS 5.00, TVQ 9.98 (9.975 rounded), total 114.98.
const GOOD = { merchant: "Bureau en Gros", date: "2026-10-01", total: "$114.98", subtotal: "$100.00", tps: "$5.00", tvq: "$9.98", tip: "", currency: "CAD" }

test("parseMoney handles $ / FR-CA comma decimals / thousands", () => {
  expect(parseMoney("$24.35")).toBe(24.35)
  expect(parseMoney("24,35 $")).toBe(24.35)
  expect(parseMoney("1 234,56 $")).toBe(1234.56)
  expect(parseMoney("$1,234.56")).toBe(1234.56)
  expect(parseMoney("1.234,56")).toBe(1234.56)
  expect(parseMoney("")).toBeNull()
  expect(parseMoney("n/a")).toBeNull()
})

test("arithmetic: subtotal + tps + tvq + tip ≈ total (±0.02)", () => {
  expect(checkArithmetic(GOOD)).toEqual([])
  expect(checkArithmetic({ ...GOOD, total: "$115.00" })).toEqual([]) // 0.02 off: tolerated
  const off = checkArithmetic({ ...GOOD, total: "$120.00" })
  expect(off).toHaveLength(1)
  expect(off[0]!.field).toBe("total")
  expect(off[0]!.problem).toContain("≠ total")
  // tip outside the subtotal
  expect(checkArithmetic({ ...GOOD, tip: "$15.00", total: "$129.98" })).toEqual([])
  // no subtotal → nothing to add up
  expect(checkArithmetic({ ...GOOD, subtotal: "" })).toEqual([])
})

test("arithmetic: a tax-inclusive subtotal is named, with the pre-tax suggestion", () => {
  const r = checkArithmetic({ ...GOOD, subtotal: "$114.98" })
  expect(r).toEqual([{ field: "subtotal", problem: expect.stringContaining("includes taxes"), suggestion: "100.00" }])
})

test("arithmetic: missing / non-positive total", () => {
  expect(checkArithmetic({ ...GOOD, total: "" })[0]!.problem).toContain("missing")
  expect(checkArithmetic({ ...GOOD, total: "$0.00" })[0]!.problem).toContain("not a positive")
})

test("tax rates: TPS 5 %, TVQ 9.975 % of the pre-tax base (±0.03), only when present", () => {
  expect(checkTaxRates(GOOD)).toEqual([])
  expect(checkTaxRates({ ...GOOD, tps: "", tvq: "", total: "$100.00" })).toEqual([])
  const bad = checkTaxRates({ ...GOOD, tps: "$7.00", total: "$116.98" })
  expect(bad.map((i) => i.field)).toEqual(["tps"])
  expect(bad[0]!.suggestion).toBe("5.00")
  // implied base when no subtotal: 114.98 - 5.00 - 9.98 = 100.00
  expect(checkTaxRates({ ...GOOD, subtotal: "" })).toEqual([])
  expect(checkTaxRates({ ...GOOD, subtotal: "", tvq: "$12.00", total: "$117.00" }).map((i) => i.field)).toEqual(["tvq"])
})

test("date: valid, not future, not > 120 days old", () => {
  expect(checkDate(GOOD, NOW)).toEqual([])
  expect(checkDate({ ...GOOD, date: "2026-10-04" }, NOW)[0]!.problem).toContain("future")
  expect(checkDate({ ...GOOD, date: "2026-05-01" }, NOW)[0]!.problem).toContain("days old")
  expect(checkDate({ ...GOOD, date: "2026-06-05" }, NOW)).toEqual([]) // 120 days
  expect(checkDate({ ...GOOD, date: "2026-02-30" }, NOW)[0]!.problem).toContain("YYYY-MM-DD")
  expect(checkDate({ ...GOOD, date: "" }, NOW)).toHaveLength(1)
})

test("currency: known codes, foreign-looking totals, absurd amounts", () => {
  expect(checkCurrency(GOOD)).toEqual([])
  expect(checkCurrency({ ...GOOD, currency: "" })).toEqual([])
  expect(checkCurrency({ ...GOOD, currency: "XBT" })[0]!.field).toBe("currency")
  expect(checkCurrency({ ...GOOD, total: "US$114.98" })[0]!.problem).toContain("foreign")
  expect(checkCurrency({ ...GOOD, total: "USD 114.98", currency: "USD" })).toEqual([])
  expect(checkCurrency({ ...GOOD, total: "$25,000.00" })[0]!.problem).toContain("unusually large")
})

test("codeChecks: a clean receipt has no issue", () => {
  expect(codeChecks(GOOD, NOW)).toEqual([])
})

test("duplicate: same merchant (normalized) + total + date elsewhere → issue; else none", async () => {
  const seen: Array<[string, string]> = []
  const q = async (date: string, exclude: string) => {
    seen.push([date, exclude])
    return [{ id: "accounting/2026-10/other", merchant: "BUREAU EN GROS!", total: "114,98 $" }, { id: "x", merchant: "Tim", total: "$114.98" }]
  }
  const r = await checkDuplicate("accounting/2026-10/me", GOOD, q)
  expect(r).toEqual([{ field: "total", problem: "possible duplicate of accounting/2026-10/other (same merchant, date and total)" }])
  expect(seen).toEqual([["2026-10-01", "accounting/2026-10/me"]])
  expect(await checkDuplicate("me", { ...GOOD, total: "$1.00" }, q)).toEqual([])
  await expect(checkDuplicate("me", GOOD, async () => { throw new Error("turso down") })).rejects.toThrow()
})
