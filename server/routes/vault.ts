import { checkBearerHeaderOnly, unauthorized } from "../lib/auth"
import { companionLog } from "../lib/log"
import { type AuditOrigin, REVEAL_FORBIDDEN, type RevealResult, type VaultResult, deleteSecret, listSecrets, revealSecret, setSecretHosts, upsertSecret, validName, vaultWritable } from "../lib/secret-store"
import { type Limiter, clientOrigin, peerOf, readLimiter, requestLimiter, revealLimiter, writeLimiter } from "../lib/vault-guard"
import { createRequest, declineRequest, fulfilRequest, getRequest, listRequests, type Outcome } from "../lib/secret-requests"
import { HOP_HEADER, type UpstreamConfig, type UpstreamReply, forwardVault, vaultUpstream } from "../lib/vault-upstream"

// Companion Vault API — values are write-only; only the reveal 200 carries one.
//   GET    /api/vault          → { ok, writable, secrets: [{name, hosts, scripts, updated_at}] }
//   POST   /api/vault          {name, value, hosts} → upsert (create or rotate)
//   POST   /api/secret         alias of POST /api/vault (chat composer key button)
//   PATCH  /api/vault/:name    {hosts} → change hosts, value untouched
//   DELETE /api/vault/:name    → remove the line
//   POST   /api/vault/:name/reveal → { ok, name, value } — the ONE exception to
//          "no response carries a value" (Jeremie, 2026-10-02: iOS shows it
//          behind Face ID). Own 5/min budget, audited, never logged.
//   POST   /api/vault/requests  {name, hosts, reason, session_id} → {id} (agent asks)
//   GET    /api/vault/requests[?status=pending] · GET /api/vault/requests/:id[?wait=s]
//   POST   /api/vault/requests/:id/fulfil {value} · POST …/:id/decline (phone answers)
// Gates, in order: network (loopback / tailnet / tailscale serve, else 403) →
// header-only bearer (`?token=` refused, 401) → rate limit (429) → writable
// (501 when tls-secrets.py is absent). The /api/* bearer gate in
// companion-server.ts runs first too; the vault never relies on it.
// Never log the URL or the body: a `?token=` or the value would land in the log.
// Upstream mode (COMPANION_VAULT_UPSTREAM): same gates 1–3 here, then the call
// is forwarded to the other Companion's vault and its status + body come back
// unchanged; the local writable/501 check is skipped (lib/vault-upstream.ts).
// Contract: docs/vault-api.md.

const PREFIX = "/api/vault/"
const REQUESTS = "/api/vault/requests"
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STATUSES = ["pending", "saved", "declined", "expired"]
const MAX_WAIT_S = 25
const REVEAL_SUFFIX = "/reveal"
const NO_STORE = { "Cache-Control": "no-store" }
const REVEAL_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
}

function claimedDevice(req: Request): string {
  const raw = req.headers.get("x-companion-device") || req.headers.get("user-agent") || "unknown"
  return raw.replace(/[^\x20-\x7e]/g, "").slice(0, 64)
}

function reply(r: VaultResult): Response {
  const { status, ...body } = r
  companionLog(`vault ${r.action ?? r.error} ${r.name ?? ""}`.trim())
  return json(body, status)
}

function limited(limiter: Limiter): Response | null {
  const wait = limiter.take()
  if (wait === null) return null
  companionLog("vault rate_limited")
  return json({ ok: false, error: "rate_limited", message: `Trop de requêtes — réessaie dans ${wait}s.`, retry_after: wait }, 429, { "Retry-After": String(wait) })
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null) as unknown
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null
}

async function mutate(req: Request, isCollection: boolean, name: string, origin: AuditOrigin): Promise<Response> {
  if (isCollection && req.method === "POST") {
    const body = await readJson(req)
    if (!body) return json({ ok: false, error: "bad_json" }, 400)
    return reply(await upsertSecret(body, origin))
  }
  if (!isCollection && req.method === "DELETE") return reply(await deleteSecret(name, origin))
  if (!isCollection && req.method === "PATCH") {
    const body = await readJson(req)
    if (!body) return json({ ok: false, error: "bad_json" }, 400)
    return reply(await setSecretHosts(name, body.hosts, origin))
  }
  return json({ ok: false, error: "method_not_allowed" }, 405)
}

