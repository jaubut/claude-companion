import type { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import type { SourceItem, TriageOption } from "./triage"
import type { ExecOutcome } from "./triage-engine"

// Outbound approval (docs/orchestrator-triage-api.md#source-outbound): an action
// that leaves the house (v1: one email) is proposed with its exact payload, shown
// in full on a triage card, and sent only when Jeremie approves the version he saw.
// Pure helpers + the companion.db store (injected Database: tests use :memory:).
//   outbound_actions  one row per proposal; payload_hash = the card version;
//                     status proposed → sending → sent | rejected (failed send → proposed again)

export type OutboundAccount = "personal" | "hello"
export type OutboundStatus = "proposed" | "sending" | "sent" | "rejected"

/** The fields that leave: exactly what payloadHash covers. */
export interface OutboundPayload {
  account: OutboundAccount
  to: string[]
  cc: string[]
  subject: string
  body: string
  inReplyTo: string | null
}

export interface OutboundProposal extends OutboundPayload {
  kind: "email"
  threadId: string | null
  why: string
  requestedBy: string
}

export interface OutboundRecord extends OutboundProposal {
  id: string
  payloadHash: string
  status: OutboundStatus
  messageId: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

/** The wire view on a triage card (TriageItem.payload). */
export interface OutboundView extends OutboundProposal {
  id: string
  payloadHash: string
}

/** v1 guardrails (server policy, enforced at propose AND at send, whatever was approved). */
export const BODY_MAX_BYTES = 50 * 1024
export const RECIPIENTS_MAX = 10
const SUBJECT_MAX = 998
const META_MAX = 2000
const HEADER_ID_MAX = 1000
const ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

// ── payload ──────────────────────────────────────────────────────────────────

export const sendable = (p: OutboundPayload): OutboundPayload => ({
  account: p.account, to: [...p.to], cc: [...p.cc], subject: p.subject, body: p.body, inReplyTo: p.inReplyTo,
})

/** Canonical JSON: fixed key order, no whitespace. */
export function canonicalJson(p: OutboundPayload): string {
  const s = sendable(p)
  return JSON.stringify({ account: s.account, to: s.to, cc: s.cc, subject: s.subject, body: s.body, inReplyTo: s.inReplyTo })
}

export const payloadHash = (p: OutboundPayload): string => createHash("sha256").update(canonicalJson(p)).digest("hex")

/** Why the server refuses to send this, whatever was approved; null = allowed. */
export function policyRefusal(p: Pick<OutboundPayload, "to" | "cc" | "body">): string | null {
  const bytes = Buffer.byteLength(p.body, "utf8")
  if (bytes > BODY_MAX_BYTES) return `body is ${bytes} bytes (max ${BODY_MAX_BYTES})`
  const n = p.to.length + p.cc.length
  if (n > RECIPIENTS_MAX) return `${n} recipients (max ${RECIPIENTS_MAX})`
  return null
}

const optStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function addresses(v: unknown, field: string, required: boolean): string[] | string {
  if (v === undefined || v === null) return required ? `${field} required` : []
  if (!Array.isArray(v)) return `${field} must be an array`
  const out: string[] = []
  for (const a of v) {
    if (typeof a !== "string" || !ADDRESS_RE.test(a.trim())) return `${field}: invalid address`
    out.push(a.trim())
  }
  if (required && !out.length) return `${field} required`
  return out
}

export type ParseResult = { ok: true; proposal: OutboundProposal } | { ok: false; error: string }

/** The producer's JSON → a proposal (400 on anything malformed; the policy is checked separately). */
export function parseProposal(raw: Record<string, unknown>): ParseResult {
  const bad = (error: string): ParseResult => ({ ok: false, error })
  const { account, subject, body } = raw
  if (raw.kind !== "email") return bad("kind must be \"email\"")
  if (account !== "personal" && account !== "hello") return bad("account must be \"personal\" or \"hello\"")
  const to = addresses(raw.to, "to", true)
  if (typeof to === "string") return bad(to)
  const cc = addresses(raw.cc, "cc", false)
  if (typeof cc === "string") return bad(cc)
  if (typeof subject !== "string" || !subject.trim()) return bad("subject required")
  if (/[\r\n]/.test(subject) || subject.length > SUBJECT_MAX) return bad("subject must be one line")
  if (typeof body !== "string" || !body.trim()) return bad("body required")
  for (const k of ["inReplyTo", "threadId"] as const) {
    const v = raw[k]
    if (v !== undefined && v !== null && (typeof v !== "string" || /[\r\n]/.test(v) || v.length > HEADER_ID_MAX)) return bad(`${k} must be a one-line string`)
  }
  const why = optStr(raw.why)
  if (!why || why.length > META_MAX) return bad("why required")
  const requestedBy = optStr(raw.requestedBy)
  if (!requestedBy || requestedBy.length > 200) return bad("requestedBy required")
  return {
    ok: true,
    proposal: {
      kind: "email", account, to, cc, subject: subject.trim(), body,
      inReplyTo: optStr(raw.inReplyTo), threadId: optStr(raw.threadId), why, requestedBy,
    },
  }
}

export type ProduceResult = { status: number; body: Record<string, unknown> }

/** POST /api/orchestrator/outbound: 400 malformed · 422 refused (policy) · 201 {id, payloadHash}. */
export function produceOutbound(store: OutboundStore, raw: Record<string, unknown>, now: number): ProduceResult {
  const parsed = parseProposal(raw)
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } }
  const refusal = policyRefusal(parsed.proposal)
  if (refusal) return { status: 422, body: { ok: false, error: "refused", reason: refusal } }
  const rec = store.propose(parsed.proposal, now)
  return { status: 201, body: { ok: true, id: rec.id, payloadHash: rec.payloadHash, status: rec.status } }
}

