import { checkBearerHeaderOnly, unauthorized } from "../lib/auth"
import { companionLog } from "../lib/log"
import { type AuditOrigin, type VaultResult, deleteSecret, listSecrets, setSecretHosts, upsertSecret, vaultWritable } from "../lib/secret-store"
import { type Limiter, clientOrigin, peerOf, readLimiter, writeLimiter } from "../lib/vault-guard"

// Companion Vault API — values are write-only, no response ever carries one.
//   GET    /api/vault          → { ok, writable, secrets: [{name, hosts, scripts, updated_at}] }
//   POST   /api/vault          {name, value, hosts} → upsert (create or rotate)
//   POST   /api/secret         alias of POST /api/vault (chat composer key button)
//   PATCH  /api/vault/:name    {hosts} → change hosts, value untouched
//   DELETE /api/vault/:name    → remove the line
// Gates, in order: network (loopback / tailnet / tailscale serve, else 403) →
// header-only bearer (`?token=` refused, 401) → rate limit (429) → writable
// (501 when tls-secrets.py is absent). The /api/* bearer gate in
// companion-server.ts runs first too; the vault never relies on it.
// Never log the URL or the body: a `?token=` or the value would land in the log.
// Contract: docs/vault-api.md.

const PREFIX = "/api/vault/"
const NO_STORE = { "Cache-Control": "no-store" }

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

  if (isCollection && req.method === "GET") {
    return limited(readLimiter) ?? json({ ok: true, writable: vaultWritable(), secrets: listSecrets() })
  }
  const known = (isCollection && req.method === "POST") || (!isCollection && (req.method === "PATCH" || req.method === "DELETE"))
  if (!known) return json({ ok: false, error: "method_not_allowed" }, 405)

  const wait = limited(writeLimiter)
  if (wait) return wait
  // Up front: no body parse, no store read when this host can't sync the mask.
  if (!vaultWritable()) {
    return json({ ok: false, error: "vault_unavailable", message: "Coffre en lecture seule sur cet hôte (tls-secrets.py absent)." }, 501)
  }
  // Valid names are [A-Z0-9_] only, so no URL decoding: anything else is a 400.
  const name = isCollection ? "" : p.slice(PREFIX.length)
  return mutate(req, isCollection, name, { device_claimed: claimedDevice(req), transport: from.transport, peer: from.peer })
}