function passthrough(r: UpstreamReply, extra?: Record<string, unknown>, base: Record<string, string> = NO_STORE): Response {
  const headers: Record<string, string> = { ...base, "content-type": r.json ? "application/json" : "text/plain;charset=utf-8" }
  if (r.retryAfter) headers["Retry-After"] = r.retryAfter
  const text = extra && r.json ? JSON.stringify({ ...r.json, ...extra }) : r.text
  return new Response(text, { status: r.status, headers })
}

// Gates 1–3 already passed. Bodies are parsed here (bad_json stays local) and
// re-serialized, so only a JSON object ever reaches the upstream.
async function forward(req: Request, up: UpstreamConfig, isCollection: boolean, name: string, device: string): Promise<Response> {
  if (req.method === "GET") return passthrough(await forwardVault(up, "GET", "/api/vault", device), { upstream: up.host })
  if (!isCollection && !validName(name)) return json({ ok: false, error: "bad_name", message: "NOM en MAJUSCULES_ET_CHIFFRES (2–64)" }, 400)
  const body = req.method === "DELETE" ? undefined : await readJson(req)
  if (req.method !== "DELETE" && !body) return json({ ok: false, error: "bad_json" }, 400)
  return passthrough(await forwardVault(up, req.method, isCollection ? "/api/vault" : `/api/vault/${name}`, device, body ?? undefined))
}

// Gates 1–2 + hop guard already passed. Value only ever in the returned body.
// A bad name is never logged: it is caller text (could be a pasted value).
async function reveal(req: Request, name: string, up: UpstreamConfig | null, origin: AuditOrigin): Promise<Response> {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405)
  const wait = limited(revealLimiter)
  if (wait) return wait
  const via = `via=${origin.transport} from=${origin.peer}`
  if (!validName(name)) {
    companionLog(`vault reveal bad_name ${via}`)
    return revealReply(revealSecret(name, origin))
  }
  if (REVEAL_FORBIDDEN.includes(name)) {
    companionLog(`vault reveal reveal_forbidden ${name} ${via}`)
    return revealReply(revealSecret(name, origin))
  }
  if (up) {
    // The upstream audits; it is never asked to run the pull command for a read.
    const r = await forwardVault(up, "POST", `/api/vault/${name}/reveal`, origin.device_claimed, undefined, { pull: false })
    companionLog(`vault reveal ${name} ${via} upstream=${r.status}`)
    return passthrough(r, undefined, REVEAL_HEADERS)
  }
  const r = revealSecret(name, origin)
  companionLog(r.ok ? `vault reveal ${name} ${via}` : `vault reveal ${r.error} ${name} ${via}`)
  return revealReply(r)
}

function revealReply(r: RevealResult): Response {
  const { status, ...body } = r
  return Response.json(body, { status, headers: REVEAL_HEADERS })
}

function outcome(o: Outcome, id: string, name = ""): Response {
  companionLog(`vault request ${id} ${name} ${o.ok ? String(o.body.status) : String(o.body.error)}`.replace(/ +/g, " "))
  return json(o.body, o.status)
}

