import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ID records (passport, driver's licence) in ~/.config/tls-agent/records.json.
// Decision (Jeremie, 2026-10-02): plaintext at rest (dir 0700, file 0600), but
// NEVER exported into agent sessions, never in secrets.env, never mirrored to
// the Mac. This module is the only reader/writer of the file. Field values
// leave it only through `revealRecord` (the POST /api/records/:id/reveal body)
// and `readRecords` (the expiry check, which reads label + expiry_date only).
// No log line, audit entry or error message here ever carries a value or a
// label — errors name the rule, never the offending text.

export type RecordType = "passport" | "driver_license"
export type RecordAction = "created" | "updated" | "deleted" | "revealed"

export interface IdRecord {
  id: string
  type: RecordType
  label: string
  fields: Record<string, string>
  created_at: string
  updated_at: string
}

export interface RecordSummary { id: string; type: RecordType; label: string; expiry_date: string; updated_at: string }

/** Who asked, as recorded in the audit file (server's view + claimed device). */
export interface RecordOrigin { device_claimed: string; transport: string; peer: string }

export type RecordError = "bad_type" | "bad_field" | "bad_date" | "bad_json" | "missing_expiry" | "not_found" | "audit_failed" | "store_unreadable"

export type RecordResult =
  | { ok: true; status: 200 | 201; id: string; type: RecordType; action: RecordAction }
  | { ok: false; status: 400 | 404 | 500; error: RecordError; message: string }

export type RevealRecordResult =
  | { ok: true; status: 200; record: IdRecord }
  | { ok: false; status: 404 | 500; error: RecordError; message: string }

const FIELDS: Record<RecordType, readonly string[]> = {
  passport: ["full_name", "nationality", "document_number", "date_of_birth", "place_of_birth", "sex", "issue_date", "expiry_date", "issuing_authority", "notes"],
  driver_license: ["full_name", "licence_number", "date_of_birth", "address", "class", "conditions", "issue_date", "expiry_date", "issuing_region", "notes"],
}
const DATE_FIELDS = new Set(["date_of_birth", "issue_date", "expiry_date"])
const MAX_VALUE = 200
const MAX_NOTES = 2000
const MAX_LABEL = 60
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
const ID_RE = /^[a-z2-7]{12}$/

// ── Paths (HOME read per call so tests can point it at a temp dir) ──

export function recordsDir(): string {
  return join(process.env.HOME || homedir(), ".config", "tls-agent")
}
export const recordsPath = (): string => join(recordsDir(), "records.json")
export const recordsAuditPath = (): string => join(recordsDir(), "records-audit.jsonl")

// ── Validation ──

export function validType(t: unknown): t is RecordType {
  return t === "passport" || t === "driver_license"
}

export function validId(id: string): boolean {
  return ID_RE.test(id)
}

export function validDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === v
}

function badValue(name: string, v: string): boolean {
  if (v.length > (name === "notes" ? MAX_NOTES : MAX_VALUE)) return true
  return name === "notes" ? /[\x00-\x09\x0b-\x1f\x7f]/.test(v) : /[\x00-\x1f\x7f]/.test(v)
}

type Fail = Extract<RecordResult, { ok: false }>

function fail(error: RecordError, message: string, status: 400 | 404 | 500 = 400): Fail {
  return { ok: false, status, error, message }
}

/**
 * Check a `fields` object against the type's schema. "" = delete (returned as
 * null). Never echoes a key or value back: an unknown key may be pasted text.
 */
function checkFields(type: RecordType, raw: unknown): Map<string, string | null> | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("bad_field", "fields doit être un objet")
  const out = new Map<string, string | null>()
  const allowed = FIELDS[type]
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(k)) return fail("bad_field", "champ inconnu pour ce type de document")
    if (typeof v !== "string") return fail("bad_field", `${k}: texte attendu`)
    if (v === "") { out.set(k, null); continue }
    if (badValue(k, v)) return fail("bad_field", `${k}: trop long ou caractère de contrôle`)
    if (DATE_FIELDS.has(k) && !validDate(v)) return fail("bad_date", `${k}: date AAAA-MM-JJ attendue`)
    out.set(k, v)
  }
  return out
}

/** undefined = not given; "" = reset to the default label. */
function checkLabel(raw: unknown): string | undefined | Fail {
  if (raw === undefined) return undefined
  if (typeof raw !== "string") return fail("bad_field", "label: texte attendu")
  const label = raw.trim()
  if (label.length > MAX_LABEL || /[\x00-\x1f\x7f]/.test(label)) return fail("bad_field", `label: ${MAX_LABEL} caractères max, sans caractère de contrôle`)
  return label
}

export function defaultLabel(type: RecordType, fields: Record<string, string>): string {
  const base = type === "passport" ? "Passport" : "Driver licence"
  const where = (type === "passport" ? fields.nationality : fields.issuing_region)?.trim()
  return (where ? `${base} · ${where}` : base).slice(0, MAX_LABEL)
}

// ── IO ──

function ensureDir(): void {
  const dir = recordsDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/** Atomic (tmp + rename), 0600, in a 0700 dir. Shared with records-expiry. */
export function atomicWriteJson(path: string, value: unknown): void {
  ensureDir()
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/** All records, or null when the file exists but can't be parsed. */
export function readRecords(): IdRecord[] | null {
  const path = recordsPath()
  if (!existsSync(path)) return []
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; records?: unknown }
    return doc.version === 1 && Array.isArray(doc.records) ? doc.records as IdRecord[] : null
  } catch {
    return null
  }
}

