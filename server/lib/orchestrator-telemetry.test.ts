import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  preserveModelTurnThoughtSignatures,
  sanitizeGemini4GenerationConfig,
  startBrainTurnMetrics,
} from "./brain-turn-harness"
import { triageOpsEvents } from "./ops-triage"
import {
  type TurnMetricRecord,
  extractUsageMetrics,
  logTurnMetrics,
  readTurnMetrics,
  sanitizeThinkingLevel,
} from "./orchestrator-telemetry"

describe("Phase 0: orchestrator_turn_metrics schema & logger", () => {
  test("PostgreSQL migration 003_orchestrator_telemetry.sql matches spec and aligns thinking_level column", () => {
    const migrationPath = join(import.meta.dir, "..", "..", "db", "migrations", "003_orchestrator_telemetry.sql")
    const sql = readFileSync(migrationPath, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS orchestrator_turn_metrics")
    expect(sql).toContain("turn_id VARCHAR(64) PRIMARY KEY")
    expect(sql).toContain("session_id VARCHAR(128) NOT NULL")
    expect(sql).toContain("route_tier VARCHAR(32) NOT NULL")
    expect(sql).toContain("model_id VARCHAR(64) NOT NULL")
    expect(sql).toContain("thinking_level VARCHAR(16) NOT NULL")
    expect(sql).toContain("injected_skill_count INT NOT NULL")
    expect(sql).toContain("prompt_tokens INT NOT NULL")
    expect(sql).toContain("cached_prompt_tokens INT NOT NULL DEFAULT 0")
    expect(sql).toContain("ttft_ms INT NOT NULL")
    expect(sql).toContain("total_latency_ms INT NOT NULL")
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_metrics_session ON orchestrator_turn_metrics(session_id)")
    expect(sql).not.toContain("thinking_budget")
  })

  test("logTurnMetrics writes parameterized rows to both PostgreSQL tagged-template sql and bun:sqlite", async () => {
    const sample: TurnMetricRecord = {
      turnId: "turn-001",
      sessionId: "sess-abc",
      routeTier: "dynamic_skills_p1",
      modelId: "gemini-4-argon-low",
      thinkingLevel: "low",
      injectedSkillCount: 4,
      promptTokens: 8200,
      cachedPromptTokens: 6100,
      ttftMs: 420,
      totalLatencyMs: 1180,
      toolCallCount: 1,
      toolErrorCount: 0,
    }

    // 1. PostgreSQL tagged-template SQL sink
    let capturedQuery = ""
    let capturedValues: Array<string | number> = []
    const pgMock = async (strings: TemplateStringsArray, ...values: readonly (string | number)[]) => {
      capturedQuery = strings.join("?")
      capturedValues = [...values]
      return []
    }
    await logTurnMetrics(pgMock, sample)
    expect(capturedQuery).toContain("INSERT INTO orchestrator_turn_metrics")
    expect(capturedQuery).toContain("thinking_level")
    expect(capturedQuery).not.toContain("thinking_budget")
    expect(capturedValues).toEqual([
      "turn-001",
      "sess-abc",
      "dynamic_skills_p1",
      "gemini-4-argon-low",
      "low",
      4,
      8200,
      6100,
      420,
      1180,
      1,
      0,
    ])

    // 2. Local bun:sqlite sink
    const memDb = new Database(":memory:")
    await logTurnMetrics(memDb, sample)
    const rows = readTurnMetrics(memDb, "sess-abc")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject(sample)
    memDb.close()
  })

  test("extractUsageMetrics reads cached_prompt_tokens from Interactions API and generateContent usageMetadata", () => {
    // Gemini Interactions API shape
    expect(
      extractUsageMetrics({
        event: "result",
        usage: {
          total_input_tokens: 12000,
          total_cached_tokens: 9000,
          total_output_tokens: 450,
        },
      }),
    ).toEqual({
      promptTokens: 12000,
      cachedPromptTokens: 9000,
      outputTokens: 450,
    })

    // Gemini generateContent shape
    expect(
      extractUsageMetrics({
        usageMetadata: {
          promptTokenCount: 10500,
          cachedContentTokenCount: 8400,
          candidatesTokenCount: 320,
        },
      }),
    ).toEqual({
      promptTokens: 10500,
      cachedPromptTokens: 8400,
      outputTokens: 320,
    })
  })

  test("startBrainTurnMetrics measures TTFT, total latency, tool calls, and implicit cache hits", async () => {
    const memDb = new Database(":memory:")
    let clock = 1_000
    const tracker = startBrainTurnMetrics({
      turnId: "turn-ttft-1",
      sessionId: "sess-ttft",
      routeTier: "dynamic_skills_p1",
      modelId: "gemini-4-carbon-medium",
      injectedSkillCount: 3,
      estimatedPromptTokens: 9_500,
      now: () => clock,
    })

    // Init handshake at +50ms must NOT count as first model token
    clock = 1_050
    tracker.noteStreamLine(JSON.stringify({ event: "init", conversation_id: "c1" }))

    // First active tool call at +380ms sets TTFT = 380ms
    clock = 1_380
    tracker.noteStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "tool", state: "ACTIVE", tool_name: "load_skill", tool_info: { parameters: { skillId: "cso" } } },
      }),
    )

    // Result with Gemini usageMetadata at +920ms
    clock = 1_920
    tracker.noteStreamLine(
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "done",
          usageMetadata: { promptTokenCount: 9_800, cachedContentTokenCount: 7_200, candidatesTokenCount: 150 },
        },
      }),
    )

    const saved = await tracker.finish({ telemetrySink: memDb })
    expect(saved).toEqual({
      turnId: "turn-ttft-1",
      sessionId: "sess-ttft",
      routeTier: "dynamic_skills_p1",
      modelId: "gemini-4-carbon-medium",
      thinkingLevel: "medium",
      injectedSkillCount: 3,
      promptTokens: 9_800,
      cachedPromptTokens: 7_200,
      ttftMs: 380,
      totalLatencyMs: 920,
      toolCallCount: 1,
      toolErrorCount: 0,
    })
    memDb.close()
  })
})

