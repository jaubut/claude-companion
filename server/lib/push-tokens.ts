import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { companionDbPath } from "./db-path"

const DB_PATH = companionDbPath()
mkdirSync(dirname(DB_PATH), { recursive: true })
const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS push_tokens (
    token TEXT PRIMARY KEY,
    environment TEXT NOT NULL DEFAULT 'sandbox',
    device_name TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )
`)

export type ApnsEnv = "sandbox" | "production"

export interface PushToken { token: string; environment: ApnsEnv; deviceName: string | null }

export function registerToken(token: string, environment: ApnsEnv, deviceName?: string): void {
  const now = Date.now()
  db.query(
    "INSERT INTO push_tokens (token, environment, device_name, created_at, last_seen) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(token) DO UPDATE SET last_seen=excluded.last_seen, environment=excluded.environment, device_name=excluded.device_name",
  ).run(token, environment, deviceName ?? null, now, now)
}

export function listTokens(): PushToken[] {
  const rows = db.query("SELECT token, environment, device_name FROM push_tokens").all() as Array<{
    token: string; environment: ApnsEnv; device_name: string | null
  }>
  return rows.map(r => ({ token: r.token, environment: r.environment, deviceName: r.device_name }))
}

export function removeToken(token: string): void {
  db.query("DELETE FROM push_tokens WHERE token = ?").run(token)
}

export function tokenCount(): number {
  const row = db.query("SELECT COUNT(*) AS n FROM push_tokens").get() as { n: number }
  return row.n
}
