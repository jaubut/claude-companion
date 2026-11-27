import type { SafeParseResult } from "./feature-flags"
import type { DynamicSkillRegistry } from "./skill-retrieval"

export interface LoadSkillInput {
  skillId: string
}

const SKILL_ID_INPUT_RE = /^\/?[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

export const LoadSkillInputSchema = {
  parse(input: unknown): LoadSkillInput {
    const res = LoadSkillInputSchema.safeParse(input)
    if (!res.success) {
      throw new Error(res.error.issues.map((i) => `Field '${i.path.join(".")}': ${i.message}`).join("; "))
    }
    return res.data
  },
  safeParse(input: unknown): SafeParseResult<LoadSkillInput> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {
        success: false,
        error: { issues: [{ path: ["skillId"], message: "Expected an object with skillId" }] },
      }
    }
    const raw = (input as Record<string, unknown>).skillId
    if (typeof raw !== "string" || !raw.trim()) {
      return {
        success: false,
        error: { issues: [{ path: ["skillId"], message: "skillId must be a non-empty string" }] },
      }
    }
    const trimmed = raw.trim()
    if (!SKILL_ID_INPUT_RE.test(trimmed)) {
      return {
        success: false,
        error: { issues: [{ path: ["skillId"], message: "skillId contains invalid characters" }] },
      }
    }
    return {
      success: true,
      data: { skillId: trimmed.replace(/^\/+/, "") },
    }
  },
} as const

export const loadSkillToolDefinition = {
  name: "load_skill",
  description: "Dynamically load the full content and instructions for an un-injected skill from the skill directory.",
  parameters: LoadSkillInputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      skillId: {
        type: "string",
        description: "The exact ID of the skill to fetch from the available directory",
      },
    },
    required: ["skillId"],
    additionalProperties: false,
  },
} as const

export type LoadSkillExecutionResult =
  | {
      ok: true
      success: true
      skillId: string
      name: string
      category: string
      estimatedTokens: number
      content: string
      output: string
    }
  | {
      ok: false
      success: false
      error: "validation_error" | "skill_not_found"
      output: string
    }

export function executeLoadSkill(
  registry: DynamicSkillRegistry,
  rawArgs: unknown,
): LoadSkillExecutionResult {
  const parsed = LoadSkillInputSchema.safeParse(rawArgs)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `Field '${i.path.join(".")}': ${i.message}`)
      .join("; ")
    return {
      ok: false,
      success: false,
      error: "validation_error",
      output: `[TOOL_SCHEMA_VALIDATION_ERROR]: Invalid parameters provided. Details: ${details}. Please correct the parameters and retry.`,
    }
  }

  const { skillId } = parsed.data
  const found = registry.getSkill(skillId)
  if (!found) {
    const lower = skillId.toLowerCase()
    const suggestions = registry
      .getAllSkills()
      .filter((s) => s.id.toLowerCase().includes(lower) || lower.includes(s.id.toLowerCase()))
      .slice(0, 5)
      .map((s) => s.id)
    const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""
    return {
      ok: false,
      success: false,
      error: "skill_not_found",
      output: `[SKILL_NOT_FOUND]: Unknown skillId '${skillId}'.${hint} Choose an exact id from the available skill directory.`,
    }
  }

  return {
    ok: true,
    success: true,
    skillId: found.id,
    name: found.name,
    category: found.category,
    estimatedTokens: found.estimatedTokens,
    content: found.content,
    output: `# Skill: ${found.name} (${found.id})\n\n${found.content}`,
  }
}
