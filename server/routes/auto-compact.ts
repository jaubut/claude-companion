import { thresholdFromEnv } from "../lib/auto-compact"
import { companionLog } from "../lib/log"
import { autoCompactor } from "../wiring/auto-compact"

// Smart auto-compact (lib/auto-compact.ts). Bearer-gated like every /api/*.
//   GET  /api/auto-compact         → { threshold, pending: [{key, phase, name, tokens}] }
//   POST /api/auto-compact/cancel  { key } → { ok, cancelled } — the push's Cancel action
export async function handleAutoCompactRoute(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/auto-compact" && req.method === "GET") {
    return Response.json({ threshold: thresholdFromEnv(), pending: autoCompactor.status() })
  }
  if (url.pathname === "/api/auto-compact/cancel" && req.method === "POST") {
    let key = ""
    try {
      const body = await req.json() as { key?: unknown }
      key = typeof body.key === "string" ? body.key : ""
    } catch { /* fall through to 400 */ }
    if (!key) return Response.json({ ok: false, error: "key_required" }, { status: 400 })
    const cancelled = autoCompactor.cancel(key, "phone")
    if (!cancelled) companionLog(`auto-compact cancel: nothing pending for ${key}`)
    return Response.json({ ok: true, cancelled })
  }
  return null
}
