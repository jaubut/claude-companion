import type { ServerWebSocket } from "bun"
import {
  addApprovalRequest,
  resolveApproval,
  getPending,
  onApprovalRequest,
} from "./lib/pty-manager"
import { judgeWithBranchContext } from "./lib/branch-guard"
import { injectText } from "./lib/keyboard-inject"
import {
  recordSession,
  removeSession,
  getSession,
  listSessions,
  onSessions,
  metaFromHeaders,
  type Session,
} from "./lib/sessions"
import {
  recordToolStart,
  recordToolEnd,
  recordUserPrompt,
  recordTurnEnd,
  getFeed,
  getActivity,
  onFeed,
  onActivity,
  summarize,
  type FeedEvent,
  type Verdict,
} from "./lib/activity"

interface WsData {
  id: string
}

const clients = new Set<ServerWebSocket<WsData>>()
let waitingForInput = false
let waitingCwd = ""

function broadcast(data: Record<string, unknown>): void {
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    try { ws.send(msg) } catch { /* dead client */ }
  }
}

function extractLastAssistantMessage(transcriptPath: string | undefined): string {
  if (!transcriptPath) return ""
  try {
    const raw = require("node:fs").readFileSync(transcriptPath, "utf8") as string
    const lines = raw.trim().split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!)
        if (entry.type !== "assistant") continue
        const content = entry.message?.content
        if (!Array.isArray(content)) continue
        const textBlocks = content
          .filter((b: Record<string, unknown>) => b.type === "text")
          .map((b: Record<string, unknown>) => b.text as string)
        if (textBlocks.length) return textBlocks.join("\n")
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return ""
}

onApprovalRequest((req) => {
  broadcast({
    type: "approval",
    id: req.id,
    tool: req.tool,
    input: req.input,
    sessionId: req.sessionId,
    cwd: req.cwd,
  })
})

onFeed((ev: FeedEvent) => {
  broadcast({ type: "event", event: ev })
})

onActivity((activity) => {
  broadcast({ type: "activity", activity })
})

onSessions((sessions: Session[]) => {
  broadcast({ type: "sessions", sessions })
})

