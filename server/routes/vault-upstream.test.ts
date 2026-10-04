import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { handleKeyCommand, vaultDeps } from "../lib/secret-store"
import { recordPeer, resetVaultLimits } from "../lib/vault-guard"
import { parseUpstream, pendingPulls } from "../lib/vault-upstream"
import { handleVaultRoute } from "./vault"

// Upstream mode: a fake upstream Companion (Bun.serve, ephemeral port) stands
// in for Zettlab. The route + /key paths must forward to it, map its replies
// through, run the pull command after each successful write, and never leak
// the value. With the env unset, behaviour must match the local store exactly.

// Same fixture token as vault.test.ts: auth.ts caches the first one it reads
// and both files share one bun test process.
process.env.COMPANION_AUTH_TOKEN = "vault-test-token-0123456789"
const TOKEN = getAuthToken()
const SECRET = "UPSTREAM-SEKRET-7d1e"
const FILE = "A_KEY='1'  # a.io\n"

interface Seen { method: string; path: string; search: string; auth: string | null; device: string | null; hop: string | null; body: string }
let seen: Seen[] = []
let respond: (s: Seen) => Response = () => Response.json({ ok: true })
let upstream: ReturnType<typeof Bun.serve>
let dir = ""
let store = ""
let pullLog = ""
let stderr = ""
let syncCalls = 0
const realWrite = process.stderr.write.bind(process.stderr)
const realSync = vaultDeps.sync

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
  dir = mkdtempSync(join(tmpdir(), "vault-upstream-"))
  store = process.env.TLS_SECRETS_FILE = join(dir, "secrets.env")
  process.env.TLS_VAULT_AUDIT_FILE = join(dir, "vault-audit.jsonl")
  process.env.TLS_SECRETS_TOOL = join(dir, "tls-secrets.py") // absent = Mac-like host
  writeFileSync(store, FILE, { mode: 0o600 })
  process.env.COMPANION_VAULT_UPSTREAM = `http://127.0.0.1:${upstream.port}`
  pullLog = join(dir, "pulls.log")
  const pull = join(dir, "pull.sh")
  writeFileSync(pull, `#!/bin/sh\necho pulled >> '${pullLog}'\necho "${SECRET}-stdout"\n`)
  chmodSync(pull, 0o700)
  process.env.COMPANION_VAULT_PULL_CMD = pull
  seen = []
  respond = () => Response.json({ ok: true })
  resetVaultLimits()
  syncCalls = 0
  vaultDeps.sync = async () => { syncCalls++; return { ok: true, detail: "" } }
  stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
})
afterEach(async () => {
  await pendingPulls()
  process.stderr.write = realWrite
  vaultDeps.sync = realSync
  delete process.env.COMPANION_VAULT_UPSTREAM
  delete process.env.COMPANION_VAULT_PULL_CMD
  rmSync(dir, { recursive: true, force: true })
})

