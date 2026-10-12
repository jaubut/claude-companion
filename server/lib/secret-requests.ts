import { randomUUID } from "node:crypto"
import { broadcast } from "../state"
import { pushToAll } from "./push"
import { type AuditOrigin, type VaultResult, saveSecret, validHosts, validName } from "./secret-store"
import { clock } from "./vault-guard"

// Agent-initiated secret requests (POST /api/vault/requests): an agent asks
// for NAME, the phone shows a masked field, the value goes straight to the
// vault via saveSecret. A request never carries a value — not in the store,
// the WS events, the push or any response. Name + hosts are fixed at creation;
// fulfil only supplies the value. In-memory: a server restart drops pending
// requests (the agent's ask-secret then sees 404 and exits).

export const REQUEST_TTL_MS = 15 * 60_000
// Resolved requests stay readable this long so a polling agent sees the outcome.
const KEEP_MS = 60 * 60_000
const MAX_REASON = 200
const SESSION_RE = /^[A-Za-z0-9._:-]{0,128}$/

export type RequestStatus = "pending" | "saved" | "declined" | "expired"

export interface SecretRequest {
  id: string
  name: string
  hosts: string[]
  reason: string
  session_id: string
  expires_at: string
  status: RequestStatus
}

interface Entry { req: Omit<SecretRequest, "status">; state: "pending" | "saving" | "saved" | "declined"; expiresMs: number }

export interface RequestDeps {
  broadcast: (data: Record<string, unknown>) => void
  push: (name: string, reason: string, id: string) => void
}

function pushRequest(name: string, reason: string, id: string): void {
  void pushToAll({
    title: `Claude needs ${name}`,
    body: reason,
    category: "secret_request",
    interruptionLevel: "time-sensitive",
    collapseId: id,
    userInfo: { requestId: id, name },
  }).catch(() => { /* a failed push never blocks the request */ })
}

// Test seam: tests swap these to capture the events.
export const requestDeps: RequestDeps = { broadcast, push: pushRequest }

const entries = new Map<string, Entry>()

export function resetSecretRequests(): void {
  entries.clear()
}

function statusOf(e: Entry): RequestStatus {
  if (e.state === "saved" || e.state === "declined") return e.state
  return clock.now() >= e.expiresMs ? "expired" : "pending"
}

function view(e: Entry): SecretRequest {
  return { ...e.req, status: statusOf(e) }
}

function prune(): void {
  const t = clock.now()
  for (const [id, e] of entries) if (t - e.expiresMs > KEEP_MS) entries.delete(id)
}

export type Outcome =
  | { ok: true; status: 200; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> }

function fail(status: number, error: string, message: string): Outcome {
  return { ok: false, status, body: { ok: false, error, message } }
}

export function createRequest(input: Record<string, unknown>): Outcome {
  const { name, hosts, reason } = input
  const session = input.session_id ?? ""
  if (!validName(name)) return fail(400, "bad_name", "NOM en MAJUSCULES_ET_CHIFFRES (2–64)")
  if (!validHosts(hosts) || hosts.length === 0) return fail(400, "bad_hosts", "1 à 5 hôtes (ex. api.example.com ou *.example.com)")
  if (typeof reason !== "string" || !reason.trim() || reason.length > MAX_REASON || /[\x00-\x1f\x7f]/.test(reason)) {
    return fail(400, "bad_reason", `raison requise, ${MAX_REASON} caractères max, une ligne`)
  }
  if (typeof session !== "string" || !SESSION_RE.test(session)) return fail(400, "bad_session_id", "session_id invalide")
  prune()
  const expiresMs = clock.now() + REQUEST_TTL_MS
  const req = { id: randomUUID(), name, hosts, reason: reason.trim(), session_id: session, expires_at: new Date(expiresMs).toISOString() }
  entries.set(req.id, { req, state: "pending", expiresMs })
  requestDeps.broadcast({ type: "secret_request", ...req })
  requestDeps.push(name, req.reason, req.id)
  return { ok: true, status: 200, body: { ok: true, id: req.id, status: "pending", expires_at: req.expires_at } }
}

export function getRequest(id: string): SecretRequest | null {
  const e = entries.get(id)
  return e ? view(e) : null
}

export function listRequests(status?: string): SecretRequest[] {
  return [...entries.values()].map(view).filter((r) => !status || r.status === status)
}

/** Live entry that may still be fulfilled/declined, or the refusal. */
function claimable(id: string): Entry | Outcome {
  const e = entries.get(id)
  if (!e) return fail(404, "not_found", "Demande introuvable.")
  const s = statusOf(e)
  if (s === "expired") return fail(410, "expired", "Demande expirée — rien enregistré.")
  if (e.state !== "pending") return fail(409, "already_resolved", "Demande déjà traitée.")
  return e
}

function resolved(e: Entry, status: "saved" | "declined"): void {
  e.state = status
  requestDeps.broadcast({ type: "secret_request_resolved", id: e.req.id, status })
}

/**
 * Save the value under the REQUEST's name + hosts — the body's value is the
 * only client input used. A failed save (bad value, sync failure) leaves the
 * request pending so the phone can retry.
 */
export async function fulfilRequest(id: string, value: unknown, origin: Partial<AuditOrigin>): Promise<Outcome> {
  const e = claimable(id)
  if (!("req" in e)) return e
  if (typeof value !== "string") return fail(400, "bad_value", `valeur de ${e.req.name} refusée`)
  e.state = "saving"
  let r: VaultResult
  try {
    r = await saveSecret({ name: e.req.name, value, hosts: e.req.hosts }, origin)
  } catch {
    r = { ok: false, status: 500, error: "save_failed", message: `${e.req.name} NON enregistré.` }
  }
  if (!r.ok) {
    e.state = "pending"
    const { status, ...body } = r
    return { ok: false, status, body: { ...body, ok: false } }
  }
  resolved(e, "saved")
  return { ok: true, status: 200, body: { ok: true, id, status: "saved", name: e.req.name, hosts: e.req.hosts, message: r.message } }
}

export function declineRequest(id: string): Outcome {
  const e = claimable(id)
  if (!("req" in e)) return e
  resolved(e, "declined")
  return { ok: true, status: 200, body: { ok: true, id, status: "declined" } }
}
