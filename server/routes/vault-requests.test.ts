import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REQUEST_TTL_MS, requestDeps, resetSecretRequests } from "../lib/secret-requests"
import { vaultDeps } from "../lib/secret-store"
import { clock, recordPeer, resetVaultLimits } from "../lib/vault-guard"
import { handleVaultRoute } from "./vault"

// Agent-initiated secret requests. Drives handleVaultRoute directly (as
// vault.test.ts does); sync is mocked through vaultDeps, WS + push through
// requestDeps. The last test runs the real ask-secret CLI against a Bun.serve.

const TOKEN = "vault-test-token-0123456789"
process.env.COMPANION_AUTH_TOKEN = TOKEN
const SECRET = "phx_SEKRET-VALUE-77ab31"
const realSync = vaultDeps.sync
const realDeps = { ...requestDeps }
const realNow = clock.now
const realWrite = process.stderr.write.bind(process.stderr)
let store = ""
let syncCalls = 0
let events: Record<string, unknown>[] = []
let pushes: string[] = []
let stderr = ""

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "vault-req-"))
  store = process.env.TLS_SECRETS_FILE = join(dir, "secrets.env")
  process.env.TLS_VAULT_AUDIT_FILE = join(dir, "vault-audit.jsonl")
  writeFileSync(store, "A_KEY='1'  # a.io\n", { mode: 0o600 })
  process.env.TLS_SECRETS_TOOL = join(dir, "tls-secrets.py")
  writeFileSync(process.env.TLS_SECRETS_TOOL, "")
  resetVaultLimits()
  resetSecretRequests()
  syncCalls = 0
  vaultDeps.sync = async () => { syncCalls++; return { ok: true, detail: "" } }
  events = []
  pushes = []
  requestDeps.broadcast = (d) => { events.push(d) }
  requestDeps.push = (name, reason, id) => { pushes.push(`${name}|${reason}|${id}`) }
  stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
})
afterEach(() => {
  vaultDeps.sync = realSync
  Object.assign(requestDeps, realDeps)
  clock.now = realNow
  process.stderr.write = realWrite
})

interface Reply { status: number; text: string; json: Record<string, unknown> }

async function call(method: string, path: string, body?: unknown, auth = true, peer = "127.0.0.1"): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-companion-device": "test-phone" }
  if (auth) headers.authorization = `Bearer ${TOKEN}`
  const req = new Request(`http://localhost:4245${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  recordPeer(req, peer)
  const res = (await handleVaultRoute(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : {} }
}

const ASK = { name: "POSTHOG_PERSONAL_KEY", hosts: ["us.posthog.com"], reason: "/today mockup views", session_id: "sess-1" }

async function create(body: Record<string, unknown> = ASK): Promise<string> {
  const r = await call("POST", "/api/vault/requests", body)
  expect(r.status).toBe(200)
  return String(r.json.id)
}

test("(a) create → pending, WS secret_request + push, no value anywhere", async () => {
  const id = await create()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "secret_request", id, name: ASK.name, hosts: ASK.hosts, reason: ASK.reason, session_id: "sess-1" })
  expect(Object.keys(events[0]!).sort()).toEqual(["expires_at", "hosts", "id", "name", "reason", "session_id", "type"])
  expect(pushes).toEqual([`${ASK.name}|${ASK.reason}|${id}`])
  expect((await call("GET", `/api/vault/requests/${id}`)).json).toMatchObject({ ok: true, id, status: "pending" })
  const list = await call("GET", "/api/vault/requests?status=pending")
  expect((list.json.requests as { id: string }[]).map((r) => r.id)).toEqual([id])
  expect(stderr).toContain(`vault request ${id} ${ASK.name} pending`)
})

test("create validates name / hosts / reason / session", async () => {
  for (const bad of [
    { ...ASK, name: "lower" },
    { ...ASK, hosts: [] },
    { ...ASK, hosts: ["evil io"] },
    { ...ASK, reason: "" },
    { ...ASK, reason: "x".repeat(201) },
    { ...ASK, reason: "two\nlines" },
    { ...ASK, session_id: "a b" },
  ]) {
    resetVaultLimits() // creates have their own 3/min budget
    expect((await call("POST", "/api/vault/requests", bad)).status).toBe(400)
  }
  expect(events).toHaveLength(0)
})

test("(b) fulfil saves via the vault upsert + sync; status=saved; resolved event", async () => {
  const id = await create()
  const r = await call("POST", `/api/vault/requests/${id}/fulfil`, { value: SECRET })
  expect(r.status).toBe(200)
  expect(r.json).toMatchObject({ ok: true, id, status: "saved", name: ASK.name, hosts: ASK.hosts })
  expect(r.text).not.toContain(SECRET)
  expect(syncCalls).toBe(1)
  expect(readFileSync(store, "utf8")).toBe(`A_KEY='1'  # a.io\n${ASK.name}='${SECRET}'  # us.posthog.com\n`)
  expect(events[1]).toEqual({ type: "secret_request_resolved", id, status: "saved" })
  expect((await call("GET", `/api/vault/requests/${id}`)).json.status).toBe("saved")
})

