import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { getAuthToken } from "../lib/auth"

// A valid JSON object with a wrong-typed field, through the real server: 400,
// never the 500 of a string method called on a number.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "wrong-type-body-")), "test.db")
process.env.COMPANION_AUTH_TOKEN ??= "wrong-type-body-test-token-0123456789"
const TOKEN = getAuthToken()

let server: { port: number; stop(force?: boolean): void }

beforeAll(async () => {
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
})
afterAll(() => server.stop(true))

const send = (method: string, path: string, body: unknown): Promise<Response> => fetch(`http://127.0.0.1:${server.port}${path}`, {
  method,
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body),
})

const WRONG: [string, string, Record<string, unknown>][] = [
  ["POST", "/api/register-token", { token: 5 }],
  ["POST", "/api/register-token", { token: "a".repeat(32), device_name: [] }],
  ["DELETE", "/api/register-token", { token: 5 }],
  ["POST", "/api/super-auto", { enabled: 5 }],
  ["DELETE", "/api/learned", { tool: 0 }],
  ["DELETE", "/api/learned", { tool: false }],
  ["POST", "/api/push/broadcast", { title: 5, body: "b" }],
  ["POST", "/api/push/broadcast", { title: "t", body: {} }],
  ["POST", "/api/spawn-session", { cwd: 5 }],
  ["POST", "/api/resolve", { id: 5, decision: "allow" }],
  ["POST", "/api/answer", { id: 5, answers: [{ selected: [] }] }],
  ["POST", "/api/inject", { text: 5 }],
  ["POST", "/api/inject", { text: "hi", key: 5 }],
  ["POST", "/api/inject", { text: "hi", cwd: 5 }],
  ["POST", "/api/orchestrator/send", { text: 5 }],
  ["POST", "/api/orchestrator/send", { text: "hi", channel: 5 }],
  ["POST", "/api/dialog/key", { key: 5, name: "Enter" }],
  ["POST", "/api/dialog/key", { key: "k", name: 5 }],
  ["POST", "/api/dialog/pick", { key: 5, index: 1 }],
  ["POST", "/api/model/open", { key: 5 }],
  ["POST", "/api/model/set", { key: 5, index: 1 }],
  ["POST", "/api/model/cancel", { key: 5 }],
  ["POST", "/api/command/suggest", { key: 5 }],
  ["POST", "/api/command/suggest", { key: "k", prefix: 5 }],
  ["POST", "/api/command/list", { key: 5 }],
  ["POST", "/hooks/pre-tool-use", { cwd: 5 }],
  ["POST", "/hooks/pre-tool-use", { tool_name: 5 }],
  ["POST", "/hooks/post-tool-use", { cwd: 5 }],
  ["POST", "/hooks/post-tool-use", { tool_name: 5 }],
  ["POST", "/hooks/user-prompt-submit", { session_id: 5 }],
  ["POST", "/hooks/user-prompt-submit", { cwd: 5 }],
  ["POST", "/hooks/user-prompt-submit", { prompt: 5 }],
  ["POST", "/hooks/permission-request", { cwd: 5 }],
  ["POST", "/hooks/permission-request", { tool_name: 5 }],
  ["POST", "/hooks/stop", { cwd: 5 }],
  ["POST", "/hooks/stop", { last_assistant_message: 5 }],
  ["POST", "/hooks/session-start", { cwd: 5 }],
  ["POST", "/hooks/session-end", { session_id: {} }],
]

test.each(WRONG)("%s %s %j answers 400", async (method, path, body) => {
  const res = await send(method, path, body)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ ok: false, error: "bad_json" })
})

test("a non-object tool_input answers 400 instead of waiting on the phone", async () => {
  for (const path of ["/hooks/pre-tool-use", "/hooks/permission-request"]) {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST", body: JSON.stringify({ tool_name: "Bash", tool_input: 5 }), signal: AbortSignal.timeout(1000),
    })
    expect(res.status).toBe(400)
  }
})

test("a null answers entry keeps the route's invalid-args", async () => {
  const res = await send("POST", "/api/answer", { id: "x", answers: [null] })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ ok: false, error: "invalid-args" })
})

test("a tool's own non-string input is not a bad body: the hook still answers", async () => {
  const res = await send("POST", "/hooks/post-tool-use", { tool_name: "Bash", tool_input: { command: 5 } })
  expect(res.status).toBe(200)
})

test("the bodies iOS really sends still go through (a 400 would drop the row)", async () => {
  expect(await (await send("POST", "/api/resolve", { id: "no-such-id", decision: "allow" })).json()).toEqual({ ok: false, reason: "gone" })
  expect(await (await send("POST", "/api/answer", { id: "no-such-id", answers: [{ selected: ["a"], otherText: "o" }, { selected: [] }] })).json())
    .toEqual({ ok: false, reason: "gone" })
  expect((await send("POST", "/api/register-token", { token: "b".repeat(32), environment: "sandbox", device_name: "iPhone" })).status).toBe(200)
})

test("the iOS SUPER toggle logs who sent it, and an unfiltered learned wipe still works", async () => {
  const flag = join(mkdtempSync(join(tmpdir(), "wrong-type-super-")), "super-auto.flag")
  process.env.COMPANION_SUPER_FLAG = flag
  try {
    expect((await send("POST", "/api/super-auto", { enabled: true })).status).toBe(200)
    expect((await send("POST", "/api/super-auto", { enabled: false })).status).toBe(200)
  } finally {
    delete process.env.COMPANION_SUPER_FLAG
  }
  const row = JSON.parse(readFileSync(join(dirname(flag), "super-auto-changes.jsonl"), "utf8").trim().split("\n").at(-1) ?? "") as { source: string; new: boolean }
  expect(row.new).toBe(false)
  expect(row.source).toContain("from=127.0.0.1")
  expect((await send("DELETE", "/api/learned", {})).status).toBe(200)
})

test("null stays an absent optional field", async () => {
  expect((await send("POST", "/hooks/session-start", { cwd: null, session_id: "s" })).status).toBe(200)
})
