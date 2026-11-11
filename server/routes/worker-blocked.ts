import { MAX_KEY_LENGTH } from "../lib/idempotency"
import { type Result, type WorkerBlocked, parseBlocked } from "../lib/worker-blocked"
import { workerBlocked } from "../wiring/worker-blocked"

// Blocked dispatch worker alerts (docs/worker-blocked-api.md).
//   POST /hooks/worker-blocked                               runner → {taskId, title, worker, dialog, options[{key,label}]} + Idempotency-Key
//   GET  /hooks/worker-blocked/<id>                          runner polls → {state, choice}
//   POST /hooks/worker-blocked/<id>/close                    runner gave up / dialog gone → expired
//   POST /api/orchestrator/worker-blocked/<id>/choose        phone → {optionId} + Idempotency-Key
// /hooks/* = loopback or Bearer (host gate, like /hooks/dispatch-event); /api/* = Bearer.

const HOOK_RE = /^\/hooks\/worker-blocked\/([0-9a-f-]{36})(\/close)?$/
const CHOOSE_RE = /^\/api\/orchestrator\/worker-blocked\/([0-9a-f-]{36})\/choose$/

const reply = (r: Result): Response => Response.json(r.body, { status: r.status, headers: r.body.replay ? { "Idempotent-Replayed": "true" } : undefined })

async function jsonBody(req: Request): Promise<unknown> {
  try { return await req.json() as unknown } catch { return null }
}

function idemKeyOf(req: Request): string | null | false {
  const k = req.headers.get("idempotency-key")?.trim() || null
  return k && k.length > MAX_KEY_LENGTH ? false : k
}

export function workerBlockedRoute(alerts: WorkerBlocked) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const p = url.pathname
    if (p === "/hooks/worker-blocked" && req.method === "POST") {
      const key = idemKeyOf(req)
      if (key === false) return reply({ status: 400, body: { ok: false, error: "idempotency-key-too-long" } })
      const input = parseBlocked(await jsonBody(req))
      if (typeof input === "string") return reply({ status: input === "not_dispatch_worker" ? 422 : 400, body: { ok: false, error: input } })
      return reply(alerts.create(input, key))
    }
    const hook = HOOK_RE.exec(p)
    if (hook) {
      if (!hook[2] && req.method === "GET") return reply(alerts.status(hook[1]!))
      if (hook[2] && req.method === "POST") return reply(alerts.close(hook[1]!))
      return null
    }
    const choose = CHOOSE_RE.exec(p)
    if (choose && req.method === "POST") {
      const key = idemKeyOf(req)
      if (key === false) return reply({ status: 400, body: { ok: false, error: "idempotency-key-too-long" } })
      const body = await jsonBody(req)
      const optionId = body && typeof body === "object" && typeof (body as Record<string, unknown>).optionId === "string"
        ? ((body as Record<string, unknown>).optionId as string).trim() : ""
      if (!optionId) return reply({ status: 400, body: { ok: false, error: "optionId required" } })
      return reply(alerts.choose(choose[1]!, optionId, key))
    }
    return null
  }
}

export const handleWorkerBlockedRoute = workerBlockedRoute(workerBlocked)