test("(c) second fulfil 409, decline path, expired 410, unknown 404", async () => {
  const id = await create()
  expect((await call("POST", `/api/vault/requests/${id}/fulfil`, { value: SECRET })).status).toBe(200)
  expect((await call("POST", `/api/vault/requests/${id}/fulfil`, { value: "other" })).status).toBe(409)
  expect((await call("POST", `/api/vault/requests/${id}/decline`)).status).toBe(409)
  expect(syncCalls).toBe(1)

  const d = await create({ ...ASK, name: "OTHER_KEY" })
  expect((await call("POST", `/api/vault/requests/${d}/decline`)).json).toMatchObject({ ok: true, status: "declined" })
  expect(events.at(-1)).toEqual({ type: "secret_request_resolved", id: d, status: "declined" })
  expect((await call("GET", `/api/vault/requests/${d}`)).json.status).toBe("declined")
  expect((await call("POST", `/api/vault/requests/${d}/fulfil`, { value: SECRET })).status).toBe(409)

  const e = await create({ ...ASK, name: "THIRD_KEY" })
  const t0 = Date.now()
  clock.now = () => t0 + REQUEST_TTL_MS + 1
  expect((await call("GET", `/api/vault/requests/${e}`)).json.status).toBe("expired")
  expect((await call("POST", `/api/vault/requests/${e}/fulfil`, { value: SECRET })).status).toBe(410)
  expect((await call("POST", `/api/vault/requests/${e}/decline`)).status).toBe(410)

  const unknown = "00000000-0000-4000-8000-000000000000"
  expect((await call("POST", `/api/vault/requests/${unknown}/fulfil`, { value: SECRET })).status).toBe(404)
  expect((await call("GET", `/api/vault/requests/${unknown}`)).status).toBe(404)
  expect(syncCalls).toBe(1)
})

test("create refuses a name already in the vault (409 exists), hosts unchanged", async () => {
  const r = await call("POST", "/api/vault/requests", { ...ASK, name: "A_KEY", hosts: ["evil.io"] })
  expect(r.status).toBe(409)
  expect(r.json.error).toBe("exists")
  expect(readFileSync(store, "utf8")).toBe("A_KEY='1'  # a.io\n")
  expect(events).toHaveLength(0)
  expect(pushes).toHaveLength(0)
})

test("open-request cap (5 total, 1 per name) + own create budget; fulfil still 200", async () => {
  const first = await create()
  const dup = await call("POST", "/api/vault/requests", ASK)
  expect(dup.status).toBe(429)
  expect(dup.json.error).toBe("too_many_pending")
  await create({ ...ASK, name: "KEY_2" })
  // 3/min create budget is spent (the 429 dup counted too).
  const limited = await call("POST", "/api/vault/requests", { ...ASK, name: "KEY_X" })
  expect(limited.json.error).toBe("rate_limited")
  resetVaultLimits()
  for (const n of ["KEY_3", "KEY_4", "KEY_5"]) await create({ ...ASK, name: n })
  resetVaultLimits()
  const full = await call("POST", "/api/vault/requests", { ...ASK, name: "KEY_6" })
  expect(full.status).toBe(429)
  expect(full.json.error).toBe("too_many_pending")
  expect((await call("POST", `/api/vault/requests/${first}/fulfil`, { value: SECRET })).status).toBe(200)
})

test("a slow save past the TTL reports pending, then saved — never expired", async () => {
  const id = await create()
  const t0 = Date.now()
  let release = (): void => {}
  vaultDeps.sync = () => new Promise((resolve) => {
    syncCalls++
    clock.now = () => t0 + REQUEST_TTL_MS + 1
    release = () => resolve({ ok: true, detail: "" })
  })
  const f = call("POST", `/api/vault/requests/${id}/fulfil`, { value: SECRET })
  for (let i = 0; i < 100 && syncCalls === 0; i++) await Bun.sleep(10)
  expect(syncCalls).toBe(1)
  expect((await call("GET", `/api/vault/requests/${id}`)).json.status).toBe("pending")
  expect((await call("POST", `/api/vault/requests/${id}/decline`)).status).toBe(410)
  release()
  expect((await f).status).toBe(200)
  expect((await call("GET", `/api/vault/requests/${id}`)).json.status).toBe("saved")
})

test("(d) fulfil ignores name/hosts from the client", async () => {
  const id = await create()
  const r = await call("POST", `/api/vault/requests/${id}/fulfil`, { value: SECRET, name: "A_KEY", hosts: ["evil.io"] })
  expect(r.json).toMatchObject({ name: ASK.name, hosts: ASK.hosts })
  const file = readFileSync(store, "utf8")
  expect(file).toContain("A_KEY='1'  # a.io\n")
  expect(file).toContain(`${ASK.name}='${SECRET}'  # us.posthog.com\n`)
  expect(file).not.toContain("evil.io")
})

