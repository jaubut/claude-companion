import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { recordsAuditPath, recordsDir, recordsPath } from "../lib/records-store"
import { recordPeer } from "../lib/vault-guard"
import { handleRecordsRoute, resetRecordsLimits } from "./records"

// /api/records on the store host. Temp HOME, fake values only. A field value
// may appear in exactly one place: the reveal 200 body.

// Same fixture token as the vault tests (auth.ts caches the first one it reads).
process.env.COMPANION_AUTH_TOKEN = "vault-test-token-0123456789"
const TOKEN = getAuthToken()
const NUM = "FAKE-DOCNUM-Q7X2"
const DOB = "1901-02-03"
const NAME = "Testy McFakeface"
const PASSPORT = { full_name: NAME, nationality: "CA", document_number: NUM, date_of_birth: DOB, expiry_date: "2031-07-16", notes: "line one\nline two" }

let home = ""
let stderr = ""
const realHome = process.env.HOME
const realWrite = process.stderr.write.bind(process.stderr)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "records-home-"))
  process.env.HOME = home
  delete process.env.COMPANION_VAULT_UPSTREAM
  resetRecordsLimits()
  stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
})
afterEach(() => {
  process.stderr.write = realWrite
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

interface Reply { status: number; text: string; json: Record<string, any>; headers: Headers }

async function call(method: string, path: string, opts: { auth?: "header" | "query" | "none"; peer?: string; body?: unknown; raw?: string; extra?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-companion-device": "test-phone", ...opts.extra }
  const auth = opts.auth ?? "header"
  if (auth === "header") headers.authorization = `Bearer ${TOKEN}`
  const url = `http://localhost:4245${path}${auth === "query" ? `?token=${TOKEN}` : ""}`
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const req = new Request(url, { method, headers, body })
  recordPeer(req, opts.peer ?? "127.0.0.1")
  const res = (await handleRecordsRoute(req, new URL(req.url)))!
  const text = await res.text()
  return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : {}, headers: res.headers }
}

async function create(fields: Record<string, string> = PASSPORT, type = "passport", label?: string): Promise<string> {
  const r = await call("POST", "/api/records", { body: { type, fields, ...(label === undefined ? {} : { label }) } })
  expect(r.status).toBe(201)
  return r.json.id as string
}

function noValuesIn(text: string): void {
  for (const v of [NUM, DOB, NAME, "line one"]) expect(text).not.toContain(v)
}

test("ignores paths it does not own", async () => {
  const req = new Request("http://localhost:4245/api/recordsx", { headers: { authorization: `Bearer ${TOKEN}` } })
  expect(await handleRecordsRoute(req, new URL(req.url))).toBeNull()
})

test("CRUD: create → list → patch (merge, '' deletes) → reveal → delete", async () => {
  expect((await call("GET", "/api/records")).json).toEqual({ ok: true, writable: true, records: [] })
  const id = await create()
  expect(id).toMatch(/^[a-z2-7]{12}$/)

  const list = await call("GET", "/api/records")
  expect(list.status).toBe(200)
  expect(list.headers.get("cache-control")).toBe("no-store")
  expect(list.json.records).toHaveLength(1)
  const row = list.json.records[0]
  expect(Object.keys(row).sort()).toEqual(["expiry_date", "id", "label", "type", "updated_at"])
  expect(row).toMatchObject({ id, type: "passport", label: "Passport · CA", expiry_date: "2031-07-16" })
  noValuesIn(list.text)

  const p = await call("PATCH", `/api/records/${id}`, { body: { label: "Mon passeport", fields: { notes: "", place_of_birth: "Montréal" } } })
  expect(p.status).toBe(200)
  expect(p.json).toEqual({ ok: true, id })

  const r = await call("POST", `/api/records/${id}/reveal`)
  expect(r.status).toBe(200)
  expect(r.headers.get("cache-control")).toBe("no-store")
  expect(r.headers.get("pragma")).toBe("no-cache")
  expect(r.json.record).toMatchObject({ id, type: "passport", label: "Mon passeport" })
  expect(r.json.record.fields).toEqual({ full_name: NAME, nationality: "CA", document_number: NUM, date_of_birth: DOB, expiry_date: "2031-07-16", place_of_birth: "Montréal" })
  expect(Object.keys(r.json.record).sort()).toEqual(["created_at", "fields", "id", "label", "type", "updated_at"])

  // Label "" resets to the default.
  await call("PATCH", `/api/records/${id}`, { body: { label: "" } })
  expect((await call("GET", "/api/records")).json.records[0].label).toBe("Passport · CA")

  expect((await call("DELETE", `/api/records/${id}`)).json).toEqual({ ok: true, id })
  expect((await call("GET", "/api/records")).json.records).toEqual([])
  expect((await call("DELETE", `/api/records/${id}`)).status).toBe(404)
  expect((await call("POST", `/api/records/${id}/reveal`)).status).toBe(404)
  expect((await call("PATCH", `/api/records/${id}`, { body: { label: "x" } })).status).toBe(404)
})

test("driver_license: default label, own field set", async () => {
  const id = await create({ licence_number: NUM, issuing_region: "QC", expiry_date: "2027-01-31", class: "5" }, "driver_license")
  expect((await call("GET", "/api/records")).json.records[0]).toMatchObject({ id, type: "driver_license", label: "Driver licence · QC" })
  // passport-only field on a licence → rejected
  expect((await call("PATCH", `/api/records/${id}`, { body: { fields: { document_number: "x" } } })).json.error).toBe("bad_field")
})

test("validation: bad_type, bad_date, missing_expiry, unknown field, lengths, control chars, bad_json", async () => {
  const post = (body: unknown) => { resetRecordsLimits(); return call("POST", "/api/records", { body }) }
  expect((await post({ type: "visa", fields: { expiry_date: "2030-01-01" } })).json.error).toBe("bad_type")
  expect((await post({ fields: { expiry_date: "2030-01-01" } })).json.error).toBe("bad_type")
  for (const d of ["2030-02-30", "2030-1-01", "30-01-01", "2030-13-01", "tomorrow"]) {
    const r = await post({ type: "passport", fields: { expiry_date: d } })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("bad_date")
  }
  expect((await post({ type: "passport", fields: { expiry_date: "2030-01-01", date_of_birth: "1990-02-31" } })).json.error).toBe("bad_date")
  expect((await post({ type: "passport", fields: { full_name: NAME } })).json.error).toBe("missing_expiry")
  expect((await post({ type: "passport", fields: { full_name: NAME, expiry_date: "" } })).json.error).toBe("missing_expiry")
  const unknown = await post({ type: "passport", fields: { expiry_date: "2030-01-01", [NUM]: "x" } })
  expect(unknown.json.error).toBe("bad_field")
  noValuesIn(unknown.text)
  expect((await post({ type: "passport", fields: { expiry_date: "2030-01-01", full_name: "x".repeat(201) } })).json.error).toBe("bad_field")
  expect((await post({ type: "passport", fields: { expiry_date: "2030-01-01", full_name: "x".repeat(200) } })).status).toBe(201)
  expect((await post({ type: "passport", fields: { expiry_date: "2030-01-01", notes: "x".repeat(2001) } })).json.error).toBe("bad_field")
  expect((await post({ type: "passport", fields: { expiry_date: "2030-01-01", notes: "x".repeat(2000) } })).status).toBe(201)
  expect((await post({ type: "passport", fields: { expiry_date: "2030-01-01", full_name: "a\nb" } })).json.error).toBe("bad_field")
  expect((await post({ type: "passport", fields: { expiry_date: "2030-01-01", notes: "a\tb" } })).json.error).toBe("bad_field")
  expect((await post({ type: "passport", fields: { expiry_date: "2030-01-01", sex: 1 } })).json.error).toBe("bad_field")
  expect((await post({ type: "passport", fields: "nope" })).json.error).toBe("bad_field")
  expect((await post({ type: "passport", label: "x".repeat(61), fields: { expiry_date: "2030-01-01" } })).json.error).toBe("bad_field")
  resetRecordsLimits()
  expect((await call("POST", "/api/records", { raw: "not json" })).json.error).toBe("bad_json")
  expect((await call("POST", "/api/records", { raw: "[1]" })).json.error).toBe("bad_json")

  resetRecordsLimits()
  const id = await create()
  const patch = (body: unknown) => { resetRecordsLimits(); return call("PATCH", `/api/records/${id}`, { body }) }
  expect((await patch({ fields: { expiry_date: "" } })).json.error).toBe("missing_expiry")
  expect((await patch({ fields: { issue_date: "2020-02-30" } })).json.error).toBe("bad_date")
  expect((await patch({})).json.error).toBe("bad_field")
  // Nothing above changed the stored record.
  expect((await call("POST", `/api/records/${id}/reveal`)).json.record.fields).toEqual(PASSPORT)
  noValuesIn(stderr)
})

test("unknown / malformed ids → 404, other methods → 405", async () => {
  expect((await call("DELETE", "/api/records/ABCDEFGHIJKL")).status).toBe(404)
  expect((await call("PATCH", "/api/records/a%2F..%2Fetc", { body: { label: "x" } })).status).toBe(404)
  expect((await call("POST", "/api/records/aaaaaaaaaaaa/reveal")).json).toMatchObject({ ok: false, error: "not_found" })
  expect((await call("GET", "/api/records/aaaaaaaaaaaa")).status).toBe(405)
  expect((await call("PUT", "/api/records")).status).toBe(405)
  expect((await call("GET", "/api/records/aaaaaaaaaaaa/reveal")).status).toBe(405)
})

test("guards: ?token= → 401, LAN → 403, funnel → 403, no auth → 401", async () => {
  const id = await create()
  for (const [m, p] of [["GET", "/api/records"], ["POST", `/api/records/${id}/reveal`], ["DELETE", `/api/records/${id}`]] as const) {
    expect((await call(m, p, { auth: "query" })).status).toBe(401)
    expect((await call(m, p, { auth: "none" })).status).toBe(401)
    const lan = await call(m, p, { peer: "192.168.1.20" })
    expect(lan.status).toBe(403)
    expect(lan.json.error).toBe("forbidden_network")
    expect((await call(m, p, { extra: { "x-forwarded-for": "100.64.0.9", "tailscale-funnel-request": "?1" } })).status).toBe(403)
  }
  // tailnet + tailscale serve pass
  expect((await call("GET", "/api/records", { peer: "100.101.102.103" })).status).toBe(200)
  expect((await call("GET", "/api/records", { extra: { "x-forwarded-for": "100.64.0.9" } })).status).toBe(200)
  expect(existsSync(recordsPath())).toBe(true)
})

test("rate limits: writes 10/min shared, reveal 5/min own, GET 60/min, with Retry-After", async () => {
  const id = await create() // 1 write
  for (let i = 0; i < 8; i++) expect((await call("PATCH", `/api/records/${id}`, { body: { label: `L${i}` } })).status).toBe(200)
  expect((await call("DELETE", "/api/records/aaaaaaaaaaaa")).status).toBe(404) // 10th write slot
  const w = await call("POST", "/api/records", { body: { type: "passport", fields: { expiry_date: "2030-01-01" } } })
  expect(w.status).toBe(429)
  expect(w.json.error).toBe("rate_limited")
  expect(Number(w.headers.get("retry-after"))).toBeGreaterThan(0)

  for (let i = 0; i < 5; i++) expect((await call("POST", `/api/records/${id}/reveal`)).status).toBe(200)
  const r = await call("POST", `/api/records/${id}/reveal`)
  expect(r.status).toBe(429)
  expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0)

  for (let i = 0; i < 60; i++) expect((await call("GET", "/api/records")).status).toBe(200)
  const g = await call("GET", "/api/records")
  expect(g.status).toBe(429)
  expect(Number(g.headers.get("retry-after"))).toBeGreaterThan(0)
})

test("audit: one line per action, never a value or label; logs carry id + type only", async () => {
  const id = await create(PASSPORT, "passport", "Secret Label Zq")
  await call("PATCH", `/api/records/${id}`, { body: { fields: { sex: "X" } } })
  await call("POST", `/api/records/${id}/reveal`, { extra: { "x-companion-device": "iPhone Test" } })
  await call("DELETE", `/api/records/${id}`)
  const raw = readFileSync(recordsAuditPath(), "utf8")
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l))
  expect(lines.map((l) => l.action)).toEqual(["created", "updated", "revealed", "deleted"])
  for (const l of lines) {
    expect(Object.keys(l).sort()).toEqual(["action", "device_claimed", "id", "peer", "transport", "ts", "type"])
    expect(l).toMatchObject({ id, type: "passport", transport: "loopback", peer: "127.0.0.1" })
  }
  expect(lines[2].device_claimed).toBe("iPhone Test")
  noValuesIn(raw)
  expect(raw).not.toContain("Secret Label")
  expect(stderr).toContain(`records created ${id} passport via=loopback from=127.0.0.1`)
  expect(stderr).toContain(`records revealed ${id} passport via=loopback from=127.0.0.1`)
  noValuesIn(stderr)
  expect(stderr).not.toContain("Secret Label")
  expect(stderr).not.toContain(TOKEN)
})

