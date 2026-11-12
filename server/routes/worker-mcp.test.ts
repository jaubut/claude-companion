import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordPeer } from "../lib/vault-guard"
import { createWorkerMcpHandler } from "../lib/worker-mcp"
import { createWorkerSupervisor } from "../lib/worker-supervisor"
import { syncWorkerTaskToTurso } from "../wiring/worker-mcp"
import { createWorkerMcpRoute } from "./worker-mcp"

describe("worker-mcp route and JSON-RPC 2.0 handler", () => {
  test("enforces loopback + brain/lead pid auth on /hooks/brain/workers-mcp, serves MCP tools, and forwards remote host calls", async () => {
    const home = join(tmpdir(), `worker-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const repoDir = join(home, "claude-companion")
    mkdirSync(join(repoDir, ".git"), { recursive: true })

    const sup = createWorkerSupervisor({
      host: "zettlab",
      home,
      now: () => 1700000000000,
      uuid: () => "22222222-3333-4444-8555-666666666666",
      trust: () => {},
      reportJob: () => {},
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) {
          const wtPath = args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!
          mkdirSync(wtPath, { recursive: true })
        }
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker(opts) {
        queueMicrotask(() => {
          opts.onStdoutLine(JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "DONE https://github.com/jaubut/claude-companion/pull/311",
          }))
          opts.onExit(0, null)
        })
        return { pid: 5151, kill() {} }
      },
    })

    const forwarded: Array<{ url: string; auth: string | null; body: unknown }> = []
    const mcp = createWorkerMcpHandler({
      supervisor: sup,
      localHost: "zettlab",
      resolvePeer(host) {
        if (host === "mac") return { url: "http://100.64.0.2:4245", token: "mac-peer-token" }
        return null
      },
      fetchPeer: (async (input: string | URL | Request, init?: RequestInit) => {
        const u = String(input)
        const headers = new Headers(init?.headers)
        const parsed = JSON.parse(String(init?.body ?? "{}"))
        forwarded.push({ url: u, auth: headers.get("authorization"), body: parsed })
        return Response.json({
          jsonrpc: "2.0",
          id: parsed.id ?? 1,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true, host: "mac", tasks: [] }) }],
            structuredContent: { ok: true, host: "mac", tasks: [] },
          },
        })
      }) as typeof fetch,
    })

    let enabled = true
    const route = createWorkerMcpRoute({
      mcp,
      enabled: () => enabled,
      wiring: {
        status: () => ({
          state: "up",
          sessionKey: "brain-key",
          since: 1,
          restarts: 0,
          host: "zettlab",
          activity: null,
        }),
      },
      sessions: () => [
        {
          key: "brain-key",
          sessionId: "brain-sid",
          pid: "9001",
          cwd: "/home/aubut/claude-companion/brain",
          taskId: "brain",
          startedAt: 1,
          lastSeenAt: 1,
        },
        {
          key: "lead-key",
          sessionId: "lead-sid",
          pid: "9002",
          cwd: "/home/aubut/leads/claude-companion",
          taskId: "lead-claude-companion",
          startedAt: 1,
          lastSeenAt: 1,
        },
      ],
    })

    function makeHookReq(body: unknown, headers: Record<string, string>, ip = "127.0.0.1"): Request {
      const req = new Request("http://127.0.0.1:4245/hooks/brain/workers-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
      recordPeer(req, ip)
      return req
    }

    try {
      // Non-loopback peer is refused (403)
      const nonLoop = await route(
        makeHookReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-Companion-Task-Id": "brain", "X-Companion-Pid": "9001" }, "100.64.0.9"),
        new URL("http://127.0.0.1:4245/hooks/brain/workers-mcp"),
      )
      expect(nonLoop?.status).toBe(403)

      // Refused when brainEnabled() is false (403 brain_disabled)
      enabled = false
      const disabledRes = await route(
        makeHookReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-Companion-Task-Id": "brain", "X-Companion-Pid": "9001" }),
        new URL("http://127.0.0.1:4245/hooks/brain/workers-mcp"),
      )
      expect(disabledRes?.status).toBe(403)
      enabled = true

      // Wrong pid is refused (403)
      const wrongPid = await route(
        makeHookReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-Companion-Task-Id": "brain", "X-Companion-Pid": "9999" }),
        new URL("http://127.0.0.1:4245/hooks/brain/workers-mcp"),
      )
      expect(wrongPid?.status).toBe(403)

      // Verified brain session lists all 4 Inverted MCP tools
      const listRes = await route(
        makeHookReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-Companion-Task-Id": "brain", "X-Companion-Pid": "9001" }),
        new URL("http://127.0.0.1:4245/hooks/brain/workers-mcp"),
      )
      expect(listRes?.status).toBe(200)
      const listJson = await listRes!.json() as { result: { tools: Array<{ name: string }> } }
      expect(listJson.result.tools.map((t) => t.name)).toEqual([
        "dispatch_task",
        "await_task",
        "interrupt_task",
        "list_tasks",
      ])

      // Verified repo lead session (`lead-claude-companion`) can dispatch_task and await_task
      const dispRes = await route(
        makeHookReq({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "dispatch_task",
            arguments: {
              task_id: "task-mcp-1",
              repo: "claude-companion",
              prompt: "Ship worker mcp",
            },
          },
        }, { "X-Companion-Task-Id": "lead-claude-companion", "X-Companion-Pid": "9002" }),
        new URL("http://127.0.0.1:4245/hooks/brain/workers-mcp"),
      )
      expect(dispRes?.status).toBe(200)

      const awaitRes = await route(
        makeHookReq({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "await_task",
            arguments: {
              task_id: "task-mcp-1",
              wait_ms: 5000,
            },
          },
        }, { "X-Companion-Task-Id": "lead-claude-companion", "X-Companion-Pid": "9002" }),
        new URL("http://127.0.0.1:4245/hooks/brain/workers-mcp"),
      )
      expect(awaitRes?.status).toBe(200)
      const awaitJson = await awaitRes!.json() as { result: { structuredContent: { ok: boolean; task: { status: string; prUrl: string } } } }
      expect(awaitJson.result.structuredContent.ok).toBe(true)
      expect(awaitJson.result.structuredContent.task.status).toBe("completed")
      expect(awaitJson.result.structuredContent.task.prUrl).toBe("https://github.com/jaubut/claude-companion/pull/311")

      // Remote host delegation (`host: "mac"`) forwards to peer `/api/mcp/workers` with Bearer token
      const remoteRes = await route(
        makeHookReq({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "list_tasks",
            arguments: { host: "mac" },
          },
        }, { "X-Companion-Task-Id": "brain", "X-Companion-Pid": "9001" }),
        new URL("http://127.0.0.1:4245/hooks/brain/workers-mcp"),
      )
      expect(remoteRes?.status).toBe(200)
      expect(forwarded).toHaveLength(1)
      expect(forwarded[0]!.url).toBe("http://100.64.0.2:4245/api/mcp/workers")
      expect(forwarded[0]!.auth).toBe("Bearer mac-peer-token")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("syncWorkerTaskToTurso links dispatch_pr_url and dispatch_status on Turso tasks", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const exec = async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args })
      return { rows: [], affected: 1 }
    }
    const taskId = "89b0c0ac1e6f866189c3dbd821fb8f85"
    await syncWorkerTaskToTurso({ taskId, status: "running", prUrl: null, error: null }, exec)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sql).toContain("dispatch_status = 'running'")

    await syncWorkerTaskToTurso({ taskId, status: "running", prUrl: "https://github.com/jaubut/le-brouemont-maquette/pull/8", error: null }, exec)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.args).toContain("https://github.com/jaubut/le-brouemont-maquette/pull/8")

    await syncWorkerTaskToTurso({ taskId, status: "completed", prUrl: "https://github.com/jaubut/le-brouemont-maquette/pull/8", error: null }, exec)
    expect(calls).toHaveLength(3)
    expect(calls[2]!.sql).toContain("dispatch_status = 'completed'")
  })
})