test("bad value / sync failure leave the request pending (retryable)", async () => {
  const id = await create()
  expect((await call("POST", `/api/vault/requests/${id}/fulfil`, { value: `${SECRET}'` })).status).toBe(400)
  vaultDeps.sync = async () => ({ ok: false, detail: `boom ${SECRET}` })
  const f = await call("POST", `/api/vault/requests/${id}/fulfil`, { value: SECRET })
  expect(f.status).toBe(500)
  expect(f.text).not.toContain(SECRET)
  expect((await call("GET", `/api/vault/requests/${id}`)).json.status).toBe("pending")
  vaultDeps.sync = async () => ({ ok: true, detail: "" })
  expect((await call("POST", `/api/vault/requests/${id}/fulfil`, { value: SECRET })).status).toBe(200)
  expect(stderr).not.toContain(SECRET)
})

test("(e) gates: non-tailnet 403, no bearer 401 on every request route", async () => {
  const id = await create()
  const routes: [string, string, unknown][] = [
    ["POST", "/api/vault/requests", ASK],
    ["GET", "/api/vault/requests?status=pending", undefined],
    ["GET", `/api/vault/requests/${id}`, undefined],
    ["POST", `/api/vault/requests/${id}/fulfil`, { value: SECRET }],
    ["POST", `/api/vault/requests/${id}/decline`, undefined],
  ]
  for (const [m, p, b] of routes) {
    expect((await call(m, p, b, true, "192.168.1.20")).status).toBe(403)
    expect((await call(m, p, b, false)).status).toBe(401)
  }
  expect((await call("GET", `/api/vault/requests/${id}`)).json.status).toBe("pending")
  expect(syncCalls).toBe(0)
})

test("long-poll GET returns as soon as the request resolves", async () => {
  const id = await create()
  const poll = call("GET", `/api/vault/requests/${id}?wait=5`)
  await Bun.sleep(300)
  await call("POST", `/api/vault/requests/${id}/decline`)
  expect((await poll).json.status).toBe("declined")
})

test("(f) ask-secret CLI: saved line, exit 0, value never in its output or the server log", async () => {
  process.stderr.write = realWrite
  let log = ""
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      recordPeer(req, srv.requestIP(req)?.address)
      const res = await handleVaultRoute(req, new URL(req.url))
      return res ?? new Response("nope", { status: 404 })
    },
  })
  process.stderr.write = ((chunk: string | Uint8Array) => { log += String(chunk); return true }) as typeof process.stderr.write
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/ask-secret.ts"), ASK.name, "--host", "us.posthog.com", "--why", "mockup views"], {
      env: { ...process.env, COMPANION_URL: `http://127.0.0.1:${server.port}`, COMPANION_AUTH_TOKEN: TOKEN },
      stdout: "pipe",
      stderr: "pipe",
    })
    let id = ""
    for (let i = 0; i < 100 && !id; i++) {
      await Bun.sleep(50)
      id = String(events.find((e) => e.type === "secret_request")?.id ?? "")
    }
    expect(id).not.toBe("")
    expect((await call("POST", `/api/vault/requests/${id}/fulfil`, { value: SECRET })).status).toBe(200)
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(code).toBe(0)
    expect(out).toBe(`saved ${ASK.name} (hosts: us.posthog.com) — available in new sessions\n`)
    expect(`${out}${err}${log}`.split(SECRET).length - 1).toBe(0)
    expect(log).toContain(`vault request ${id} ${ASK.name} saved`)
  } finally {
    server.stop(true)
  }
})

test("ask-secret refuses extra args (no way to pass a value) and prints declined / exit 2", async () => {
  const bad = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../scripts/ask-secret.ts"), ASK.name, SECRET, "--host", "a.io", "--why", "x"], { stdout: "pipe", stderr: "pipe" })
  expect(bad.exitCode).toBe(64)
  expect(`${bad.stdout}${bad.stderr}`).not.toContain(SECRET)

  process.stderr.write = realWrite
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      recordPeer(req, srv.requestIP(req)?.address)
      return (await handleVaultRoute(req, new URL(req.url))) ?? new Response("nope", { status: 404 })
    },
  })
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/ask-secret.ts"), ASK.name, "--host", "us.posthog.com", "--why", "x"], {
      env: { ...process.env, COMPANION_URL: `http://127.0.0.1:${server.port}`, COMPANION_AUTH_TOKEN: TOKEN },
      stdout: "pipe",
      stderr: "pipe",
    })
    let id = ""
    for (let i = 0; i < 100 && !id; i++) {
      await Bun.sleep(50)
      id = String(events.find((e) => e.type === "secret_request")?.id ?? "")
    }
    await call("POST", `/api/vault/requests/${id}/decline`)
    expect(await new Response(proc.stdout).text()).toBe("declined\n")
    expect(await proc.exited).toBe(2)
  } finally {
    server.stop(true)
  }
})
