import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vaultDeps } from "../lib/secret-store"
import { clock, recordPeer, resetVaultLimits } from "../lib/vault-guard"
import { handleVaultRoute } from "./vault"

// Drives the route handler directly (booting createCompanionServer would pull
// in every wiring side effect). The handler repeats the bearer check, so the
// 401 is tested here too. The sync spawn is mocked through vaultDeps.

const TOKEN = "vault-test-token-0123456789"
process.env.COMPANION_AUTH_TOKEN = TOKEN
const SECRET = "SEKRET-VALUE-4f9a2c"
const FILE = "# keep me\nA_KEY='1'  # a.io\n\nB_KEY='2'  # scripts\n"
const realSync = vaultDeps.sync
let store = ""
let auditFile = ""
let syncCalls = 0
let stderr = ""
const realWrite = process.stderr.write.bind(process.stderr)

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "vault-route-"))
  store = process.env.TLS_SECRETS_FILE = join(dir, "secrets.env")
  auditFile = process.env.TLS_VAULT_AUDIT_FILE = join(dir, "vault-audit.jsonl")
  writeFileSync(store, FILE, { mode: 0o600 })
  // Temp stand-in for ~/.claude/tools/tls-secrets.py (sync itself is mocked).
  process.env.TLS_SECRETS_TOOL = join(dir, "tls-secrets.py")
  writeFileSync(process.env.TLS_SECRETS_TOOL, "")
  resetVaultLimits()
  syncCalls = 0
  vaultDeps.sync = async () => { syncCalls++; return { ok: true, detail: "" } }
  stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
})
afterEach(() => {
  vaultDeps.sync = realSync
  process.stderr.write = realWrite
})

interface Reply { status: number; text: string; json: Record<string, unknown>; headers: Headers }

// `peer` = what Bun's server.requestIP would report; default = loopback.
async function call(method: string, path: string, body?: unknown, auth = true, peer: string | null = "127.0.0.1", extra: Record<string, string> = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-companion-device": "test-phone", ...extra }
  if (auth) headers.authorization = `Bearer ${TOKEN}`
  const req = new Request(`http://localhost:4245${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  recordPeer(req, peer)
  const res = (await handleVaultRoute(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : {}, headers: res.headers }
}

test("other paths pass through", async () => {
  const req = new Request("http://localhost/api/status")
  expect(await handleVaultRoute(req, new URL(req.url))).toBeNull()
})

test("no/wrong bearer → 401 on every verb, store untouched", async () => {
  expect((await call("GET", "/api/vault", undefined, false)).status).toBe(401)
  expect((await call("POST", "/api/vault", { name: "C_KEY", value: SECRET }, false)).status).toBe(401)
  expect((await call("POST", "/api/secret", { name: "C_KEY", value: SECRET }, false)).status).toBe(401)
  expect((await call("PATCH", "/api/vault/A_KEY", { hosts: [] }, false)).status).toBe(401)
  expect((await call("DELETE", "/api/vault/A_KEY", undefined, false)).status).toBe(401)
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)
})

test("bad name / value / hosts / json → 400 without the value, no sync", async () => {
  for (const body of [
    { name: "lower", value: SECRET },
    { name: "C_KEY", value: "" },
    { name: "C_KEY", value: `${SECRET}'` },
    { name: "C_KEY", value: `${SECRET}\nD_KEY=x` },
    { name: "C_KEY", value: SECRET, hosts: ["evil.io\n#"] },
    { name: "C_KEY", value: SECRET, hosts: ["a.io", "b.io", "c.io", "d.io", "e.io", "f.io"] },
  ]) {
    const r = await call("POST", "/api/vault", body)
    expect(r.status).toBe(400)
    expect(r.text).not.toContain(SECRET)
  }
  expect((await call("PATCH", "/api/vault/A_KEY", { hosts: ["no spaces.io"] })).status).toBe(400)
  expect((await call("PATCH", "/api/vault/a%20key", { hosts: [] })).status).toBe(400)
  expect((await call("POST", "/api/vault", [1])).status).toBe(400)
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)
})

