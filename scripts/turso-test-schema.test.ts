import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { type Obj, PROD_READ, keepObjects, parseTable, subsetSql, syncPlan, testDbWriter } from "./turso-test-schema"
import { TEST_HOST } from "../server/lib/turso-test-guard.test-util"

const obj = (type: string, name: string, tbl: string, sql: string): Obj => ({ type, name, tbl, sql })
const T = obj("table", "t", "t", "CREATE TABLE t (a)")
const I = obj("index", "t_a", "t", "CREATE INDEX t_a ON t (a)")
const G = obj("trigger", "t_g", "t", "CREATE TRIGGER t_g BEFORE INSERT ON t BEGIN SELECT 1; END")

test("parseTable: columns by the header, multi-line SQL rejoined, NULL rows kept for keepObjects", () => {
  const out = [
    "TYPE      NAME        TBL NAME    SQL                ",
    "index     sqlite_au   tasks       NULL               ",
    "table     tasks       tasks       CREATE TABLE tasks (",
    "                                    id TEXT,         ",
    "                                                     ",
    "                                    x TEXT           ",
    "                                  )                  ",
    "",
  ].join("\n")
  expect(parseTable(out)).toEqual([
    obj("index", "sqlite_au", "tasks", "NULL"),
    obj("table", "tasks", "tasks", "CREATE TABLE tasks (\n  id TEXT,\n\n  x TEXT\n)"),
  ])
  expect(() => parseTable("Error: nope")).toThrow("no header")
})

test("keepObjects: no engine objects, no FTS shadows, tables before what hangs off them", () => {
  const v = obj("table", "n_fts", "n_fts", "CREATE VIRTUAL TABLE n_fts USING fts5(a)")
  const objs = [G, I, T, v, obj("table", "n_fts_data", "n_fts_data", "CREATE TABLE 'n_fts_data'(id)"), obj("table", "sqlite_sequence", "sqlite_sequence", "CREATE TABLE sqlite_sequence(name,seq)"), obj("index", "sqlite_autoindex_t_1", "t", "NULL")]
  expect(keepObjects(objs).map((o) => o.name)).toEqual(["n_fts", "t", "t_a", "t_g"])
})

describe("syncPlan", () => {
  test("in sync, whitespace aside: nothing to do", () => {
    expect(syncPlan([T, I, G], [{ ...T, sql: "CREATE  TABLE\n t (a)" }, I, G])).toEqual({ drops: [], creates: [] })
  })
  test("a changed guard is replaced alone", () => {
    const g2 = { ...G, sql: "CREATE TRIGGER t_g BEFORE INSERT ON t BEGIN SELECT 2; END" }
    expect(syncPlan([T, I, g2], [T, I, G])).toEqual({ drops: ['DROP TRIGGER IF EXISTS "t_g"'], creates: [g2] })
  })
  test("a changed table takes its index and trigger with it, and they come back", () => {
    const t2 = { ...T, sql: "CREATE TABLE t (a, b)" }
    const p = syncPlan([t2, I, G], [T, I, G])
    expect(p.drops).toEqual(['DROP TABLE IF EXISTS "t"'])
    expect(p.creates).toEqual([t2, I, G])
  })
  test("what production dropped goes", () => {
    expect(syncPlan([T], [T, I]).drops).toEqual(['DROP INDEX IF EXISTS "t_a"'])
  })
})

test("subsetSql: the four tables and guards, no FTS, nothing else", () => {
  const n = obj("table", "notes", "notes", "CREATE TABLE notes (id)")
  const q = obj("trigger", "tasks_queue_guard_ins", "tasks", "CREATE TRIGGER tasks_queue_guard_ins BEFORE INSERT ON tasks BEGIN SELECT 1; END")
  const fts = obj("trigger", "notes_fts_ai", "notes", "CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts VALUES (1); END")
  const sql = subsetSql([n, obj("table", "plaid_accounts", "plaid_accounts", "CREATE TABLE plaid_accounts (id)"), q, fts])
  expect(sql).toContain("CREATE TABLE notes")
  expect(sql).toContain("tasks_queue_guard_ins")
  expect(sql).not.toContain("plaid_accounts")
  expect(sql).not.toContain("notes_fts")
})

describe("the write path", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  test("every write goes through the allowlist: no statement leaves for any other target", async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls += 1; return new Response("{}") }) as unknown as typeof fetch
    for (const url of ["libsql://tls-dashboard-jaubut.aws-us-east-1.turso.io", `https://${TEST_HOST}.evil.example`, "", undefined]) {
      await expect(testDbWriter(url, "dummy")("DELETE FROM tasks")).rejects.toThrow("refused")
    }
    expect(calls).toBe(0)
  })

  test("tls-test passes, with the caller's token", async () => {
    const seen: string[] = []
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      seen.push(`${u} ${new Headers(init.headers).get("authorization")}`)
      return new Response(JSON.stringify({ results: [{ type: "ok", response: { result: { cols: [], rows: [] } } }] }))
    }) as unknown as typeof fetch
    await testDbWriter(`libsql://${TEST_HOST}`, "tok")("SELECT 1")
    expect(seen).toEqual([`https://${TEST_HOST}/v2/pipeline Bearer tok`])
  })

  test("production appears once in the script, as the fixed read; it can't take a second statement", async () => {
    const src = await Bun.file(join(import.meta.dir, "turso-test-schema.ts")).text()
    expect(PROD_READ).toBe("SELECT type,name,tbl_name,sql FROM sqlite_master")
    expect(src.match(/\bPROD_DB\b/g)).toHaveLength(2)
    expect(src).toContain(`cli("db", "shell", PROD_DB, PROD_READ)`)
    expect(src.match(/"db", "shell"/g)).toHaveLength(1)
    expect(src.match(/tls-dashboard/g)).toHaveLength(2)
  })
})
