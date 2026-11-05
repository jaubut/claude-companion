import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { isSuperAuto, setSuperAutoInMemoryForTests } from "../lib/super-auto"

// A JSON body that is not an object, through the real server: 400, never the
// 500 of a field read on null, and never a handler run on an array.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "non-object-body-")), "test.db")
process.env.COMPANION_AUTH_TOKEN ??= "non-object-body-test-token-0123456789"
const TOKEN = getAuthToken()

let server: { port: number; stop(force?: boolean): void }

beforeAll(async () => {
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
})
afterAll(() => server.stop(true))

const post = (path: string, body: string): Promise<Response> => fetch(`http://127.0.0.1:${server.port}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  body,
})

for (const path of ["/api/shell/close", "/api/resolve", "/api/inject", "/api/model/open", "/hooks/session-start"]) {
  test.each(["null", "[]", "7"])(`${path} answers 400 to %s`, async (body) => {
    const res = await post(path, body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: "bad_json" })
  })
}

test("a non-object body changes nothing: SUPER stays on", async () => {
  setSuperAutoInMemoryForTests(true)
  try {
    expect((await post("/api/super-auto", "[]")).status).toBe(400)
    expect(isSuperAuto()).toBe(true)
  } finally {
    setSuperAutoInMemoryForTests(false)
  }
})

test("/api/shell/close keeps treating malformed JSON as an empty body", async () => {
  const res = await post("/api/shell/close", "{bad")
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ ok: false, error: "bad_name" })
})

test("a valid object still reaches the route", async () => {
  const res = await post("/api/shell/close", '{"name":7}')
  expect(await res.json()).toEqual({ ok: false, error: "bad_name" })
})