interface Reply { status: number; text: string; json: Record<string, unknown>; headers: Headers }

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-companion-device": "test-phone", authorization: `Bearer ${TOKEN}`, ...extra }
  const req = new Request(`http://localhost:4245${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  recordPeer(req, "127.0.0.1")
  const res = (await handleVaultRoute(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : {}, headers: res.headers }
}

async function pulls(): Promise<number> {
  await pendingPulls()
  return existsSync(pullLog) ? readFileSync(pullLog, "utf8").split("\n").filter(Boolean).length : 0
}

const via = (device: string) => `${device} via ${hostname()}`

test("config: https or local http only, no credentials/query; invalid → ignored with one log line", async () => {
  expect(parseUpstream("https://zettlab.tailfc45f2.ts.net/")).toEqual({ base: "https://zettlab.tailfc45f2.ts.net", host: "zettlab.tailfc45f2.ts.net" })
  expect(parseUpstream("http://127.0.0.1:4245")?.host).toBe("127.0.0.1:4245")
  expect(parseUpstream("http://localhost:4245")?.base).toBe("http://localhost:4245")
  for (const bad of ["http://zettlab.tailfc45f2.ts.net", "http://100.64.0.1:4245", "ftp://x.io", "https://u:p@x.io", "https://x.io/?token=a", "nope"]) {
    expect(parseUpstream(bad)).toBeNull()
  }
  process.env.COMPANION_VAULT_UPSTREAM = "http://evil.example.com"
  for (let i = 0; i < 3; i++) expect((await call("POST", "/api/vault", { name: "C_KEY", value: SECRET })).status).toBe(501)
  expect(stderr.match(/vault upstream ignored/g)?.length).toBe(1)
  expect(seen).toEqual([])
})

test("GET passes the upstream list through, adds `upstream`, writable comes from upstream", async () => {
  respond = () => Response.json({ ok: true, writable: true, secrets: [{ name: "FAL_KEY", hosts: ["*.fal.run"], scripts: false, updated_at: null }] })
  const r = await call("GET", "/api/vault")
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true, writable: true, secrets: [{ name: "FAL_KEY", hosts: ["*.fal.run"], scripts: false, updated_at: null }], upstream: `127.0.0.1:${upstream.port}` })
  expect(r.headers.get("cache-control")).toBe("no-store")
  expect(seen).toMatchObject([{ method: "GET", path: "/api/vault", search: "", auth: `Bearer ${TOKEN}`, device: via("test-phone"), hop: "1" }])
  expect(await pulls()).toBe(0)
})

test("POST + /api/secret forward the body, header-only auth, device header; local store untouched, no 501", async () => {
  respond = (s) => Response.json({ ok: true, name: "C_KEY", hosts: ["c.io"], action: s.path === "/api/vault" ? "created" : "?", message: "ok" })
  const r = await call("POST", "/api/vault", { name: "C_KEY", value: SECRET, hosts: ["c.io"] })
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true, name: "C_KEY", hosts: ["c.io"], action: "created", message: "ok" })
  const a = await call("POST", "/api/secret", { name: "C_KEY", value: SECRET }, { "x-companion-device": "x".repeat(80) })
  expect(a.status).toBe(200)
  expect(seen.map((s) => [s.method, s.path, s.search])).toEqual([["POST", "/api/vault", ""], ["POST", "/api/vault", ""]])
  expect(JSON.parse(seen[0]!.body)).toEqual({ name: "C_KEY", value: SECRET, hosts: ["c.io"] })
  expect(seen[0]).toMatchObject({ auth: `Bearer ${TOKEN}`, device: via("test-phone"), hop: "1" })
  expect(seen[1]!.device!.length).toBeLessThanOrEqual(64)
  expect(seen[1]!.device!.endsWith(` via ${hostname()}`)).toBe(true)
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)
  expect(await pulls()).toBe(2)
})

test("PATCH + DELETE forward to /api/vault/:name; bad local name never leaves", async () => {
  respond = (s) => Response.json({ ok: true, name: "A_KEY", hosts: s.method === "PATCH" ? ["b.io"] : [], action: s.method === "PATCH" ? "hosts" : "deleted", message: "m" })
  expect((await call("PATCH", "/api/vault/A_KEY", { hosts: ["b.io"] })).json).toMatchObject({ action: "hosts", hosts: ["b.io"] })
  expect((await call("DELETE", "/api/vault/A_KEY")).json).toMatchObject({ action: "deleted" })
  expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([["PATCH", "/api/vault/A_KEY", JSON.stringify({ hosts: ["b.io"] })], ["DELETE", "/api/vault/A_KEY", ""]])
  expect((await call("DELETE", "/api/vault/..%2Fapi%2Finject")).json).toMatchObject({ error: "bad_name" })
  expect((await call("PATCH", "/api/vault/A_KEY", [1])).json).toMatchObject({ error: "bad_json" })
  expect(seen.length).toBe(2)
  expect(await pulls()).toBe(2)
})

test("4xx passthrough: bad_name body unchanged, 429 keeps Retry-After; no pull on failure", async () => {
  const badName = JSON.stringify({ ok: false, error: "bad_name", message: "NOM en MAJUSCULES_ET_CHIFFRES (2–64)" })
  respond = () => new Response(badName, { status: 400, headers: { "content-type": "application/json" } })
  const b = await call("POST", "/api/vault", { name: "C_KEY", value: SECRET })
  expect([b.status, b.text]).toEqual([400, badName])
  respond = () => Response.json({ ok: false, error: "rate_limited", retry_after: 42 }, { status: 429, headers: { "Retry-After": "42" } })
  const r = await call("DELETE", "/api/vault/A_KEY")
  expect(r.status).toBe(429)
  expect(r.headers.get("retry-after")).toBe("42")
  expect(r.json).toEqual({ ok: false, error: "rate_limited", retry_after: 42 })
  respond = () => new Response("Unauthorized", { status: 401 })
  expect((await call("GET", "/api/vault")).status).toBe(401)
  expect(await pulls()).toBe(0)
})

test("local gates still run first: 11th write → local 429, never forwarded", async () => {
  for (let i = 0; i < 10; i++) expect((await call("DELETE", "/api/vault/A_KEY")).status).toBe(200)
  const r = await call("DELETE", "/api/vault/A_KEY")
  expect(r.status).toBe(429)
  expect(seen.length).toBe(10)
  const q = new Request(`http://localhost:4245/api/vault?token=${TOKEN}`)
  recordPeer(q, "127.0.0.1")
  expect((await handleVaultRoute(q, new URL(q.url)))!.status).toBe(401)
  const lan = new Request("http://localhost:4245/api/vault", { headers: { authorization: `Bearer ${TOKEN}` } })
  recordPeer(lan, "192.168.1.20")
  expect((await handleVaultRoute(lan, new URL(lan.url)))!.status).toBe(403)
  expect(seen.length).toBe(10)
})

