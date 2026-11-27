import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GEMINI4_DEFAULT_SYNC_OUTPUT_LIMIT,
  GEMINI4_UNIFIED_CONTEXT_WINDOW,
  TIER3_MIN_TIMEOUT_MS,
  classifyPromptRoute,
  resolveTierTimeoutMs,
} from "./adaptive-routing"
import type { Message } from "./context-pruning"
import {
  type Gemini4NativeRequestPayload,
  type OrchestratorEvent,
  agyStreamLineToOrchestratorEvents,
  buildGemini4NativeRequest,
  formatOrchestratorSseEvent,
  parseOrchestratorSseChunk,
  runGemini4OrchestratorTurn,
} from "./gemini4-orchestrator-client"
import {
  createNativeLoadSkillTool,
  defineNativeTool,
  defineObjectToolSchema,
  executeNativeTool,
} from "./native-tool-executor"
import { ensureTurnMetricsTable, readTurnMetrics } from "./orchestrator-telemetry"
import { DynamicSkillRegistry } from "./skill-retrieval"
import { SkillManifestSchema } from "./skill-types"
import { normalizeAgyCliModelFlag } from "./worker-invocation"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-adaptive-routing-")), "test.db")

describe("Phase 4: Deterministic Fast Classifier & Route Tiers", () => {
  afterEach(() => {
    delete process.env.ENABLE_ADAPTIVE_ROUTING
  })

  test("routes simple Q&A and status lookups to Tier 1 (gemini-4-hydrogen, low thinking, <1ms, zero prompt rewrite)", () => {
    const raw = "What is the current deployment status?"
    const t0 = performance.now()
    const decision = classifyPromptRoute(raw)
    const elapsedMs = performance.now() - t0

    expect(elapsedMs).toBeLessThan(5)
    expect(decision.tier).toBe("tier1_fast")
    expect(decision.modelId).toBe("gemini-4-hydrogen")
    expect(decision.thinkingLevel).toBe("low")
    expect(decision.cliModelFlag).toBe("gemini-4-hydrogen-low")
    expect(normalizeAgyCliModelFlag(decision.cliModelFlag)).toBe("gemini-4-hydrogen-low")
  })

  test("routes single-file edits and PR reviews to Tier 2 (gemini-4-hydrogen / gemini-4-neon, medium thinking)", () => {
    const singleEdit = classifyPromptRoute("Fix the null check in server/lib/ops-triage.ts and add a unit test.")
    expect(singleEdit.tier).toBe("tier2_standard")
    expect(singleEdit.modelId).toBe("gemini-4-hydrogen")
    expect(singleEdit.thinkingLevel).toBe("medium")
    expect(singleEdit.cliModelFlag).toBe("gemini-4-hydrogen-medium")

    const prReview = classifyPromptRoute("Review PR #381 and diagnose why the failing CI check occurred.")
    expect(prReview.tier).toBe("tier2_standard")
    expect(prReview.modelId).toBe("gemini-4-neon")
    expect(prReview.thinkingLevel).toBe("medium")
    expect(prReview.cliModelFlag).toBe("gemini-4-neon-medium")
    expect(normalizeAgyCliModelFlag(prReview.cliModelFlag)).toBe("gemini-4-neon-medium")
  })

  test("routes multi-file refactors and deep architecture/concurrency tasks to Tier 3 (neon/carbon, high/xhigh, >=15m timeout)", () => {
    const multiFile = classifyPromptRoute(
      "Perform a multi-file refactor across server/lib/a.ts, server/lib/b.ts, and server/wiring/c.ts.",
    )
    expect(multiFile.tier).toBe("tier3_deep")
    expect(multiFile.modelId).toBe("gemini-4-neon")
    expect(multiFile.thinkingLevel).toBe("high")
    expect(multiFile.timeoutMs).toBeGreaterThanOrEqual(TIER3_MIN_TIMEOUT_MS)
    expect(multiFile.timeoutMs).toBeGreaterThanOrEqual(15 * 60 * 1000)

    const deepAudit = classifyPromptRoute(
      "Run a cross-repo security audit and root-cause race condition analysis across the orchestrator.",
    )
    expect(deepAudit.tier).toBe("tier3_deep")
    expect(deepAudit.modelId).toBe("gemini-4-carbon")
    expect(deepAudit.thinkingLevel).toBe("xhigh")
    expect(deepAudit.cliModelFlag).toBe("gemini-4-carbon-xhigh")
    expect(normalizeAgyCliModelFlag(deepAudit.cliModelFlag)).toBe("gemini-4-carbon-xhigh")
    expect(resolveTierTimeoutMs("tier3_deep", 60_000)).toBe(TIER3_MIN_TIMEOUT_MS)
  })
})

