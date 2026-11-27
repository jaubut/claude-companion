import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { BRAIN_DIR, createHeadlessBrainRunner, type SpawnedPersistentWorkerHandle } from "../wiring/brain-headless"
import type { SpawnWorkerOpts } from "./worker-supervisor"
import { loadSkillManifests } from "./skill-loader"
import {
  buildBaselineStaticSystemPrompt,
  buildDynamicSystemPrompt,
  loadStaticBrainRules,
} from "./skill-prompt"
import { DynamicSkillRegistry } from "./skill-retrieval"
import { executeLoadSkill, loadSkillToolDefinition } from "./skill-tools"
import { type SkillCategory, type SkillManifest, SkillManifestSchema, estimateTokens } from "./skill-types"
import { Database } from "bun:sqlite"
import { readTurnMetrics } from "./orchestrator-telemetry"

const DOMAIN_TOPICS: ReadonlyArray<{ category: SkillCategory; slug: string; keyword: string; phrase: string }> = [
  { category: "git", slug: "git", keyword: "worktree", phrase: "manage git worktree" },
  { category: "db", slug: "db", keyword: "migration", phrase: "validate database schema" },
  { category: "ops", slug: "ops", keyword: "tailscale", phrase: "diagnose tailscale serve" },
  { category: "code", slug: "code", keyword: "swiftui", phrase: "audit swiftui view" },
  { category: "architecture", slug: "arch", keyword: "archmap", phrase: "regenerate architecture map" },
  { category: "general", slug: "gen", keyword: "invoice", phrase: "prepare client invoice" },
]

function buildSynthetic78SkillCatalogue(coreCount = 2): SkillManifest[] {
  const manifests: SkillManifest[] = []
  for (let i = 0; i < 78; i++) {
    const topic = DOMAIN_TOPICS[i % DOMAIN_TOPICS.length]!
    const isCore = i < coreCount
    const id = isCore ? `core-protocol-${i + 1}` : `${topic.slug}-specialist-${i + 1}`
    const name = isCore ? `Core Protocol ${i + 1}` : `${topic.slug.toUpperCase()} Specialist ${i + 1}`
    const description = isCore
      ? `Core orchestrator safety and routing protocol ${i + 1}. Always pinned.`
      : `Specialized workflow ${i + 1} for ${topic.keyword} tasks. Triggers on "${topic.phrase} ${i + 1}".`
    // Realistic ~2,400-token (~9.6 KB) SKILL.md body matching real claude-config average (~2,800 tokens/skill)
    const detailedBody = Array.from(
      { length: 90 },
      (_, lineIdx) =>
        `Step ${lineIdx + 1} (${id}): Execute deterministic ${topic.keyword} verification gate, inspect structured outputs, and report actionable findings without mutating unrelated state.`,
    ).join("\n")
    const content = `---\nname: ${id}\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n\n# ${name}\n\n${detailedBody}`
    manifests.push(
      SkillManifestSchema.parse({
        id,
        name,
        description,
        triggers: isCore ? [] : [`${topic.phrase} ${i + 1}`, `/${id}`],
        category: topic.category,
        alwaysInclude: isCore,
        estimatedTokens: estimateTokens(content),
        content,
      }),
    )
  }
  return manifests
}

