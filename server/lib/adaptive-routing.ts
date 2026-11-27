import { sanitizeThinkingLevel } from "./orchestrator-telemetry"

export const GEMINI4_UNIFIED_CONTEXT_WINDOW = 1_048_576
export const GEMINI4_DEFAULT_SYNC_OUTPUT_LIMIT = 65_536
export const TIER1_TIMEOUT_MS = 2 * 60 * 1000
export const TIER2_TIMEOUT_MS = 5 * 60 * 1000
export const TIER3_MIN_TIMEOUT_MS = 15 * 60 * 1000

export type RouteTier = "tier1_fast" | "tier2_standard" | "tier3_deep"
export type Gemini4ThinkingLevel = "low" | "medium" | "high" | "xhigh"

export interface AdaptiveRouteDecision {
  tier: RouteTier
  modelId: string
  cliModelFlag: string
  thinkingLevel: Gemini4ThinkingLevel
  timeoutMs: number
  reasons: string[]
}

const TURN_HEADER_RE = /^\s*\[turn\s+[^\]]+\]\s*/gm
const FILE_PATH_RE = /(?:^|[\s`"'(])(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8}\b/gi

const TIER3_XHIGH_RE =
  /\b(?:cross-repo|multi-repo|security\s+audit|threat\s+model|race\s+condition|deadlock|formal\s+proof|distributed\s+consensus|system-wide\s+architecture|full-repo\s+migration|zero-downtime\s+migration)\b/i

const TIER3_DEEP_RE =
  /\b(?:multi-file\s+refactor|refactor\s+(?:the\s+)?(?:entire|whole|all)|across\s+(?:multiple|all)\s+(?:files|modules|packages|repos|services)|architectural\s+(?:refactor|redesign|overhaul)|migrate\s+(?:all|every|from)|root[- ]cause\s+analysis|deep[- ]dive|end-to-end\s+(?:refactor|redesign|migration)|phase\s+[1-4]\b.*\bphase\s+[2-5])\b/i

const TIER2_ANALYTICAL_RE =
  /\b(?:review\s+pr|pr\s*#\d+|pull\s+request|merge\s+conflict|compare|trade-?off|investigate|diagnose|debug|why\s+(?:is|did|does)|failing\s+(?:test|ci|build)|schema\s+change|migration)\b/i

const TIER2_ACTION_RE =
  /\b(?:edit|modify|update|patch|fix|implement|write\s+a\s+test|unit\s+test|add\s+a\s+(?:route|endpoint|flag|column|function|helper)|dispatch|propose|send\s+(?:an?\s+)?email|draft\s+(?:an?\s+)?email|deploy\s+(?:now|to|the|staging|prod|production)|rollback|cancel\s+task)\b/i

function stripTurnEnvelope(raw: string): string {
  return raw
    .replace(/### Background System Updates[\s\S]*$/i, "")
    .replace(TURN_HEADER_RE, "")
    .trim()
}

function countDistinctPaths(text: string): number {
  const matches = text.match(FILE_PATH_RE)
  if (!matches) return 0
  const set = new Set(matches.map((m) => m.trim().replace(/^[`"'(]+/, "").toLowerCase()))
  return set.size
}

function normalizeGemini4BaseModel(raw: string | undefined, fallback: string): string {
  const cleaned = raw?.trim().toLowerCase().replace(/-(?:xhigh|high|medium|low)$/, "")
  if (cleaned && /^gemini-4-(?:hydrogen|neon|carbon|argon)$/.test(cleaned)) {
    return cleaned
  }
  return fallback
}

function enforceNonMinimalLevel(level: string): Gemini4ThinkingLevel {
  const sanitized = sanitizeThinkingLevel("gemini-4-hydrogen", level)
  if (sanitized === "xhigh" || sanitized === "high" || sanitized === "medium" || sanitized === "low") {
    return sanitized
  }
  return "low"
}

/**
 * Phase 4 Deterministic Fast Classifier.
 * Routes raw user prompts without invoking a low-capability pre-model (preserving exact user intent
 * with sub-millisecond overhead) across Tier 1 (Fast), Tier 2 (Standard), and Tier 3 (Deep).
 */
export function classifyPromptRoute(
  rawPrompt: string,
  opts: { env?: Record<string, string | undefined> } = {},
): AdaptiveRouteDecision {
  const env = opts.env ?? process.env
  const clean = stripTurnEnvelope(rawPrompt)
  const pathCount = countDistinctPaths(clean)
  const codeFenceCount = (clean.match(/```/g) ?? []).length >> 1
  const charLen = clean.length
  const reasons: string[] = []

  // Tier 3: Deep (multi-file refactors, cross-repo architecture, security/concurrency proofs)
  const hasXhighSignal = TIER3_XHIGH_RE.test(clean)
  const hasDeepSignal = TIER3_DEEP_RE.test(clean)
  if (hasXhighSignal || hasDeepSignal || pathCount >= 3 || (codeFenceCount >= 2 && charLen > 1200)) {
    if (hasXhighSignal) reasons.push("deep_architectural_or_concurrency_signal")
    if (hasDeepSignal) reasons.push("multi_file_or_system_refactor_signal")
    if (pathCount >= 3) reasons.push(`mentions_${pathCount}_files`)
    if (codeFenceCount >= 2 && charLen > 1200) reasons.push("large_multi_block_specification")

    const useCarbonXhigh = hasXhighSignal || pathCount >= 5 || charLen > 2400
    const defaultBase = useCarbonXhigh ? "gemini-4-carbon" : "gemini-4-neon"
    const modelId = normalizeGemini4BaseModel(env.COMPANION_TIER3_MODEL, defaultBase)
    const thinkingLevel = enforceNonMinimalLevel(useCarbonXhigh ? "xhigh" : "high")
    return {
      tier: "tier3_deep",
      modelId,
      cliModelFlag: `${modelId}-${thinkingLevel}`,
      thinkingLevel,
      timeoutMs: TIER3_MIN_TIMEOUT_MS,
      reasons,
    }
  }

  // Tier 2: Standard (single-file edits, PR triage/review, worker dispatch, targeted debugging)
  const hasAnalytical = TIER2_ANALYTICAL_RE.test(clean)
  const hasAction = TIER2_ACTION_RE.test(clean)
  if (hasAnalytical || hasAction || pathCount >= 1 || codeFenceCount >= 1 || charLen > 360) {
    if (hasAnalytical) reasons.push("analytical_or_pr_review_signal")
    if (hasAction) reasons.push("single_task_or_edit_action_signal")
    if (pathCount >= 1) reasons.push(`mentions_${pathCount}_file`)
    if (codeFenceCount >= 1) reasons.push("contains_code_block")
    if (charLen > 360) reasons.push("detailed_multi_sentence_prompt")

    const defaultBase = hasAnalytical ? "gemini-4-neon" : "gemini-4-hydrogen"
    const modelId = normalizeGemini4BaseModel(env.COMPANION_TIER2_MODEL, defaultBase)
    const thinkingLevel = enforceNonMinimalLevel("medium")
    return {
      tier: "tier2_standard",
      modelId,
      cliModelFlag: `${modelId}-${thinkingLevel}`,
      thinkingLevel,
      timeoutMs: TIER2_TIMEOUT_MS,
      reasons,
    }
  }

  // Tier 1: Fast (simple Q&A, status lookups, quick acknowledgments)
  reasons.push("simple_qa_or_lookup")
  const modelId = normalizeGemini4BaseModel(env.COMPANION_TIER1_MODEL, "gemini-4-hydrogen")
  const thinkingLevel = enforceNonMinimalLevel("low")
  return {
    tier: "tier1_fast",
    modelId,
    cliModelFlag: `${modelId}-${thinkingLevel}`,
    thinkingLevel,
    timeoutMs: TIER1_TIMEOUT_MS,
    reasons,
  }
}

/** Guarantee Tier 3 HTTP/CLI timeouts are always >= 15 minutes (`900,000` ms). */
export function resolveTierTimeoutMs(tier: RouteTier, requestedMs?: number): number {
  const base =
    tier === "tier3_deep"
      ? TIER3_MIN_TIMEOUT_MS
      : tier === "tier2_standard"
        ? TIER2_TIMEOUT_MS
        : TIER1_TIMEOUT_MS
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return base
  }
  return tier === "tier3_deep" ? Math.max(TIER3_MIN_TIMEOUT_MS, Math.round(requestedMs)) : Math.round(requestedMs)
}
