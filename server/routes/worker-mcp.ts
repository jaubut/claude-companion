import { checkBearer, unauthorized } from "../lib/auth"
import { BRAIN_AGENT, LEAD_PREFIX, brainEnabled } from "../lib/brain"
import { type Session, listSessions } from "../lib/sessions"
import { clientOrigin, peerOf } from "../lib/vault-guard"
import type { WorkerMcpHandler } from "../lib/worker-mcp"
import { type BrainWiring, brainWiring } from "../wiring/brain"
import { workerMcp } from "../wiring/worker-mcp"

// Inverted MCP routes (BKM-Q24R Phase 3):
//   POST /api/mcp/workers         → JSON-RPC 2.0 MCP endpoint (Bearer-gated for cross-host delegation).
//   POST /hooks/brain/workers-mcp → Loopback endpoint for local `bin/worker` (verified brain or lead-<repo> pid).

export interface WorkerMcpRouteDeps {
  mcp?: WorkerMcpHandler
  enabled?: () => boolean
  wiring?: Pick<BrainWiring, "status">
  sessions?: () => Array<Pick<Session, "key" | "sessionId" | "pid" | "taskId">>
}

async function readObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.json() as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function callerAuthorizedOnHook(req: Request, deps: WorkerMcpRouteDeps): boolean {
  const origin = clientOrigin(req, peerOf(req))
  if (origin.transport !== "loopback") return false
  if (checkBearer(req)) return true
  const taskId = req.headers.get("x-companion-task-id")?.trim() ?? ""
  const pid = req.headers.get("x-companion-pid")?.trim() ?? ""
  if (!taskId || !pid) return false
  const sessions = (deps.sessions ?? listSessions)()
  if (taskId === BRAIN_AGENT) {
    const st = (deps.wiring ?? brainWiring).status()
    if (!st.sessionKey) return false
    const s = sessions.find((x) => x.key === st.sessionKey)
    const brain = sessions.find((x) => x.pid === pid)
    return !!s && !!brain && brain.key === s.key && brain.sessionId === s.sessionId && brain.taskId === BRAIN_AGENT
  }
  if (taskId.startsWith(LEAD_PREFIX)) {
    const sandboxed = req.headers.get("x-companion-sandbox") === "1"
    const lead = sessions.find((x) => x.taskId === taskId && (x.pid === pid || sandboxed))
    return !!lead
  }
  return false
}

export function createWorkerMcpRoute(deps: WorkerMcpRouteDeps = {}) {
  const mcp = deps.mcp ?? workerMcp
  return async function handleWorkerMcpRoute(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== "/api/mcp/workers" && url.pathname !== "/hooks/brain/workers-mcp") {
      return null
    }
    if (req.method !== "POST") {
      return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 })
    }
    if (url.pathname === "/api/mcp/workers") {
      if (!checkBearer(req)) return unauthorized()
    } else {
      if (!(deps.enabled ?? brainEnabled)()) {
        return Response.json({ ok: false, error: "brain_disabled" }, { status: 403 })
      }
      if (!callerAuthorizedOnHook(req, deps)) {
        return Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      }
    }

    const body = await readObject(req)
    if (!body) {
      return Response.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }, { status: 400 })
    }

    const res = await mcp.handleRpc(body)
    if (res === null) {
      return new Response(null, { status: 202 })
    }
    return Response.json(res)
  }
}

export const handleWorkerMcpRoute = createWorkerMcpRoute()
