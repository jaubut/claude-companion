import { checkBearer, unauthorized } from "../lib/auth"
import { companionLog } from "../lib/log"
import {
  DEFAULT_ENV_PATH,
  DEFAULT_META_PATH,
  type SecretPaths,
  createRateLimiter,
  deleteSecret,
  isValidSecretName,
  isValidSecretValue,
  listSecrets,
  upsertSecret,
} from "../lib/secrets"

// Secret hand-off from the phone (never through chat/tmux/transcript):
//   POST   /api/secret        {name, value} → {ok, name, action:"added"|"updated"}
//   GET    /api/secret                      → {ok, secrets:[{name, updatedAt}]}  (names only)
//   DELETE /api/secret/:NAME                → {ok, name, action:"deleted"}
// The /api/* bearer gate and the tailnet/loopback transport gate live in
// companion-server.ts; the bearer is re-checked here so this route can't be
// mounted open by accident. The value is never logged, echoed, broadcast or
// put in the feed. A running Claude Code process can't see the new var — the
// client shows "NAME saved — restart session to load".

const PREFIX = "/api/secret"
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

export interface SecretDeps {
  paths?: SecretPaths
  log?: (msg: string) => void
  allow?: () => boolean
}

export function createSecretHandler(deps: SecretDeps = {}) {
  const paths = deps.paths ?? { envPath: DEFAULT_ENV_PATH, metaPath: DEFAULT_META_PATH }
  const log = deps.log ?? companionLog
  const allow = deps.allow ?? createRateLimiter(10, 60_000)

  return async function handleSecretRoute(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + "/")) return null
    if (!checkBearer(req)) return unauthorized()

    if (url.pathname === PREFIX && req.method === "GET") {
      return json({ ok: true, secrets: listSecrets(paths) })
    }

    if (req.method !== "POST" && req.method !== "DELETE") return json({ ok: false, error: "method-not-allowed" }, 405)
    if (!allow()) return json({ ok: false, error: "rate-limited" }, 429)

    if (url.pathname === PREFIX && req.method === "POST") {
      let body: { name?: unknown; value?: unknown }
      try { body = await req.json() as typeof body } catch { return json({ ok: false, error: "invalid-json" }, 400) }
      if (!isValidSecretName(body.name)) return json({ ok: false, error: "invalid-name" }, 400)
      if (!isValidSecretValue(body.value)) return json({ ok: false, error: "invalid-value" }, 400)
      const name = body.name
      try {
        const action = upsertSecret(paths, name, body.value)
        log(`secret ${action}: ${name}`)
        return json({ ok: true, name, action })
      } catch (err) {
        // Error text could only carry paths/errno, never the value.
        log(`secret write failed: ${name} (${(err as NodeJS.ErrnoException).code ?? "error"})`)
        return json({ ok: false, error: "write-failed" }, 500)
      }
    }

    if (req.method === "DELETE") {
      const name = url.pathname.slice(PREFIX.length + 1)
      if (!isValidSecretName(name)) return json({ ok: false, error: "invalid-name" }, 400)
      try {
        if (!deleteSecret(paths, name)) return json({ ok: false, error: "not-found" }, 404)
      } catch (err) {
        log(`secret delete failed: ${name} (${(err as NodeJS.ErrnoException).code ?? "error"})`)
        return json({ ok: false, error: "write-failed" }, 500)
      }
      log(`secret deleted: ${name}`)
      return json({ ok: true, name, action: "deleted" })
    }

    return json({ ok: false, error: "not-found" }, 404)
  }
}

export const handleSecretRoute = createSecretHandler()
