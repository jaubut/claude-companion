import { describe, expect, test } from "bun:test"
import { FeatureFlagsSchema, getFeatureFlags, parseFeatureFlags } from "./feature-flags"

describe("FeatureFlagsSchema & parseFeatureFlags (Step 2 Rollout)", () => {
  test("defaults ENABLE_DYNAMIC_SKILLS to true (Step 2) and Phases 2-4 strictly to false when unset", () => {
    expect(FeatureFlagsSchema.parse({})).toEqual({
      ENABLE_DYNAMIC_SKILLS: true,
      ENABLE_CONTEXT_PRUNING: false,
      ENABLE_LANE_ISOLATION: false,
      ENABLE_ADAPTIVE_ROUTING: false,
    })
    expect(parseFeatureFlags({})).toEqual({
      ENABLE_DYNAMIC_SKILLS: true,
      ENABLE_CONTEXT_PRUNING: false,
      ENABLE_LANE_ISOLATION: false,
      ENABLE_ADAPTIVE_ROUTING: false,
    })
  })

  test("allows explicit 'false' rollback on ENABLE_DYNAMIC_SKILLS and treats only 'true' as enabled on Phases 2-4", () => {
    expect(
      getFeatureFlags({
        ENABLE_DYNAMIC_SKILLS: "false",
        ENABLE_CONTEXT_PRUNING: "TRUE",
        ENABLE_LANE_ISOLATION: "1",
        ENABLE_ADAPTIVE_ROUTING: "false",
      }),
    ).toEqual({
      ENABLE_DYNAMIC_SKILLS: false,
      ENABLE_CONTEXT_PRUNING: true,
      ENABLE_LANE_ISOLATION: false,
      ENABLE_ADAPTIVE_ROUTING: false,
    })
  })

  test("safeParse rejects non-object inputs cleanly without throwing", () => {
    const bad = FeatureFlagsSchema.safeParse("not-an-env")
    expect(bad.success).toBe(false)
    expect(() => FeatureFlagsSchema.parse("not-an-env")).toThrow(/Expected an environment object/)
  })
})
