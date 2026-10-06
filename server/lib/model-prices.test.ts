import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { MODEL_PRICES, priceFor, unpricedRowSql, usdFor, usdRowSql } from "./model-prices"

describe("model prices", () => {
  test("exact ids, dated snapshots, [1m] and @ variants", () => {
    expect(priceFor("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5 })
    expect(priceFor("claude-opus-5-5[1m]")).toBe(MODEL_PRICES["claude-opus-5-5"]!)
    expect(priceFor("claude-haiku-4-5-20251001")).toBe(MODEL_PRICES["claude-haiku-4-5"]!)
    expect(priceFor("claude-opus-4-5@20251101")).toBe(MODEL_PRICES["claude-opus-4-5"]!)
    expect(priceFor("claude-opus-4-20250514")).toBe(MODEL_PRICES["claude-opus-4"]!)
    expect(priceFor("claude-3-5-haiku-20241022")).toBe(MODEL_PRICES["claude-3-5-haiku"]!)
  })

  test("a shorter id never swallows a longer one; unknown ids are unpriced", () => {
    expect(priceFor("claude-opus-4-5")).toBe(MODEL_PRICES["claude-opus-4-5"]!)
    expect(priceFor("claude-opus-5")).toBe(MODEL_PRICES["claude-opus-5"]!)
    expect(priceFor("claude-sonnet-5-5")).toBe(MODEL_PRICES["claude-sonnet-5-5"]!)
    for (const m of ["claude-opus-4-9", "claude-opus-5-7", "opus", "sonnet", "<synthetic>", "unknown", "", "CLAUDE-OPUS-5-5"]) {
      expect(priceFor(m)).toBeNull()
    }
  })

  test("usdFor: per-MTok rates, cache write at the 5m rate", () => {
    expect(usdFor("claude-fable-5-1", { input: 1e6, output: 1e6, cache_read: 1e6, cache_creation: 1e6 })).toBe(10 + 50 + 0.25 + 12.5)
    expect(usdFor("claude-sonnet-4-6", { input: 0, output: 0, cache_read: 1e6, cache_creation: 0 })).toBe(0.3)
    expect(usdFor("sonnet", { input: 1e6, output: 0, cache_read: 0, cache_creation: 0 })).toBeNull()
  })

  test("the SQL CASE agrees with priceFor for every id and its variants", () => {
    const db = new Database(":memory:")
    db.run("CREATE TABLE t (model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_creation INTEGER)")
    const models = [
      ...Object.keys(MODEL_PRICES).flatMap((id) => [id, `${id}-20250101`, `${id}[1m]`, `${id}@x`, `${id}-9`]),
      "opus", "<synthetic>", "claude-opus-4-9", "Claude-opus-5-5",
    ]
    const counts = { input: 1_000_000, output: 200_000, cache_read: 3_000_000, cache_creation: 40_000 }
    for (const m of models) db.run("INSERT INTO t VALUES (?, ?, ?, ?, ?)", [m, counts.input, counts.output, counts.cache_read, counts.cache_creation])
    const rows = db.query(`SELECT model, ${usdRowSql()} AS usd, ${unpricedRowSql()} AS unpriced FROM t`).all() as Array<{ model: string; usd: number | null; unpriced: number }>
    expect(rows).toHaveLength(models.length)
    for (const r of rows) {
      const want = usdFor(r.model, counts)
      if (want === null) {
        expect([r.model, r.usd]).toEqual([r.model, null])
        expect(r.unpriced).toBe(4_240_000)
      } else {
        expect(r.usd).toBeCloseTo(want, 9)
        expect(r.unpriced).toBe(0)
      }
    }
  })
})