describe("Hard Constraints: Gemini 4 parameter hygiene & thoughtSignature preservation", () => {
  test("never passes temperature, top_p, top_k, explicit cache, or thinking_level='minimal' to Gemini 4", () => {
    expect(sanitizeThinkingLevel("gemini-4-argon-low", "minimal")).toBe("low")
    expect(sanitizeThinkingLevel("gemini-4-carbon", "minimal")).toBe("low")
    expect(sanitizeThinkingLevel("gemini-4-hydrogen-xhigh")).toBe("xhigh")

    const sanitized = sanitizeGemini4GenerationConfig("gemini-4-carbon-high", {
      temperature: 0.2,
      top_p: 0.9,
      topP: 0.9,
      top_k: 40,
      topK: 40,
      thinking_level: "minimal",
      thinkingConfig: { thinkingLevel: "minimal" },
      responseMimeType: "application/json",
    })
    expect(sanitized).toEqual({
      thinking_level: "low",
      thinkingConfig: { thinkingLevel: "low" },
      responseMimeType: "application/json",
    })
    expect("temperature" in sanitized).toBe(false)
    expect("top_p" in sanitized).toBe(false)
    expect("top_k" in sanitized).toBe(false)
  })

  test("ops-triage HTTP fallback omits temperature and low maxOutputTokens when model is Gemini 4", async () => {
    let sentBody: Record<string, unknown> | null = null
    const mockFetch = (async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      return Response.json({
        candidates: [{ content: { parts: [{ text: '{"action":"ignore","reason":"ok"}' }] } }],
      })
    }) as unknown as typeof fetch

    await triageOpsEvents([{ id: "e1", text: "PR ready [abc]" }], {
      mode: "live",
      provider: "http",
      model: "gemini-4-hydrogen-low",
      geminiKey: "test-key",
      openrouterKey: null,
      fetch: mockFetch,
    })
    const genCfg = (sentBody as { generationConfig?: Record<string, unknown> } | null)?.generationConfig ?? {}
    expect(genCfg).toEqual({ responseMimeType: "application/json" })
    expect("temperature" in genCfg).toBe(false)
    expect("maxOutputTokens" in genCfg).toBe(false)
  })

  test("preserves thoughtSignature fields byte-for-byte verbatim on model turns without copying across parallel calls", () => {
    const opaqueSig = "Et4BCtYBAXLI2ny/verbatim+opaque==signature//001122"
    const modelTurn = {
      role: "model" as const,
      parts: [
        {
          thought: true,
          text: "Checking both git status and open PRs in parallel.",
          thoughtSignature: opaqueSig,
        },
        {
          functionCall: { name: "git_status", args: {} },
          thoughtSignature: opaqueSig,
        },
        {
          // Second parallel function call intentionally has NO thoughtSignature; must not be fabricated or copied onto it
          functionCall: { name: "gh_pr_list", args: { limit: 10 } },
        },
      ],
    }

    const preserved = preserveModelTurnThoughtSignatures(modelTurn)
    expect(preserved.parts?.[0]?.thoughtSignature).toBe(opaqueSig)
    expect(preserved.parts?.[1]?.thoughtSignature).toBe(opaqueSig)
    expect("thoughtSignature" in (preserved.parts?.[2] ?? {})).toBe(false)
  })
})