function writeRecords(records: IdRecord[]): void {
  atomicWriteJson(recordsPath(), { version: 1, records })
}

function audit(action: RecordAction, rec: { id: string; type: RecordType }, origin: RecordOrigin): void {
  ensureDir()
  const line = { ts: new Date().toISOString(), action, id: rec.id, type: rec.type, device_claimed: origin.device_claimed, transport: origin.transport, peer: origin.peer }
  appendFileSync(recordsAuditPath(), JSON.stringify(line) + "\n", { mode: 0o600 })
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => ID_ALPHABET[b & 31]).join("")
}

// ponytail: one global write lock — a handful of records, rare writes.
let lock: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.catch(() => undefined)
  return run
}

const UNREADABLE = (): Fail => fail("store_unreadable", "records.json illisible — rien n'a changé.", 500)
const NOT_FOUND = (): Fail => fail("not_found", "document introuvable", 404)

// Write first, then audit; an audit failure after a committed write must not
// turn a success into an error (the change is real). The route logs either way.
function commit(records: IdRecord[], action: RecordAction, rec: IdRecord, origin: RecordOrigin, status: 200 | 201): RecordResult {
  writeRecords(records)
  try { audit(action, rec, origin) } catch { /* see above */ }
  return { ok: true, status, id: rec.id, type: rec.type, action }
}

// ── Operations ──

export function listRecords(): RecordSummary[] | null {
  const all = readRecords()
  if (!all) return null
  return all
    .map((r) => ({ id: r.id, type: r.type, label: r.label, expiry_date: r.fields.expiry_date ?? "", updated_at: r.updated_at }))
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))
}

export function createRecord(body: Record<string, unknown>, origin: RecordOrigin): Promise<RecordResult> {
  if (!validType(body.type)) return Promise.resolve(fail("bad_type", "type: passport ou driver_license"))
  const type = body.type
  const checked = checkFields(type, body.fields)
  if (!(checked instanceof Map)) return Promise.resolve(checked)
  const label = checkLabel(body.label)
  if (typeof label === "object") return Promise.resolve(label)
  const fields: Record<string, string> = {}
  for (const [k, v] of checked) if (v !== null) fields[k] = v
  if (!fields.expiry_date) return Promise.resolve(fail("missing_expiry", "expiry_date est obligatoire"))
  return serialized(() => {
    const all = readRecords()
    if (!all) return UNREADABLE()
    const now = new Date().toISOString()
    let id = newId()
    while (all.some((r) => r.id === id)) id = newId()
    const rec: IdRecord = { id, type, label: label || defaultLabel(type, fields), fields, created_at: now, updated_at: now }
    return commit([...all, rec], "created", rec, origin, 201)
  })
}

export function updateRecord(id: string, body: Record<string, unknown>, origin: RecordOrigin): Promise<RecordResult> {
  if (!validId(id)) return Promise.resolve(NOT_FOUND())
  const label = checkLabel(body.label)
  if (typeof label === "object") return Promise.resolve(label)
  if (label === undefined && body.fields === undefined) return Promise.resolve(fail("bad_field", "rien à modifier (label ou fields)"))
  return serialized(() => {
    const all = readRecords()
    if (!all) return UNREADABLE()
    const rec = all.find((r) => r.id === id)
    if (!rec) return NOT_FOUND()
    const fields = { ...rec.fields }
    if (body.fields !== undefined) {
      const checked = checkFields(rec.type, body.fields)
      if (!(checked instanceof Map)) return checked
      for (const [k, v] of checked) {
        if (v === null) delete fields[k]
        else fields[k] = v
      }
    }
    if (!fields.expiry_date) return fail("missing_expiry", "expiry_date est obligatoire")
    const next: IdRecord = { ...rec, fields, label: label === undefined ? rec.label : label || defaultLabel(rec.type, fields), updated_at: new Date().toISOString() }
    return commit(all.map((r) => (r.id === id ? next : r)), "updated", next, origin, 200)
  })
}

export function deleteRecord(id: string, origin: RecordOrigin): Promise<RecordResult> {
  if (!validId(id)) return Promise.resolve(NOT_FOUND())
  return serialized(() => {
    const all = readRecords()
    if (!all) return UNREADABLE()
    const rec = all.find((r) => r.id === id)
    if (!rec) return NOT_FOUND()
    return commit(all.filter((r) => r.id !== id), "deleted", rec, origin, 200)
  })
}

/** The one place full fields leave the store. No audit line → no record. */
export function revealRecord(id: string, origin: RecordOrigin): RevealRecordResult {
  if (!validId(id)) return NOT_FOUND() as RevealRecordResult
  const all = readRecords()
  if (!all) return UNREADABLE() as RevealRecordResult
  const rec = all.find((r) => r.id === id)
  if (!rec) return NOT_FOUND() as RevealRecordResult
  try {
    audit("revealed", rec, origin)
  } catch {
    return { ok: false, status: 500, error: "audit_failed", message: "document non affiché — journal d'audit illisible." }
  }
  return { ok: true, status: 200, record: { id: rec.id, type: rec.type, label: rec.label, fields: { ...rec.fields }, created_at: rec.created_at, updated_at: rec.updated_at } }
}
