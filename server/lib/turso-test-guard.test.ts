import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { schemaDb, schemaGaps } from "./turso-test-db.test-util"
import { TEST_HOST, guardFetch, testDbUrl } from "./turso-test-guard.test-util"
import { tursoExec } from "./turso"

// The wall in front of production: the allowlist, the fetch wrap, and the bunfig preload that installs both.
// No case here opens a socket to Turso: the fake URLs stop at the guard, the spy stands in for the network.

const PROD = "tls-dashboard-jaubut.aws-us-east-1.turso.io"

describe("testDbUrl: only the tls-test host passes", () => {
  for (const ok of [`libsql://${TEST_HOST}`, `https://${TEST_HOST}`, `https://${TEST_HOST}/`]) {
    test(`takes ${ok}`, () => expect(testDbUrl(ok)).toBe(`https://${TEST_HOST}`))
  }
  for (const bad of [
    `libsql://${PROD}`, `https://${PROD}`, "https://other-jaubut.aws-us-east-1.turso.io",
    `https://${TEST_HOST}.evil.example`, `https://evil.example/${TEST_HOST}`, `https://${TEST_HOST}@evil.example`,
    `https://user:pw@${TEST_HOST}`, `http://${TEST_HOST}`, `https://${TEST_HOST}:8080`, `https://${TEST_HOST}/v2/pipeline`,
    `libsql://${TEST_HOST}?authToken=abc`, "http://127.0.0.1:8080", "file:local.db", "not a url", "", undefined,
  ]) {
    test(`refuses ${bad}`, () => expect(() => testDbUrl(bad)).toThrow("refused"))
  }

  test("a refusal never repeats what it was given: a libsql URL can carry its token", () => {
    const secret = "ey-not-a-real-token"
    let msg = ""
    try { testDbUrl(`libsql://${PROD}?authToken=${secret}`) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain("refused")
    expect(msg).not.toContain(secret)
    expect(msg).not.toContain(PROD)
  })
})

describe("guardFetch", () => {
  const realFetch = globalThis.fetch
  const saved = { home: process.env.HOME, token: process.env.TURSO_AUTH_TOKEN, url: process.env.TURSO_DATABASE_URL }
  const seen: { url: string; auth: string | null }[] = []
  const spy = (async (input: Request | string | URL, init?: RequestInit) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), auth: new Headers(init?.headers).get("authorization") })
    return new Response("{}", { status: 401 })
  }) as unknown as typeof fetch

  beforeEach(() => { seen.length = 0 })
  afterEach(() => {
    globalThis.fetch = realFetch
    for (const [k, v] of [["HOME", saved.home], ["TURSO_AUTH_TOKEN", saved.token], ["TURSO_DATABASE_URL", saved.url]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test("a Turso host other than tls-test never reaches the network, in any input form", async () => {
    const f = guardFetch(spy)
    for (const input of [`https://${PROD}/v2/pipeline`, `https://${PROD}./v2/pipeline`, new URL(`https://${PROD}/v2/pipeline`), new Request(`https://${PROD}/v2/pipeline`)]) {
      await expect(f(input)).rejects.toThrow("refused")
    }
    expect(seen).toHaveLength(0)
  })

  test("the preload wrapped fetch, and turso.ts has no transport around it", async () => {
    await expect(fetch(`https://${PROD}/v2/pipeline`)).rejects.toThrow("refused")
    const src = await Bun.file(join(import.meta.dir, "turso.ts")).text()
    expect(src).toContain("await fetch(")
    expect(src).not.toMatch(/Bun\.fetch|node:https?|node:net|node:tls|Bun\.connect|new WebSocket/)
  })

  test("tls-test and non-Turso hosts pass", async () => {
    const f = guardFetch(spy)
    await f(`https://${TEST_HOST}/v2/pipeline`)
    await f("http://127.0.0.1:9/x")
    expect(seen.map((s) => s.url)).toEqual([`https://${TEST_HOST}/v2/pipeline`, "http://127.0.0.1:9/x"])
  })

  test("the production client, with no URL set, stops at the guard: its default URL is production's", async () => {
    globalThis.fetch = guardFetch(spy)
    delete process.env.TURSO_DATABASE_URL
    process.env.TURSO_AUTH_TOKEN = "dummy"
    await expect(tursoExec("SELECT 1", [])).rejects.toThrow("network")
    expect(seen).toHaveLength(0)
  })

  test("a 401 on tls-test never swaps in the agent token file", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-guard-home-"))
    mkdirSync(join(home, ".config", "tls-agent"), { recursive: true })
    writeFileSync(join(home, ".config", "tls-agent", "env"), "TURSO_AUTH_TOKEN=from-the-agent-file\n")
    process.env.HOME = home
    process.env.TURSO_DATABASE_URL = `https://${TEST_HOST}`
    globalThis.fetch = guardFetch(spy)
    await expect(tursoExec("SELECT 1", [])).rejects.toThrow("http 401")
    expect(seen.map((s) => s.auth)).toEqual(["Bearer test-token"])
  })
})

describe("schemaGaps: a behind tls-test fails by name", () => {
  const want = { cols: [{ tbl: "tasks", col: "origin" }], objs: [{ type: "trigger", name: "g", sql: "CREATE TRIGGER g  x" }] }

  test("whitespace aside, in step; extra columns pass, so a bump doesn't fail other branches", () => {
    const have = { cols: [{ tbl: "tasks", col: "origin" }, { tbl: "tasks", col: "newer" }], objs: [{ type: "trigger", name: "g", sql: "CREATE TRIGGER g\nx" }] }
    expect(schemaGaps(want, have)).toEqual([])
  })

  test("a missing column and a changed trigger are each named", () => {
    expect(schemaGaps(want, { cols: [], objs: [{ type: "trigger", name: "g", sql: "CREATE TRIGGER g y" }] }))
      .toEqual(["column tasks.origin is missing", "trigger g is missing or differs"])
  })

  test("the committed subset loads, with the task guards and no FTS", () => {
    const names = (schemaDb().query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name)
    expect(names.sort()).toEqual(["tasks_origin_immutable", "tasks_queue_guard_ins", "tasks_queue_guard_upd"])
  })
})

describe("the bunfig preload", () => {
  const ROOT = join(import.meta.dir, "../..")
  const dir = mkdtempSync(join(tmpdir(), "cc-guard-fixture-"))
  const FIXTURE = join(dir, "fixture.test.ts")
  writeFileSync(FIXTURE, `console.log("FIXTURE-LOADED")\nimport { test } from "bun:test"\ntest("x", () => { console.log("REAL-FETCH", String(process.env.TURSO_AUTH_TOKEN), String(process.env.TURSO_DATABASE_URL)) })\n`)

  const run = async (env: Record<string, string>) => {
    const { TURSO_TEST_URL: _u, TURSO_TEST_AUTH_TOKEN: _t, TURSO_TEST_REQUIRED: _r, ...rest } = process.env
    const p = Bun.spawn(["bun", "test", "--isolate", FIXTURE], { cwd: ROOT, env: { ...rest, ...env }, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { all: out + err, code }
  }

  test("production's URL: refused before any test file loads", async () => {
    const r = await run({ TURSO_TEST_URL: `libsql://${PROD}`, TURSO_TEST_AUTH_TOKEN: "dummy" })
    expect(r.code).not.toBe(0)
    expect(r.all).toContain("refused")
    expect(r.all).not.toContain("FIXTURE-LOADED")
  }, 20_000)

  test("TURSO_TEST_REQUIRED with the vars missing: refused the same way", async () => {
    const r = await run({ TURSO_TEST_REQUIRED: "1" })
    expect(r.code).not.toBe(0)
    expect(r.all).toContain("TURSO_TEST_URL")
    expect(r.all).not.toContain("FIXTURE-LOADED")
  }, 20_000)

  test("nothing set, not required: the suite runs, with production's env replaced", async () => {
    const r = await run({ TURSO_AUTH_TOKEN: "looks-like-production", TURSO_DATABASE_URL: `libsql://${PROD}` })
    expect(r.code).toBe(0)
    expect(r.all).toContain("FIXTURE-LOADED")
    expect(r.all).toContain("REAL-FETCH test-token undefined")
    expect(r.all).not.toContain("looks-like-production")
  }, 20_000)
})
