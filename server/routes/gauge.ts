import { checkBearer } from "../lib/auth"
import { parseModReport } from "../lib/gauge"
import { isLoopback, peerOf } from "../lib/vault-guard"
import { gauge } from "../wiring/gauge"

// Context gauge (lib/gauge.ts).
//   POST /hooks/gauge → the context-gauge mod's report, after every turn, on
//        session start and after a compact. Only session_id is required;
//        `rate_limits` [{kind, percent_used, resets_at}] → account.limits.
//        Loopback, or the bearer (like /hooks/dispatch-event); never forwarded
//        upstream — each host gauges its own sessions.
//   GET  /api/gauge  → { ok, account | null, sessions: [{ sessionKey, ctxTokens, ctxWindow, ctxPercent, source, at }] }
//        Bearer-gated like every /api/*. Live updates ride the `gauge` WS frame.
// The Stop-hook transcript fallback and the session-end drop live in routes/hooks.ts.
export async function handleGaugeRoute(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/hooks/gauge" && req.method === "POST") {
    const peer = peerOf(req)
    if (!(peer && isLoopback(peer)) && !checkBearer(req)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 })
    let raw: unknown
    try { raw = await req.json() } catch { return Response.json({ ok: false, error: "invalid_json" }, { status: 400 }) }
    const report = parseModReport(raw)
    if (!report) return Response.json({ ok: false, error: "session_id_required" }, { status: 400 })
    gauge.reportMod(report)
    return Response.json({ ok: true })
  }
  if (url.pathname === "/api/gauge" && req.method === "GET") {
    return Response.json(gauge.snapshot())
  }
  return null
}
