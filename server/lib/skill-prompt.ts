import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DynamicSkillRegistry } from "./skill-retrieval"
import { type SkillManifest, type SkillSelectionResult, estimateTokens } from "./skill-types"

/**
 * Static Stage 2 `load_skill` tool instructions included in the immutable system prefix.
 * Contains zero timestamps, session IDs, turn counters, or mutable fields so Gemini 4
 * Implicit Context Caching matches the prefix byte-for-byte across every turn.
 */
export const STATIC_LOAD_SKILL_INSTRUCTIONS = [
  "## Dynamic Skill Directory & `load_skill` Meta-Tool",
  "",
  "- Only core pinned skills and at most 5 turn-relevant dynamic skills are injected in full per turn.",
  "- Un-injected skills are listed in the compact Available Skill Directory at the bottom of this prompt.",
  "- Whenever a user turn requires instructions from an un-injected skill in that directory, fetch its full `SKILL.md` on demand via the `load_skill` tool (`{ \"skillId\": \"<id>\" }`, or CLI `./bin/load-skill <id>` in headless Brain mode) before acting.",
  "- Never guess a skill's internal flags or workflow without loading it first.",
].join("\n")

const cachedBrainRulesByDir = new Map<string, string>()

function normalizeStaticText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
}

/**
 * Load and memoize the static Brain behavioral rules (`AGENTS.md` + `CLAUDE.md` + `STATIC_LOAD_SKILL_INSTRUCTIONS`)
 * from `brainDir`. Guaranteed byte-for-byte identical across turns (~5,600 tokens, exceeding Gemini 4's
 * >= 4,096 token implicit context cache minimum).
 */
export function loadStaticBrainRules(brainDir: string): string {
  const hit = cachedBrainRulesByDir.get(brainDir)
  if (hit !== undefined) return hit

  const parts: string[] = []
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(brainDir, file)
    if (!existsSync(path)) continue
    try {
      const content = normalizeStaticText(readFileSync(path, "utf8"))
      if (content) parts.push(content)
    } catch { /* ignore unreadable file */ }
  }
  parts.push(STATIC_LOAD_SKILL_INSTRUCTIONS)
  const combined = parts.join("\n\n---\n\n")
  cachedBrainRulesByDir.set(brainDir, combined)
  return combined
}

export function renderFullSkillBlock(skill: SkillManifest): string {
  return `<skill id="${skill.id}" name="${skill.name}" category="${skill.category}">\n${skill.content}\n</skill>`
}

export interface BuiltSystemPrompt {
  fullPrompt: string
  /** Byte-for-byte invariant prefix: Static Behavioral Rules + Core Pinned Skills (`alwaysInclude = true`). */
  staticPrefix: string
  /** Volatile suffix placed strictly at the bottom: Compact `load_skill` Directory + Dynamic Selected Skills (max 5). */
  dynamicSuffix: string
  staticPrefixTokens: number
  totalPromptTokens: number
  injectedSkillCount: number
  pinnedSkillCount: number
  dynamicSkillCount: number
  selection: SkillSelectionResult
}

/**
 * Construct the Gemini 4 Implicit-Cache-Aligned System Prompt:
 *   1. Static Behavioral Rules (Prefix)
 *   2. Core Pinned Skills (`alwaysInclude = true`)
 *   3. Meta-Tool `load_skill` Available Directory
 *   4. Dynamic Turn-Selected Skills (Suffix, max 5)
 *
 * Explicit context caching APIs are never used; prefix invariance alone drives >= 95% discount implicit cache hits.
 */
export function buildDynamicSystemPrompt(opts: {
  staticRules: string
  registry: DynamicSkillRegistry
  currentInput: string
  historySummary?: string[]
}): BuiltSystemPrompt {
  const cleanStaticRules = normalizeStaticText(opts.staticRules)
  const selection = opts.registry.selectSkillsForTurn(opts.currentInput, opts.historySummary ?? [])

  const prefixBlocks: string[] = [cleanStaticRules]
  if (selection.pinnedSkills.length > 0) {
    const pinnedBody = selection.pinnedSkills.map(renderFullSkillBlock).join("\n\n")
    prefixBlocks.push(`## Core Pinned Skills\n\n${pinnedBody}`)
  }
  const staticPrefix = prefixBlocks.join("\n\n")

  const suffixBlocks: string[] = []
  if (selection.availableDirectory.length > 0) {
    const dirLines = selection.availableDirectory.map(
      (entry) => `- \`${entry.id}\` (${entry.name}): ${entry.description}`,
    )
    suffixBlocks.push(
      `## Available Skill Directory (load via \`load_skill\`)\n\n${dirLines.join("\n")}`,
    )
  }

  if (selection.dynamicSkills.length > 0) {
    const dynamicBody = selection.dynamicSkills.map(renderFullSkillBlock).join("\n\n")
    suffixBlocks.push(`## Active Turn Skills\n\n${dynamicBody}`)
  }

  const dynamicSuffix = suffixBlocks.join("\n\n")
  const fullPrompt = dynamicSuffix ? `${staticPrefix}\n\n${dynamicSuffix}` : staticPrefix

  return {
    fullPrompt,
    staticPrefix,
    dynamicSuffix,
    staticPrefixTokens: estimateTokens(staticPrefix),
    totalPromptTokens: estimateTokens(fullPrompt),
    injectedSkillCount: selection.activeSkills.length,
    pinnedSkillCount: selection.pinnedSkills.length,
    dynamicSkillCount: selection.dynamicSkills.length,
    selection,
  }
}

/**
 * Construct the legacy unscoped baseline prompt (all skills statically injected in full)
 * used when `ENABLE_DYNAMIC_SKILLS=false` or when benchmarking token savings.
 */
export function buildBaselineStaticSystemPrompt(opts: {
  staticRules: string
  skills: readonly SkillManifest[]
}): { fullPrompt: string; totalPromptTokens: number; injectedSkillCount: number } {
  const cleanStaticRules = normalizeStaticText(opts.staticRules)
  const sorted = [...opts.skills].sort((a, b) => a.id.localeCompare(b.id))
  const skillBlocks = sorted.map(renderFullSkillBlock).join("\n\n")
  const fullPrompt = skillBlocks
    ? `${cleanStaticRules}\n\n## All Registered Skills\n\n${skillBlocks}`
    : cleanStaticRules
  return {
    fullPrompt,
    totalPromptTokens: estimateTokens(fullPrompt),
    injectedSkillCount: sorted.length,
  }
}
