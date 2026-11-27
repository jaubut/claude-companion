import type { SafeParseResult } from "./feature-flags"

export const SKILL_CATEGORIES = ["git", "db", "ops", "code", "architecture", "general"] as const
export type SkillCategory = (typeof SKILL_CATEGORIES)[number]

const CATEGORY_SET: ReadonlySet<string> = new Set(SKILL_CATEGORIES)

export interface SkillManifest {
  id: string
  name: string
  description: string
  triggers: string[]
  category: SkillCategory
  alwaysInclude: boolean
  estimatedTokens: number
  content: string
  manualOnly?: boolean
}

export interface SkillDirectoryEntry {
  id: string
  name: string
  description: string
}

export interface SkillSelectionResult {
  activeSkills: SkillManifest[]
  pinnedSkills: SkillManifest[]
  dynamicSkills: SkillManifest[]
  availableDirectory: SkillDirectoryEntry[]
  totalInjectedTokens: number
}

/** Deterministic UTF-8 token estimator (~4 bytes per token). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4))
}

export function isSkillCategory(v: unknown): v is SkillCategory {
  return typeof v === "string" && CATEGORY_SET.has(v)
}

export const SkillManifestSchema = {
  parse(input: unknown): SkillManifest {
    const res = SkillManifestSchema.safeParse(input)
    if (!res.success) {
      throw new Error(res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
    }
    return res.data
  },
  safeParse(input: unknown): SafeParseResult<SkillManifest> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { success: false, error: { issues: [{ path: [], message: "Expected an object" }] } }
    }
    const raw = input as Record<string, unknown>
    const issues: Array<{ path: string[]; message: string }> = []

    const id = typeof raw.id === "string" ? raw.id.trim() : ""
    if (!id) issues.push({ path: ["id"], message: "id must be a non-empty string" })

    const name = typeof raw.name === "string" ? raw.name.trim() : ""
    if (!name) issues.push({ path: ["name"], message: "name must be a non-empty string" })

    const description = typeof raw.description === "string" ? raw.description.trim() : ""
    if (typeof raw.description !== "string") {
      issues.push({ path: ["description"], message: "description must be a string" })
    }

    let triggers: string[] = []
    if (!Array.isArray(raw.triggers) || raw.triggers.some((t) => typeof t !== "string")) {
      issues.push({ path: ["triggers"], message: "triggers must be an array of strings" })
    } else {
      triggers = raw.triggers.map((t) => String(t).trim()).filter(Boolean)
    }

    const category = raw.category
    if (!isSkillCategory(category)) {
      issues.push({ path: ["category"], message: `category must be one of: ${SKILL_CATEGORIES.join(", ")}` })
    }

    if (raw.alwaysInclude !== undefined && typeof raw.alwaysInclude !== "boolean") {
      issues.push({ path: ["alwaysInclude"], message: "alwaysInclude must be a boolean when provided" })
    }

    if (typeof raw.estimatedTokens !== "number" || !Number.isFinite(raw.estimatedTokens) || raw.estimatedTokens < 0) {
      issues.push({ path: ["estimatedTokens"], message: "estimatedTokens must be a non-negative number" })
    }

    if (typeof raw.content !== "string") {
      issues.push({ path: ["content"], message: "content must be a string" })
    }

    if (issues.length > 0) return { success: false, error: { issues } }

    return {
      success: true,
      data: {
        id,
        name,
        description,
        triggers,
        category: category as SkillCategory,
        alwaysInclude: raw.alwaysInclude === true,
        estimatedTokens: Math.round(raw.estimatedTokens as number),
        content: raw.content as string,
        ...(typeof raw.manualOnly === "boolean" ? { manualOnly: raw.manualOnly } : {}),
      },
    }
  },
} as const
