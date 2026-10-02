import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { checkRecordExpiry, expiryDeps, startRecordsExpiry } from "../lib/records-expiry"
import { recordsDir, recordsPath } from "../lib/records-store"
import { recordPeer } from "../lib/vault-guard"
import { pendingPulls } from "../lib/vault-upstream"
import { handleRecordsRoute, resetRecordsLimits } from "./records"

// Upstream mode (the Mac): every /api/records* call goes to a fake upstream
// Companion; nothing is read or written locally, the pull command never runs,
// the expiry timer is inert.

process.env.COMPANION_AUTH_TOKEN = "vault-test-token-0123456789"
const TOKEN = getAuthToken()
const NUM = "UPSTREAM-FAKE-NUM-55K"
const ID = "abcdefghijk2"

interface Seen { method: string; path: string; search: string; auth: string | null; device: string | null; hop: string | null; body: string }
let seen: Seen[] = []
let respond: (s: Seen) => Response = () => Response.json({ ok: true })
let upstream: ReturnType<typeof Bun.serve>
let home = ""
let pullLog = ""
let stderr = ""
const realHome = process.env.HOME
const realWrite = process.stderr.write.bind(process.stderr)

beforeAll(() => {
  upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      const s: Seen = { method: req.method, path: u.pathname, search: u.search, auth: req.headers.get("authorization"), device: req.headers.get("x-companion-device"), hop: req.headers.get("x-companion-vault-hop"), body: await req.text() }
      seen.push(s)
      return respond(s)
    },
  })
})
afterAll(() => { upstream.stop(true) })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "records-up-"))
  process.env.HOME = home
  process.env.COMPANION_VAULT_UPSTREAM = `http://127.0.0.1:${upstream.port}`
  pullLog = join(home, "pulls.log")
  const pull = join(home, "pull.sh")
  writeFileSync(pull, `#!/bin/sh\necho pulled >> '${pullLog}'\n`)
  chmodSync(pull, 0o700)
  process.env.COMPANION_VAULT_PULL_CMD = pull
  seen = []
  respond = () => Response.json({ ok: true })
  resetRecordsLimits()
  stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
})
afterEach(async () => {
  await pendingPulls()
  process.stderr.write = realWrite
  delete process.env.COMPANION_VAULT_UPSTREAM
  delete process.env.COMPANION_VAULT_PULL_CMD
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

interface Reply { status: number; text: string; json: Record<string, any>; headers: Headers }

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-companion-device": "test-phone", authorization: `Bearer ${TOKEN}`, ...extra }
  const req = new Request(`http://localhost:4245${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  recordPeer(req, "127.0.0.1")
  const res = (await handleRecordsRoute(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : {}, headers: res.headers }
}

function nothingLocal(): void {
  expect(existsSync(recordsPath())).toBe(false)
  expect(existsSync(recordsDir())).toBe(false)
  expect(existsSync(pullLog)).toBe(false)
}

const via = `test-phone via ${hostname()}`

test("GET forwards, adds `upstream`, header-only auth, device + hop headers", async () => {
  respond = () => Response.json({ ok: true, writable: true, records: [{ id: ID, type: "passport", label: "Passport · CA", expiry_date: "2030-01-01", updated_at: "x" }] })
  const r = await call("GET", "/api/records")
  expect(r.status).toBe(200)
  expect(r.json).toMatchObject({ ok: true, writable: true, upstream: `127.0.0.1:${upstream.port}` })
  expect(r.json.records).toHaveLength(1)
  expect(seen).toMatchObject([{ method: "GET", path: "/api/records", search: "", auth: `Bearer ${TOKEN}`, device: via, hop: "1" }])
  nothingLocal()
})

test("POST / PATCH / DELETE forward body + status unchanged; no pull, no local file", async () => {
  respond = (s) => Response.json({ ok: true, id: ID }, { status: s.method === "POST" ? 201 : 200 })
  const fields = { document_number: NUM, expiry_date: "2030-01-01" }
  const c = await call("POST", "/api/records", { type: "passport", fields })
  expect(c.status).toBe(201)
  expect(c.json).toEqual({ ok: true, id: ID })
  expect(JSON.parse(seen[0]!.body)).toEqual({ type: "passport", fields })
  expect((await call("PATCH", `/api/records/${ID}`, { label: "x" })).status).toBe(200)
  expect((await call("DELETE", `/api/records/${ID}`)).status).toBe(200)
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/records", `PATCH /api/records/${ID}`, `DELETE /api/records/${ID}`])
  await pendingPulls()
  nothingLocal()
  expect(stderr).not.toContain(NUM)
})

test("reveal forwards (empty body), passes the record through with no-store + no-cache, never logs it", async () => {
  respond = () => Response.json({ ok: true, record: { id: ID, type: "passport", label: "P", fields: { document_number: NUM, expiry_date: "2030-01-01" }, created_at: "a", updated_at: "b" } })
  const r = await call("POST", `/api/records/${ID}/reveal`)
  expect(r.status).toBe(200)
  expect(r.json.record.fields.document_number).toBe(NUM)
  expect(r.headers.get("cache-control")).toBe("no-store")
  expect(r.headers.get("pragma")).toBe("no-cache")
  expect(seen).toMatchObject([{ method: "POST", path: `/api/records/${ID}/reveal`, body: "" }])
  expect(stderr).not.toContain(NUM)
  await pendingPulls()
  nothingLocal()
})

test("upstream errors pass through: 400, 429 + Retry-After, plain-text 401", async () => {
  respond = () => Response.json({ ok: false, error: "bad_date" }, { status: 400 })
  expect((await call("POST", "/api/records", { type: "passport", fields: { expiry_date: "x" } })).json.error).toBe("bad_date")
  respond = () => Response.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "Retry-After": "17" } })
  const r = await call("POST", `/api/records/${ID}/reveal`)
  expect(r.status).toBe(429)
  expect(r.headers.get("retry-after")).toBe("17")
  respond = () => new Response("Unauthorized", { status: 401 })
  const u = await call("GET", "/api/records")
  expect(u.status).toBe(401)
  expect(u.text).toBe("Unauthorized")
})

test("local-only answers: bad_json, malformed id; nothing forwarded", async () => {
  const req = new Request("http://localhost:4245/api/records", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "nope" })
  recordPeer(req, "127.0.0.1")
  expect((await (await handleRecordsRoute(req, new URL(req.url)))!.json() as { error: string }).error).toBe("bad_json")
  expect((await call("DELETE", "/api/records/BAD")).status).toBe(404)
  expect((await call("POST", "/api/records/BAD/reveal")).status).toBe(404)
  expect(seen).toEqual([])
})

test("hop header → 508 upstream_loop, unreachable → 502, redirect not followed → 502", async () => {
  const loop = await call("GET", "/api/records", undefined, { "x-companion-vault-hop": "1" })
  expect(loop.status).toBe(508)
  expect(loop.json.error).toBe("upstream_loop")
  expect(seen).toEqual([])

  respond = () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } })
  expect((await call("GET", "/api/records")).json.error).toBe("upstream_unreachable")

  process.env.COMPANION_VAULT_UPSTREAM = "http://127.0.0.1:1"
  const down = await call("POST", `/api/records/${ID}/reveal`)
  expect(down.status).toBe(502)
  expect(down.json.error).toBe("upstream_unreachable")
  nothingLocal()
})

test("expiry timer + check are inert in upstream mode", async () => {
  let pushes = 0
  const realPush = expiryDeps.push
  expiryDeps.push = async () => { pushes++; return { sent: 1, pruned: 0, total: 1 } }
  try {
    expect(await checkRecordExpiry()).toEqual([])
    startRecordsExpiry()()
    expect(pushes).toBe(0)
    nothingLocal()
  } finally {
    expiryDeps.push = realPush
  }
})
