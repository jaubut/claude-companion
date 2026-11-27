import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { getFeatureFlags } from "./feature-flags"
import {
  type ExtractedUsageMetrics,
  type TelemetrySink,
  type TurnMetricRecord,
  extractUsageMetrics,
  isGemini4Model,
  logTurnMetrics,
  recordTurnMetrics,
  sanitizeThinkingLevel,
} from "./orchestrator-telemetry"
import { defaultSkillsDir, loadSkillManifests } from "./skill-loader"
import { buildBaselineStaticSystemPrompt, buildDynamicSystemPrompt, loadStaticBrainRules, renderFullSkillBlock } from "./skill-prompt"
import { DynamicSkillRegistry } from "./skill-retrieval"
import { type LoadSkillExecutionResult, executeLoadSkill } from "./skill-tools"
import { estimateTokens } from "./skill-types"
import { defaultKillPid } from "./worker-pid"
import type { SpawnWorkerOpts, SpawnedWorkerHandle } from "./worker-supervisor"

export interface SpawnedPersistentWorkerHandle extends SpawnedWorkerHandle {
  writeLine(line: string): boolean
  closeInput(): void
}

export function defaultSpawnPersistentWorker(opts: SpawnWorkerOpts): SpawnedPersistentWorkerHandle {
  const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true })
  let outBuf = "", errBuf = "", closed = false
  child.stdin?.on("error", () => { closed = true })
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    outBuf += chunk; const lines = outBuf.split("\n"); outBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStdoutLine(l)
  })
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    errBuf += chunk; const lines = errBuf.split("\n"); errBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStderrLine(l)
  })
  child.on("error", (err) => { closed = true; opts.onStderrLine(err.message); opts.onExit(1, null) })
  child.on("close", (code, sig) => {
    closed = true
    if (outBuf.trim()) opts.onStdoutLine(outBuf)
    if (errBuf.trim()) opts.onStderrLine(errBuf)
    opts.onExit(code, sig)
  })
  return {
    pid: child.pid ?? 0,
    writeLine(line: string): boolean {
      if (closed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false
      try {
        child.stdin.write(line.endsWith("\n") ? line : `${line}\n`, "utf8")
        return true
      } catch {
        closed = true
        return false
      }
    },
    closeInput() {
      closed = true
      try { child.stdin?.end() } catch { /* ignore */ }
    },
    kill(sig: NodeJS.Signals) {
      closed = true
      try { child.stdin?.destroy() } catch { /* ignore */ }
      if (child.pid) defaultKillPid(child.pid, sig)
    },
  }
}

let defaultRegistry: DynamicSkillRegistry | null = null
let defaultRegistryDir = ""

export function getSharedSkillRegistry(skillsDir = defaultSkillsDir()): DynamicSkillRegistry {
  if (defaultRegistry && defaultRegistryDir === skillsDir) return defaultRegistry
  defaultRegistry = new DynamicSkillRegistry(loadSkillManifests(skillsDir))
  defaultRegistryDir = skillsDir
  return defaultRegistry
}

export function resetSharedSkillRegistryForTests(): void {
  defaultRegistry = null
  defaultRegistryDir = ""
}

export function runBrainLoadSkill(rawArgs: unknown, registry = getSharedSkillRegistry()): LoadSkillExecutionResult {
  return executeLoadSkill(registry, rawArgs)
}

export interface StreamToolCall {
  phase: "pre" | "post"
  tool: string
  input: Record<string, unknown>
  toolUseId: string
  thoughtSignature?: string
}