// Gates 1–2 + hop guard already passed. Requests live on THIS server (the
// phone's WS); in upstream mode only the fulfil's save is forwarded
// (saveSecret). Log lines: id + name + status only — never a body or query.
async function requests(req: Request, url: URL, origin: AuditOrigin, up: UpstreamConfig | null): Promise<Response> {
  const [id = "", action = "", ...extra] = url.pathname.slice(REQUESTS.length + 1).split("/")
  if (req.method === "GET" && !action) {
    const wait = limited(readLimiter)
    if (wait) return wait
    if (!id) {
      const status = url.searchParams.get("status") ?? ""
      if (status && !STATUSES.includes(status)) return json({ ok: false, error: "bad_status" }, 400)
      return json({ ok: true, requests: listRequests(status || undefined) })
    }
    if (!ID_RE.test(id)) return json({ ok: false, error: "not_found" }, 404)
    // Long-poll: hold up to ?wait= seconds while still pending.
    const until = Date.now() + Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait")) || 0)) * 1000
    let r = getRequest(id)
    while (r?.status === "pending" && Date.now() < until && !req.signal.aborted) {
      await Bun.sleep(250)
      r = getRequest(id)
    }
    return r ? json({ ok: true, ...r }) : json({ ok: false, error: "not_found" }, 404)
  }
  if (req.method !== "POST" || extra.length || (id && !["fulfil", "decline"].includes(action))) {
    return json({ ok: false, error: "method_not_allowed" }, 405)
  }
  const wait = limited(id ? writeLimiter : requestLimiter)
  if (wait) return wait
  if (!id) {
    if (!up && !vaultWritable()) return json({ ok: false, error: "vault_unavailable", message: "Coffre en lecture seule sur cet hôte (tls-secrets.py absent)." }, 501)
    const body = await readJson(req)
    if (!body) return json({ ok: false, error: "bad_json" }, 400)
    const o = await createRequest(body)
    return outcome(o, o.ok ? String(o.body.id) : "-", o.ok && typeof body.name === "string" ? body.name : "")
  }
  if (!ID_RE.test(id)) return json({ ok: false, error: "not_found" }, 404)
  const name = getRequest(id)?.name ?? ""
  if (action === "decline") return outcome(declineRequest(id), id, name)
  const body = await readJson(req)
  if (!body) return json({ ok: false, error: "bad_json" }, 400)
  return outcome(await fulfilRequest(id, body.value, origin), id, name)
}

export async function handleVaultRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname
  const isCollection = p === "/api/vault" || (p === "/api/secret" && req.method === "POST")
  if (!isCollection && !p.startsWith(PREFIX)) return null

  const from = clientOrigin(req, peerOf(req))
  if (from.transport === "untrusted") {
    companionLog(`vault forbidden peer=${from.peer}`)
    return json({ ok: false, error: "forbidden_network" }, 403)
  }
  if (!checkBearerHeaderOnly(req)) return unauthorized()

  const up = vaultUpstream()
  // A forwarded call landing on a server that would forward again = a loop.
  if (up && req.headers.get(HOP_HEADER)) return json({ ok: false, error: "upstream_loop" }, 508)
  if (p === REQUESTS || p.startsWith(`${REQUESTS}/`)) {
    return requests(req, url, { device_claimed: claimedDevice(req), transport: from.transport, peer: from.peer }, up)
  }
  const name = isCollection ? "" : p.slice(PREFIX.length)

  if (name.endsWith(REVEAL_SUFFIX)) {
    const origin = { device_claimed: claimedDevice(req), transport: from.transport, peer: from.peer }
    return reveal(req, name.slice(0, -REVEAL_SUFFIX.length), up, origin)
  }

  if (isCollection && req.method === "GET") {
    const wait = limited(readLimiter)
    if (wait) return wait
    if (up) return forward(req, up, true, "", claimedDevice(req))
    return json({ ok: true, writable: vaultWritable(), secrets: listSecrets() })
  }
  const known = (isCollection && req.method === "POST") || (!isCollection && (req.method === "PATCH" || req.method === "DELETE"))
  if (!known) return json({ ok: false, error: "method_not_allowed" }, 405)

  const wait = limited(writeLimiter)
  if (wait) return wait
  if (up) return forward(req, up, isCollection, name, claimedDevice(req))
  // Up front: no body parse, no store read when this host can't sync the mask.
  if (!vaultWritable()) {
    return json({ ok: false, error: "vault_unavailable", message: "Coffre en lecture seule sur cet hôte (tls-secrets.py absent)." }, 501)
  }
  // Valid names are [A-Z0-9_] only, so no URL decoding: anything else is a 400.
  return mutate(req, isCollection, name, { device_claimed: claimedDevice(req), transport: from.transport, peer: from.peer })
}
