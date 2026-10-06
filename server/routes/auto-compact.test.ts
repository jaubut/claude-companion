import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { recordSession } from "../lib/sessions"

// Route-level: POST /api/auto-compact/test through the real server's auth
// gate. The happy path (countdown → inject) is covered in lib/auto-compact.test.ts.

const dir = mkdtempSync(join(tmpdir(), "auto-compact-route-"))
process.env.COMPANION_DB_PATH ??= join(dir, "test.db")
process.env.COMPANION_AUTH_TOKEN ??= "autocompact-test-token-0123456789ab"
const TOKEN = getAuthToken()

let server: { port: number; stop(force?: boolean): void }
const prevTokens = process.env.AUTO_COMPACT_TOKENS

beforeAll(async () => {
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
})
afterAll(() => {
  server.stop(true)
  if (prevTokens === undefined) delete process.env.AUTO_COMPACT_TOKENS
  else process.env.AUTO_COMPACT_TOKENS = prevTokens
})

function post(body: unknown, auth = `Bearer ${TOKEN}`): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/auto-compact/test`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  })
}

describe("POST /api/auto-compact/test", () => {
  test("bearer required", async () => {
    expect((await post({ key: "x" }, "")).status).toBe(401)
  })

  test("key required; unknown session → 404", async () => {
    expect((await post({})).status).toBe(400)
    expect(await (await post({ key: "claude:tty:/dev/nope" })).json()).toEqual({ ok: false, error: "session_not_found" })
  })

  test("feature off → 409 off", async () => {
    delete process.env.AUTO_COMPACT_TOKENS
    const s = recordSession({ cwd: "/tmp/ac-off", sessionId: "ac-sid-off", tty: "/dev/ttys801", agentStatus: "idle" })!
    const res = await post({ key: s.key })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: "off" })
  })

  test("busy session → 409 busy", async () => {
    process.env.AUTO_COMPACT_TOKENS = "600000"
    const s = recordSession({ cwd: "/tmp/ac-busy", sessionId: "ac-sid-busy", tty: "/dev/ttys802", agentStatus: "busy" })!
    const res = await post({ key: s.key })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: "busy" })
  })

  test("idle session without a transcript → 422, nothing armed", async () => {
    process.env.AUTO_COMPACT_TOKENS = "600000"
    const s = recordSession({ cwd: `/tmp/ac-none-${Date.now()}`, sessionId: "ac-sid-none", tty: "/dev/ttys803", agentStatus: "idle" })!
    const res = await post({ key: s.key })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ ok: false, error: "transcript_unreadable" })
    const get = await fetch(`http://127.0.0.1:${server.port}/api/auto-compact`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(((await get.json()) as { pending: unknown[] }).pending).toEqual([])
  })
})
