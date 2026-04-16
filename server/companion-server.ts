import type { ServerWebSocket } from "bun"
import {
  addApprovalRequest,
  resolveApproval,
  getPending,
  onApprovalRequest,
  type ApprovalRequest,
} from "./lib/pty-manager"
import { autoJudge } from "./lib/auto-judge"

interface WsData {
  id: string
}

const clients = new Set<ServerWebSocket<WsData>>()

function broadcast(data: Record<string, unknown>) {
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    try { ws.send(msg) } catch { /* dead client */ }
  }
}

// Notify phone when new approval request comes in
onApprovalRequest((req) => {
  broadcast({
    type: "approval",
    id: req.id,
    tool: req.tool,
    input: req.input,
    sessionId: req.sessionId,
  })
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

      // ── Hook endpoint — Claude Code HTTP hooks POST here ──
      if (url.pathname === "/hooks/pre-tool-use" && req.method === "POST") {
        const body = await req.json() as {
          session_id?: string
          tool_name?: string
          tool_input?: Record<string, unknown>
        }

        const tool = body.tool_name ?? "unknown"
        const input = body.tool_input ?? {}
        const sessionId = body.session_id ?? ""

        const dim = "\x1b[2m"
        const reset = "\x1b[0m"
        const green = "\x1b[32m"
        const red = "\x1b[31m"
        const yellow = "\x1b[33m"
        const cyan = "\x1b[36m"

        // Auto-judge: only escalate real decisions to phone
        const verdict = autoJudge(tool, input)

        let decision: "allow" | "deny"

        if (verdict === "allow") {
          decision = "allow"
          process.stderr.write(`${dim}[companion]${reset} ${green}auto-allow${reset} ${tool} ${dim}${getSummary(tool, input)}${reset}\n`)
        } else if (verdict === "deny") {
          decision = "deny"
          process.stderr.write(`${dim}[companion]${reset} ${red}auto-deny${reset} ${tool} ${dim}${getSummary(tool, input)}${reset}\n`)
        } else {
          // Ask the human via phone
          process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}${tool}${reset} ${dim}${getSummary(tool, input)}${reset}\n`)
          decision = await addApprovalRequest({ sessionId, tool, input })
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

      // ── Status endpoint ──
      if (url.pathname === "/api/status") {
        return Response.json({
          pending: getPending().length,
          clients: clients.size,
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

        // Send any pending approvals
        const pendingList = getPending()
        for (const req of pendingList) {
          ws.send(JSON.stringify({
            type: "approval",
            id: req.id,
            tool: req.tool,
            input: req.input,
            sessionId: req.sessionId,
          }))
        }

        ws.send(JSON.stringify({
          type: "init",
          pending: pendingList.length,
        }))
      },
      message(ws, raw) {
        let msg: { type: string; id?: string }
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

function getSummary(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Bash":
      return ((input.command as string) ?? "").slice(0, 80)
    case "Edit":
    case "Read":
    case "Write":
    case "MultiEdit":
      return (input.file_path as string) ?? ""
    case "Grep":
      return `/${input.pattern as string ?? ""}/`
    case "Glob":
      return (input.pattern as string) ?? ""
    default:
      return ""
  }
}
