// Environment-gated feature flags for the Companion Orchestrator Harness upgrade (Phases 1-4).
// Full sequential rollout (Steps 1-5) active: all four harness flags default to `true`.
// Set `"false"` on any flag to roll back that phase independently at runtime.

export interface FeatureFlags {
  ENABLE_DYNAMIC_SKILLS: boolean
  ENABLE_CONTEXT_PRUNING: boolean
  ENABLE_LANE_ISOLATION: boolean
  ENABLE_ADAPTIVE_ROUTING: boolean
}

export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: Array<{ path: string[]; message: string }> } }

function parseBoolEnv(raw: unknown, defaultValue = false): boolean {
  if (typeof raw === "boolean") return raw
  if (typeof raw === "string") {
    const norm = raw.trim().toLowerCase()
    if (!norm) return defaultValue
    return norm === "true"
  }
  return defaultValue
}

export function parseFeatureFlags(env: Record<string, unknown> = process.env): FeatureFlags {
  return {
    ENABLE_DYNAMIC_SKILLS: parseBoolEnv(env.ENABLE_DYNAMIC_SKILLS, true),
    ENABLE_CONTEXT_PRUNING: parseBoolEnv(env.ENABLE_CONTEXT_PRUNING, true),
    ENABLE_LANE_ISOLATION: parseBoolEnv(env.ENABLE_LANE_ISOLATION, true),
    ENABLE_ADAPTIVE_ROUTING: parseBoolEnv(env.ENABLE_ADAPTIVE_ROUTING, true),
  }
}

export const FeatureFlagsSchema = {
  parse(input: unknown): FeatureFlags {
    const res = FeatureFlagsSchema.safeParse(input)
    if (!res.success) {
      throw new Error(res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
    }
    return res.data
  },
  safeParse(input: unknown): SafeParseResult<FeatureFlags> {
    if (input === null || input === undefined) {
      return { success: true, data: parseFeatureFlags({}) }
    }
    if (typeof input !== "object" || Array.isArray(input)) {
      return {
        success: false,
        error: { issues: [{ path: [], message: "Expected an environment object" }] },
      }
    }
    return { success: true, data: parseFeatureFlags(input as Record<string, unknown>) }
  },
} as const

export const FLAGS: FeatureFlags = FeatureFlagsSchema.parse(process.env)

/** Read current feature flags from `env` (defaults to live `process.env` so runtime/test overrides take effect). */
export function getFeatureFlags(env: Record<string, string | undefined> = process.env): FeatureFlags {
  return parseFeatureFlags(env)
}
