import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

// Minimal Turso (libSQL Hrana-over-HTTP) client: read-only proxy routes, plus
// the guarded dispatch-task writes (tursoExec, orchestrator-one-queue P2).
// The phone never holds the Turso token; the server does. Token source is
// TURSO_AUTH_TOKEN from the shell env, ~/.claude-companion/.env (loaded by
// cli.ts), or the agent env files ~/.config/tls-agent/{env,secrets.env}. Never log it, and
// never put SQL or the token into an error message — callers surface
// `TursoUnreachable` as a generic 503.

export type SqlArg = string | number | null
export type Row = Record<string, string | number | null>
export type QueryFn = (sql: string, args: SqlArg[]) => Promise<Row[]>
/** A write: rows (if any) plus the affected row count, for guarded compare-and-set. */
export type ExecFn = (sql: string, args: SqlArg[]) => Promise<{ rows: Row[]; affected: number }>

export class TursoUnreachable extends Error {
  constructor(reason: string) {
    super(`turso unreachable: ${reason}`)
    this.name = "TursoUnreachable"
  }
}

const DEFAULT_URL = "https://tls-dashboard-jaubut.aws-us-east-1.turso.io"
const TIMEOUT_MS = 8000

let agentToken: string | undefined
let agentEnvRead = false

// Only TURSO_AUTH_TOKEN is read from the agent env file — never the whole
// file into process.env, which every spawned tmux/inject child would inherit.
function readAgentToken(): string | undefined {
  if (agentEnvRead) return agentToken
  agentEnvRead = true
  // Zettlab keeps the token in secrets.env (the vault store); the Mac in env.
  for (const file of ["env", "secrets.env"]) {
    try {
      const raw = readFileSync(join(homedir(), ".config", "tls-agent", file), "utf8")
      for (const line of raw.split("\n")) {
        const m = /^\s*(?:export\s+)?TURSO_AUTH_TOKEN\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line)
        if (!m) continue
        const v = m[1]!.trim().replace(/^["']|["']$/g, "")
        if (v) agentToken = v
      }
    } catch { /* file absent on this host */ }
    if (agentToken) break
  }
  return agentToken
}

function token(): string | undefined {
  return process.env.TURSO_AUTH_TOKEN || readAgentToken()
}

function baseUrl(): string {
  const raw = process.env.TURSO_DATABASE_URL || DEFAULT_URL
  return raw.replace(/^libsql:\/\//, "https://").replace(/\/+$/, "")
}

type HranaValue = { type: "null" } | { type: "integer" | "text" | "float" | "blob"; value?: string | number; base64?: string }

function toArg(v: SqlArg): HranaValue {
  if (v === null) return { type: "null" }
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v }
  return { type: "text", value: v }
}

function fromValue(v: HranaValue): string | number | null {
  if (v.type === "null") return null
  if (v.type === "integer" || v.type === "float") return Number(v.value)
  if (v.type === "blob") return v.base64 ?? null
  return v.value == null ? null : String(v.value)
}

interface ExecResult {
  cols: { name: string }[]
  rows: HranaValue[][]
  affected_row_count?: number
}

function parseResult(body: unknown): ExecResult {
  const results = (body as { results?: unknown[] })?.results
  const first = results?.[0] as { type?: string; response?: { result?: ExecResult } } | undefined
  if (first?.type !== "ok" || !first.response?.result) throw new TursoUnreachable("query failed")
  return first.response.result
}

async function post(auth: string, sql: string, args: SqlArg[]): Promise<Response> {
  try {
    return await fetch(`${baseUrl()}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ type: "execute", stmt: { sql, args: args.map(toArg) } }, { type: "close" }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new TursoUnreachable("network")
  }
}

async function execute(sql: string, args: SqlArg[]): Promise<{ rows: Row[]; affected: number }> {
  let auth = token()
  if (!auth) throw new TursoUnreachable("no token configured")
  let res = await post(auth, sql, args)
  if (res.status === 401) {
    // Token rotated under us: drop the cached agent token and re-read it once.
    agentToken = undefined
    agentEnvRead = false
    const fresh = token()
    if (fresh && fresh !== auth) {
      auth = fresh
      res = await post(auth, sql, args)
    }
  }
  if (!res.ok) throw new TursoUnreachable(`http ${res.status}`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new TursoUnreachable("bad response")
  }
  const { cols, rows, affected_row_count } = parseResult(body)
  return {
    rows: rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, fromValue(row[i] ?? { type: "null" })]))),
    affected: Number(affected_row_count ?? 0),
  }
}

export const tursoQuery: QueryFn = async (sql, args) => (await execute(sql, args)).rows

/** Writes only through the named functions in lib/dispatch-tasks.ts — never a generic SQL route. */
export const tursoExec: ExecFn = execute