test("GET lists names + hosts + scripts, never values", async () => {
  const r = await call("GET", "/api/vault")
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true, writable: true, secrets: [
    { name: "A_KEY", hosts: ["a.io"], scripts: false, updated_at: null },
    { name: "B_KEY", hosts: [], scripts: true, updated_at: null },
  ] })
  expect(r.text).not.toContain("'1'")
})

test("POST upserts (created / updated), keeps other lines + comments, runs sync", async () => {
  const c = await call("POST", "/api/vault", { name: "C_KEY", value: SECRET, hosts: ["*.example.com"] })
  expect(c.status).toBe(200)
  expect(c.json).toMatchObject({ ok: true, name: "C_KEY", hosts: ["*.example.com"], action: "created" })
  expect(readFileSync(store, "utf8")).toBe(FILE + `C_KEY='${SECRET}'  # *.example.com\n`)

  const u = await call("POST", "/api/secret", { name: "A_KEY", value: "rotated", hosts: ["a.io"] })
  expect(u.json.action).toBe("updated")
  expect(readFileSync(store, "utf8")).toBe(`# keep me\nA_KEY='rotated'  # a.io\n\nB_KEY='2'  # scripts\nC_KEY='${SECRET}'  # *.example.com\n`)
  expect(syncCalls).toBe(2)
})

test("PATCH changes hosts only; DELETE removes only that line; unknown → 404", async () => {
  const p = await call("PATCH", "/api/vault/B_KEY", { hosts: ["b.io"] })
  expect(p.json).toMatchObject({ ok: true, action: "hosts", hosts: ["b.io"] })
  expect(readFileSync(store, "utf8")).toBe("# keep me\nA_KEY='1'  # a.io\n\nB_KEY='2'  # b.io scripts\n")

  const d = await call("DELETE", "/api/vault/A_KEY")
  expect(d.json).toMatchObject({ ok: true, action: "deleted", name: "A_KEY" })
  expect(readFileSync(store, "utf8")).toBe("# keep me\n\nB_KEY='2'  # b.io scripts\n")

  expect((await call("DELETE", "/api/vault/NOPE_KEY")).status).toBe(404)
  expect((await call("PATCH", "/api/vault/NOPE_KEY", { hosts: [] })).status).toBe(404)
  expect(syncCalls).toBe(2)
  expect((await call("GET", "/api/vault")).json.secrets).toMatchObject([{ name: "B_KEY", hosts: ["b.io"], scripts: true }])
})

test("sync failure → 500 without the value, store rolled back", async () => {
  vaultDeps.sync = async () => { syncCalls++; return { ok: false, detail: `python said ${SECRET}` } }
  const r = await call("POST", "/api/vault", { name: "C_KEY", value: SECRET, hosts: [] })
  expect(r.status).toBe(500)
  expect(r.json).toMatchObject({ ok: false, error: "sync_failed" })
  expect(r.text).not.toContain(SECRET)
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(1)
})

test("leak: after add + rotate the value is absent from log, responses and audit", async () => {
  const bodies: string[] = []
  bodies.push((await call("POST", "/api/vault", { name: "C_KEY", value: SECRET, hosts: ["c.io"] })).text)
  bodies.push((await call("POST", "/api/secret", { name: "C_KEY", value: `${SECRET}-2`, hosts: ["c.io"] })).text)
  bodies.push((await call("PATCH", "/api/vault/C_KEY", { hosts: [] })).text)
  bodies.push((await call("GET", "/api/vault")).text)
  bodies.push((await call("DELETE", "/api/vault/C_KEY")).text)

  expect(stderr).toContain("vault created C_KEY")
  expect(stderr).not.toContain(SECRET)
  for (const b of bodies) expect(b).not.toContain(SECRET)
  const audit = readFileSync(auditFile, "utf8")
  expect(audit).not.toContain(SECRET)
  expect(JSON.parse(audit.split("\n")[0]!)).toMatchObject({ action: "created", name: "C_KEY", hosts: ["c.io"], device_claimed: "test-phone", transport: "loopback", peer: "127.0.0.1" })
})

