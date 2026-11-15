#!/usr/bin/env bun
// Ephemeral local Hrana v2 HTTP server over the committed test schema (`schemaDb()`).
// Used by `.github/workflows/ci.yml` when no external GCP `tls-test-sqld` secret is set.

import { timingSafeEqual } from "node:crypto"
import { schemaDb } from "../server/lib/turso-test-db.test-util"

type SqlScalar = string | bigint | Buffer | number | null

interface HranaValue {
  type: "null" | "integer" | "float" | "text" | "blob"
  value?: string | number
  base64?: string
}

interface HranaNamedArg {
  name: string
  value: HranaValue
}

interface HranaStmt {
  sql: string
  args?: HranaValue[]
  named_args?: HranaNamedArg[]
}

type HranaCond =
  | { type: "ok" | "error"; step: number }
  | { type: "not"; cond: HranaCond }
  | { type: "and" | "or"; conds: HranaCond[] }
  | { type: "is_autocommit" }

interface HranaBatchStep {
  condition?: HranaCond
  stmt: HranaStmt
}

interface HranaResult {
  cols: { name: string }[]
  rows: HranaValue[][]
  affected_row_count: number
}

function parsePort(argv: string[]): number {
  const idx = argv.indexOf("--port")
  const raw = (idx >= 0 ? argv[idx + 1] : undefined) ?? process.env.PORT ?? "18080"
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`)
  }
  return port
}

function isAuthorized(header: string | null, expected: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false
  const given = Buffer.from(header.slice(7))
  const want = Buffer.from(expected)
  return given.length === want.length && timingSafeEqual(given, want)
}

function decodeValue(v: HranaValue | undefined): SqlScalar {
  if (!v || v.type === "null") return null
  if (v.type === "integer") {
    const raw = String(v.value ?? "0")
    const num = Number(raw)
    return Number.isSafeInteger(num) ? num : BigInt(raw)
  }
  if (v.type === "float") return Number(v.value ?? 0)
  if (v.type === "blob") return Buffer.from(String(v.base64 ?? ""), "base64")
  return String(v.value ?? "")
}

function encodeValue(v: unknown): HranaValue {
  if (v === null || v === undefined) return { type: "null" }
  if (typeof v === "bigint") return { type: "integer", value: v.toString() }
  if (typeof v === "number") {
    return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v }
  }
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" }
  if (v instanceof Uint8Array) return { type: "blob", base64: Buffer.from(v).toString("base64") }
  return { type: "text", value: String(v) }
}

const token = (process.env.TURSO_TEST_AUTH_TOKEN ?? "").trim()
if (!token) {
  console.error("TURSO_TEST_AUTH_TOKEN must be non-empty")
  process.exit(1)
}

const port = parsePort(process.argv.slice(2))
const db = schemaDb()

function runStmt(stmt: HranaStmt): HranaResult {
  const sql = stmt.sql
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
    db.exec(sql)
    return { cols: [], rows: [], affected_row_count: 0 }
  }
  const q = db.query(sql)
  const named = stmt.named_args?.length
    ? Object.fromEntries(stmt.named_args.map((a) => [a.name, decodeValue(a.value)]))
    : null
  const pos = (stmt.args ?? []).map(decodeValue)

  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
    const rows = (named ? q.all(named) : q.all(...pos)) as Record<string, unknown>[]
    const colNames = rows[0] ? Object.keys(rows[0]) : q.columnNames
    return {
      cols: colNames.map((name) => ({ name })),
      rows: rows.map((row) => colNames.map((name) => encodeValue(row[name]))),
      affected_row_count: /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) ? 0 : rows.length,
    }
  }

  const res = named ? q.run(named) : q.run(...pos)
  return { cols: [], rows: [], affected_row_count: Number(res.changes) }
}

function evalCond(c: HranaCond, results: (HranaResult | null)[], errors: ({ message: string } | null)[]): boolean {
  switch (c.type) {
    case "ok": return results[c.step] != null
    case "error": return errors[c.step] != null
    case "not": return !evalCond(c.cond, results, errors)
    case "and": return c.conds.every((x) => evalCond(x, results, errors))
    case "or": return c.conds.some((x) => evalCond(x, results, errors))
    case "is_autocommit": return !db.inTransaction
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (req.method === "GET" && path === "/healthz") {
      return Response.json({ ok: true })
    }
    if (req.method !== "POST" || path !== "/v2/pipeline") {
      return Response.json({ error: "not found" }, { status: 404 })
    }
    if (!isAuthorized(req.headers.get("authorization"), token)) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!rawBody || typeof rawBody !== "object") {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
    const requests = (rawBody as { requests?: unknown[] }).requests
    if (!Array.isArray(requests)) {
      return Response.json({ error: "missing requests" }, { status: 400 })
    }

    const out: unknown[] = []
    for (const item of requests) {
      if (!item || typeof item !== "object") {
        out.push({ type: "error", error: { message: "invalid request" } })
        continue
      }
      const r = item as { type?: string; stmt?: HranaStmt; batch?: { steps?: HranaBatchStep[] } }
      if (r.type === "close") {
        out.push({ type: "ok", response: { type: "close" } })
      } else if (r.type === "execute" && r.stmt) {
        try {
          out.push({ type: "ok", response: { type: "execute", result: runStmt(r.stmt) } })
        } catch (e) {
          out.push({ type: "error", error: { message: (e as Error).message } })
        }
      } else if (r.type === "batch" && Array.isArray(r.batch?.steps)) {
        const stepResults: (HranaResult | null)[] = []
        const stepErrors: ({ message: string } | null)[] = []
        for (const st of r.batch.steps) {
          if (st.condition && !evalCond(st.condition, stepResults, stepErrors)) {
            stepResults.push(null)
            stepErrors.push(null)
            continue
          }
          try {
            stepResults.push(runStmt(st.stmt))
            stepErrors.push(null)
          } catch (e) {
            stepResults.push(null)
            stepErrors.push({ message: (e as Error).message })
          }
        }
        out.push({ type: "ok", response: { type: "batch", result: { step_results: stepResults, step_errors: stepErrors } } })
      } else {
        out.push({ type: "error", error: { message: `unsupported request type: ${String(r.type ?? "")}` } })
      }
    }

    return Response.json({ results: out })
  },
})

console.log(`[tls-test-sqld] listening on http://${server.hostname}:${server.port}`)