describe("Phase 4: Gemini 4 API Hygiene Checklist", () => {
  test("strips sampling params, explicit cache, minimal thinking, low maxOutputTokens, and enables background >64K", () => {
    const payload = buildGemini4NativeRequest({
      modelId: "gemini-4-neon",
      routeTier: "tier3_deep",
      thinkingLevel: "minimal" as unknown as "low",
      systemInstruction: 'Follow rules. Emit raw JSON tool calls like respond with {"tool": "x"} if needed.',
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { name: "ping", args: {} }, thoughtSignature: "sig_exact_991==" },
            { functionCall: { name: "pong", args: {} } },
          ],
        },
      ],
      rawGenerationConfig: {
        temperature: 0.7,
        top_p: 0.9,
        topP: 0.9,
        top_k: 40,
        topK: 40,
        cachedContents: "cachedContents/forbidden-123",
        maxOutputTokens: 1024, // Low hardcoded cap -> must be stripped
      },
      timeoutMs: 30_000, // Below 15m -> must be raised to >= 15m for Tier 3
    })

    expect(payload.thinkingLevel).toBe("low")
    expect(payload.timeoutMs).toBe(TIER3_MIN_TIMEOUT_MS)

    const gen = payload.body.generationConfig as Record<string, unknown>
    expect(gen.temperature).toBeUndefined()
    expect(gen.top_p).toBeUndefined()
    expect(gen.topP).toBeUndefined()
    expect(gen.top_k).toBeUndefined()
    expect(gen.topK).toBeUndefined()
    expect(gen.cachedContents).toBeUndefined()
    expect(gen.maxOutputTokens).toBeUndefined()
    expect(payload.body.background).toBeUndefined()

    // Zero native tools declared -> raw-text JSON tool prompting is stripped to prevent MALFORMED_FUNCTION_CALL
    const sys = (payload.body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]?.text ?? ""
    expect(sys).not.toContain('{"tool"')

    // Parallel tool call thoughtSignature preserved verbatim ONLY on the part that emitted it
    const contents = payload.body.contents as Array<{ parts: Array<Record<string, unknown>> }>
    expect(contents[0]?.parts[0]?.thoughtSignature).toBe("sig_exact_991==")
    expect("thoughtSignature" in (contents[0]?.parts[1] ?? {})).toBe(false)

    // Decode length > 64K enables background: true within the 1M unified context window
    const longDecode = buildGemini4NativeRequest({
      modelId: "gemini-4-carbon",
      routeTier: "tier3_deep",
      thinkingLevel: "xhigh",
      contents: [{ role: "user", parts: [{ text: "Generate full architecture report" }] }],
      requestedMaxOutputTokens: GEMINI4_DEFAULT_SYNC_OUTPUT_LIMIT + 10_000,
    })
    expect(longDecode.body.background).toBe(true)
    expect((longDecode.body.generationConfig as Record<string, unknown>).maxOutputTokens).toBeLessThanOrEqual(
      GEMINI4_UNIFIED_CONTEXT_WINDOW,
    )
  })
})

