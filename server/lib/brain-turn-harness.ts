import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { classifyPromptRoute } from "./adaptive-routing"
import {
  type SpawnedPersistentWorkerHandle,
  type StreamToolCall,
  defaultSpawnPersistentWorker,
  extractStreamToolCall,
} from "./brain-stream"
import { isOperationalEventText } from "./context-pruning"
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
import { getSessionSummarySync } from "./session-summaries"
import { defaultSkillsDir, loadSkillManifests } from "./skill-loader"
import {
  STATIC_LOAD_SKILL_INSTRUCTIONS,
  buildBaselineStaticSystemPrompt,
  buildDynamicSystemPrompt,
  loadStaticBrainRules,
  renderFullSkillBlock,
} from "./skill-prompt"
import { DynamicSkillRegistry } from "./skill-retrieval"
import { type LoadSkillExecutionResult, executeLoadSkill } from "./skill-tools"
import { estimateTokens } from "./skill-types"

export {
  type SpawnedPersistentWorkerHandle,
  type StreamToolCall,
  defaultSpawnPersistentWorker,
  extractStreamToolCall as extractBrainStreamToolCall,
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
  routedModelId?: string
  thinkingLevel?: string
  timeoutMs?: number
}

/** Strip mixed operational `[event ...]` lines when a batch carries interactive user `[turn ...]` lines. */
export function sanitizeInteractiveBatchText(rawText: string): string {
  const lines = rawText.split("\n")
  const hasUserTurnLine = lines.some((l) => /^\s*\[turn\s+[^\]]+\]/.test(l))
  if (!hasUserTurnLine) return rawText
  const kept = lines.filter((l) => !isOperationalEventText(l))
  return kept.join("\n").trim() || rawText
}

export function prepareBrainTurn(opts: {
  userText: string
  family: "claude" | "gemini"
  bootPrefixSent: boolean
  legacyAgyBootPrefix: string
  brainDir: string
  sessionId?: string
  summaryDb?: Database
  alreadyInjectedSkillIds?: ReadonlySet<string>
  historySummary?: string[]
  registry?: DynamicSkillRegistry
  env?: Record<string, string | undefined>
}): PreparedBrainTurn {
  const flags = getFeatureFlags(opts.env)
  const registry = opts.registry ?? getSharedSkillRegistry(defaultSkillsDir(opts.env))
  const effectiveUserText = flags.ENABLE_CONTEXT_PRUNING
    ? sanitizeInteractiveBatchText(opts.userText)
    : opts.userText
  const cleanHistory = flags.ENABLE_CONTEXT_PRUNING
    ? (opts.historySummary ?? []).filter((h) => !isOperationalEventText(h))
    : opts.historySummary
  const coldSummary = flags.ENABLE_CONTEXT_PRUNING && !opts.bootPrefixSent && opts.sessionId
    ? getSessionSummarySync(opts.summaryDb, opts.sessionId)
    : null
  const coldBlock = coldSummary?.summaryMarkdown
    ? `### Cold Session Summary\n${coldSummary.summaryMarkdown}\n\n`
    : ""
  const adaptive = flags.ENABLE_ADAPTIVE_ROUTING
    ? classifyPromptRoute(effectiveUserText, { env: opts.env })
    : null

  if (!flags.ENABLE_DYNAMIC_SKILLS) {
    const baseText = `${coldBlock}${effectiveUserText}`
    const promptToSend = opts.family === "gemini" && !opts.bootPrefixSent
      ? `${opts.legacyAgyBootPrefix}${baseText}`
      : baseText
    const staticRules = loadStaticBrainRules(opts.brainDir)
    const baseline = buildBaselineStaticSystemPrompt({
      staticRules,
      skills: registry.getAllSkills(),
    })
    return {
      promptToSend,
      injectedSkillCount: baseline.injectedSkillCount,
      estimatedPromptTokens: baseline.totalPromptTokens + estimateTokens(baseText),
      newlyInjectedSkillIds: [],
      routeTier: adaptive?.tier ?? (flags.ENABLE_CONTEXT_PRUNING ? "context_pruning_p2" : "baseline"),
      ...(adaptive
        ? {
            routedModelId: adaptive.cliModelFlag,
            thinkingLevel: adaptive.thinkingLevel,
            timeoutMs: adaptive.timeoutMs,
          }
        : {}),
    }
  }

  const baseStatic = loadStaticBrainRules(opts.brainDir)
  // `agy` runs with `cwd: BRAIN_DIR` and already loads `AGENTS.md` + `CLAUDE.md` natively into its system prompt;
  // do not duplicate ~5.6K tokens of those files inside Turn 1's stdin user message.
  const staticRules = opts.family === "gemini"
    ? `${opts.legacyAgyBootPrefix}${STATIC_LOAD_SKILL_INSTRUCTIONS}`
    : baseStatic
  const nativeCwdTokens = opts.family === "gemini"
    ? Math.max(0, estimateTokens(baseStatic) - estimateTokens(STATIC_LOAD_SKILL_INSTRUCTIONS))
    : 0
  const built = buildDynamicSystemPrompt({
    staticRules,
    registry,
    currentInput: effectiveUserText,
    historySummary: cleanHistory,
  })
  const fallbackTier = flags.ENABLE_CONTEXT_PRUNING ? "dynamic_p1_pruned_p2" : "dynamic_skills_p1"

  if (!opts.bootPrefixSent) {
    const promptToSend = `${built.fullPrompt}\n\n---\n\n${coldBlock}${effectiveUserText}`
    return {
      promptToSend,
      injectedSkillCount: built.injectedSkillCount,
      estimatedPromptTokens: nativeCwdTokens + built.totalPromptTokens + estimateTokens(`${coldBlock}${effectiveUserText}`),
      newlyInjectedSkillIds: built.selection.activeSkills.map((s) => s.id),
      routeTier: adaptive?.tier ?? fallbackTier,
      ...(adaptive
        ? {
            routedModelId: adaptive.cliModelFlag,
            thinkingLevel: adaptive.thinkingLevel,
            timeoutMs: adaptive.timeoutMs,
          }
        : {}),
    }
  }

  // Subsequent turn on a persistent session: keep the session's static prefix intact for implicit cache hits,
  // and append only newly matched dynamic skills that have not yet been injected in this session.
  const already = opts.alreadyInjectedSkillIds ?? new Set<string>()
  const deltaSkills = built.selection.dynamicSkills.filter((s) => !already.has(s.id))
  const deltaSuffix = deltaSkills.length > 0
    ? `[Active Turn Skills]\n${deltaSkills.map(renderFullSkillBlock).join("\n\n")}\n\n`
    : ""
  const promptToSend = `${deltaSuffix}${effectiveUserText}`

  return {
    promptToSend,
    injectedSkillCount: built.injectedSkillCount,
    estimatedPromptTokens: nativeCwdTokens + built.totalPromptTokens + estimateTokens(effectiveUserText),
    newlyInjectedSkillIds: deltaSkills.map((s) => s.id),
    routeTier: adaptive?.tier ?? fallbackTier,
    ...(adaptive
      ? {
          routedModelId: adaptive.cliModelFlag,
          thinkingLevel: adaptive.thinkingLevel,
          timeoutMs: adaptive.timeoutMs,
        }
      : {}),
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
  thinkingLevel?: string
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

      if (extractStreamToolCall(trimmed)) {
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
        thinkingLevel: sanitizeThinkingLevel(opts.modelId, opts.thinkingLevel),
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