test("leak: `/key` typed in the chat never reaches the log, a WS client, the feed or the response", async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "vault-inject-")), "test.db")
  const { handleApiRoute } = await import("./api")
  const { clients } = await import("../state")
  const { getFeed } = await import("../lib/feed")
  const sent: string[] = []
  const fake = { send: (m: string) => { sent.push(m) } } as unknown as Parameters<typeof clients.add>[0]
  clients.add(fake)
  try {
    const req = new Request("http://localhost:4245/api/inject", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ text: `/key C_KEY ${SECRET} --hosts c.io` }),
    })
    recordPeer(req, "127.0.0.1")
    const res = (await handleApiRoute(req, new URL(req.url)))!
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ ok: true, name: "C_KEY", action: "created" })
    expect(readFileSync(store, "utf8")).toContain(`C_KEY='${SECRET}'  # c.io\n`)
    for (const out of [text, stderr, sent.join("\n"), JSON.stringify(getFeed()), readFileSync(auditFile, "utf8")]) {
      expect(out).not.toContain(SECRET)
    }
  } finally {
    clients.delete(fake)
  }
})

// ── `/key` through the chat paths gets the vault's bar (batch 1a follow-up) ──

async function injectKey(peer: string | null, opts: { query?: boolean; xff?: string } = {}): Promise<Reply> {
  const { handleApiRoute } = await import("./api")
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (!opts.query) headers.authorization = `Bearer ${TOKEN}`
  if (opts.xff) headers["x-forwarded-for"] = opts.xff
  const req = new Request(`http://localhost:4245/api/inject${opts.query ? `?token=${TOKEN}` : ""}`, {
    method: "POST", headers, body: JSON.stringify({ text: `/key C_KEY ${SECRET} --hosts c.io` }),
  })
  recordPeer(req, peer)
  const res = (await handleApiRoute(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, text, json: JSON.parse(text), headers: res.headers }
}

test("/api/inject `/key`: untrusted network → 403, `?token=` auth → 401; nothing stored, nothing injected, no value echoed", async () => {
  process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "vault-inject-")), "test.db")
  for (const [peer, opts, status, error] of [
    ["192.168.1.20", {}, 403, "forbidden_network"],
    [null, {}, 403, "forbidden_network"],
    ["127.0.0.1", { xff: "203.0.113.9" }, 403, "forbidden_network"],
    ["127.0.0.1", { query: true }, 401, "header_auth_required"],
    ["100.101.1.2", { query: true }, 401, "header_auth_required"],
  ] as const) {
    const r = await injectKey(peer, opts)
    expect([peer, r.status, r.json.error]).toEqual([peer, status, error])
    expect(r.text).not.toContain(SECRET)
  }
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)
  expect(stderr).not.toContain(SECRET)
  // Tailnet peer with a header bearer is accepted, and the audit says how it came.
  const ok = await injectKey("100.101.1.2")
  expect(ok.json).toMatchObject({ ok: true, name: "C_KEY" })
  expect(JSON.parse(readFileSync(auditFile, "utf8").split("\n")[0]!)).toMatchObject({ transport: "tailnet", peer: "100.101.1.2" })
})

test("WS `input` `/key`: refused unless the socket passed the gate at upgrade; never reaches a pane", async () => {
  process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "vault-ws-")), "test.db")
  const { websocket } = await import("../ws")
  const { dialogWatcher } = await import("../wiring/dialogs")
  dialogWatcher.stop()
  const { keyCommandGate } = await import("../lib/vault-guard")
  const socket = (keyGate: unknown) => {
    const got: Array<Record<string, unknown>> = []
    return { got, ws: { send: (m: string) => { got.push(JSON.parse(m)) }, data: { id: "w", keyGate } } }
  }
  const upgrade = (peer: string, query: boolean) => {
    const req = new Request(`http://localhost:4245/ws${query ? `?token=${TOKEN}` : ""}`, { headers: query ? {} : { authorization: `Bearer ${TOKEN}` } })
    recordPeer(req, peer)
    return keyCommandGate(req)
  }
  const text = `/key C_KEY ${SECRET} --hosts c.io`
  for (const [gate, error] of [[undefined, "forbidden_network"], [upgrade("192.168.1.20", false), "forbidden_network"], [upgrade("127.0.0.1", true), "header_auth_required"]] as const) {
    const s = socket(gate)
    await websocket.message!(s.ws as never, JSON.stringify({ type: "input", text }))
    expect(s.got.length).toBe(1)
    expect(s.got[0]).toMatchObject({ type: "key_saved", ok: false, error })
    expect(JSON.stringify(s.got)).not.toContain(SECRET)
  }
  expect(readFileSync(store, "utf8")).toBe(FILE)
  const s = socket(upgrade("127.0.0.1", false))
  await websocket.message!(s.ws as never, JSON.stringify({ type: "input", text }))
  expect(s.got[0]).toMatchObject({ type: "key_saved", ok: true, name: "C_KEY" })
  expect(JSON.parse(readFileSync(auditFile, "utf8").split("\n")[0]!)).toMatchObject({ transport: "loopback" })
  expect(stderr).not.toContain(SECRET)
})

