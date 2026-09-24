import { checkBearer, unauthorized } from "./lib/auth"
import { type WsData } from "./state"
import "./wiring/events"
import { handleHookRoute } from "./routes/hooks"
import { handleApiRoute } from "./routes/api"
import { handleOrchestratorRoute } from "./routes/orchestrator"
import { handleDialogRoute } from "./routes/dialogs"
import { handleModelRoute } from "./routes/model"
import { handleCommandRoute } from "./routes/command"
import { handleAttachRoute } from "./routes/attach"
import { handleMediaRoute } from "./routes/media"
import { handleGoalsRoute } from "./routes/goals"
import { websocket } from "./ws"


export function createCompanionServer(port: number) {
  const server = Bun.serve<WsData>({
    port,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url)

      // ── Auth gate ──
      // Hooks endpoints are called by local Claude Code shell scripts on the
      // same machine, so we exempt them from auth (those scripts can't
      // easily carry credentials and the surface is loopback-only by
      // convention). `/` and `/health` are open plain-text probes. Everything
      // else — /ws, /api/* — requires a valid Bearer token. Without this gate any device on the
      // LAN could hit /api/inject and paste arbitrary keystrokes.
      const isHookCall = url.pathname.startsWith("/hooks/")
      const isHealth = url.pathname === "/health"
      const isStateMutation = url.pathname === "/ws" || url.pathname.startsWith("/api/")
      if (isStateMutation && !isHookCall && !isHealth && !checkBearer(req)) {
        return unauthorized()
      }

      // ── Public liveness probe ──
      // Used by the hook scripts to skip the 300s wait when the server is
      // down. Returns nothing sensitive — just confirms the port is alive.
      if (url.pathname === "/health") {
        return Response.json({ ok: true })
      }

      // ── WebSocket upgrade ──
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID() },
        })
        if (upgraded) return undefined
        return new Response("WebSocket upgrade failed", { status: 500 })
      }

      // Route chain — hooks, phone API, orchestrator, dialog mirror. Each
      // returns null for paths it doesn't own; the plain `/` page is last.
      for (const route of [handleHookRoute, handleApiRoute, handleOrchestratorRoute, handleDialogRoute, handleModelRoute, handleCommandRoute, handleAttachRoute, handleMediaRoute, handleGoalsRoute]) {
        const handled = await route(req, url)
        if (handled) return handled
      }

      // No browser client any more — the PWA was retired on 2026-09-24; the
      // iOS app is the only client. `/` says so in plain text, the rest 404s.
      if (url.pathname === "/") {
        return new Response(
          "Claude Companion server. Pair the iOS app with the host and the token printed at boot. GET /health for liveness.\n",
          { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } },
        )
      }
      return new Response("Not found", { status: 404 })
    },
    websocket,
  })

  return server
}
