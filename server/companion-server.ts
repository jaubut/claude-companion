import { resolveApproval, getPending } from "./lib/pty-manager"
import { resolveQuestion, getPendingQuestions, type QuestionAnswer } from "./lib/questions"
import { injectText } from "./lib/keyboard-inject"
import { isSuperAuto } from "./lib/super-auto"
import { resolveSession, listSessions } from "./lib/sessions"
import { getFeed, getActivity } from "./lib/activity"
import { checkBearer, unauthorized } from "./lib/auth"
import {
  clients,
  broadcast,
  HOST_INFO,
  getWaiting,
  clearWaiting,
  type WsData,
} from "./state"
import { dialogWatcher } from "./wiring/dialogs"
import "./wiring/events"
import { handleHookRoute } from "./routes/hooks"


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

      {
        const handled = await handleHookRoute(req, url)
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
    websocket: {
      open(ws) {
        clients.add(ws)

        const pendingList = getPending()
        for (const req of pendingList) {
          ws.send(JSON.stringify({
            type: "approval",
            id: req.id,
            agent: req.agent ?? "claude",
            tool: req.tool,
            input: req.input,
            sessionId: req.sessionId,
            cwd: req.cwd,
          }))
        }

        // Replay any pending questions too — without this, a phone that
        // reconnects mid-question would stay blank until Claude asks
        // something new.
        for (const q of getPendingQuestions()) {
          ws.send(JSON.stringify({
            type: "question",
            id: q.id,
            agent: q.agent ?? "claude",
            sessionId: q.sessionId,
            cwd: q.cwd,
            questions: q.questions,
          }))
        }

        ws.send(JSON.stringify({
          type: "init",
          pending: pendingList.length,
          ...getWaiting(),
          activity: getActivity(),
          feed: getFeed(),
          sessions: listSessions(),
          superAuto: isSuperAuto(),
          dialogs: dialogWatcher.current(),
          host: HOST_INFO,
        }))
      },
      async message(ws, raw) {
        let msg: {
          type: string
          id?: string
          text?: string
          key?: string
          cwd?: string
          answers?: Array<{ selected?: string[]; otherText?: string }>
        }
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString())
        } catch { return }

        switch (msg.type) {
          case "approve":
            if (msg.id) {
              resolveApproval(msg.id, "allow")
              broadcast({ type: "resolved", id: msg.id, decision: "allow" })
            }
            break
          case "deny":
            if (msg.id) {
              resolveApproval(msg.id, "deny")
              broadcast({ type: "resolved", id: msg.id, decision: "deny" })
            }
            break
          case "answer":
            if (msg.id && Array.isArray(msg.answers) && msg.answers.length > 0) {
              const answers: QuestionAnswer[] = msg.answers.map((a) => ({
                selected: Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === "string") : [],
                otherText: typeof a.otherText === "string" ? a.otherText : undefined,
              }))
              if (resolveQuestion(msg.id, answers)) {
                broadcast({ type: "resolved", id: msg.id, decision: "answered" })
              }
            }
            break
          case "input":
            if (msg.text?.trim()) {
              const lookup = msg.key || msg.cwd || ""
              const target = lookup ? resolveSession(lookup) : null
              const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
              const tag = target?.tty ? ` → ${target.label || target.key} (${target.tty})` : lookup ? ` → ${lookup} [unresolved]` : " → frontmost"
              process.stderr.write(`${dim}[companion]${reset} ${cyan}ws inject${reset}${tag} "${msg.text.slice(0, 60)}"\n`)
              if (lookup && !target) {
                process.stderr.write(`${dim}[companion]${reset} ${red}ws inject refused${reset} — ${lookup} not registered\n`)
                try {
                  ws.send(JSON.stringify({ type: "inject_error", error: "target_gone", key: msg.key, cwd: msg.cwd }))
                } catch { /* ignore */ }
                break
              }
              if (target && !target.tty) {
                process.stderr.write(`${dim}[companion]${reset} ${red}ws inject refused${reset} — ${target.label || target.key} has no tty\n`)
                try {
                  ws.send(JSON.stringify({ type: "inject_error", error: "target_idle", key: msg.key, cwd: msg.cwd }))
                } catch { /* ignore */ }
                break
              }
              clearWaiting()
              broadcast({ type: "waiting_input", waiting: false })
              const ok = await injectText(msg.text.trim(), target ?? undefined)
              if (!ok) {
                try { ws.send(JSON.stringify({ type: "inject_error", error: "osascript_failed" })) } catch { /* ignore */ }
              }
            }
            break
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }))
            break
        }
      },
      close(ws) {
        clients.delete(ws)
      },
    },
  })

  return server
}