// ── Hardening (fix/vault-hardening) ──

test("?token= is refused on every vault verb even when valid → 401, store untouched", async () => {
  for (const [method, path, body] of [
    ["GET", "/api/vault", undefined],
    ["POST", "/api/vault", { name: "C_KEY", value: SECRET }],
    ["POST", "/api/secret", { name: "C_KEY", value: SECRET }],
    ["PATCH", "/api/vault/A_KEY", { hosts: [] }],
    ["DELETE", "/api/vault/A_KEY", undefined],
  ] as const) {
    const r = await call(method, `${path}?token=${TOKEN}`, body, false)
    expect(r.status).toBe(401)
  }
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)
})

test("network gate: LAN / public / unknown peers → 403 before auth; XFF only trusted from loopback", async () => {
  const denied: [string | null, Record<string, string>][] = [
    ["192.168.1.20", {}],
    ["10.0.0.5", {}],
    ["8.8.8.8", {}],
    ["100.128.0.1", {}],                                          // just outside 100.64/10
    [null, {}],                                                   // peer unknown → fail closed
    ["192.168.1.20", { "x-forwarded-for": "100.100.1.1" }],      // spoofed XFF from LAN
    ["127.0.0.1", { "x-forwarded-for": "203.0.113.9" }],          // serve-proxied public client
    ["127.0.0.1", { "x-forwarded-for": "100.100.1.1", "tailscale-funnel-request": "?1" }], // Funnel
  ]
  for (const [peer, extra] of denied) {
    for (const auth of [true, false]) {
      expect((await call("POST", "/api/vault", { name: "C_KEY", value: SECRET }, auth, peer, extra)).status).toBe(403)
    }
    expect((await call("GET", "/api/vault", undefined, true, peer, extra)).status).toBe(403)
  }
  expect(readFileSync(store, "utf8")).toBe(FILE)

  for (const [peer, extra] of [
    ["::1", {}], ["::ffff:127.0.0.1", {}], ["100.64.0.1", {}], ["100.127.255.254", {}], ["fd7a:115c:a1e0::1", {}],
    ["127.0.0.1", { "x-forwarded-for": "100.101.102.103" }],
  ] as [string, Record<string, string>][]) {
    expect((await call("GET", "/api/vault", undefined, true, peer, extra)).status).toBe(200)
  }
  await call("POST", "/api/vault", { name: "C_KEY", value: SECRET }, true, "127.0.0.1", { "x-forwarded-for": "100.101.102.103" })
  const line = JSON.parse(readFileSync(auditFile, "utf8").trim())
  expect(line).toMatchObject({ device_claimed: "test-phone", transport: "tailscale-serve", peer: "100.101.102.103" })
  expect(line.device).toBeUndefined()
})

