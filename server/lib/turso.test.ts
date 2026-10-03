import { afterEach, expect, test } from "bun:test"
import { TursoUnreachable, tursoExec, tursoQuery } from "./turso"

// tursoExec (P2 guarded writes) reads affected_row_count; errors stay generic.

const realFetch = globalThis.fetch
const savedToken = process.env.TURSO_AUTH_TOKEN

afterEach(() => {
  globalThis.fetch = realFetch
  if (savedToken === undefined) delete process.env.TURSO_AUTH_TOKEN
  else process.env.TURSO_AUTH_TOKEN = savedToken
})

function respond(body: unknown, status = 200): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

test("tursoExec returns rows and the affected row count", async () => {
  process.env.TURSO_AUTH_TOKEN = "test-token"
  respond({ results: [{ type: "ok", response: { result: { cols: [], rows: [], affected_row_count: 1 } } }, { type: "ok" }] })
  expect(await tursoExec("UPDATE tasks SET x = ? WHERE id = ?", ["a", "b"])).toEqual({ rows: [], affected: 1 })
  respond({ results: [{ type: "ok", response: { result: { cols: [{ name: "n" }], rows: [[{ type: "integer", value: "3" }]] } } }] })
  expect(await tursoQuery("SELECT 3 AS n", [])).toEqual([{ n: 3 }])
})

test("a failed statement or HTTP error is a generic TursoUnreachable (no SQL in the message)", async () => {
  process.env.TURSO_AUTH_TOKEN = "test-token"
  respond({ results: [{ type: "error", error: { message: "no such table" } }] })
  const err = await tursoExec("UPDATE secret_sql", []).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(TursoUnreachable)
  expect((err as Error).message).not.toContain("secret_sql")
  respond({}, 500)
  expect(await tursoExec("UPDATE x", []).catch((e: unknown) => (e as Error).message)).toBe("turso unreachable: http 500")
})
