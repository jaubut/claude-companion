import { checkBearerHeaderOnly, unauthorized } from "../lib/auth"
import { companionLog } from "../lib/log"
import { type RecordOrigin, type RecordResult, type RevealRecordResult, createRecord, deleteRecord, listRecords, revealRecord, updateRecord, validId } from "../lib/records-store"
import { type Limiter, clientOrigin, createLimiter, peerOf } from "../lib/vault-guard"
import { HOP_HEADER, type UpstreamConfig, type UpstreamReply, forwardVault, vaultUpstream } from "../lib/vault-upstream"

// ID records API (passport, driver's licence) — mirrors routes/vault.ts.
//   GET    /api/records             → { ok, writable, records:[{id, type, label, expiry_date, updated_at}] }
//   POST   /api/records             {type, label?, fields} → { ok, id } (201)
//   PATCH  /api/records/:id         {label?, fields?} (merge; "" deletes a field) → { ok, id }
//   DELETE /api/records/:id         → { ok, id }
//   POST   /api/records/:id/reveal  → { ok, record } — the ONLY response with field values.
// Gates, in order: network (loopback / tailnet / tailscale serve, else 403) →
// header-only bearer (`?token=` refused, 401) → upstream hop guard (508) →
// rate limit (429). Budgets are the records' own, not the vault's.
// Never log the URL, the body, a label or a value — ids and types only.
// Upstream mode (COMPANION_VAULT_UPSTREAM, the Mac): every call is forwarded to
// the store host's /api/records; no local records.json is ever read or written
// and COMPANION_VAULT_PULL_CMD never runs. Contract: docs/records-api.md.

const BASE = "/api/records"
const PREFIX = "/api/records/"
const REVEAL_SUFFIX = "/reveal"
const NO_STORE = { "Cache-Control": "no-store" }
const REVEAL_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" }

export const recordsWriteLimiter = createLimiter(10, 60_000)
export const recordsReadLimiter = createLimiter(60, 60_000)
export const recordsRevealLimiter = createLimiter(5, 60_000)

export function resetRecordsLimits(): void {
  recordsWriteLimiter.reset()
  recordsReadLimiter.reset()
  recordsRevealLimiter.reset()
}

function json(body: unknown, status = 200, headers: Record<string, string> = NO_STORE): Response {
  return Response.json(body, { status, headers })
}

function claimedDevice(req: Request): string {
  const raw = req.headers.get("x-companion-device") || req.headers.get("user-agent") || "unknown"
  return raw.replace(/[^\x20-\x7e]/g, "").slice(0, 64)
}

const via = (o: RecordOrigin): string => `via=${o.transport} from=${o.peer}`

function limited(limiter: Limiter): Response | null {
  const wait = limiter.take()
  if (wait === null) return null
  companionLog("records rate_limited")
  return json({ ok: false, error: "rate_limited", message: `Trop de requêtes — réessaie dans ${wait}s.`, retry_after: wait }, 429, { ...NO_STORE, "Retry-After": String(wait) })
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null) as unknown
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null
}

function reply(r: RecordResult, origin: RecordOrigin): Response {
  if (r.ok) {
    companionLog(`records ${r.action} ${r.id} ${r.type} ${via(origin)}`)
    return json({ ok: true, id: r.id }, r.status)
  }
  companionLog(`records ${r.error} ${via(origin)}`)
  return json({ ok: false, error: r.error, message: r.message }, r.status)
}

function revealReply(r: RevealRecordResult, origin: RecordOrigin): Response {
  if (r.ok) {
    companionLog(`records revealed ${r.record.id} ${r.record.type} ${via(origin)}`)
    return json({ ok: true, record: r.record }, 200, REVEAL_HEADERS)
  }
  companionLog(`records reveal ${r.error} ${via(origin)}`)
  return json({ ok: false, error: r.error, message: r.message }, r.status, REVEAL_HEADERS)
}