/** Extract active tool-call metadata from Claude or `agy` stream-json lines, preserving any `thoughtSignature` verbatim. */
export function extractBrainStreamToolCall(line: string): StreamToolCall | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const raw = parsed as {
    event?: string
    thoughtSignature?: string
    step_update?: {
      step_type?: string
      state?: string
      tool_name?: string
      step_index?: number
      thoughtSignature?: string
      tool_info?: { name?: string; parameters?: Record<string, unknown>; thoughtSignature?: string }
    }
    message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string }> }
  }
  const tu = Array.isArray(raw.message?.content)
    ? raw.message.content.find((b) => b?.type === "tool_use" && typeof b.name === "string")
    : undefined
  if (tu?.name) {
    const sig = typeof tu.thoughtSignature === "string" ? tu.thoughtSignature : undefined
    return {
      phase: "pre",
      tool: tu.name,
      input: tu.input && typeof tu.input === "object" && !Array.isArray(tu.input) ? tu.input : {},
      toolUseId: tu.id || `tu_${Date.now()}`,
      ...(sig !== undefined ? { thoughtSignature: sig } : {}),
    }
  }
  if (raw.event === "step_update" && raw.step_update?.step_type === "tool" && raw.step_update.state === "ACTIVE") {
    const tool = raw.step_update.tool_name || raw.step_update.tool_info?.name
    const params = raw.step_update.tool_info?.parameters
    if (typeof tool === "string" && tool) {
      const sig = typeof raw.step_update.tool_info?.thoughtSignature === "string"
        ? raw.step_update.tool_info.thoughtSignature
        : typeof raw.step_update.thoughtSignature === "string"
          ? raw.step_update.thoughtSignature
          : typeof raw.thoughtSignature === "string"
            ? raw.thoughtSignature
            : undefined
      return {
        phase: "pre",
        tool,
        input: params && typeof params === "object" && !Array.isArray(params) ? params : {},
        toolUseId: `agy_tu_${raw.step_update.step_index ?? Date.now()}`,
        ...(sig !== undefined ? { thoughtSignature: sig } : {}),
      }
    }
  }
  return undefined
}

export interface ModelTurnPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  [key: string]: unknown
}

export interface ModelTurn {
  role: "user" | "model" | "assistant" | "tool"
  parts?: ModelTurnPart[]
  thoughtSignature?: string
  [key: string]: unknown
}

/**
 * Clone/normalize a model turn while preserving every `thoughtSignature` field byte-for-byte verbatim
 * on the exact part where the model emitted it (never stripped, edited, or copied across parallel tool calls).
 */
export function preserveModelTurnThoughtSignatures<T extends ModelTurn>(turn: T): T {
  if (!Array.isArray(turn.parts)) {
    return { ...turn }
  }
  const preservedParts = turn.parts.map((part) => {
    const cloned: ModelTurnPart = { ...part }
    if ("thoughtSignature" in part) {
      cloned.thoughtSignature = part.thoughtSignature
    }
    return cloned
  })
  return {
    ...turn,
    parts: preservedParts,
  }
}

/**
 * Strip forbidden sampling / explicit-cache / minimal-thinking fields from any Gemini 4 request config.
 */
export function sanitizeGemini4GenerationConfig(
  modelId: string,
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rawConfig }
  delete out.cachedContents
  delete out.cached_content
  if (!isGemini4Model(modelId)) return out

  delete out.temperature
  delete out.top_p
  delete out.topP
  delete out.top_k
  delete out.topK

  if (out.thinking_level === "minimal" || out.thinkingLevel === "minimal") {
    if ("thinking_level" in out) out.thinking_level = "low"
    if ("thinkingLevel" in out) out.thinkingLevel = "low"
  }
  if (out.thinkingConfig && typeof out.thinkingConfig === "object" && !Array.isArray(out.thinkingConfig)) {
    const tc = { ...(out.thinkingConfig as Record<string, unknown>) }
    if (tc.thinkingLevel === "minimal" || tc.thinking_level === "minimal") {
      if ("thinkingLevel" in tc) tc.thinkingLevel = "low"
      if ("thinking_level" in tc) tc.thinking_level = "low"
    }
    out.thinkingConfig = tc
  }
  return out
}

export interface PreparedBrainTurn {
  promptToSend: string
  injectedSkillCount: number
  estimatedPromptTokens: number
  newlyInjectedSkillIds: string[]
  routeTier: string
}

