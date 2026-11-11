import type { WorkerSupervisor } from "./worker-supervisor"

// Inverted MCP Control Plane (BKM-Q24R Phase 3):
// Exposes JSON-RPC 2.0 MCP tools (`dispatch_task`, `await_task`,
// `interrupt_task`, `list_tasks`) over Companion's HTTP plane so the Brain
// and Repo Leads can orchestrate headless stream-json builders locally or
// across peer hosts (Zettlab <-> MacBook) without `herdr`/`tmux` scraping.

export const WORKER_MCP_TOOLS = [
  {
    name: "dispatch_task",
    description: "Start or resume a headless stream-json builder task in an isolated git worktree (`dispatch/<task_id>`). Streams live progress to Companion's BuilderJobStore.",
    inputSchema: {
      type: "object",
      required: ["task_id", "repo", "prompt"],
      properties: {
        task_id: { type: "string", description: "Stable task identifier (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`)." },
        repo: { type: "string", description: "Bare repository name on the target host (e.g. `claude-companion`, `claude-config`)." },
        prompt: { type: "string", description: "Task brief for turn 1, or follow-up instructions when resuming an existing task." },
        title: { type: "string", description: "Optional human-readable title shown in Companion's live builder card." },
        agent: { type: "string", description: "Optional agent profile slug (e.g. `builder`)." },
        model: { type: "string", description: "Optional model override." },
        mode: { type: "string", description: "Permission mode (`auto`, `acceptEdits`, `default`, `dontAsk`, `plan`). Defaults to `auto`." },
        timeout_s: { type: "number", description: "Per-turn timeout in seconds (default 3600)." },
        host: { type: "string", description: "Target worker host (`local`, `zettlab`, `mac`). Defaults to `local`." },
      },
    },
  },
  {
    name: "await_task",
    description: "Wait event-driven (up to `wait_ms`, or `0` for an immediate status snapshot) for a dispatched builder task to finish its current turn.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Task identifier to await." },
        wait_ms: { type: "number", description: "Max milliseconds to wait before returning the current progress snapshot (0..120000, default 30000)." },
        host: { type: "string", description: "Target worker host (`local`, `zettlab`, `mac`). Defaults to `local`." },
      },
    },
  },
  {
    name: "interrupt_task",
    description: "Interrupt a running headless builder task's process group (`SIGTERM` -> `SIGKILL`), and optionally remove its worktree if clean and pushed.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Task identifier to interrupt." },
        close_worktree: { type: "boolean", description: "When true, removes the task's git worktree and local `dispatch/<task_id>` branch iff clean and pushed." },
        host: { type: "string", description: "Target worker host (`local`, `zettlab`, `mac`). Defaults to `local`." },
      },
    },
  },
  {
    name: "list_tasks",
    description: "List supervised headless builder tasks on the target host, newest update first.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Target worker host (`local`, `zettlab`, `mac`). Defaults to `local`." },
      },
    },
  },
] as const

export interface PeerHostConfig {
  url: string
  token: string
}

export interface WorkerMcpDeps {
  supervisor: WorkerSupervisor
  localHost: string
  resolvePeer?(host: string): PeerHostConfig | null
  fetchPeer?: typeof fetch
}

export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function rpcOk(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function rpcErr(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

function toolResult(payload: Record<string, unknown>, isError = false): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  }
}

function isLocalTarget(targetHost: string | undefined, localHost: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const h = (targetHost ?? "").trim().toLowerCase()
  if (!h || h === "local") return true
  const loc = localHost.trim().toLowerCase()
  if (h === loc) return true
  const envRole = (env.COMPANION_HOST_ROLE ?? "").trim().toLowerCase()
  const knownRole = envRole === "zettlab" || envRole === "mac"
    ? envRole
    : /\bzettlab\b/.test(loc)
    ? "zettlab"
    : /\bmac(book)?\b/.test(loc)
    ? "mac"
    : process.platform === "darwin"
    ? "mac"
    : process.platform === "linux"
    ? "zettlab"
    : ""
  return h === knownRole
}

export function defaultResolvePeer(host: string, env: NodeJS.ProcessEnv = process.env): PeerHostConfig | null {
  const h = host.trim().toLowerCase()
  if (h === "mac") {
    const url = env.COMPANION_PEER_MAC_URL?.trim() ?? ""
    const token = (env.COMPANION_PEER_MAC_TOKEN ?? env.COMPANION_TOKEN ?? "").trim()
    return url && token ? { url, token } : null
  }
  if (h === "zettlab") {
    const url = env.COMPANION_PEER_ZETTLAB_URL?.trim() ?? ""
    const token = (env.COMPANION_PEER_ZETTLAB_TOKEN ?? env.COMPANION_TOKEN ?? "").trim()
    return url && token ? { url, token } : null
  }
  return null
}