describe("Phase 1: DynamicSkillRegistry, Prefix-Invariant Prompt & >= 60% Token Reduction", () => {
  test("enforces injected_skill_count <= 5 + coreCount across conversational, broad, and multi-trigger turns", () => {
    const coreCount = 2
    const manifests = buildSynthetic78SkillCatalogue(coreCount)
    const registry = new DynamicSkillRegistry(manifests)
    const staticRules = loadStaticBrainRules(BRAIN_DIR)

    const diversePrompts = [
      "Good morning! Anything urgent waiting on me?",
      "Check status on PR #380",
      // Broad query intentionally hitting every domain keyword so >30 candidate skills score > 0
      "We need worktree migration tailscale swiftui archmap invoice review across all specialists",
      "Please diagnose tailscale serve 4 and validate database schema 14 right now",
      "/code-specialist-10 and /ops-specialist-9",
      "",
    ]

    for (const input of diversePrompts) {
      const built = buildDynamicSystemPrompt({
        staticRules,
        registry,
        currentInput: input,
        historySummary: ["Previous turn discussed swiftui and tailscale"],
      })
      expect(built.pinnedSkillCount).toBe(coreCount)
      expect(built.dynamicSkillCount).toBeLessThanOrEqual(DynamicSkillRegistry.MAX_DYNAMIC_SKILLS)
      expect(built.injectedSkillCount).toBeLessThanOrEqual(5 + coreCount)
      expect(built.selection.activeSkills.length).toBe(built.injectedSkillCount)
      // Unselected candidate skills must appear in the compact availableDirectory
      expect(built.selection.availableDirectory.length).toBe(78 - coreCount - built.dynamicSkillCount)
    }
  })

  test("achieves >= 60% reduction in baseline system prompt tokens on synthetic 78-skill catalogue", () => {
    const coreCount = 2
    const manifests = buildSynthetic78SkillCatalogue(coreCount)
    const registry = new DynamicSkillRegistry(manifests)
    const staticRules = loadStaticBrainRules(BRAIN_DIR)

    const baseline = buildBaselineStaticSystemPrompt({
      staticRules,
      skills: manifests,
    })

    // Test both a standard conversational turn AND a worst-case 5-dynamic-skill technical turn
    const conversational = buildDynamicSystemPrompt({
      staticRules,
      registry,
      currentInput: "Hey, what PRs are open right now?",
    })
    const heavyTechnical = buildDynamicSystemPrompt({
      staticRules,
      registry,
      currentInput: "manage git worktree 7, validate database schema 8, diagnose tailscale serve 9, audit swiftui view 10, regenerate architecture map 11, prepare client invoice 12",
    })

    expect(heavyTechnical.dynamicSkillCount).toBe(5)
    expect(heavyTechnical.injectedSkillCount).toBe(5 + coreCount)

    const convReduction = (baseline.totalPromptTokens - conversational.totalPromptTokens) / baseline.totalPromptTokens
    const heavyReduction = (baseline.totalPromptTokens - heavyTechnical.totalPromptTokens) / baseline.totalPromptTokens

    expect(convReduction).toBeGreaterThanOrEqual(0.6)
    expect(heavyReduction).toBeGreaterThanOrEqual(0.6)
  })

  test("preserves byte-for-byte prefix invariance (>= 4,096 tokens) across multi-turn sessions for Gemini 4 implicit caching", () => {
    const manifests = buildSynthetic78SkillCatalogue(2)
    const registry = new DynamicSkillRegistry(manifests)
    const staticRules = loadStaticBrainRules(BRAIN_DIR)

    const turn1 = buildDynamicSystemPrompt({
      staticRules,
      registry,
      currentInput: "manage git worktree 7 on Zettlab",
    })
    const turn2 = buildDynamicSystemPrompt({
      staticRules,
      registry,
      currentInput: "prepare client invoice 12 for Chantal",
      historySummary: ["Turn 1 checked git worktree 7"],
    })
    const turn3 = buildDynamicSystemPrompt({
      staticRules,
      registry,
      currentInput: "audit swiftui view 10 on iOS Companion",
      historySummary: ["Turn 1 checked git", "Turn 2 prepared invoice"],
    })

    // 1. Exceeds Gemini 4's >= 4,096 token threshold right inside the invariant static prefix
    expect(turn1.staticPrefixTokens).toBeGreaterThanOrEqual(4096)

    // 2. Dynamic skills changed completely across the 3 turns...
    expect(turn1.selection.dynamicSkills.map((s) => s.id)).not.toEqual(turn2.selection.dynamicSkills.map((s) => s.id))
    expect(turn2.selection.dynamicSkills.map((s) => s.id)).not.toEqual(turn3.selection.dynamicSkills.map((s) => s.id))

    // 3. ...yet the cached prefix header (Static Behavioral Rules + Core Pinned Skills) is 100% byte-for-byte identical!
    expect(Buffer.compare(Buffer.from(turn1.staticPrefix, "utf8"), Buffer.from(turn2.staticPrefix, "utf8"))).toBe(0)
    expect(Buffer.compare(Buffer.from(turn2.staticPrefix, "utf8"), Buffer.from(turn3.staticPrefix, "utf8"))).toBe(0)

    const prefixLen = turn1.staticPrefix.length
    expect(turn1.fullPrompt.slice(0, prefixLen)).toBe(turn2.fullPrompt.slice(0, prefixLen))
    expect(turn2.fullPrompt.slice(0, prefixLen)).toBe(turn3.fullPrompt.slice(0, prefixLen))

    // 4. Compact directory and dynamic skills sit strictly in the suffix after staticPrefix
    expect(turn1.fullPrompt.indexOf("## Available Skill Directory")).toBeGreaterThan(prefixLen)
    expect(turn1.fullPrompt.indexOf("## Active Turn Skills")).toBeGreaterThan(
      turn1.fullPrompt.indexOf("## Available Skill Directory"),
    )
  })

  test("loadSkillManifests loads SKILL.md files from disk and real claude-config catalogue (when present) with >= 60% savings", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cc-skills-loader-"))
    try {
      const s1Dir = join(tmpRoot, "skills", "cso")
      const s2Dir = join(tmpRoot, "skills", "turso-migrate")
      const cmdDir = join(tmpRoot, "commands")
      mkdirSync(s1Dir, { recursive: true })
      mkdirSync(s2Dir, { recursive: true })
      mkdirSync(cmdDir, { recursive: true })

      writeFileSync(
        join(s1Dir, "SKILL.md"),
        `---\nname: cso\ndescription: Chief Security Officer audit. Triggers on "/cso", "security audit", "threat model".\n---\n\n# CSO Skill\nRun full OWASP + STRIDE security review.`,
      )
      writeFileSync(
        join(s2Dir, "SKILL.md"),
        `---\nname: turso-migrate\ndescription: Run parameterized libSQL schema migrations safely.\ndisable-model-invocation: true\n---\n\n# Turso Migrate\nCheck schema first.`,
      )
      writeFileSync(
        join(cmdDir, "git-commit.md"),
        `---\ndescription: Create a conventional commit without staging secrets.\n---\n\nReview git diff and commit.`,
      )

      const loaded = loadSkillManifests(join(tmpRoot, "skills"), { pinnedIds: new Set(["cso"]) })
      expect(loaded.map((s) => s.id)).toEqual(["cso", "git-commit", "turso-migrate"])
      expect(loaded[0]!.alwaysInclude).toBe(true)
      expect(loaded[0]!.triggers).toEqual(expect.arrayContaining(["/cso", "security audit", "threat model"]))
      expect(loaded[2]!.manualOnly).toBe(true)
      expect(loaded[2]!.category).toBe("db")
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }

    // Also verify against the real 118+ skill catalogue in claude-config when mounted locally
    const realSkillsPath = [
      join(homedir(), "jaubut", "claude-config", "skills"),
      join(homedir(), ".claude", "skills"),
    ].find((p) => existsSync(p))

    if (realSkillsPath) {
      const realManifests = loadSkillManifests(realSkillsPath)
      expect(realManifests.length).toBeGreaterThanOrEqual(78)
      const realRegistry = new DynamicSkillRegistry(realManifests)
      const staticRules = loadStaticBrainRules(BRAIN_DIR)
      const realBaseline = buildBaselineStaticSystemPrompt({ staticRules, skills: realManifests })
      const realDynamic = buildDynamicSystemPrompt({
        staticRules,
        registry: realRegistry,
        currentInput: "Run a security audit and threat model on this PR before merging",
      })
      expect(realDynamic.injectedSkillCount).toBeLessThanOrEqual(5)
      const realReduction = (realBaseline.totalPromptTokens - realDynamic.totalPromptTokens) / realBaseline.totalPromptTokens
      expect(realReduction).toBeGreaterThanOrEqual(0.6)
    }
  })

  test("Stage 2 load_skill meta-tool fetches un-injected skills and validates inputs", () => {
    const manifests = buildSynthetic78SkillCatalogue(1)
    const registry = new DynamicSkillRegistry(manifests)
    expect(loadSkillToolDefinition.name).toBe("load_skill")

    // Un-injected skill fetched on demand
    const targetSkill = manifests.find((m) => !m.alwaysInclude)!
    const okRes = executeLoadSkill(registry, { skillId: targetSkill.id })
    expect(okRes.ok).toBe(true)
    if (okRes.ok) {
      expect(okRes.skillId).toBe(targetSkill.id)
      expect(okRes.content).toBe(targetSkill.content)
      expect(okRes.output).toContain(targetSkill.content)
    }

    // Slash-prefixed ID works cleanly
    expect(executeLoadSkill(registry, { skillId: `/${targetSkill.id}` }).ok).toBe(true)

    // Schema validation error on missing/bad skillId
    const badArgs = executeLoadSkill(registry, { skillId: "" })
    expect(badArgs.ok).toBe(false)
    expect(badArgs.output).toContain("[TOOL_SCHEMA_VALIDATION_ERROR]")

    // Unknown skillId returns helpful suggestions
    const missing = executeLoadSkill(registry, { skillId: "git-specialist-999" })
    expect(missing.ok).toBe(false)
    expect(missing.output).toContain("[SKILL_NOT_FOUND]")
  })

  test("HeadlessBrainRunner logs baseline vs ENABLE_DYNAMIC_SKILLS=true telemetry with >= 60% prompt token drop", async () => {
    const manifests = buildSynthetic78SkillCatalogue(1)
    const registry = new DynamicSkillRegistry(manifests)
    const memDb = new Database(":memory:")

    const runSingleTurn = async (enableDynamic: boolean, sessionLabel: string) => {
      let clock = 10_000
      const runner = createHeadlessBrainRunner({
        noteActivity: () => {},
        onStop: async () => {},
        telemetrySink: memDb,
        skillRegistry: registry,
        env: {
          COMPANION_BRAIN_FAMILY: "gemini",
          ENABLE_DYNAMIC_SKILLS: enableDynamic ? "true" : "false",
        },
        now: () => clock,
        spawnPersistentWorker: (opts: SpawnWorkerOpts): SpawnedPersistentWorkerHandle => ({
          pid: 9191,
          writeLine() {
            queueMicrotask(() => {
              clock = 10_320
              opts.onStdoutLine(
                JSON.stringify({
                  event: "result",
                  result: {
                    conversation_id: `conv-${sessionLabel}`,
                    status: "SUCCESS",
                    response: "acknowledged",
                  },
                }),
              )
            })
            return true
          },
          closeInput() {},
          kill() {},
        }),
        log: () => {},
      })
      await runner.spawn(null)
      await runner.deliver("diagnose tailscale serve 3 and report status")
      await Bun.sleep(15)
      await runner.stopAgent()
    }

    await runSingleTurn(false, "baseline")
    await runSingleTurn(true, "upgraded")

    const metrics = readTurnMetrics(memDb)
    expect(metrics).toHaveLength(2)
    const [baselineRow, upgradedRow] = metrics as [typeof metrics[0], typeof metrics[0]]

    expect(baselineRow.routeTier).toBe("baseline")
    expect(baselineRow.injectedSkillCount).toBe(78)

    expect(upgradedRow.routeTier).toBe("dynamic_skills_p1")
    expect(upgradedRow.injectedSkillCount).toBeLessThanOrEqual(5 + 1)
    expect(upgradedRow.ttftMs).toBe(320)

    const tokenDrop = (baselineRow.promptTokens - upgradedRow.promptTokens) / baselineRow.promptTokens
    expect(tokenDrop).toBeGreaterThanOrEqual(0.6)
    memDb.close()
  })
})
