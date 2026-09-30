import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vaultDeps } from "../lib/secret-store"
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
  syncCalls = 0
  vaultDeps.sync = async () => { syncCalls++; return { ok: true, detail: "" } }
  stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
})
afterEach(() => {
  vaultDeps.sync = realSync
  process.stderr.write = realWrite
})

async function call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-companion-device": "test-phone" }
  if (auth) headers.authorization = `Bearer ${TOKEN}`
  const req = new Request(`http://localhost:4245${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const res = (await handleVaultRoute(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : {} }
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
  expect(r.json).toEqual({ ok: true, secrets: [
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
  expect(JSON.parse(audit.split("\n")[0]!)).toMatchObject({ action: "created", name: "C_KEY", hosts: ["c.io"], device: "test-phone" })
})

test("leak: `/key` typed in the chat never reaches the log, a WS client, the feed or the response", async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "vault-inject-")), "companion.db")
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
      body: JSON.stringify({ text: `/key C_KEY ${SECRET} c.io` }),
    })
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
