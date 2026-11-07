import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Row, TursoUnreachable, tursoQuery, tursoTx } from "./turso"
import { testDbUrl } from "./turso-test-guard.test-util"

// Test-only: the one way into tls-test, and the schema the Hrana stub runs on. tls-test is shared by every CI run
// and local run at once, so a run owns one note, each row hangs off it, and nothing deletes outside it. A crashed
// run's rows are swept by the next run after a day; no runner reads tls-test, so they harm nothing until then.

const FIX = "bun scripts/turso-test-schema.ts from a host with a turso login"
const COLS = "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'"
const OBJS = "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL"
const EPOCH_AT = 13 // 1-based, in `projects/it-<epoch>-<run>`

/** A fresh in-memory SQLite on the committed subset of production's schema. */
export function schemaDb(): Database {
  const db = new Database(":memory:")
  db.exec(readFileSync(join(import.meta.dir, "turso-test-schema.sql"), "utf8"))
  return db
}

export interface Shape { cols: Row[]; objs: Row[] }
const flat = (sql: unknown) => String(sql).replace(/\s+/g, " ").trim()

/** What the subset needs and tls-test lacks. Extra columns pass, so a schema bump doesn't fail other branches. */
export function schemaGaps(want: Shape, have: Shape): string[] {
  const cols = new Set(have.cols.map((c) => `${c.tbl}.${c.col}`))
  const objs = new Map(have.objs.map((o) => [String(o.name), flat(o.sql)]))
  return [
    ...want.cols.filter((c) => !cols.has(`${c.tbl}.${c.col}`)).map((c) => `column ${c.tbl}.${c.col} is missing`),
    ...want.objs.filter((o) => objs.get(String(o.name)) !== flat(o.sql)).map((o) => `${o.type} ${o.name} is missing or differs`),
  ]
}

function refuse(title: string, msg: string): Error {
  if (process.env.GITHUB_ACTIONS) console.error(`::error title=${title}::${msg}`)
  return new Error(`${title}: ${msg}`)
}

async function reach(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await tursoQuery("SELECT 1", [])
      return
    } catch (e) {
      const why = e instanceof TursoUnreachable ? e.message : "unexpected error"
      if (/http 40[13]$/.test(why)) throw refuse("tls-test token rejected", "TURSO_TEST_AUTH_TOKEN expired or was revoked; the PR that added the integration job has the rotation commands")
      if (attempt === 3) throw refuse("Turso unreachable", `${why}. A Turso outage, not a code failure: rerun this job`)
      await Bun.sleep(attempt * 2000)
    }
  }
}

export const testDbConfigured = () => Boolean(process.env.TURSO_TEST_URL && process.env.TURSO_TEST_AUTH_TOKEN)

/** Points turso.ts at tls-test (the allowlist again: a run from another cwd skips the preload). */
export async function openTestDb(): Promise<{ note: string; close(): Promise<void> }> {
  process.env.TURSO_DATABASE_URL = testDbUrl(process.env.TURSO_TEST_URL)
  process.env.TURSO_AUTH_TOKEN = process.env.TURSO_TEST_AUTH_TOKEN
  await reach()

  const subset = schemaDb()
  const want = { cols: subset.query(COLS).all() as Row[], objs: subset.query(OBJS).all() as Row[] }
  subset.close()
  const gaps = schemaGaps(want, { cols: await tursoQuery(COLS, []), objs: await tursoQuery(OBJS, []) })
  if (gaps.length) throw refuse("tls-test is behind", `${gaps.slice(0, 10).join("; ")}. Run ${FIX}`)

  const now = Math.floor(Date.now() / 1000)
  const note = `projects/it-${now}-${randomUUID().slice(0, 8)}`
  await tursoTx([
    { sql: "DELETE FROM agent_activity WHERE ts < datetime('now', '-1 day')", args: [] },
    { sql: "DELETE FROM task_stamps WHERE stamped_at < datetime('now', '-1 day')", args: [] },
    { sql: "DELETE FROM tasks WHERE created_at < datetime('now', '-1 day')", args: [] },
    { sql: `DELETE FROM notes WHERE id LIKE 'projects/it-%' AND CAST(substr(id, ${EPOCH_AT}, 10) AS INTEGER) < ?`, args: [now - 86_400] },
    { sql: "INSERT INTO notes (id, folder, filename, title) VALUES (?, 'projects', 'it.md', 'integration run')", args: [note] },
  ])
  return {
    note,
    close: async () => {
      await tursoTx([
        { sql: "DELETE FROM agent_activity WHERE target_id IN (SELECT id FROM tasks WHERE note_id = ?)", args: [note] },
        { sql: "DELETE FROM task_stamps WHERE task_id IN (SELECT id FROM tasks WHERE note_id = ?)", args: [note] },
        { sql: "DELETE FROM tasks WHERE note_id = ?", args: [note] },
        { sql: "DELETE FROM notes WHERE id = ?", args: [note] },
      ])
      delete process.env.TURSO_DATABASE_URL
      process.env.TURSO_AUTH_TOKEN = "test-token"
    },
  }
}
