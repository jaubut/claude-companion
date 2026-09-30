import { checkBearer, unauthorized } from "../lib/auth"
import { companionLog } from "../lib/log"
import { type VaultResult, deleteSecret, listSecrets, setSecretHosts, upsertSecret } from "../lib/secret-store"

// Companion Vault API — values are write-only, no response ever carries one.
//   GET    /api/vault          → { ok, secrets: [{name, hosts, scripts, updated_at}] }
//   POST   /api/vault          {name, value, hosts} → upsert (create or rotate)
//   POST   /api/secret         alias of POST /api/vault (chat composer key button)
//   PATCH  /api/vault/:name    {hosts} → change hosts, value untouched
//   DELETE /api/vault/:name    → remove the line
// The /api/* bearer gate in companion-server.ts already covers these; the
// check is repeated here so the vault never depends on the route chain order.
// Never log the URL or the body: a `?token=` or the value would land in the log.

const PREFIX = "/api/vault/"

function device(req: Request): string {
  const raw = req.headers.get("x-companion-device") || req.headers.get("user-agent") || "unknown"
  return raw.replace(/[^\x20-\x7e]/g, "").slice(0, 64)
}

function reply(r: VaultResult): Response {
  const { status, ...body } = r
  companionLog(`vault ${r.action ?? r.error} ${r.name ?? ""}`.trim())
  return Response.json(body, { status })
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null) as unknown
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null
}

export async function handleVaultRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname
  const isCollection = p === "/api/vault" || (p === "/api/secret" && req.method === "POST")
  if (!isCollection && !p.startsWith(PREFIX)) return null
  if (!checkBearer(req)) return unauthorized()

  if (isCollection && req.method === "GET") return Response.json({ ok: true, secrets: listSecrets() })

  if (isCollection && req.method === "POST") {
    const body = await readJson(req)
    if (!body) return Response.json({ ok: false, error: "bad_json" }, { status: 400 })
    return reply(await upsertSecret(body, device(req)))
  }

  if (!isCollection) {
    // Valid names are [A-Z0-9_] only, so no URL decoding: anything else is a 400.
    const name = p.slice(PREFIX.length)
    if (req.method === "DELETE") return reply(await deleteSecret(name, device(req)))
    if (req.method === "PATCH") {
      const body = await readJson(req)
      if (!body) return Response.json({ ok: false, error: "bad_json" }, { status: 400 })
      return reply(await setSecretHosts(name, body.hosts, device(req)))
    }
  }
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 })
}