// ── store ────────────────────────────────────────────────────────────────────

interface Raw {
  id: string; kind: "email"; account: OutboundAccount; to_json: string; cc_json: string; subject: string; body: string
  in_reply_to: string | null; thread_id: string | null; why: string; requested_by: string; payload_hash: string
  status: OutboundStatus; message_id: string | null; last_error: string | null; created_at: number; updated_at: number
}

const list = (json: string): string[] => {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

function toRecord(r: Raw): OutboundRecord {
  return {
    id: r.id, kind: r.kind, account: r.account, to: list(r.to_json), cc: list(r.cc_json), subject: r.subject, body: r.body,
    inReplyTo: r.in_reply_to, threadId: r.thread_id, why: r.why, requestedBy: r.requested_by, payloadHash: r.payload_hash,
    status: r.status, messageId: r.message_id, lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export interface OutboundStore {
  propose(p: OutboundProposal, now: number): OutboundRecord
  get(id: string): OutboundRecord | null
  /** Cards: everything still waiting for Jeremie. */
  listProposed(): OutboundRecord[]
  /** New body → new hash (a new card version); null when not `proposed`. */
  editBody(id: string, body: string, now: number): OutboundRecord | null
  /** proposed → sending, only at this exact hash (the one approval that may send); false = stale or already taken. */
  claim(id: string, hash: string, now: number): boolean
  markSent(id: string, messageId: string | null, now: number): void
  /** A send that did not go out: back to proposed with the error, the card stays. */
  release(id: string, error: string, now: number): void
  /** proposed → rejected at this hash; false = stale. */
  reject(id: string, hash: string, now: number): boolean
}

export function createOutboundStore(db: Database): OutboundStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_actions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, account TEXT NOT NULL, to_json TEXT NOT NULL, cc_json TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, in_reply_to TEXT, thread_id TEXT, why TEXT NOT NULL, requested_by TEXT NOT NULL,
      payload_hash TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbound_actions_status ON outbound_actions (status, created_at);
  `)
  const store: OutboundStore = {
    propose(p, now) {
      const id = randomUUID().replace(/-/g, "")
      db.query(
        "INSERT INTO outbound_actions (id, kind, account, to_json, cc_json, subject, body, in_reply_to, thread_id, why, requested_by, payload_hash, status, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)",
      ).run(id, p.kind, p.account, JSON.stringify(p.to), JSON.stringify(p.cc), p.subject, p.body, p.inReplyTo, p.threadId, p.why, p.requestedBy, payloadHash(p), now, now)
      return store.get(id)!
    },
    get(id) {
      const r = db.query("SELECT * FROM outbound_actions WHERE id = ?").get(id) as Raw | null
      return r ? toRecord(r) : null
    },
    listProposed() {
      return (db.query("SELECT * FROM outbound_actions WHERE status = 'proposed' ORDER BY created_at, id LIMIT 200").all() as Raw[]).map(toRecord)
    },
    editBody(id, body, now) {
      const cur = store.get(id)
      if (!cur || cur.status !== "proposed") return null
      const hash = payloadHash({ ...cur, body })
      const res = db.query("UPDATE outbound_actions SET body = ?, payload_hash = ?, updated_at = ? WHERE id = ? AND status = 'proposed' AND payload_hash = ?")
        .run(body, hash, now, id, cur.payloadHash)
      return res.changes ? store.get(id) : null
    },
    claim(id, hash, now) {
      return db.query("UPDATE outbound_actions SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'proposed' AND payload_hash = ?")
        .run(now, id, hash).changes === 1
    },
    markSent(id, messageId, now) {
      db.query("UPDATE outbound_actions SET status = 'sent', message_id = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'sending'").run(messageId, now, id)
    },
    release(id, error, now) {
      db.query("UPDATE outbound_actions SET status = 'proposed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending'").run(error.slice(0, 500), now, id)
    },
    reject(id, hash, now) {
      return db.query("UPDATE outbound_actions SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'proposed' AND payload_hash = ?")
        .run(now, id, hash).changes === 1
    },
  }
  return store
}

// ── triage card ──────────────────────────────────────────────────────────────

export const outboundView = (r: OutboundRecord): OutboundView => ({
  id: r.id, kind: r.kind, account: r.account, to: [...r.to], cc: [...r.cc], subject: r.subject, body: r.body,
  inReplyTo: r.inReplyTo, threadId: r.threadId, why: r.why, requestedBy: r.requestedBy, payloadHash: r.payloadHash,
})

export function outboundSource(r: OutboundRecord): SourceItem {
  return {
    source: "outbound", refId: r.id, version: r.payloadHash, title: r.subject, project: null, repo: null,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    facts: { why: r.why, requestedBy: r.requestedBy, ...(r.lastError ? { lastError: r.lastError } : {}) },
    url: null, payload: outboundView(r),
    ref: { source: "outbound", outboundId: r.id },
  }
}

// ── executor ─────────────────────────────────────────────────────────────────

/** Sends one payload; returns the Gmail message id (null if the sender did not print one). Throws = not sent. */
export type OutboundSender = (p: OutboundPayload) => Promise<{ messageId: string | null }>

export type SendOutcome =
  | { kind: "sent"; messageId: string | null }
  | { kind: "stale" }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; error: string }

/**
 * Send iff the stored hash still equals the approved one: claim (proposed → sending at that hash) is
 * the single gate, so a replay, a concurrent tap or an edit in between never sends twice or sends
 * something else. The policy is re-checked on the stored payload whatever was approved.
 */
export async function sendApproved(store: OutboundStore, sender: OutboundSender, id: string, approvedHash: string, now: () => number): Promise<SendOutcome> {
  const rec = store.get(id)
  if (!rec || rec.status !== "proposed" || rec.payloadHash !== approvedHash) return { kind: "stale" }
  const refusal = policyRefusal(rec)
  if (refusal) return { kind: "refused", reason: refusal }
  if (!store.claim(id, approvedHash, now())) return { kind: "stale" }
  try {
    const out = await sender(sendable(rec))
    store.markSent(id, out.messageId, now())
    return { kind: "sent", messageId: out.messageId }
  } catch (err) {
    const error = (err as Error)?.message ?? String(err)
    store.release(id, error, now())
    return { kind: "failed", error }
  }
}

export interface OutboundExecDeps { store: OutboundStore; sender: OutboundSender; now: () => number }

/**
 * A chosen option on an outbound card. `src.version` is the hash the engine checked against the
 * client's `version` and the store's current row. Only Jeremie's tap (by "triage") acts.
 */
export async function executeOutbound(deps: OutboundExecDeps, src: SourceItem, option: TriageOption, text: string | null, by = "triage"): Promise<ExecOutcome> {
  if (src.ref.source !== "outbound") return { kind: "error", status: 400, error: "wrong_source" }
  if (by !== "triage") return { kind: "error", status: 403, error: "human_only" }
  const id = src.ref.outboundId
  const a = option.action
  if (a.kind === "approve") {
    const out = await sendApproved(deps.store, deps.sender, id, src.version, deps.now)
    if (out.kind === "sent") return { kind: "done", detail: { status: "sent", messageId: out.messageId } }
    if (out.kind === "stale") return { kind: "stale", reason: "changed" }
    if (out.kind === "refused") return { kind: "error", status: 422, error: "refused", extra: { reason: out.reason } }
    return { kind: "error", status: 502, error: "send_failed", extra: { reason: out.error.slice(0, 300) } }
  }
  if (a.kind === "answer_custom") {
    const rec = deps.store.get(id)
    if (!rec || rec.status !== "proposed" || rec.payloadHash !== src.version) return { kind: "stale", reason: "changed" }
    const body = text ?? ""
    if (!body.trim()) return { kind: "error", status: 422, error: "text_required" }
    const refusal = policyRefusal({ ...rec, body })
    if (refusal) return { kind: "error", status: 422, error: "refused", extra: { reason: refusal } }
    const next = deps.store.editBody(id, body, deps.now())
    return next ? { kind: "done", detail: { status: "proposed", payloadHash: next.payloadHash } } : { kind: "stale", reason: "changed" }
  }
  if (a.kind === "reject") {
    return deps.store.reject(id, src.version, deps.now()) ? { kind: "done", detail: { status: "rejected" } } : { kind: "stale", reason: "changed" }
  }
  return { kind: "error", status: 400, error: "unsupported_action" }
}

/** The collector's current view of one outbound item; null = no longer waiting. */
export function currentOutbound(store: OutboundStore, id: string): SourceItem | null {
  const rec = store.get(id)
  return rec && rec.status === "proposed" ? outboundSource(rec) : null
}

// ── message id ───────────────────────────────────────────────────────────────

/** The Gmail message id out of the sender's stdout: JSON {id} / {messageId}, else an `id: <hex>` line. */
export function parseMessageId(stdout: string): string | null {
  const text = stdout.trim()
  for (const line of [text, ...text.split("\n").reverse()]) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const v = o?.messageId ?? o?.message_id ?? o?.id
      if (typeof v === "string" && /^[\w-]{6,}$/.test(v)) return v
    } catch { /* not JSON */ }
  }
  return /\b(?:message[ _-]?id|id)\s*[:=]\s*([0-9a-f]{8,})\b/i.exec(text)?.[1] ?? null
}
