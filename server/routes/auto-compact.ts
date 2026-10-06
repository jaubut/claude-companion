import { scopeFromEnv, thresholdFromEnv } from "../lib/auto-compact"
import { companionLog } from "../lib/log"
import { autoCompactor, compactTargetForKey } from "../wiring/auto-compact"

// Smart auto-compact (lib/auto-compact.ts). Bearer-gated like every /api/*.
//   GET  /api/auto-compact         → { threshold, only, pending: [{key, phase, name, tokens, trigger}] }
//   POST /api/auto-compact/cancel  { key } → { ok, cancelled } — the push's Cancel action
//   POST /api/auto-compact/test    { key } → arm that one session regardless of size
export async function handleAutoCompactRoute(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/auto-compact" && req.method === "GET") {
    return Response.json({ threshold: thresholdFromEnv(), only: scopeFromEnv(), pending: autoCompactor.status() })
  }
  if (url.pathname === "/api/auto-compact/test" && req.method === "POST") {
    const key = await bodyKey(req)
    if (!key) return Response.json({ ok: false, error: "key_required" }, { status: 400 })
    companionLog(`auto-compact test requested for ${key}`)
    const target = compactTargetForKey(key)
    if (!target) return Response.json({ ok: false, error: "session_not_found" }, { status: 404 })
    const r = await autoCompactor.test(target)
    if (!r.ok) {
      companionLog(`auto-compact test ${key}: refused — ${r.error}`)
      return Response.json(r, { status: r.error === "transcript_unreadable" ? 422 : 409 })
    }
    return Response.json({ ok: true, key, name: target.name, tokens: r.tokens, checkInSeconds: Math.round(r.waitMs / 1000) })
  }
  if (url.pathname === "/api/auto-compact/cancel" && req.method === "POST") {
    const key = await bodyKey(req)
    if (!key) return Response.json({ ok: false, error: "key_required" }, { status: 400 })
    const cancelled = autoCompactor.cancel(key, "phone")
    if (!cancelled) companionLog(`auto-compact cancel: nothing pending for ${key}`)
    return Response.json({ ok: true, cancelled })
  }
  return null
}

async function bodyKey(req: Request): Promise<string> {
  try {
    const body = await req.json() as { key?: unknown }
    return typeof body.key === "string" ? body.key : ""
  } catch { return "" }
}