function passthrough(r: UpstreamReply, extra?: Record<string, unknown>, base: Record<string, string> = NO_STORE): Response {
  const headers: Record<string, string> = { ...base, "content-type": r.json ? "application/json" : "text/plain;charset=utf-8" }
  if (r.retryAfter) headers["Retry-After"] = r.retryAfter
  const text = extra && r.json ? JSON.stringify({ ...r.json, ...extra }) : r.text
  return new Response(text, { status: r.status, headers })
}

// Upstream call. Never asks the upstream to run the pull command.
async function forward(up: UpstreamConfig, method: string, path: string, origin: RecordOrigin, body?: Record<string, unknown>, headers = NO_STORE): Promise<Response> {
  const r = await forwardVault(up, method, path, origin.device_claimed, body, { pull: false })
  companionLog(`records ${method} upstream=${r.status} ${via(origin)}`)
  return passthrough(r, method === "GET" ? { upstream: up.host } : undefined, headers)
}

async function reveal(req: Request, id: string, up: UpstreamConfig | null, origin: RecordOrigin): Promise<Response> {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, REVEAL_HEADERS)
  const wait = limited(recordsRevealLimiter)
  if (wait) return wait
  if (!validId(id)) return revealReply(revealRecord(id, origin), origin)
  if (up) return forward(up, "POST", `${PREFIX}${id}${REVEAL_SUFFIX}`, origin, undefined, REVEAL_HEADERS)
  return revealReply(revealRecord(id, origin), origin)
}

// Writes. Gates done; bodies are parsed here (bad_json stays local) and
// re-serialized, so only a JSON object ever reaches the upstream.
async function mutate(req: Request, id: string | null, up: UpstreamConfig | null, origin: RecordOrigin): Promise<Response> {
  if (id !== null && !validId(id)) return reply({ ok: false, status: 404, error: "not_found", message: "document introuvable" }, origin)
  const body = req.method === "DELETE" ? undefined : await readJson(req)
  if (req.method !== "DELETE" && !body) return json({ ok: false, error: "bad_json" }, 400)
  if (up) return forward(up, req.method, id === null ? BASE : `${PREFIX}${id}`, origin, body ?? undefined)
  if (id === null) return reply(await createRecord(body!, origin), origin)
  if (req.method === "PATCH") return reply(await updateRecord(id, body!, origin), origin)
  return reply(await deleteRecord(id, origin), origin)
}

export async function handleRecordsRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname
  const isCollection = p === BASE
  if (!isCollection && !p.startsWith(PREFIX)) return null

  const from = clientOrigin(req, peerOf(req))
  if (from.transport === "untrusted") {
    companionLog(`records forbidden peer=${from.peer}`)
    return json({ ok: false, error: "forbidden_network" }, 403)
  }
  if (!checkBearerHeaderOnly(req)) return unauthorized()

  const up = vaultUpstream()
  if (up && req.headers.get(HOP_HEADER)) return json({ ok: false, error: "upstream_loop" }, 508)
  const origin: RecordOrigin = { device_claimed: claimedDevice(req), transport: from.transport, peer: from.peer }
  const rest = isCollection ? "" : p.slice(PREFIX.length)

  if (rest.endsWith(REVEAL_SUFFIX)) return reveal(req, rest.slice(0, -REVEAL_SUFFIX.length), up, origin)

  if (isCollection && req.method === "GET") {
    const wait = limited(recordsReadLimiter)
    if (wait) return wait
    if (up) return forward(up, "GET", BASE, origin)
    const records = listRecords()
    if (!records) {
      companionLog("records store_unreadable")
      return json({ ok: false, error: "store_unreadable", message: "records.json illisible." }, 500)
    }
    return json({ ok: true, writable: true, records })
  }
  const known = (isCollection && req.method === "POST") || (!isCollection && (req.method === "PATCH" || req.method === "DELETE"))
  if (!known) return json({ ok: false, error: "method_not_allowed" }, 405)

  const wait = limited(recordsWriteLimiter)
  if (wait) return wait
  return mutate(req, isCollection ? null : rest, up, origin)
}
