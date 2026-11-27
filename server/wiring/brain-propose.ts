import { BRAIN_DIR } from "./brain-headless"
import { addBrainHandoff } from "./brain-handoff"
import { workerMcp } from "./worker-mcp"
import { brainFiling } from "../lib/brain"
import { getSharedSkillRegistry } from "../lib/brain-turn-harness"
import {
  type Gemini4StreamTransport,
  createFetchGemini4Transport,
  createOrchestratorSseResponse,
  runGemini4OrchestratorTurn,
} from "../lib/gemini4-orchestrator-client"
import { createNativeLoadSkillTool } from "../lib/native-tool-executor"
import { getTask } from "../lib/orchestrator-chat"
import { buildDynamicSystemPrompt, loadStaticBrainRules } from "../lib/skill-prompt"
import { REPO_NAME_RE } from "../lib/worker-invocation"
import type { WorkerMcpHandler } from "../lib/worker-mcp"

export interface ProposeInput {
  title: string
  prompt: string
  noteId: string
  agent: string | null
  reasoning: string
  sourceTurnId: string
  taskId?: string
  syncBudgetMs?: number
}

/** The resolver leaves a proposal alone once it is handed off: the brain is filing it, or it is no longer `proposed`. */
export const proposalHandedOff = (taskId: string): boolean =>
  brainFiling.has(taskId) || getTask(taskId)?.status !== "proposed"

const trimStr = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null

/** Atomic `/hooks/brain/dispatch` (`bin/dispatch` or `propose --dispatch`): local `<20ms` handoff + worker MCP `dispatch_task`. */
export async function executeAtomicBrainDispatch(
  body: Record<string, unknown>,
  parsed: { noteId: string; prompt: string; sourceTurnId: string; title: string; reasoning: string; taskId?: string },
  seams: { handoff?: typeof addBrainHandoff; workerMcp?: WorkerMcpHandler } = {},
): Promise<Response> {
  const rawRepo = typeof body.repo === "string" ? body.repo.trim() : ""
  if (!REPO_NAME_RE.test(rawRepo)) return Response.json({ ok: false, error: "invalid_repo" }, { status: 400 })
  const repo = rawRepo.toLowerCase()
  const family = trimStr(body.family, 32) ?? undefined
  const agent = trimStr(body.agent, 64) ?? undefined
  const model = trimStr(body.model, 128) ?? undefined
  const mode = trimStr(body.mode, 32) ?? "auto"
  const host = trimStr(body.host, 32) ?? "local"
  const handoffOut = await (seams.handoff ?? addBrainHandoff)({
    title: parsed.title,
    prompt: parsed.prompt,
    noteId: parsed.noteId,
    reasoning: parsed.reasoning,
    sourceTurnId: parsed.sourceTurnId,
    repo,
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
  })
  if (handoffOut.body.ok !== true) {
    return Response.json(handoffOut.body, { status: handoffOut.status })
  }
  const resolvedTaskId = String(handoffOut.body.taskId ?? parsed.taskId ?? "")
  const claim = typeof handoffOut.body.claim === "string" ? handoffOut.body.claim : undefined
  const mcp = seams.workerMcp ?? workerMcp
  const rpcOut = await mcp.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "dispatch_task",
      arguments: {
        task_id: resolvedTaskId,
        repo,
        prompt: parsed.prompt,
        title: parsed.title,
        mode,
        host,
        ...(family ? { family } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(claim ? { claim } : {}),
      },
    },
  })
  const structured = ((rpcOut?.result as { structuredContent?: Record<string, unknown> } | undefined)?.structuredContent) ?? {}
  if (structured.ok !== true) {
    if (handoffOut.body.replay === true && structured.error === "task_already_running") {
      const existingOut = await mcp.handleRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_task", arguments: { task_id: resolvedTaskId, host } },
      })
      const existing = ((existingOut?.result as { structuredContent?: Record<string, unknown> } | undefined)?.structuredContent) ?? {}
      return Response.json({
        ...handoffOut.body,
        dispatched: true,
        replay: true,
        host: existing.host ?? host,
        task: existing.task ?? null,
      }, { status: 200, headers: { "Idempotent-Replayed": "true" } })
    }
    const status = typeof structured.status === "number" ? structured.status : 502
    return Response.json({
      ...handoffOut.body,
      ok: false,
      dispatched: false,
      error: typeof structured.error === "string" ? structured.error : "dispatch_failed",
    }, { status })
  }
  return Response.json({
    ...handoffOut.body,
    dispatched: true,
    claimStatus: structured.claim ?? (claim ? "verified" : "absent"),
    host: structured.host ?? host,
    task: structured.task ?? null,
  }, {
    status: 200,
    headers: handoffOut.body.replay ? { "Idempotent-Replayed": "true" } : undefined,
  })
}

/** Direct Gemini 4 SSE streaming endpoint (`POST /api/brain/stream`) with native `load_skill` tool execution. */
export function createBrainSseTurnResponse(opts: {
  sessionId: string
  prompt: string
  transport?: Gemini4StreamTransport
  signal?: AbortSignal
}): Response {
  const apiKey = process.env.GEMINI_API_KEY?.trim() ?? ""
  const transport = opts.transport ?? (apiKey ? createFetchGemini4Transport({ apiKey }) : null)
  if (!transport) return Response.json({ ok: false, error: "gemini_transport_unavailable" }, { status: 503 })
  const registry = getSharedSkillRegistry()
  const systemInstruction = buildDynamicSystemPrompt({
    staticRules: loadStaticBrainRules(BRAIN_DIR),
    registry,
    currentInput: opts.prompt,
  }).fullPrompt
  return createOrchestratorSseResponse(
    runGemini4OrchestratorTurn({
      sessionId: opts.sessionId,
      userPrompt: opts.prompt,
      systemInstruction,
      tools: [createNativeLoadSkillTool(registry)],
      transport,
      signal: opts.signal,
    }),
  )
}
