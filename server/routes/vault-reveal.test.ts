import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { listSecrets } from "../lib/secret-store"
import { clock, recordPeer, resetVaultLimits } from "../lib/vault-guard"
import { pendingPulls } from "../lib/vault-upstream"
import { handleVaultRoute } from "./vault"

// POST /api/vault/:name/reveal — the one route that returns a value. Every
// fixture is a fake value in a temp store; the value may appear in exactly one
// place: the 200 response body.

// Same fixture token as vault.test.ts (auth.ts caches the first one it reads).
process.env.COMPANION_AUTH_TOKEN = "vault-test-token-0123456789"
const TOKEN = getAuthToken()
const SECRET = "REVEAL-FAKE-VALUE-3b8e"
const FILE = `# keep me\nA_KEY='${SECRET}'  # a.io\nB_KEY="dq-${SECRET}"\nexport C_KEY=bare-${SECRET}  # scripts\nPHASE_SERVICE_TOKEN='phase-${SECRET}'\nPHASE_HOST='phase-host-${SECRET}'\n`

let dir = ""
let store = ""
let auditFile = ""
let stderr = ""
const realWrite = process.stderr.write.bind(process.stderr)

interface Seen { method: string; path: string; search: string; auth: string | null; device: string | null; hop: string | null; body: string }
let seen: Seen[] = []
let respond: (s: Seen) => Response = () => Response.json({ ok: true })
let upstream: ReturnType<typeof Bun.serve>

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
  dir = mkdtempSync(join(tmpdir(), "vault-reveal-"))
  store = process.env.TLS_SECRETS_FILE = join(dir, "secrets.env")
  auditFile = process.env.TLS_VAULT_AUDIT_FILE = join(dir, "vault-audit.jsonl")
  process.env.TLS_SECRETS_TOOL = join(dir, "tls-secrets.py")
  writeFileSync(process.env.TLS_SECRETS_TOOL, "")
  writeFileSync(store, FILE, { mode: 0o600 })
  delete process.env.COMPANION_VAULT_UPSTREAM
  delete process.env.COMPANION_VAULT_PULL_CMD
  seen = []
  resetVaultLimits()
  stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
})
afterEach(async () => {
  await pendingPulls()
  process.stderr.write = realWrite
  delete process.env.COMPANION_VAULT_UPSTREAM
  delete process.env.COMPANION_VAULT_PULL_CMD
  rmSync(dir, { recursive: true, force: true })
})

interface Reply { status: number; text: string; json: Record<string, unknown>; headers: Headers }