export function createCompanionServer(port: number) {
  const server = Bun.serve<WsData>({
    port,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url)

      // ── WebSocket upgrade ──
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID() },
        })
        if (upgraded) return undefined
        return new Response("WebSocket upgrade failed", { status: 500 })
      }

      // ── Hook endpoint — PreToolUse ──
      if (url.pathname === "/hooks/pre-tool-use" && req.method === "POST") {
        const body = await req.json() as {
          session_id?: string
          tool_name?: string
          tool_input?: Record<string, unknown>
          cwd?: string
        }

        const tool = body.tool_name ?? "unknown"
        const input = body.tool_input ?? {}
        const sessionId = body.session_id ?? ""
        const cwd = body.cwd ?? ""

        if (cwd) {
          recordSession({ cwd, sessionId, ...metaFromHeaders(req.headers) })
        }

        if (waitingForInput) {
          waitingForInput = false
          waitingCwd = ""
          broadcast({ type: "waiting_input", waiting: false })
        }

        const dim = "\x1b[2m"
        const reset = "\x1b[0m"
        const green = "\x1b[32m"
        const red = "\x1b[31m"
        const yellow = "\x1b[33m"
        const cyan = "\x1b[36m"

        const verdictJudge = await judgeWithBranchContext(tool, input, cwd)

        let decision: "allow" | "deny"
        let verdict: Verdict

        if (verdictJudge === "allow") {
          decision = "allow"
          verdict = "auto-allow"
          process.stderr.write(`${dim}[companion]${reset} ${green}auto-allow${reset} ${tool} ${dim}${summarize(tool, input)}${reset}\n`)
          recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd })
        } else if (verdictJudge === "deny") {
          decision = "deny"
          verdict = "auto-deny"
          process.stderr.write(`${dim}[companion]${reset} ${red}auto-deny${reset} ${tool} ${dim}${summarize(tool, input)}${reset}\n`)
          recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd })
        } else {
          verdict = "pending"
          process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}${tool}${reset} ${dim}${summarize(tool, input)}${reset}\n`)
          recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd })
          decision = await addApprovalRequest({ sessionId, tool, input, cwd })
          const decisionColor = decision === "allow" ? green : red
          process.stderr.write(`${dim}[companion]${reset} ${decisionColor}${decision}${reset} ← phone\n`)
        }

        return Response.json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: decision === "allow"
              ? "Approved via Claude Companion"
              : "Denied via Claude Companion",
          },
        })
      }

      // ── Hook endpoint — PostToolUse ──
      if (url.pathname === "/hooks/post-tool-use" && req.method === "POST") {
        const body = await req.json() as {
          session_id?: string
          tool_name?: string
          tool_input?: Record<string, unknown>
          transcript_path?: string
          cwd?: string
        }
        const tool = body.tool_name ?? "unknown"
        const input = body.tool_input ?? {}
        const cwd = body.cwd ?? ""

        if (cwd) {
          recordSession({ cwd, sessionId: body.session_id ?? "", ...metaFromHeaders(req.headers) })
        }

        recordToolEnd({ tool, input, transcriptPath: body.transcript_path, cwd })
        return Response.json({})
      }

      // ── Hook endpoint — UserPromptSubmit ──
      if (url.pathname === "/hooks/user-prompt-submit" && req.method === "POST") {
        const body = await req.json() as {
          session_id?: string
          prompt?: string
          transcript_path?: string
          cwd?: string
        }
        const cwd = body.cwd ?? ""
        if (cwd) {
          recordSession({ cwd, sessionId: body.session_id ?? "", ...metaFromHeaders(req.headers) })
        }
        recordUserPrompt(body.prompt ?? "", body.transcript_path, cwd)
        return Response.json({})
      }

      // ── Permission request hook — multi-choice permission dialogs ──
      if (url.pathname === "/hooks/permission-request" && req.method === "POST") {
        const body = await req.json() as {
          session_id?: string
          tool_name?: string
          tool_input?: Record<string, unknown>
          hook_event_name?: string
          cwd?: string
        }

        const tool = body.tool_name ?? "permission"
        const input = body.tool_input ?? {}
        const sessionId = body.session_id ?? ""
        const cwd = body.cwd ?? ""

        if (cwd) {
          recordSession({ cwd, sessionId, ...metaFromHeaders(req.headers) })
        }

        const dim = "\x1b[2m"
        const reset = "\x1b[0m"
        const yellow = "\x1b[33m"
        const cyan = "\x1b[36m"

        process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}permission${reset} ${tool} ${dim}${summarize(tool, input)}${reset}\n`)

        recordToolStart({ tool, input, summary: summarize(tool, input), verdict: "pending", cwd })
        const decision = await addApprovalRequest({ sessionId, tool, input, cwd })

        const green = "\x1b[32m"
        const red = "\x1b[31m"
        const decisionColor = decision === "allow" ? green : red
        process.stderr.write(`${dim}[companion]${reset} ${decisionColor}${decision}${reset} ← permission\n`)

        return Response.json({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: decision },
          },
        })
      }

      // ── Stop hook — Claude finished its turn, waiting for user input ──
      if (url.pathname === "/hooks/stop" && req.method === "POST") {
        const body = await req.json() as {
          session_id?: string
          cwd?: string
          transcript_path?: string
          stop_hook_active?: boolean
        }

        const cwd = body.cwd ?? ""
        if (cwd) {
          recordSession({ cwd, sessionId: body.session_id ?? "", ...metaFromHeaders(req.headers) })
        }

        const lastMessage = extractLastAssistantMessage(body.transcript_path)

        recordTurnEnd(body.transcript_path, lastMessage)

        waitingForInput = true
        waitingCwd = cwd
        const dim = "\x1b[2m"
        const reset = "\x1b[0m"
        const magenta = "\x1b[35m"
        process.stderr.write(`${dim}[companion]${reset} ${magenta}waiting for input${reset} — phone can respond\n`)

        broadcast({
          type: "waiting_input",
          waiting: true,
          message: lastMessage.slice(-500),
          cwd,
        })
        return Response.json({})
      }

      // ── Inject text from phone into terminal ──
      if (url.pathname === "/api/inject" && req.method === "POST") {
        const { text, cwd } = await req.json() as { text: string; cwd?: string }
        if (!text?.trim()) return Response.json({ ok: false, error: "empty" }, { status: 400 })

        const target = cwd ? getSession(cwd) : null

        // If the caller asked for a specific cwd and we don't have it registered,
        // refuse rather than silently pasting into the frontmost macOS app —
        // that's what caused "messages sometimes don't reach the terminal".
        if (cwd && !target) {
          const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"
          process.stderr.write(`${dim}[companion]${reset} ${red}inject refused${reset} — target cwd ${cwd} not registered\n`)
          return Response.json({ ok: false, error: "target_gone", cwd }, { status: 410 })
        }

        const dim = "\x1b[2m"
        const reset = "\x1b[0m"
        const cyan = "\x1b[36m"
        const tag = target?.cwd ? ` → ${target.cwd.split("/").pop()}` : " → frontmost"
        process.stderr.write(`${dim}[companion]${reset} ${cyan}injecting${reset}${tag} "${text.slice(0, 60)}"\n`)

        waitingForInput = false
        waitingCwd = ""
        broadcast({ type: "waiting_input", waiting: false })

        const ok = await injectText(text, target ?? undefined)
        if (!ok) {
          process.stderr.write(`${dim}[companion]${reset} \x1b[31minject failed\x1b[0m — osascript rejected (Accessibility permission?)\n`)
        }
        return Response.json({ ok })
      }

      // ── Hook endpoint — SessionStart — register on startup/resume/clear/compact
      // so idle Claude sessions are visible to the phone picker from the moment
      // they open, without waiting for the user to trigger a tool-call hook.
      if (url.pathname === "/hooks/session-start" && req.method === "POST") {
        const body = await req.json() as { cwd?: string; session_id?: string; source?: string }
        const cwd = body.cwd ?? ""
        if (cwd) {
          recordSession({ cwd, sessionId: body.session_id ?? "", ...metaFromHeaders(req.headers) })
          const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
          process.stderr.write(`${dim}[companion]${reset} ${cyan}session start${reset} ${cwd.split("/").pop()} ${dim}(${body.source ?? "-"})${reset}\n`)
        }
        return Response.json({ ok: true })
      }

      // ── Hook endpoint — SessionEnd — remove cwd from registry immediately ──
      if (url.pathname === "/hooks/session-end" && req.method === "POST") {
        const body = await req.json() as { cwd?: string; session_id?: string; reason?: string }
        const cwd = body.cwd ?? ""
        if (cwd) {
          const removed = removeSession(cwd)
          const dim = "\x1b[2m"; const reset = "\x1b[0m"; const magenta = "\x1b[35m"
          if (removed) {
            process.stderr.write(`${dim}[companion]${reset} ${magenta}session end${reset} ${cwd.split("/").pop()} ${dim}(${body.reason ?? "-"})${reset}\n`)
          }
        }
        return Response.json({ ok: true })
      }

      // ── Status endpoint ──
      if (url.pathname === "/api/status") {
        return Response.json({
          pending: getPending().length,
          clients: clients.size,
          waitingForInput,
          waitingCwd,
          sessions: listSessions(),
        })
      }

      // ── Debug: dump current feed ──
      if (url.pathname === "/api/feed") {
        return Response.json({
          activity: getActivity(),
          feed: getFeed(),
          sessions: listSessions(),
        })
      }

      // ── Serve static files ──
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname
      const file = Bun.file(`${import.meta.dir}/../client/dist${filePath}`)
      if (await file.exists()) {
        return new Response(file)
      }
      // SPA fallback
      const index = Bun.file(`${import.meta.dir}/../client/dist/index.html`)
      if (await index.exists()) {
        return new Response(index, { headers: { "Content-Type": "text/html" } })
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
            tool: req.tool,
            input: req.input,
            sessionId: req.sessionId,
            cwd: req.cwd,
          }))
        }

        ws.send(JSON.stringify({
          type: "init",
          pending: pendingList.length,
          waitingForInput,
          waitingCwd,
          activity: getActivity(),
          feed: getFeed(),
          sessions: listSessions(),
        }))
      },
      async message(ws, raw) {
        let msg: { type: string; id?: string; text?: string; cwd?: string }
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
          case "input":
            if (msg.text?.trim()) {
              const target = msg.cwd ? getSession(msg.cwd) : null
              // Mirror /api/inject behavior: if a specific cwd was requested
              // and we don't know it, tell the client so it can surface the
              // error instead of silently routing to the wrong terminal.
              if (msg.cwd && !target) {
                try {
                  ws.send(JSON.stringify({ type: "inject_error", error: "target_gone", cwd: msg.cwd }))
                } catch { /* ignore */ }
                break
              }
              waitingForInput = false
              waitingCwd = ""
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
