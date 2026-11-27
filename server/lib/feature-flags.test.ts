import { describe, expect, test } from "bun:test"
import { FeatureFlagsSchema, getFeatureFlags, parseFeatureFlags } from "./feature-flags"

describe("FeatureFlagsSchema & parseFeatureFlags (Step 5 Full Rollout)", () => {
  test("defaults all four harness flags to true when unset on full Step 5 rollout", () => {
    expect(FeatureFlagsSchema.parse({})).toEqual({
      ENABLE_DYNAMIC_SKILLS: true,
      ENABLE_CONTEXT_PRUNING: true,
      ENABLE_LANE_ISOLATION: true,
      ENABLE_ADAPTIVE_ROUTING: true,
    })
    expect(parseFeatureFlags({})).toEqual({
      ENABLE_DYNAMIC_SKILLS: true,
      ENABLE_CONTEXT_PRUNING: true,
      ENABLE_LANE_ISOLATION: true,
      ENABLE_ADAPTIVE_ROUTING: true,
    })
  })

  test("allows explicit case-insensitive 'false' rollback on every flag independently", () => {
    expect(
      getFeatureFlags({
        ENABLE_DYNAMIC_SKILLS: "false",
        ENABLE_CONTEXT_PRUNING: "FALSE",
        ENABLE_LANE_ISOLATION: "0",
        ENABLE_ADAPTIVE_ROUTING: "false",
      }),
    ).toEqual({
      ENABLE_DYNAMIC_SKILLS: false,
      ENABLE_CONTEXT_PRUNING: false,
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