export function prepareBrainTurn(opts: {
  userText: string
  family: "claude" | "gemini"
  bootPrefixSent: boolean
  legacyAgyBootPrefix: string
  brainDir: string
  alreadyInjectedSkillIds?: ReadonlySet<string>
  historySummary?: string[]
  registry?: DynamicSkillRegistry
  env?: Record<string, string | undefined>
}): PreparedBrainTurn {
  const flags = getFeatureFlags(opts.env)
  const registry = opts.registry ?? getSharedSkillRegistry(defaultSkillsDir(opts.env))

  if (!flags.ENABLE_DYNAMIC_SKILLS) {
    const promptToSend = opts.family === "gemini" && !opts.bootPrefixSent
      ? `${opts.legacyAgyBootPrefix}${opts.userText}`
      : opts.userText
    const staticRules = loadStaticBrainRules(opts.brainDir)
    const baseline = buildBaselineStaticSystemPrompt({
      staticRules,
      skills: registry.getAllSkills(),
    })
    return {
      promptToSend,
      injectedSkillCount: baseline.injectedSkillCount,
      estimatedPromptTokens: baseline.totalPromptTokens + estimateTokens(opts.userText),
      newlyInjectedSkillIds: [],
      routeTier: "baseline",
    }
  }

  const staticRules = loadStaticBrainRules(opts.brainDir)
  const built = buildDynamicSystemPrompt({
    staticRules,
    registry,
    currentInput: opts.userText,
    historySummary: opts.historySummary,
  })

  if (!opts.bootPrefixSent) {
    const promptToSend = `${built.fullPrompt}\n\n---\n\n${opts.userText}`
    return {
      promptToSend,
      injectedSkillCount: built.injectedSkillCount,
      estimatedPromptTokens: built.totalPromptTokens + estimateTokens(opts.userText),
      newlyInjectedSkillIds: built.selection.activeSkills.map((s) => s.id),
      routeTier: "dynamic_skills_p1",
    }
  }

  // Subsequent turn on a persistent session: keep the session's static prefix intact for implicit cache hits,
  // and append only newly matched dynamic skills that have not yet been injected in this session.
  const already = opts.alreadyInjectedSkillIds ?? new Set<string>()
  const deltaSkills = built.selection.dynamicSkills.filter((s) => !already.has(s.id))
  const deltaSuffix = deltaSkills.length > 0
    ? `[Active Turn Skills]\n${deltaSkills.map(renderFullSkillBlock).join("\n\n")}\n\n`
    : ""
  const promptToSend = `${deltaSuffix}${opts.userText}`

  return {
    promptToSend,
    injectedSkillCount: built.injectedSkillCount,
    estimatedPromptTokens: built.totalPromptTokens + estimateTokens(opts.userText),
    newlyInjectedSkillIds: deltaSkills.map((s) => s.id),
    routeTier: "dynamic_skills_p1",
  }
}

export interface TurnMetricsTracker {
  noteStreamLine(line: string): void
  finish(opts?: { isError?: boolean; telemetrySink?: TelemetrySink }): Promise<TurnMetricRecord>
}

export function startBrainTurnMetrics(opts: {
  turnId?: string
  sessionId: string
  routeTier: string
  modelId: string
  injectedSkillCount: number
  estimatedPromptTokens: number
  now?: () => number
}): TurnMetricsTracker {
  const now = opts.now ?? Date.now
  const turnId = opts.turnId ?? randomUUID()
  const startedAt = now()
  let firstTokenAt: number | null = null
  let toolCallCount = 0
  let toolErrorCount = 0
  let usage: ExtractedUsageMetrics | null = null

  return {
    noteStreamLine(line: string): void {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) return
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed) as unknown
      } catch {
        return
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
      const obj = parsed as Record<string, unknown>

      // Init handshake alone is not first model token; count first assistant/thinking/tool/result event.
      if (firstTokenAt === null && obj.event !== "init" && obj.subtype !== "init") {
        firstTokenAt = now()
      }

      if (extractBrainStreamToolCall(trimmed)) {
        toolCallCount++
      }
      if (obj.event === "error" || obj.is_error === true || obj.type === "turn.failed") {
        toolErrorCount++
      }

      const extracted = extractUsageMetrics(obj)
      if (extracted) {
        usage = {
          promptTokens: extracted.promptTokens ?? usage?.promptTokens,
          cachedPromptTokens: extracted.cachedPromptTokens ?? usage?.cachedPromptTokens,
          outputTokens: extracted.outputTokens ?? usage?.outputTokens,
        }
      }
    },

    async finish(finishOpts?: { isError?: boolean; telemetrySink?: TelemetrySink }): Promise<TurnMetricRecord> {
      const endedAt = now()
      const totalLatencyMs = Math.max(0, endedAt - startedAt)
      const ttftMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : totalLatencyMs
      if (finishOpts?.isError && toolErrorCount === 0) toolErrorCount = 1

      const record: TurnMetricRecord = {
        turnId,
        sessionId: opts.sessionId,
        routeTier: opts.routeTier,
        modelId: opts.modelId,
        thinkingLevel: sanitizeThinkingLevel(opts.modelId),
        injectedSkillCount: opts.injectedSkillCount,
        promptTokens: usage?.promptTokens ?? opts.estimatedPromptTokens,
        cachedPromptTokens: usage?.cachedPromptTokens ?? 0,
        ttftMs,
        totalLatencyMs,
        toolCallCount,
        toolErrorCount,
      }

      if (finishOpts?.telemetrySink) {
        await logTurnMetrics(finishOpts.telemetrySink, record)
      } else {
        await recordTurnMetrics(record)
      }
      return record
    },
  }
}