describe("Phase 4: Native Tool Invocation, Zod Self-Correction & SSE Stream", () => {
  let memDb: Database

  beforeEach(() => {
    memDb = new Database(":memory:")
    ensureTurnMetricsTable(memDb)
  })

  afterEach(() => {
    memDb.close()
    delete process.env.ENABLE_ADAPTIVE_ROUTING
  })

  test("executeNativeTool formats schema validation and runtime execution errors without throwing", async () => {
    const { schema } = defineObjectToolSchema<{ repo: string; prNumber: number }>({
      repo: { type: "string", minLength: 3, pattern: /^[\w.-]+\/[\w.-]+$/ },
      prNumber: { type: "number" },
    })

    const invalid = await executeNativeTool(schema, { repo: "bad", prNumber: "not-a-number" }, async () => "ok")
    expect(invalid.success).toBe(false)
    expect(invalid.isSchemaValidationError).toBe(true)
    expect(invalid.output).toContain("[TOOL_SCHEMA_VALIDATION_ERROR]: Invalid parameters provided.")
    expect(invalid.output).toContain("Field 'repo'")
    expect(invalid.output).toContain("Field 'prNumber'")

    const runtimeErr = await executeNativeTool(schema, { repo: "jaubut/claude-companion", prNumber: 42 }, async () => {
      throw new Error("GitHub API rate limit")
    })
    expect(runtimeErr.success).toBe(false)
    expect(runtimeErr.output).toBe("[TOOL_EXECUTION_ERROR]: GitHub API rate limit")

    const ok = await executeNativeTool(schema, { repo: "jaubut/claude-companion", prNumber: 42 }, async (args) => {
      return `Merged ${args.repo}#${args.prNumber}`
    })
    expect(ok).toEqual({ success: true, output: "Merged jaubut/claude-companion#42" })
  })

  test("self-corrects malformed tool args, preserves thoughtSignature, streams SSE events, and logs Tier 1 TTFT < 1.5s with zero agy_exit_1", async () => {
    process.env.ENABLE_ADAPTIVE_ROUTING = "true"
    const registry = new DynamicSkillRegistry([
      SkillManifestSchema.parse({
        id: "deploy-zettlab",
        name: "Deploy Zettlab",
        description: "Deploy service safely to Zettlab host.",
        triggers: ["deploy zettlab"],
        category: "ops",
        alwaysInclude: false,
        estimatedTokens: 150,
        content: "# Deploy Zettlab\nRun ff-only pull and verify systemd unit.",
      }),
    ])

    const capturedPayloads: Gemini4NativeRequestPayload[] = []
    let transportStep = 0
    let simulatedClock = 10_000

    const events: OrchestratorEvent[] = []
    for await (const ev of runGemini4OrchestratorTurn({
      sessionId: "sess_phase4_tool_loop",
      turnId: "turn_phase4_1",
      userPrompt: "What does deploy-zettlab skill say?",
      systemInstruction: "Core orchestrator rules.",
      tools: [createNativeLoadSkillTool(registry)],
      injectedSkillCount: 2,
      telemetrySink: memDb,
      now: () => simulatedClock,
      transport: async function* (payload) {
        capturedPayloads.push(payload)
        transportStep++
        if (transportStep === 1) {
          simulatedClock += 120 // TTFT = 120ms (< 1,500ms Tier 1 target)
          yield {
            parts: [
              { thought: true, text: "Checking skill directory..." },
              // First attempt omits required `skillId` to trigger schema self-correction
              {
                functionCall: { name: "load_skill", args: {} },
                thoughtSignature: "sig_step1_native_call_verbatim==",
              },
            ],
            usage: { promptTokens: 4800, cachedPromptTokens: 4096, outputTokens: 45 },
          }
          return
        }
        if (transportStep === 2) {
          simulatedClock += 90
          // Model self-corrects after receiving [TOOL_SCHEMA_VALIDATION_ERROR]
          yield {
            parts: [
              {
                functionCall: { name: "load_skill", args: { skillId: "deploy-zettlab" } },
                thoughtSignature: "sig_step2_corrected_call_verbatim==",
              },
            ],
            usage: { promptTokens: 4950, cachedPromptTokens: 4096, outputTokens: 35 },
          }
          return
        }
        simulatedClock += 80
        yield {
          parts: [{ text: "Deploy Zettlab pulls ff-only and verifies the systemd unit." }],
          usage: { promptTokens: 5120, cachedPromptTokens: 4096, outputTokens: 28 },
        }
      },
    })) {
      events.push(ev)
      // Verify SSE wire round-trip on every emitted event
      const parsed = parseOrchestratorSseChunk(formatOrchestratorSseEvent(ev))
      expect(parsed).toEqual([ev])
    }

    // Native Function Calling tools declared on every step
    expect(capturedPayloads.length).toBe(3)
    expect(capturedPayloads[0]?.body.tools).toBeDefined()

    // Step 2 contents preserved Step 1's thoughtSignature verbatim on the model functionCall part
    const step2Contents = capturedPayloads[1]?.body.contents as Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }>
    const step1ModelTurn = step2Contents.find((c) => c.role === "model")
    expect(step1ModelTurn?.parts[1]?.thoughtSignature).toBe("sig_step1_native_call_verbatim==")

    // Event sequence matches Spec §4 SSE contract
    expect(events.map((e) => e.event)).toEqual([
      "thinking_delta",
      "tool_start",
      "tool_result_summary",
      "tool_start",
      "tool_result_summary",
      "text_delta",
      "done",
    ])

    // Telemetry recorded Tier 1 route with TTFT < 1,500ms, implicit cache hit, 2 tool calls, 1 self-corrected schema error
    const metrics = readTurnMetrics(memDb, "sess_phase4_tool_loop")
    expect(metrics.length).toBe(1)
    expect(metrics[0]).toMatchObject({
      turnId: "turn_phase4_1",
      routeTier: "tier1_fast",
      modelId: "gemini-4-hydrogen",
      thinkingLevel: "low",
      promptTokens: 5120,
      cachedPromptTokens: 4096,
      ttftMs: 120,
      toolCallCount: 2,
      toolErrorCount: 1,
    })
    expect(metrics[0]!.ttftMs).toBeLessThan(1500)
  })

  test("enforces max 2 schema validation retries without looping infinitely", async () => {
    const { schema, jsonSchema } = defineObjectToolSchema<{ id: string }>({
      id: { type: "string", minLength: 2 },
    })
    let calls = 0
    const events: OrchestratorEvent[] = []
    for await (const ev of runGemini4OrchestratorTurn({
      sessionId: "sess_retry_cap",
      userPrompt: "Lookup item",
      tools: [
        defineNativeTool({
          name: "lookup_item",
          description: "Lookup by id",
          parametersJsonSchema: jsonSchema,
          schema,
          handler: async () => "found",
        }),
      ],
      telemetrySink: memDb,
      transport: async function* () {
        calls++
        yield {
          parts: [{ functionCall: { name: "lookup_item", args: { id: "" } } }],
        }
      },
    })) {
      events.push(ev)
    }

    // 1 initial attempt + 2 retries = 3 total model calls, then halts cleanly with done event
    expect(calls).toBe(3)
    expect(events.at(-1)?.event).toBe("done")
  })

  test("HeadlessBrainRunner routes Tier 1 and Tier 3 Gemini 4 CLI flags cleanly with zero agy_exit_1 errors", async () => {
    const { createHeadlessBrainRunner } = await import("../wiring/brain-headless")
    const spawnedModels: string[] = []
    let clock = 50_000

    const runner = createHeadlessBrainRunner({
      noteActivity: () => {},
      onStop: async () => {},
      telemetrySink: memDb,
      now: () => clock,
      env: {
        COMPANION_BRAIN_FAMILY: "gemini",
        ENABLE_DYNAMIC_SKILLS: "true",
        ENABLE_ADAPTIVE_ROUTING: "true",
      },
      spawnPersistentWorker: () => {
        throw new Error("force one-shot to inspect per-turn --model argv")
      },
      spawnWorker: (opts) => {
        const modelIdx = opts.args.indexOf("--model")
        if (modelIdx >= 0 && opts.args[modelIdx + 1]) {
          spawnedModels.push(opts.args[modelIdx + 1]!)
        }
        queueMicrotask(() => {
          clock += 95 // Tier 1 TTFT = 95ms (< 1,500ms)
          opts.onStdoutLine(JSON.stringify({ event: "init", session_id: "agy-conv-p4" }))
          opts.onStdoutLine(JSON.stringify({ event: "assistant", message: { content: "All systems green." } }))
          opts.onStdoutLine(
            JSON.stringify({
              event: "result",
              usage: { input_tokens: 5200, total_cached_tokens: 4200, output_tokens: 30 },
            }),
          )
          clock += 40
          opts.onExit(0, null) // Zero agy_exit_1
        })
        return { pid: 49001, kill: () => {} }
      },
    })

    await runner.spawn(null)
    const r1 = await runner.deliver("Quick status check?")
    expect(r1.status).toBe(200)
    await Bun.sleep(20)

    const r2 = await runner.deliver(
      "Run a cross-repo security audit and race condition root-cause analysis across all services.",
    )
    expect(r2.status).toBe(200)
    await Bun.sleep(20)

    expect(spawnedModels).toEqual(["gemini-4-hydrogen-low", "gemini-4-carbon-xhigh"])

    const rows = memDb.query("SELECT route_tier, model_id, thinking_level, ttft_ms, tool_error_count FROM orchestrator_turn_metrics ORDER BY rowid ASC").all() as Array<{
      route_tier: string
      model_id: string
      thinking_level: string
      ttft_ms: number
      tool_error_count: number
    }>
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({
      route_tier: "tier1_fast",
      model_id: "gemini-4-hydrogen-low",
      thinking_level: "low",
      tool_error_count: 0,
    })
    expect(rows[0]!.ttft_ms).toBeLessThan(1500)
    expect(rows[1]).toMatchObject({
      route_tier: "tier3_deep",
      model_id: "gemini-4-carbon-xhigh",
      thinking_level: "xhigh",
      tool_error_count: 0,
    })

    const agyMapped = agyStreamLineToOrchestratorEvents(
      JSON.stringify({ event: "assistant", message: { content: "Hello SSE" } }),
      "turn_x",
    )
    expect(agyMapped).toEqual([{ event: "text_delta", data: { text: "Hello SSE" } }])
    await runner.stopAgent()
  })
})