test("files: dir 0700, records/audit 0600, atomic (no tmp left), store JSON shape", async () => {
  const id = await create()
  await call("POST", `/api/records/${id}/reveal`)
  expect(statSync(recordsDir()).mode & 0o777).toBe(0o700)
  expect(statSync(recordsPath()).mode & 0o777).toBe(0o600)
  expect(statSync(recordsAuditPath()).mode & 0o777).toBe(0o600)
  const doc = JSON.parse(readFileSync(recordsPath(), "utf8"))
  expect(doc.version).toBe(1)
  expect(doc.records[0]).toMatchObject({ id, type: "passport", label: "Passport · CA", fields: PASSPORT })
  expect(typeof doc.records[0].created_at).toBe("string")
  const { readdirSync } = await import("node:fs")
  expect(readdirSync(recordsDir()).filter((f) => f.endsWith(".tmp"))).toEqual([])
})

test("corrupt store: reads 500 store_unreadable, writes refuse and keep the file", async () => {
  await create()
  writeFileSync(recordsPath(), "{broken", { mode: 0o600 })
  expect((await call("GET", "/api/records")).json.error).toBe("store_unreadable")
  expect((await call("POST", "/api/records", { body: { type: "passport", fields: { expiry_date: "2030-01-01" } } })).json.error).toBe("store_unreadable")
  expect(readFileSync(recordsPath(), "utf8")).toBe("{broken")
})

test("reveal: audit unwritable → 500 audit_failed, no fields", async () => {
  const id = await create()
  rmSync(recordsAuditPath())
  const { mkdirSync } = await import("node:fs")
  mkdirSync(recordsAuditPath()) // a directory where the audit file should be
  const r = await call("POST", `/api/records/${id}/reveal`)
  expect(r.status).toBe(500)
  expect(r.json.error).toBe("audit_failed")
  noValuesIn(r.text)
})