test("forwarded call arriving on a server in upstream mode → 508, not forwarded again", async () => {
  const r = await call("POST", "/api/vault", { name: "C_KEY", value: SECRET }, { "x-companion-vault-hop": "1" })
  expect(r.status).toBe(508)
  expect(seen).toEqual([])
})

test("upstream down / redirect → 502 upstream_unreachable, no pull, no value anywhere", async () => {
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const port = dead.port
  dead.stop(true)
  process.env.COMPANION_VAULT_UPSTREAM = `http://127.0.0.1:${port}`
  const r = await call("POST", "/api/vault", { name: "C_KEY", value: SECRET })
  expect(r.status).toBe(502)
  expect(r.json).toMatchObject({ ok: false, error: "upstream_unreachable" })
  const k = await handleKeyCommand(`/key C_KEY ${SECRET}`)
  expect(k).toMatchObject({ ok: false, status: 502, error: "upstream_unreachable" })

  process.env.COMPANION_VAULT_UPSTREAM = `http://127.0.0.1:${upstream.port}`
  respond = () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/api/vault" } })
  expect((await call("POST", "/api/vault", { name: "C_KEY", value: SECRET })).status).toBe(502)
  expect(await pulls()).toBe(0)
  for (const out of [r.text, JSON.stringify(k), stderr]) expect(out).not.toContain(SECRET)
})