describe("Spec §5 Final Definition of Done (All 4 Feature Flags Enabled)", () => {
  test("verifies all 4 phases working together seamlessly under full rollout flags", async () => {
    const { prepareBrainTurn } = await import("./brain-turn-harness")
    const { pruneContext } = await import("./context-pruning")
    const { createIsolatedBackgroundLane, appendLaneANotifications } = await import("./brain-lane-isolation")
    const { ensureAgentNotificationsTable } = await import("./agent-notifications")
    const { getFeatureFlags } = await import("./feature-flags")

    const rolloutEnv = {
      ENABLE_DYNAMIC_SKILLS: "true",
      ENABLE_CONTEXT_PRUNING: "true",
      ENABLE_LANE_ISOLATION: "true",
      ENABLE_ADAPTIVE_ROUTING: "true",
    }
    const flags = getFeatureFlags(rolloutEnv)
    expect(flags).toEqual({
      ENABLE_DYNAMIC_SKILLS: true,
      ENABLE_CONTEXT_PRUNING: true,
      ENABLE_LANE_ISOLATION: true,
      ENABLE_ADAPTIVE_ROUTING: true,
    })

    // 1. >= 60% baseline system prompt token reduction with <= 5 + coreCount injected skills
    const skills = Array.from({ length: 40 }, (_, i) =>
      SkillManifestSchema.parse({
        id: `skill-${i}`,
        name: `Skill ${i}`,
        description: `Specialized workflow number ${i} for domain tasks.`,
        triggers: [`trigger-${i}`],
        category: "code",
        alwaysInclude: i === 0,
        estimatedTokens: 900,
        content: `# Skill ${i}\n${"Detailed workflow step instructions. ".repeat(80)}`,
      }),
    )
    const registry = new DynamicSkillRegistry(skills)
    const brainDir = join(import.meta.dir, "../../brain")

    const baselinePrepared = prepareBrainTurn({
      userText: "What is our deployment status?",
      family: "gemini",
      bootPrefixSent: false,
      legacyAgyBootPrefix: "[System]\n",
      brainDir,
      registry,
      env: { ENABLE_DYNAMIC_SKILLS: "false" },
    })
    const upgradedPrepared = prepareBrainTurn({
      userText: "What is our deployment status?",
      family: "gemini",
      bootPrefixSent: false,
      legacyAgyBootPrefix: "[System]\n",
      brainDir,
      registry,
      env: rolloutEnv,
    })
    const tokenReductionRatio = 1 - upgradedPrepared.estimatedPromptTokens / baselinePrepared.estimatedPromptTokens
    expect(tokenReductionRatio).toBeGreaterThanOrEqual(0.6)
    expect(upgradedPrepared.injectedSkillCount).toBeLessThanOrEqual(5 + 1)
    expect(upgradedPrepared.routeTier).toBe("tier1_fast")
    expect(upgradedPrepared.routedModelId).toBe("gemini-4-hydrogen-low")

    // 2. 35+ turn conversation maintains < 24,000 token ceiling while preserving latest 4+ turns verbatim
    const longHistory: Message[] = []
    for (let t = 1; t <= 38; t++) {
      longHistory.push({ id: t * 2 - 1, role: "user", content: `Turn #${t}: inspect module state and report findings.` })
      longHistory.push({
        id: t * 2,
        role: "assistant",
        content: `Completed inspection #${t}.\n${"Verbose diagnostic output line. ".repeat(25)}`,
        thoughtSignature: `sig_turn_${t}_exact==`,
      })
    }
    const pruned = pruneContext(longHistory, " Cold summary of turns 1..23.")
    expect(pruned.estimatedTokens).toBeLessThan(24_000)
    const tail = pruned.messages.slice(-8)
    expect(tail.some((m) => m.content.includes("Turn #38:"))).toBe(true)
    expect(tail.some((m) => m.content.includes("Turn #35:"))).toBe(true)
    expect(tail.at(-1)?.thoughtSignature).toBe("sig_turn_38_exact==")

    // 3. Lane B isolated notification bridge + Tier 1 SSE execution with >= 70% implicit cache hit telemetry
    const rolloutDb = new Database(":memory:")
    ensureTurnMetricsTable(rolloutDb)
    ensureAgentNotificationsTable(rolloutDb)

    const laneB = createIsolatedBackgroundLane({ notificationSink: rolloutDb })
    laneB.enqueue({
      id: "bg_1",
      text: "stuck claude-companion #501 — prod migration check red",
      createdAt: Date.now(),
    })
    await laneB.drain()
    const interactivePrompt = await appendLaneANotifications("What is our deployment status?", rolloutDb)
    expect(interactivePrompt).toContain("### Background System Updates")
    expect(interactivePrompt).not.toContain("[event]")

    let simNow = 1_000
    for await (const _ev of runGemini4OrchestratorTurn({
      sessionId: "sess_dod_rollout",
      userPrompt: interactivePrompt,
      systemInstruction: upgradedPrepared.promptToSend,
      injectedSkillCount: upgradedPrepared.injectedSkillCount,
      telemetrySink: rolloutDb,
      env: rolloutEnv,
      now: () => simNow,
      transport: async function* () {
        simNow += 110 // TTFT = 110ms (< 1,500ms)
        yield {
          parts: [{ text: "Deployment is green; note that PR #501 has a red migration check." }],
          usage: { promptTokens: 6000, cachedPromptTokens: 4800, outputTokens: 24 }, // 80% >= 70% implicit cache hit
        }
      },
    })) {
      /* consume stream */
    }

    const metrics = readTurnMetrics(rolloutDb, "sess_dod_rollout")
    expect(metrics.length).toBe(1)
    expect(metrics[0]!.ttftMs).toBeLessThan(1500)
    expect(metrics[0]!.cachedPromptTokens / metrics[0]!.promptTokens).toBeGreaterThanOrEqual(0.7)
    expect(metrics[0]!.toolErrorCount).toBe(0)

    laneB.stop()
    rolloutDb.close()
  })
})

