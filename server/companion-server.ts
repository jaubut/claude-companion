import { checkBearer, checkBearerHeaderOnly, unauthorized } from "./lib/auth"
import { type WsData, HOST_INFO, broadcast, clientInfo } from "./state"
import "./wiring/events"
import { handleHookRoute } from "./routes/hooks"
import { deliverInject, handleApiRoute } from "./routes/api"
import { handleOrchestratorRoute } from "./routes/orchestrator"
import { handleTriageRoute } from "./routes/triage"
import { handleDialogRoute } from "./routes/dialogs"
import { handleModelRoute } from "./routes/model"
import { handleCommandRoute } from "./routes/command"
import { handleAttachRoute } from "./routes/attach"
import { handleMediaRoute } from "./routes/media"
import { handleGoalsRoute } from "./routes/goals"
import { handleBodyRoute } from "./routes/body"
import { handleVaultRoute } from "./routes/vault"
import { handleRecordsRoute } from "./routes/records"
import { VOICE_UPLOAD_PATH, handleCaptureRoute } from "./routes/capture"
import { handleTripsRoute } from "./routes/trips"
import { handleAutoCompactRoute } from "./routes/auto-compact"
import { handleGaugeRoute } from "./routes/gauge"
import { handleCopyJobsRoute } from "./routes/copy-jobs"
import { handleMyTasksRoute } from "./routes/my-tasks"
import { handleTasteRoute } from "./routes/taste"
import { handleNotesRoute } from "./routes/notes"
import { createTasksAgentRoute } from "./routes/tasks-agent"
import { tasksAgent, tasksChat } from "./wiring/tasks-agent"
import { createCanvasRoute } from "./routes/canvas"
import { canvasSend, canvasStatus, canvasStore, setCanvasDeliver } from "./wiring/canvas"
import { keyCommandGate, originLabel, recordPeer } from "./lib/vault-guard"
import { websocket } from "./ws"
import { disableAutoSelectFamily } from "./lib/apns"
import { waitForFirstDiscovery } from "./lib/discover"
import { getShellSession, startShellPoll } from "./lib/shell-sessions"
import { startEndedSweep } from "./lib/ended-sessions"
import { listSessions, resolveSession } from "./lib/sessions"
import { MAX_ATTACHES_PER_KEY, TERMINAL_PATH, parseTerminalSize, shellNetworkRefusal } from "./lib/terminal-bridge"
import { attachCount } from "./wiring/shell-sessions"
import { PANE_MIRROR_PATH, paneMirrorUpgrade } from "./lib/pane-mirror"
import { mirrorViewerCount } from "./wiring/pane-mirror"
import { ensureUtf8Locale } from "./lib/tmux-pane"

// How long a /ws upgrade may wait for the boot discovery pass. The phone
// treats init's `sessions` as authoritative, so an init sent before discovery
// finished wipes its list. Bounded: a slow ps/lsof must not lock clients out.
ensureUtf8Locale()

const WS_FIRST_DISCOVERY_WAIT_MS = 3_000
// Above the 150 s upstream timeout the forwarding host waits on.
const VOICE_UPLOAD_IDLE_TIMEOUT_S = 200

const handleTasksAgentRoute = createTasksAgentRoute({ agent: tasksAgent, chat: tasksChat, notify: broadcast })
setCanvasDeliver(deliverInject)
const handleCanvasRoute = createCanvasRoute({ store: canvasStore, status: canvasStatus, host: HOST_INFO.name, notify: broadcast, send: canvasSend })