async function call(method: string, path: string, opts: { auth?: boolean; peer?: string | null; extra?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-companion-device": "test-phone", ...opts.extra }
  if (opts.auth !== false) headers.authorization = `Bearer ${TOKEN}`
  const req = new Request(`http://localhost:4245${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  recordPeer(req, opts.peer === undefined ? "127.0.0.1" : opts.peer)
  const res = (await handleVaultRoute(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : {}, headers: res.headers }
}

const reveal = (name: string, opts: Parameters<typeof call>[2] = {}) => call("POST", `/api/vault/${name}/reveal`, opts)

function auditLines(): Record<string, unknown>[] {
  return existsSync(auditFile) ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
}

test("reveal ok: value in the body only, no-store + no-cache, audited and logged without the value", async () => {
  const r = await reveal("A_KEY", { peer: "100.101.1.2" })
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true, name: "A_KEY", value: SECRET })
  expect(r.headers.get("cache-control")).toBe("no-store")
  expect(r.headers.get("pragma")).toBe("no-cache")

  expect(auditLines()).toEqual([{ ts: expect.any(String), action: "revealed", name: "A_KEY", device_claimed: "test-phone", transport: "tailnet", peer: "100.101.1.2" }])
  expect(readFileSync(auditFile, "utf8")).not.toContain(SECRET)
  expect(stderr).toContain("vault reveal A_KEY via=tailnet from=100.101.1.2")
  expect(stderr).not.toContain(SECRET)
  // Store untouched, and a reveal does not count as an update.
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(listSecrets().find((e) => e.name === "A_KEY")?.updated_at).toBeNull()
})

test("reveal unquotes double-quoted and bare (export) lines", async () => {
  expect((await reveal("B_KEY")).json).toEqual({ ok: true, name: "B_KEY", value: `dq-${SECRET}` })
  expect((await reveal("C_KEY")).json).toEqual({ ok: true, name: "C_KEY", value: `bare-${SECRET}` })
})

test("not_found → 404; bad_name → 400; neither audited", async () => {
  const nf = await reveal("NOPE_KEY")
  expect([nf.status, nf.json]).toEqual([404, { ok: false, error: "not_found", message: "NOPE_KEY introuvable" }])
  expect(nf.headers.get("cache-control")).toBe("no-store")
  for (const name of ["lower", "a%20key", "A_KEY%0A", "..%2FA_KEY", "A/B_KEY"]) {
    resetVaultLimits()
    const r = await call("POST", `/api/vault/${name}/reveal`)
    expect([name, r.status, r.json.error]).toEqual([name, 400, "bad_name"])
    expect(r.text).not.toContain(SECRET)
  }
  resetVaultLimits()
  expect((await reveal("X")).json.error).toBe("bad_name")
  expect(auditLines()).toEqual([])
  expect(stderr).not.toContain(SECRET)
})

test("audit file unwritable → 500 audit_failed, no value", async () => {
  writeFileSync(join(dir, "not-a-dir"), "")
  process.env.TLS_VAULT_AUDIT_FILE = join(dir, "not-a-dir", "audit.jsonl")
  const r = await reveal("A_KEY")
  expect([r.status, r.json.error]).toEqual([500, "audit_failed"])
  expect(r.text).not.toContain(SECRET)
  expect(stderr).not.toContain(SECRET)
})

test("vault bootstrap keys → 403 reveal_forbidden, not audited, no value", async () => {
  for (const name of ["PHASE_SERVICE_TOKEN", "PHASE_HOST"]) {
    const r = await reveal(name)
    expect(r.status).toBe(403)
    expect(r.json).toMatchObject({ ok: false, error: "reveal_forbidden" })
    expect(r.text).not.toContain(SECRET)
  }
  expect(auditLines()).toEqual([])
  expect(stderr).not.toContain(SECRET)
})

test("GET / PATCH on …/reveal → 405, nothing revealed", async () => {
  for (const m of ["GET", "PATCH", "DELETE", "PUT"]) {
    const r = await call(m, "/api/vault/A_KEY/reveal")
    expect(r.status).toBe(405)
    expect(r.text).not.toContain(SECRET)
  }
  expect(auditLines()).toEqual([])
})

test("?token= (even valid) → 401; LAN / spoofed / funnel peer → 403; nothing revealed or audited", async () => {
  const q = await call("POST", `/api/vault/A_KEY/reveal?token=${TOKEN}`, { auth: false })
  expect(q.status).toBe(401)
  expect(q.text).not.toContain(SECRET)
  for (const [peer, extra] of [
    ["192.168.1.20", {}],
    [null, {}],
    ["192.168.1.20", { "x-forwarded-for": "100.100.1.1" }],
    ["127.0.0.1", { "x-forwarded-for": "100.100.1.1", "tailscale-funnel-request": "?1" }],
  ] as [string | null, Record<string, string>][]) {
    for (const auth of [true, false]) {
      const r = await reveal("A_KEY", { peer, extra, auth })
      expect([peer, r.status]).toEqual([peer, 403])
      expect(r.text).not.toContain(SECRET)
    }
  }
  expect(auditLines()).toEqual([])
})

test("6th reveal in a minute → 429 + Retry-After; independent from the write budget", async () => {
  const t0 = 9_000_000
  const realNow = clock.now
  clock.now = () => t0
  try {
    for (let i = 0; i < 5; i++) expect((await reveal("A_KEY")).status).toBe(200)
    clock.now = () => t0 + 20_000
    const r = await reveal("A_KEY")
    expect(r.status).toBe(429)
    expect(r.headers.get("retry-after")).toBe("40")
    expect(r.json).toMatchObject({ ok: false, error: "rate_limited", retry_after: 40 })
    expect(r.text).not.toContain(SECRET)
    expect(auditLines().length).toBe(5)

    // The write budget is untouched by 5 reveals: 10 writes still pass…
    for (let i = 0; i < 10; i++) expect((await call("PATCH", "/api/vault/C_KEY", { body: { hosts: [`h${i}.io`] } })).status).toBe(200)
    expect((await call("PATCH", "/api/vault/C_KEY", { body: { hosts: [] } })).status).toBe(429)
    // …and an exhausted write budget does not block a reveal once its own window frees.
    clock.now = () => t0 + 60_000
    expect((await reveal("A_KEY")).status).toBe(200)
  } finally {
    clock.now = realNow
  }
})

test("leak: reveal never reaches a WS client, the feed or the log", async () => {
  process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "vault-reveal-db-")), "companion.db")
  const { clients } = await import("../state")
  const { getFeed } = await import("../lib/feed")
  const sent: string[] = []
  const fake = { send: (m: string) => { sent.push(m) } } as unknown as Parameters<typeof clients.add>[0]
  clients.add(fake)
  try {
    expect((await reveal("A_KEY")).json.value).toBe(SECRET)
    for (const out of [sent.join("\n"), JSON.stringify(getFeed()), stderr, readFileSync(auditFile, "utf8")]) expect(out).not.toContain(SECRET)
  } finally {
    clients.delete(fake)
  }
})

// ── Upstream mode (the Mac) ──

function upstreamMode(): string {
  process.env.COMPANION_VAULT_UPSTREAM = `http://127.0.0.1:${upstream.port}`
  const pullLog = join(dir, "pulls.log")
  const pull = join(dir, "pull.sh")
  writeFileSync(pull, `#!/bin/sh\necho pulled >> '${pullLog}'\n`)
  chmodSync(pull, 0o700)
  process.env.COMPANION_VAULT_PULL_CMD = pull
  return pullLog
}

test("upstream: forwards POST …/reveal (header bearer, device via host, hop, empty body); status + body pass through; pull NOT run; no local audit", async () => {
  const pullLog = upstreamMode()
  respond = (s) => Response.json({ ok: true, name: "UP_KEY", value: `up-${SECRET}`, path: s.path })
  const r = await reveal("UP_KEY", { extra: { "x-companion-device": "iPhone 17" } })
  expect(r.status).toBe(200)
  expect(r.json).toEqual({ ok: true, name: "UP_KEY", value: `up-${SECRET}`, path: "/api/vault/UP_KEY/reveal" })
  expect(r.headers.get("cache-control")).toBe("no-store")
  expect(r.headers.get("pragma")).toBe("no-cache")
  expect(seen).toEqual([{ method: "POST", path: "/api/vault/UP_KEY/reveal", search: "", auth: `Bearer ${TOKEN}`, device: `iPhone 17 via ${hostname()}`, hop: "1", body: "" }])

  respond = () => Response.json({ ok: false, error: "not_found", message: "m" }, { status: 404 })
  const nf = await reveal("NOPE_KEY")
  expect([nf.status, nf.json]).toEqual([404, { ok: false, error: "not_found", message: "m" }])
  respond = () => Response.json({ ok: false, error: "rate_limited", retry_after: 33 }, { status: 429, headers: { "Retry-After": "33" } })
  const rl = await reveal("UP_KEY")
  expect([rl.status, rl.headers.get("retry-after")]).toEqual([429, "33"])

  await pendingPulls()
  expect(existsSync(pullLog)).toBe(false)
  expect(existsSync(auditFile)).toBe(false)
  expect(stderr).toContain(`vault reveal UP_KEY via=loopback from=127.0.0.1 upstream=200`)
  expect(stderr).not.toContain(SECRET)
})

test("upstream: bad / forbidden names answered locally, never forwarded; local reveal budget applies first", async () => {
  upstreamMode()
  respond = () => Response.json({ ok: true, name: "UP_KEY", value: `up-${SECRET}` })
  expect((await reveal("PHASE_SERVICE_TOKEN")).json).toMatchObject({ error: "reveal_forbidden" })
  expect((await call("POST", "/api/vault/..%2Fapi%2Finject/reveal")).json).toMatchObject({ error: "bad_name" })
  expect(seen).toEqual([])
  resetVaultLimits()
  for (let i = 0; i < 5; i++) expect((await reveal("UP_KEY")).status).toBe(200)
  expect((await reveal("UP_KEY")).status).toBe(429)
  expect(seen.length).toBe(5)
  // A forwarded reveal arriving on a server that is itself in upstream mode → 508.
  expect((await reveal("UP_KEY", { extra: { "x-companion-vault-hop": "1" } })).status).toBe(508)
  expect(seen.length).toBe(5)
  expect(stderr).not.toContain(SECRET)
})

test("upstream down / redirect → 502, no value, no pull", async () => {
  const pullLog = upstreamMode()
  respond = () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/api/vault/UP_KEY/reveal" } })
  const r = await reveal("UP_KEY")
  expect([r.status, r.json.error]).toEqual([502, "upstream_unreachable"])
  await pendingPulls()
  expect(existsSync(pullLog)).toBe(false)
})
