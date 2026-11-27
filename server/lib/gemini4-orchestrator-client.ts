import { randomUUID } from "node:crypto"
import {
  type AdaptiveRouteDecision,
  GEMINI4_DEFAULT_SYNC_OUTPUT_LIMIT,
  GEMINI4_UNIFIED_CONTEXT_WINDOW,
  type Gemini4ThinkingLevel,
  type RouteTier,
  classifyPromptRoute,
  resolveTierTimeoutMs,
} from "./adaptive-routing"
import {
  type ModelTurn,
  type ModelTurnPart,
  preserveModelTurnThoughtSignatures,
  sanitizeGemini4GenerationConfig,
} from "./brain-turn-harness"
import { getFeatureFlags } from "./feature-flags"
import {
  type ExecutableNativeTool,
  MAX_TOOL_SCHEMA_RETRIES,
  buildGeminiFunctionDeclarations,
} from "./native-tool-executor"
import {
  type ExtractedUsageMetrics,
  type TelemetrySink,
  extractUsageMetrics,
  isGemini4Model,
  logTurnMetrics,
  recordTurnMetrics,
  sanitizeThinkingLevel,
} from "./orchestrator-telemetry"
import { estimateTokens } from "./skill-types"

/** Spec §4 Streaming Response Event Protocol (SSE). */
export type OrchestratorEvent =
  | { event: "thinking_delta"; data: { text: string } }
  | { event: "text_delta"; data: { text: string } }
  | { event: "tool_start"; data: { id: string; name: string } }
  | { event: "tool_result_summary"; data: { id: string; summary: string } }
  | { event: "done"; data: { turnId: string; totalTokens: number } }