export function createWorkerMcpHandler(deps: WorkerMcpDeps) {
  const resolvePeer = deps.resolvePeer ?? defaultResolvePeer
  const fetchFn = deps.fetchPeer ?? fetch

  async function forwardToolCall(peer: PeerHostConfig, id: string | number | null, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    const endpoint = `${peer.url.replace(/\/$/, "")}/api/mcp/workers`
    const waitMs = typeof args.wait_ms === "number" && Number.isFinite(args.wait_ms) ? Math.min(120_000, Math.max(0, args.wait_ms)) : 30_000
    const timeoutMs = name === "await_task" ? waitMs + 15_000 : 30_000
    let res: Response
    try {
      res = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${peer.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? 1,
          method: "tools/call",
          params: { name, arguments: { ...args, host: "local" } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      return rpcOk(id, toolResult({ ok: false, error: `peer_unreachable: ${(err as Error)?.message ?? String(err)}` }, true))
    }
    let body: unknown = null
    try { body = await res.json() as unknown } catch { body = null }
    if (!res.ok || !body || typeof body !== "object" || Array.isArray(body)) {
      return rpcOk(id, toolResult({ ok: false, error: `peer_http_${res.status}` }, true))
    }
    const rpc = body as Partial<JsonRpcResponse>
    if (rpc.error) return rpcErr(id, rpc.error.code ?? -32000, rpc.error.message ?? "peer_error", rpc.error.data)
    return rpcOk(id, rpc.result ?? toolResult({ ok: false, error: "empty_peer_result" }, true))
  }

  async function callTool(id: string | number | null, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    const targetHost = typeof args.host === "string" ? args.host : undefined
    if (!isLocalTarget(targetHost, deps.localHost)) {
      const peer = resolvePeer(targetHost!)
      if (!peer) {
        return rpcOk(id, toolResult({ ok: false, error: `peer_not_configured: ${targetHost}` }, true))
      }
      return forwardToolCall(peer, id, name, args)
    }

    if (name === "dispatch_task") {
      const out = await deps.supervisor.dispatchTask({
        taskId: typeof args.task_id === "string" ? args.task_id : String(args.taskId ?? ""),
        repo: typeof args.repo === "string" ? args.repo : "",
        prompt: typeof args.prompt === "string" ? args.prompt : "",
        title: typeof args.title === "string" ? args.title : undefined,
        agent: typeof args.agent === "string" ? args.agent : undefined,
        model: typeof args.model === "string" ? args.model : undefined,
        mode: typeof args.mode === "string" ? args.mode : undefined,
        timeoutS: typeof args.timeout_s === "number" && Number.isFinite(args.timeout_s) ? args.timeout_s : undefined,
      })
      if (!out.ok) return rpcOk(id, toolResult({ ok: false, error: out.error, status: out.status }, true))
      return rpcOk(id, toolResult({ ok: true, host: deps.localHost, task: out.task }))
    }

    if (name === "await_task") {
      const taskId = typeof args.task_id === "string" ? args.task_id : String(args.taskId ?? "")
      const waitMs = typeof args.wait_ms === "number" && Number.isFinite(args.wait_ms) ? args.wait_ms : undefined
      const out = await deps.supervisor.awaitTask(taskId, waitMs)
      if (!out.ok) return rpcOk(id, toolResult({ ok: false, error: out.error, status: out.status }, true))
      return rpcOk(id, toolResult({ ok: true, host: deps.localHost, timedOut: out.timedOut, task: out.task }))
    }

    if (name === "interrupt_task") {
      const taskId = typeof args.task_id === "string" ? args.task_id : String(args.taskId ?? "")
      const closeWorktree = args.close_worktree === true || args.closeWorktree === true
      const out = await deps.supervisor.interruptTask(taskId, { closeWorktree })
      if (!out.ok) return rpcOk(id, toolResult({ ok: false, error: out.error, status: out.status }, true))
      return rpcOk(id, toolResult({ ok: true, host: deps.localHost, worktreeRemoved: out.worktreeRemoved, ...(out.note ? { note: out.note } : {}), task: out.task }))
    }

    if (name === "list_tasks") {
      return rpcOk(id, toolResult({ ok: true, host: deps.localHost, tasks: deps.supervisor.listTasks() }))
    }

    return rpcErr(id, -32601, `Unknown tool: ${name}`)
  }

  return {
    async handleRpc(raw: Record<string, unknown>): Promise<JsonRpcResponse | null> {
      const id = typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null
      const method = typeof raw.method === "string" ? raw.method : ""
      if (!method) return rpcErr(id, -32600, "Invalid Request: missing method")

      if (method === "notifications/initialized" || method.startsWith("notifications/")) {
        return null
      }
      if (method === "ping") {
        return rpcOk(id, {})
      }
      if (method === "initialize") {
        return rpcOk(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "companion-worker-mcp", version: "1.0.0", host: deps.localHost },
        })
      }
      if (method === "tools/list") {
        return rpcOk(id, { tools: WORKER_MCP_TOOLS })
      }
      if (method === "tools/call") {
        const params = raw.params && typeof raw.params === "object" && !Array.isArray(raw.params) ? (raw.params as Record<string, unknown>) : null
        const name = typeof params?.name === "string" ? params.name : ""
        if (!name) return rpcErr(id, -32602, "Invalid params: missing tool name")
        const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}
        return callTool(id, name, args)
      }
      return rpcErr(id, -32601, `Method not found: ${method}`)
    },
    callTool,
  }
}

export type WorkerMcpHandler = ReturnType<typeof createWorkerMcpHandler>
