import { checkBearer, unauthorized } from "./lib/auth"
import { type WsData } from "./state"
import "./wiring/events"
import { handleHookRoute } from "./routes/hooks"
import { handleApiRoute } from "./routes/api"
import { handleOrchestratorRoute } from "./routes/orchestrator"
import { handleDialogRoute } from "./routes/dialogs"
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
      // convention). Static asset paths are also open so the PWA can load
      // its bundle before authenticating. Everything else — /ws, /api/* —
      // requires a valid Bearer token. Without this gate any device on the
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
      // returns null for paths it doesn't own; the static/SPA fallback is last.
      for (const route of [handleHookRoute, handleApiRoute, handleOrchestratorRoute, handleDialogRoute]) {
        const handled = await route(req, url)
        if (handled) return handled
      }

      // ── Serve static files ──
      // Cache strategy:
      //   - index.html → no-cache. WKWebView heuristically caches HTML
      //     otherwise, which pins the page to a stale bundle hash and means
      //     server fixes never reach the phone until the user manually
      //     reinstalls. Always revalidate.
      //   - /assets/* → immutable, 1 year. Vite content-hashes filenames so
      //     a different bundle gets a different URL anyway.
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname
      const file = Bun.file(`${import.meta.dir}/../client/dist${filePath}`)
      if (await file.exists()) {
        const isHtml = filePath.endsWith(".html") || filePath === "/index.html"
        const isHashedAsset = filePath.startsWith("/assets/")
        const headers: Record<string, string> = {}
        if (isHtml) headers["Cache-Control"] = "no-cache"
        else if (isHashedAsset) headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return new Response(file, { headers })
      }
      // SPA fallback
      const index = Bun.file(`${import.meta.dir}/../client/dist/index.html`)
      if (await index.exists()) {
        return new Response(index, { headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" } })
      }
      return new Response("Not found", { status: 404 })
    },
    websocket,
  })

  return server
}