export function createCompanionServer(port: number) {
  // Before any outbound node:net / http2 connect (APNs, broker): Bun's
  // happy-eyeballs path is a known process crash — see lib/apns.ts.
  disableAutoSelectFamily()
  // Shell sessions are read from tmux (lib/shell-sessions.ts): first read now,
  // then every few seconds so an `exit` reaches the phone.
  startShellPoll(listSessions)
  startEndedSweep(listSessions)
  const server = Bun.serve<WsData>({
    port,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url)
      // TCP peer for the vault's network gate and the resolve/WS audit log
      // (routes only get req + url). Weak map: dies with the Request.
      recordPeer(req, server.requestIP(req)?.address)

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
      // A one-shot voice upload streams ~50 chunks + finalize (Deepgram) to the
      // dashboard before replying — far past Bun's 10 s idle default. After the
      // gate: unauthenticated callers keep the default.
      if (url.pathname === VOICE_UPLOAD_PATH) server.timeout(req, VOICE_UPLOAD_IDLE_TIMEOUT_S)
      // ask-secret long-polls GET /api/vault/requests/<id>?wait=25.
      if (req.method === "GET" && /^\/api\/vault\/requests\/[^/]+$/.test(url.pathname)) server.timeout(req, 40)

      // ── Public liveness probe ──
      // Used by the hook scripts to skip the 300s wait when the server is
      // down. Returns nothing sensitive — just confirms the port is alive.
      if (url.pathname === "/health") {
        return Response.json({ ok: true })
      }

      // ── WebSocket upgrade ──
      if (url.pathname === "/ws") {
        // Immediate except in the first seconds after boot (lib/discover.ts).
        await waitForFirstDiscovery(WS_FIRST_DISCOVERY_WAIT_MS)
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID(), client: clientInfo(req, originLabel(req)), keyGate: keyCommandGate(req) },
        })
        if (upgraded) return undefined
        return new Response("WebSocket upgrade failed", { status: 500 })
      }

      // ── Live terminal (lib/terminal-bridge.ts) ──
      // Behind the Bearer gate above like every /api/* path. Unknown key → 410
      // before any upgrade, so nothing is spawned for a stale row.
      // Header token only: a remote shell must not authenticate with a token
      // in the URL (URLs land in proxy and access logs).
      if (url.pathname === TERMINAL_PATH) {
        if (!checkBearerHeaderOnly(req)) return unauthorized()
        const refused = shellNetworkRefusal(req)
        if (refused) return refused
        const key = url.searchParams.get("key") ?? ""
        if (!getShellSession(key)) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })
        const size = parseTerminalSize(url.searchParams.get("cols"), url.searchParams.get("rows"))
        if (!size) return Response.json({ ok: false, error: "bad_size" }, { status: 400 })
        if (attachCount(key) >= MAX_ATTACHES_PER_KEY) return Response.json({ ok: false, error: "too_many_attaches" }, { status: 429 })
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID(), client: clientInfo(req, originLabel(req)), terminal: { key, ...size } },
        })
        if (upgraded) return undefined
        return new Response("WebSocket upgrade failed", { status: 500 })
      }

      // ── Herdr pane mirror (lib/pane-mirror.ts) ──
      // Same gates as /api/terminal: header-only Bearer, the vault network
      // rule, a session key this server knows, and it must be a herdr pane.
      if (url.pathname === PANE_MIRROR_PATH) {
        const t = paneMirrorUpgrade(req, url, { authorized: checkBearerHeaderOnly, lookup: resolveSession, viewers: mirrorViewerCount })
        if (t instanceof Response) return t
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID(), client: clientInfo(req, originLabel(req)), mirror: t },
        })
        if (upgraded) return undefined
        return new Response("WebSocket upgrade failed", { status: 500 })
      }

      // Route chain — hooks, phone API, orchestrator, dialog mirror. Each
      // returns null for paths it doesn't own; the plain `/` page is last.
      for (const route of [handleHookRoute, handleApiRoute, handleTriageRoute, handleOrchestratorRoute, handleDialogRoute, handleModelRoute, handleCommandRoute, handleAttachRoute, handleMediaRoute, handleGoalsRoute, handleBodyRoute, handleVaultRoute, handleRecordsRoute, handleCaptureRoute, handleTripsRoute, handleAutoCompactRoute, handleGaugeRoute, handleCopyJobsRoute, handleTasksAgentRoute, handleMyTasksRoute, handleTasteRoute, handleNotesRoute, handleCanvasRoute]) {
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