test("/key via /api/inject and WS input goes upstream; value never in log, response, WS frame, feed", async () => {
  process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "vault-up-inject-")), "test.db")
  respond = () => Response.json({ ok: true, name: "C_KEY", hosts: ["c.io"], action: "created", message: "🔑 C_KEY enregistré" })
  const { handleApiRoute } = await import("./api")
  const { clients } = await import("../state")
  const { getFeed } = await import("../lib/feed")
  const sent: string[] = []
  const fake = { send: (m: string) => { sent.push(m) } } as unknown as Parameters<typeof clients.add>[0]
  clients.add(fake)
  try {
    const req = new Request("http://localhost:4245/api/inject", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-companion-device": "iPhone 17" },
      body: JSON.stringify({ text: `/key C_KEY ${SECRET} --hosts c.io` }),
    })
    recordPeer(req, "127.0.0.1")
    const res = (await handleApiRoute(req, new URL(req.url)))!
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ ok: true, name: "C_KEY", action: "created" })
    expect(seen).toMatchObject([{ method: "POST", path: "/api/vault", auth: `Bearer ${TOKEN}`, device: via("iPhone 17") }])
    expect(JSON.parse(seen[0]!.body)).toEqual({ name: "C_KEY", value: SECRET, hosts: ["c.io"] })

    const { websocket } = await import("../ws")
    const { dialogWatcher } = await import("../wiring/dialogs")
    dialogWatcher.stop()
    const { keyCommandGate } = await import("../lib/vault-guard")
    const up = new Request("http://localhost:4245/ws", { headers: { authorization: `Bearer ${TOKEN}` } })
    recordPeer(up, "127.0.0.1")
    const got: string[] = []
    const ws = { send: (m: string) => { got.push(m) }, data: { id: "w", keyGate: keyCommandGate(up) } }
    await websocket.message!(ws as never, JSON.stringify({ type: "input", text: `/key D_KEY ${SECRET}` }))
    expect(JSON.parse(got[0]!)).toMatchObject({ type: "key_saved", ok: true })
    expect(seen.length).toBe(2)
    expect(JSON.parse(seen[1]!.body)).toEqual({ name: "D_KEY", value: SECRET, hosts: [] })

    expect(await pulls()).toBe(2)
    expect(stderr).toContain("vault pull exit=0")
    for (const out of [text, stderr, sent.join("\n"), got.join("\n"), JSON.stringify(getFeed())]) expect(out).not.toContain(SECRET)
    expect(readFileSync(store, "utf8")).toBe(FILE)
    expect(existsSync(process.env.TLS_VAULT_AUDIT_FILE!)).toBe(false)
  } finally {
    clients.delete(fake)
  }
})

test("/key upstream 4xx maps through (status, error, retry_after), no pull", async () => {
  respond = () => Response.json({ ok: false, error: "rate_limited", message: "m", retry_after: 30 }, { status: 429, headers: { "Retry-After": "30" } })
  expect(await handleKeyCommand(`/key C_KEY ${SECRET}`)).toMatchObject({ ok: false, status: 429, error: "rate_limited", retry_after: 30 })
  respond = () => new Response("Unauthorized", { status: 401 })
  expect(await handleKeyCommand(`/key C_KEY ${SECRET}`)).toMatchObject({ ok: false, status: 401, error: "upstream_unauthorized" })
  expect(await pulls()).toBe(0)
})

test("unset config: Mac-like host → 501 (route + /key), Zettlab-like host → local write; upstream never called", async () => {
  delete process.env.COMPANION_VAULT_UPSTREAM
  expect((await call("POST", "/api/vault", { name: "C_KEY", value: SECRET })).json).toEqual({ ok: false, error: "vault_unavailable", message: "Coffre en lecture seule sur cet hôte (tls-secrets.py absent)." })
  expect(await handleKeyCommand(`/key C_KEY ${SECRET}`)).toMatchObject({ ok: false, status: 501, error: "vault_unavailable" })
  const list = await call("GET", "/api/vault")
  expect(list.json).toEqual({ ok: true, writable: false, secrets: [{ name: "A_KEY", hosts: ["a.io"], scripts: false, updated_at: null }] })

  writeFileSync(process.env.TLS_SECRETS_TOOL!, "")
  expect((await call("POST", "/api/vault", { name: "C_KEY", value: SECRET, hosts: ["c.io"] })).json).toMatchObject({ ok: true, action: "created" })
  expect((await handleKeyCommand(`/key D_KEY ${SECRET}`))).toMatchObject({ ok: true, action: "created" })
  expect(readFileSync(store, "utf8")).toBe(`${FILE}C_KEY='${SECRET}'  # c.io\nD_KEY='${SECRET}'\n`)
  expect(syncCalls).toBe(2)
  expect(seen).toEqual([])
  expect(await pulls()).toBe(0)
})