test("rate limit: 11th write in a minute → 429 + Retry-After, nothing written; GET still served", async () => {
  const t0 = 5_000_000
  const realNow = clock.now
  clock.now = () => t0
  try {
    for (let i = 0; i < 10; i++) {
      const verb = i % 3
      const r = verb === 0 ? await call("POST", "/api/vault", { name: "C_KEY", value: `v${i}` })
        : verb === 1 ? await call("PATCH", "/api/vault/A_KEY", { hosts: [`h${i}.io`] })
        : await call("POST", "/api/secret", { name: "C_KEY", value: `v${i}` })
      expect(r.status).toBe(200)
    }
    const before = readFileSync(store, "utf8")
    clock.now = () => t0 + 15_000
    const r = await call("DELETE", "/api/vault/A_KEY")
    expect(r.status).toBe(429)
    expect(r.headers.get("retry-after")).toBe("45")
    expect(r.json).toMatchObject({ ok: false, error: "rate_limited", retry_after: 45 })
    expect(readFileSync(store, "utf8")).toBe(before)
    expect((await call("GET", "/api/vault")).status).toBe(200)
    clock.now = () => t0 + 60_000
    expect((await call("DELETE", "/api/vault/A_KEY")).status).toBe(200)
  } finally {
    clock.now = realNow
  }
})

test("GET is capped at 60/min", async () => {
  for (let i = 0; i < 60; i++) expect((await call("GET", "/api/vault")).status).toBe(200)
  expect((await call("GET", "/api/vault")).status).toBe(429)
})

test("tls-secrets.py absent → mutations 501 vault_unavailable up front; GET lists with writable:false", async () => {
  process.env.TLS_SECRETS_TOOL = join(tmpdir(), "definitely-missing-tls-secrets.py")
  for (const r of [
    await call("POST", "/api/vault", { name: "C_KEY", value: SECRET }),
    await call("POST", "/api/secret", { name: "C_KEY", value: SECRET }),
    await call("PATCH", "/api/vault/A_KEY", { hosts: [] }),
    await call("DELETE", "/api/vault/A_KEY"),
  ]) {
    expect(r.status).toBe(501)
    expect(r.json).toMatchObject({ ok: false, error: "vault_unavailable" })
    expect(r.text).not.toContain(SECRET)
  }
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)
  const g = await call("GET", "/api/vault")
  expect(g.status).toBe(200)
  expect(g.json.writable).toBe(false)
  expect((g.json.secrets as unknown[]).length).toBe(2)
})

test("real Bun.serve: the peer Bun reports for a loopback client passes the gate", async () => {
  const srv = Bun.serve({
    port: 0,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      recordPeer(req, server.requestIP(req)?.address)
      return (await handleVaultRoute(req, new URL(req.url))) ?? new Response("nf", { status: 404 })
    },
  })
  try {
    const ok = await fetch(`http://127.0.0.1:${srv.port}/api/vault`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(ok.status).toBe(200)
    const q = await fetch(`http://127.0.0.1:${srv.port}/api/vault?token=${TOKEN}`)
    expect(q.status).toBe(401)
  } finally {
    srv.stop(true)
  }
})

test("/api/orchestrator/send `/key`: same gate as inject; a refused /key never reaches the thread", async () => {
  process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "vault-orch-")), "test.db")
  const { handleOrchestratorRoute } = await import("./orchestrator")
  const { getThread } = await import("../lib/orchestrator-chat")
  const send = async (peer: string | null, query = false) => {
    const url = new URL(`http://localhost:4245/api/orchestrator/send${query ? `?token=${TOKEN}` : ""}`)
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...(query ? {} : { authorization: `Bearer ${TOKEN}` }) },
      body: JSON.stringify({ text: `/key C_KEY ${SECRET} --hosts c.io` }),
    })
    if (peer) recordPeer(req, peer)
    const res = (await handleOrchestratorRoute(req, url))!
    const text = await res.text()
    return { status: res.status, text, json: JSON.parse(text) }
  }
  for (const [peer, query, status, error] of [
    ["192.168.1.20", false, 403, "forbidden_network"],
    [null, false, 403, "forbidden_network"],
    ["127.0.0.1", true, 401, "header_auth_required"],
  ] as const) {
    const r = await send(peer, query)
    expect([peer, r.status, r.json.error]).toEqual([peer, status, error])
    expect(r.text).not.toContain(SECRET)
  }
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(JSON.stringify(getThread())).not.toContain(SECRET)
  expect(stderr).not.toContain(SECRET)
})
