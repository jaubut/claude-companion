import type { Database } from "bun:sqlite"

// Test-only: a stub of Turso's Hrana-over-HTTP pipeline (POST /v2/pipeline) in front of ONE in-memory SQLite, installed
// as globalThis.fetch. It implements the batch step conditions (`ok`, `not`, `and`, `or`) the way the server does
// (a step whose condition is false is skipped: null result, null error; a failed step: null result + step_error),
// so turso.ts's real request building and response parsing run end to end, with real SQL underneath.

export interface HranaStubOptions {
  /** A statement that must fail (any batch or execute), e.g. to simulate a commit or insert error. */
  failOn?: (sql: string) => boolean
  /** Called before every request is handled (inject a concurrent edit, count calls…). */
  onRequest?: (kind: "execute" | "batch", sqls: string[]) => void
  /** Respond with this HTTP status instead of handling the request. */
  status?: number
  /** Replace the batch's response body (malformed / partial answers). */
  rewriteBatch?: (body: unknown) => unknown
}

type HVal = { type: "null" } | { type: "integer" | "text" | "float"; value: string | number }
type Cond = { type: "ok" | "error"; step: number } | { type: "not"; cond: Cond } | { type: "and" | "or"; conds: Cond[] }

const fromHrana = (v: HVal): string | number | null => (v.type === "null" ? null : v.type === "integer" || v.type === "float" ? Number(v.value) : String(v.value))
const toHrana = (v: unknown): HVal =>
  v === null || v === undefined ? { type: "null" } : typeof v === "number" ? (Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v }) : { type: "text", value: String(v) }

export function installHranaStub(db: Database, o: HranaStubOptions = {}) {
  const realFetch = globalThis.fetch
  /** Every statement that was actually executed, in order, with "!" prefixed when it failed. */
  const trace: string[] = []
  const requests: unknown[] = []

  function run(stmt: { sql: string; args?: HVal[] }): { cols: { name: string }[]; rows: HVal[][]; affected_row_count: number } {
    const sql = stmt.sql
    if (o.failOn?.(sql)) { trace.push(`!${sql}`); throw new Error("injected failure") }
    const args = (stmt.args ?? []).map(fromHrana)
    try {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
        db.exec(sql)
        trace.push(sql)
        return { cols: [], rows: [], affected_row_count: 0 }
      }
      const q = db.query(sql)
      if (/^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        const rows = q.all(...args) as Record<string, unknown>[]
        trace.push(sql)
        const names = rows[0] ? Object.keys(rows[0]) : []
        return { cols: names.map((name) => ({ name })), rows: rows.map((r) => names.map((n) => toHrana(r[n]))), affected_row_count: /^\s*(SELECT|WITH)/i.test(sql) ? 0 : rows.length }
      }
      const r = q.run(...args)
      trace.push(sql)
      return { cols: [], rows: [], affected_row_count: Number(r.changes) }
    } catch (e) {
      trace.push(`!${sql}`)
      throw e
    }
  }

  const holds = (c: Cond, results: (unknown | null)[], errors: (unknown | null)[]): boolean => {
    switch (c.type) {
      case "ok": return results[c.step] != null
      case "error": return errors[c.step] != null
      case "not": return !holds(c.cond, results, errors)
      case "and": return c.conds.every((x) => holds(x, results, errors))
      case "or": return c.conds.some((x) => holds(x, results, errors))
    }
  }

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (o.status) return new Response("{}", { status: o.status })
    const body = JSON.parse(String(init?.body)) as { requests: { type: string; stmt?: { sql: string; args?: HVal[] }; batch?: { steps: { stmt: { sql: string; args?: HVal[] }; condition?: Cond }[] } }[] }
    requests.push(body)
    const req = body.requests[0]!
    if (req.type === "execute") {
      o.onRequest?.("execute", [req.stmt!.sql])
      try {
        return Response.json({ results: [{ type: "ok", response: { type: "execute", result: run(req.stmt!) } }, { type: "ok", response: { type: "close" } }] })
      } catch (e) {
        return Response.json({ results: [{ type: "error", error: { message: (e as Error).message } }] })
      }
    }
    const steps = req.batch!.steps
    o.onRequest?.("batch", steps.map((s) => s.stmt.sql))
    const results: (unknown | null)[] = []
    const errors: (unknown | null)[] = []
    for (const [i, st] of steps.entries()) {
      if (st.condition && !holds(st.condition, results, errors)) { results[i] = null; errors[i] = null; continue }
      try { results[i] = run(st.stmt); errors[i] = null } catch (e) { results[i] = null; errors[i] = { message: (e as Error).message } }
    }
    const out = { results: [{ type: "ok", response: { type: "batch", result: { step_results: results, step_errors: errors } } }, { type: "ok", response: { type: "close" } }] }
    return Response.json(o.rewriteBatch ? o.rewriteBatch(out) : out)
  }) as unknown as typeof fetch

  return { trace, requests, restore: () => { globalThis.fetch = realFetch } }
}