export function formatOrchestratorSseEvent(ev: OrchestratorEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`
}

export function parseOrchestratorSseChunk(raw: string): OrchestratorEvent[] {
  const events: OrchestratorEvent[] = []
  const blocks = raw.split(/\n\n+/)
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let eventName = ""
    const dataLines: string[] = []
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    }
    if (!eventName || dataLines.length === 0) continue
    try {
      const data = JSON.parse(dataLines.join("\n")) as unknown
      if (data && typeof data === "object" && !Array.isArray(data)) {
        events.push({ event: eventName, data } as OrchestratorEvent)
      }
    } catch {
      /* ignore malformed SSE frame */
    }
  }
  return events
}

export function createOrchestratorSseResponse(stream: AsyncIterable<OrchestratorEvent>): Response {
  const encoder = new TextEncoder()
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of stream) {
          controller.enqueue(encoder.encode(formatOrchestratorSseEvent(ev)))
        }
      } finally {
        controller.close()
      }
    },
  })
  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}

const RAW_TEXT_JSON_TOOL_PROMPT_RE =
  /(?:emit|output|return)\s+(?:raw\s+)?json\s+tool\s+calls?|respond\s+with\s+\{\s*"tool"\s*:/gi

export interface Gemini4NativeRequestPayload {
  modelId: string
  routeTier: RouteTier
  thinkingLevel: Gemini4ThinkingLevel
  timeoutMs: number
  body: Record<string, unknown>
}

/**
 * Build a Gemini 4 `streamGenerateContent` / Interactions payload enforcing every Spec §4 hygiene invariant:
 * - Zero explicit cache (`cachedContents`) and zero sampling params (`temperature`, `top_p`, `top_k`)
 * - Thinking level never `"minimal"` (`low` | `medium` | `high` | `xhigh`)
 * - Native Function Calling `tools: [{ functionDeclarations }]` (strips raw-text JSON tool prompting if 0 tools)
 * - Unified 1,048,576 token window; strips low `maxOutputTokens` (< 64K); enables `background: true` when decode > 64K
 * - Verbatim `thoughtSignature` preservation on every `model` turn part
 * - Tier 3 HTTP timeout >= 15 minutes (`900,000` ms)
 */
export function buildGemini4NativeRequest(opts: {
  modelId: string
  routeTier: RouteTier
  thinkingLevel: Gemini4ThinkingLevel
  systemInstruction?: string
  contents: ReadonlyArray<ModelTurn>
  tools?: ReadonlyArray<ExecutableNativeTool>
  rawGenerationConfig?: Record<string, unknown>
  requestedMaxOutputTokens?: number
  timeoutMs?: number
}): Gemini4NativeRequestPayload {
  const modelId = opts.modelId.trim() || "gemini-4-hydrogen"
  const rawLevel = sanitizeThinkingLevel(modelId, opts.thinkingLevel)
  const thinkingLevel: Gemini4ThinkingLevel =
    rawLevel === "xhigh" || rawLevel === "high" || rawLevel === "medium" || rawLevel === "low"
      ? rawLevel
      : "low"
  const timeoutMs = resolveTierTimeoutMs(opts.routeTier, opts.timeoutMs)

  const sanitizedGen = sanitizeGemini4GenerationConfig(modelId, {
    ...(opts.rawGenerationConfig ?? {}),
    thinkingConfig: {
      thinkingLevel,
      includeThoughts: true,
    },
  })

  // Strip low hardcoded maxOutputTokens caps on Gemini 4 models; only retain >= 65,536 explicit decode targets.
  const rawMaxOut =
    opts.requestedMaxOutputTokens ??
    (typeof sanitizedGen.maxOutputTokens === "number" ? sanitizedGen.maxOutputTokens : undefined) ??
    (typeof sanitizedGen.max_output_tokens === "number" ? sanitizedGen.max_output_tokens : undefined)
  delete sanitizedGen.maxOutputTokens
  delete sanitizedGen.max_output_tokens

  let enableBackground = false
  if (typeof rawMaxOut === "number" && Number.isFinite(rawMaxOut)) {
    if (isGemini4Model(modelId)) {
      if (rawMaxOut > GEMINI4_DEFAULT_SYNC_OUTPUT_LIMIT) {
        const clamped = Math.min(GEMINI4_UNIFIED_CONTEXT_WINDOW, Math.round(rawMaxOut))
        sanitizedGen.maxOutputTokens = clamped
        enableBackground = true
      }
    } else if (rawMaxOut > 0) {
      sanitizedGen.maxOutputTokens = Math.round(rawMaxOut)
    }
  }

  const declarations = opts.tools && opts.tools.length > 0 ? buildGeminiFunctionDeclarations(opts.tools) : []
  let systemText = opts.systemInstruction ?? ""
  if (declarations.length === 0 && systemText) {
    // Prevent MALFORMED_FUNCTION_CALL when zero native tools are declared
    systemText = systemText.replace(RAW_TEXT_JSON_TOOL_PROMPT_RE, "").trim()
  }

  const preservedContents = opts.contents.map((turn) => {
    const preserved = preserveModelTurnThoughtSignatures(turn)
    return {
      role: preserved.role === "assistant" ? "model" : preserved.role === "tool" ? "user" : preserved.role,
      parts: preserved.parts ?? [],
      ...(preserved.thoughtSignature !== undefined ? { thoughtSignature: preserved.thoughtSignature } : {}),
    }
  })

  const body: Record<string, unknown> = {
    contents: preservedContents,
    generationConfig: sanitizedGen,
  }
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] }
  }
  if (declarations.length > 0) {
    body.tools = [{ functionDeclarations: declarations }]
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } }
  }
  if (enableBackground) {
    body.background = true
  }

  return {
    modelId,
    routeTier: opts.routeTier,
    thinkingLevel,
    timeoutMs,
    body,
  }
}

export interface Gemini4StreamChunk {
  parts: ModelTurnPart[]
  usage?: ExtractedUsageMetrics | null
}

export type Gemini4StreamTransport = (
  payload: Gemini4NativeRequestPayload,
  signal: AbortSignal,
) => AsyncIterable<Gemini4StreamChunk>

function parseSseDataPayload(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  const jsonText = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed
  if (!jsonText || jsonText === "[DONE]" || !jsonText.startsWith("{")) return null
  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* ignore partial frame */
  }
  return null
}

/** Default native `fetch` SSE transport for Gemini 4 `streamGenerateContent?alt=sse`. */
export function createFetchGemini4Transport(opts: {
  apiKey: string
  apiBase?: string
}): Gemini4StreamTransport {
  const base = (opts.apiBase ?? "https://generativelanguage.googleapis.com/v1beta/models").replace(/\/+$/, "")
  return async function* fetchStream(payload, signal): AsyncIterable<Gemini4StreamChunk> {
    const url = `${base}/${encodeURIComponent(payload.modelId)}:streamGenerateContent?alt=sse`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify(payload.body),
      signal,
    })
    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => "")
      throw new Error(`Gemini 4 HTTP ${res.status}: ${errBody.slice(0, 300)}`)
    }

    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          const obj = parseSseDataPayload(line)
          if (!obj) continue
          const candidates = Array.isArray(obj.candidates) ? obj.candidates : []
          const first = candidates[0] as { content?: { parts?: ModelTurnPart[] } } | undefined
          const parts = Array.isArray(first?.content?.parts) ? first.content.parts : []
          yield { parts, usage: extractUsageMetrics(obj) }
        }
      }
      if (buf.trim()) {
        const obj = parseSseDataPayload(buf)
        if (obj) {
          const candidates = Array.isArray(obj.candidates) ? obj.candidates : []
          const first = candidates[0] as { content?: { parts?: ModelTurnPart[] } } | undefined
          const parts = Array.isArray(first?.content?.parts) ? first.content.parts : []
          yield { parts, usage: extractUsageMetrics(obj) }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

function summarizeToolOutput(output: string): string {
  const singleLine = output.replace(/\s+/g, " ").trim()
  return singleLine.length > 200 ? `${singleLine.slice(0, 199)}…` : singleLine
}

/**
 * Execute an adaptive Gemini 4 orchestrator turn with native Function Calling,
 * Zod-compatible schema self-correction (up to 2 retries), verbatim `thoughtSignature`
 * preservation, `orchestrator_turn_metrics` logging, and standard `OrchestratorEvent` SSE streaming.
 */
export async function* runGemini4OrchestratorTurn(opts: {
  sessionId: string
  userPrompt: string
  turnId?: string
  systemInstruction?: string
  priorTurns?: ReadonlyArray<ModelTurn>
  tools?: ReadonlyArray<ExecutableNativeTool>
  injectedSkillCount?: number
  routeOverride?: AdaptiveRouteDecision
  requestedMaxOutputTokens?: number
  transport: Gemini4StreamTransport
  telemetrySink?: TelemetrySink
  signal?: AbortSignal
  env?: Record<string, string | undefined>
  now?: () => number
}): AsyncGenerator<OrchestratorEvent, void, unknown> {
  const now = opts.now ?? Date.now
  const turnId = opts.turnId ?? randomUUID()
  const flags = getFeatureFlags(opts.env)
  const route: AdaptiveRouteDecision =
    opts.routeOverride ??
    (flags.ENABLE_ADAPTIVE_ROUTING
      ? classifyPromptRoute(opts.userPrompt, { env: opts.env })
      : {
          tier: "tier1_fast",
          modelId: "gemini-4-argon",
          cliModelFlag: "gemini-4-argon-low",
          thinkingLevel: "low",
          timeoutMs: resolveTierTimeoutMs("tier1_fast"),
          reasons: ["adaptive_routing_disabled_default"],
        })

  const toolMap = new Map<string, ExecutableNativeTool>()
  for (const t of opts.tools ?? []) {
    toolMap.set(t.name, t)
  }

  const conversation: ModelTurn[] = [
    ...(opts.priorTurns ?? []).map((t) => preserveModelTurnThoughtSignatures(t)),
    { role: "user", parts: [{ text: opts.userPrompt }] },
  ]

  const startedAt = now()
  let firstTokenAt: number | null = null
  let toolCallCount = 0
  let toolErrorCount = 0
  let promptTokens = estimateTokens(`${opts.systemInstruction ?? ""}\n${opts.userPrompt}`)
  let cachedPromptTokens = 0
  let outputTokens = 0
  const schemaRetriesByTool = new Map<string, number>()

  const timeoutSignal = AbortSignal.timeout(route.timeoutMs)
  const combinedSignal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal

  const maxToolSteps = 8
  for (let step = 0; step < maxToolSteps; step++) {
    const payload = buildGemini4NativeRequest({
      modelId: route.modelId,
      routeTier: route.tier,
      thinkingLevel: route.thinkingLevel,
      systemInstruction: opts.systemInstruction,
      contents: conversation,
      tools: opts.tools,
      requestedMaxOutputTokens: opts.requestedMaxOutputTokens,
      timeoutMs: route.timeoutMs,
    })

    const modelPartsThisStep: ModelTurnPart[] = []
    for await (const chunk of opts.transport(payload, combinedSignal)) {
      if (chunk.usage) {
        if (chunk.usage.promptTokens !== undefined) promptTokens = chunk.usage.promptTokens
        if (chunk.usage.cachedPromptTokens !== undefined) cachedPromptTokens = chunk.usage.cachedPromptTokens
        if (chunk.usage.outputTokens !== undefined) outputTokens = chunk.usage.outputTokens
      }
      for (const part of chunk.parts) {
        if (firstTokenAt === null) firstTokenAt = now()
        modelPartsThisStep.push(part)
        if (part.thought === true && typeof part.text === "string" && part.text) {
          yield { event: "thinking_delta", data: { text: part.text } }
        } else if (typeof part.text === "string" && part.text && !part.functionCall) {
          yield { event: "text_delta", data: { text: part.text } }
        }
      }
    }

    // Preserve exact model turn parts (including verbatim thoughtSignature on functionCall/thought parts).
    conversation.push(
      preserveModelTurnThoughtSignatures({
        role: "model",
        parts: modelPartsThisStep,
      }),
    )

    const functionCallParts = modelPartsThisStep.filter(
      (p): p is ModelTurnPart & { functionCall: { name: string; args: Record<string, unknown> } } =>
        Boolean(p.functionCall && typeof p.functionCall.name === "string"),
    )
    if (functionCallParts.length === 0) {
      break
    }

    const responseParts: ModelTurnPart[] = []
    let abortFurtherSchemaRetries = false

    for (let idx = 0; idx < functionCallParts.length; idx++) {
      const fcPart = functionCallParts[idx]!
      const callName = fcPart.functionCall.name
      const callId = `call_${step}_${idx}_${callName}`
      toolCallCount++
      yield { event: "tool_start", data: { id: callId, name: callName } }

      const def = toolMap.get(callName)
      let output: string
      if (!def) {
        toolErrorCount++
        output = `[TOOL_EXECUTION_ERROR]: Unknown tool '${callName}'. Available tools: ${[...toolMap.keys()].join(", ") || "none"}`
      } else {
        const res = await def.execute(fcPart.functionCall.args)
        if (!res.success) {
          toolErrorCount++
          if (res.isSchemaValidationError) {
            const count = (schemaRetriesByTool.get(callName) ?? 0) + 1
            schemaRetriesByTool.set(callName, count)
            if (count > MAX_TOOL_SCHEMA_RETRIES) {
              abortFurtherSchemaRetries = true
              output = `${res.output} Maximum schema validation retries (${MAX_TOOL_SCHEMA_RETRIES}) reached; aborting tool call.`
            } else {
              output = res.output
            }
          } else {
            output = res.output
          }
        } else {
          schemaRetriesByTool.set(callName, 0)
          output = res.output
        }
      }

      yield {
        event: "tool_result_summary",
        data: { id: callId, summary: summarizeToolOutput(output) },
      }
      responseParts.push({
        functionResponse: {
          name: callName,
          response: { output },
        },
      })
    }

    conversation.push({
      role: "user",
      parts: responseParts,
    })

    if (abortFurtherSchemaRetries) {
      break
    }
  }

  const endedAt = now()
  const totalLatencyMs = Math.max(0, endedAt - startedAt)
  const ttftMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : totalLatencyMs
  const totalTokens = promptTokens + outputTokens

  const metricRecord = {
    turnId,
    sessionId: opts.sessionId,
    routeTier: route.tier,
    modelId: route.modelId,
    thinkingLevel: route.thinkingLevel,
    injectedSkillCount: opts.injectedSkillCount ?? 0,
    promptTokens,
    cachedPromptTokens,
    ttftMs,
    totalLatencyMs,
    toolCallCount,
    toolErrorCount,
  }

  if (opts.telemetrySink) {
    await logTurnMetrics(opts.telemetrySink, metricRecord)
  } else {
    await recordTurnMetrics(metricRecord)
  }

  yield { event: "done", data: { turnId, totalTokens } }
}

/** Convert an `agy --output-format stream-json` NDJSON line into standard Spec §4 `OrchestratorEvent`s. */
export function agyStreamLineToOrchestratorEvents(line: string, turnId = "agy_turn"): OrchestratorEvent[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const obj = parsed as Record<string, unknown>
  const out: OrchestratorEvent[] = []

  if (obj.event === "thinking" && typeof obj.text === "string" && obj.text) {
    out.push({ event: "thinking_delta", data: { text: obj.text } })
  }
  if (obj.event === "assistant" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as { content?: unknown }
    if (typeof msg.content === "string" && msg.content) {
      out.push({ event: "text_delta", data: { text: msg.content } })
    }
  }
  if (obj.event === "step_update" && obj.step_update && typeof obj.step_update === "object") {
    const su = obj.step_update as {
      step_type?: string
      state?: string
      step_index?: number
      tool_name?: string
      tool_info?: { name?: string; output?: string }
    }
    const toolName = su.tool_name || su.tool_info?.name
    const id = `agy_step_${su.step_index ?? 0}`
    if (su.step_type === "tool" && su.state === "ACTIVE" && typeof toolName === "string") {
      out.push({ event: "tool_start", data: { id, name: toolName } })
    } else if (su.step_type === "tool" && su.state === "COMPLETED") {
      out.push({
        event: "tool_result_summary",
        data: { id, summary: summarizeToolOutput(String(su.tool_info?.output ?? "completed")) },
      })
    }
  }
  if (obj.event === "result" || obj.type === "result") {
    const usage = extractUsageMetrics(obj)
    const totalTokens = (usage?.promptTokens ?? 0) + (usage?.outputTokens ?? 0)
    out.push({ event: "done", data: { turnId, totalTokens } })
  }
  return out
}
