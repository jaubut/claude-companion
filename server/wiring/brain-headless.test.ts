import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAIN_AGENT } from "../lib/brain"
import { getKv, setKv } from "../lib/brain-store"
import { listSessions, recordSession } from "../lib/sessions"
import {
  DEFAULT_GEMINI_BRAIN_MODEL,
  DEFAULT_GEMINI_WORKER_MODEL,
  agyBrainSettings,
  buildHeadlessGeminiArgs,
  buildPersistentGeminiArgs,
  formatGeminiStreamInput,
  normalizeAgyCliModelFlag,
} from "../lib/worker-invocation"
import type { SpawnWorkerOpts } from "../lib/worker-supervisor"
import {
  AGY_BOOT_PREFIX,
  BRAIN_DIR,
  BRAIN_RUNTIME_ALLOWED_TOOLS,
  HEADLESS_BRAIN_PANE,
  type SpawnedPersistentWorkerHandle,
  brainFamilyForModel,
  buildBrainClaudeArgs,
  createHeadlessBrainRunner,
  getBrainModel,
  resolveBrainEffortDefault,
  resolveBrainSessionModel,
  writeBrainMcpConfig,
} from "./brain-headless"

// The brain's --mcp-config (canvas-board-sync A1): only `board`, loopback, 0600, no token.

describe("writeBrainMcpConfig", () => {
  test("only board → loopback /api/mcp/board with the headersHelper; mode 0600; no token in the file", () => {
    process.env.COMPANION_AUTH_TOKEN = process.env.COMPANION_AUTH_TOKEN || "brain-mcp-test-token-0123456789"
    const dir = mkdtempSync(join(tmpdir(), "cc-brain-mcp-"))
    const path = writeBrainMcpConfig(dir, 4999)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const raw = readFileSync(path, "utf8")
    const cfg = JSON.parse(raw) as { mcpServers: Record<string, { type: string; url: string; headersHelper: string }> }
    expect(Object.keys(cfg.mcpServers)).toEqual(["board"])
    expect(cfg.mcpServers.board!.type).toBe("http")
    expect(cfg.mcpServers.board!.url).toBe("http://127.0.0.1:4999/api/mcp/board")
    expect(cfg.mcpServers.board!.headersHelper).toMatch(/scripts\/board-mcp-headers\.sh$/)
    expect(raw).not.toContain(process.env.COMPANION_AUTH_TOKEN!)
    expect(raw.toLowerCase()).not.toContain("bearer")
  })
})

describe("headless brain fresh spawn", () => {
  test("spawn(null) purges stale brain sessions so tick() cannot re-adopt an old session_id", async () => {
    recordSession({
      cwd: BRAIN_DIR,
      agent: "claude",
      sessionId: "stale-7-day-session-id",
      label: "brain",
      title: "Brain",
      taskId: BRAIN_AGENT,
      herdrPane: HEADLESS_BRAIN_PANE,
      herdrAgent: BRAIN_AGENT,
      agentStatus: "idle",
      pid: "99999",
    }, { sessionIdConfirmed: true })
    expect(listSessions().some((s) => s.sessionId === "stale-7-day-session-id")).toBe(true)

    const runner = createHeadlessBrainRunner({
      noteActivity: () => {},
      onStop: async () => {},
    })
    const res = await runner.spawn(null)
    expect(res.ok).toBe(true)
    const brainSessions = listSessions().filter((s) => s.taskId === BRAIN_AGENT)
    expect(brainSessions).toHaveLength(1)
    expect(brainSessions[0]!.sessionId).not.toBe("stale-7-day-session-id")
  })
})

describe("brain family and Gemini 4 resolution", () => {
  test("classifies Gemini 4 and Orchestrator models as gemini, Claude models as claude", () => {
    expect(brainFamilyForModel("gemini-4-carbon-high")).toBe("gemini")
    expect(brainFamilyForModel("Gemini 4 Carbon (High)")).toBe("gemini")
    expect(brainFamilyForModel("Gemini 4 Argon (Medium)")).toBe("gemini")
    expect(brainFamilyForModel("gemini-pro-orchestrator")).toBe("gemini")
    expect(brainFamilyForModel("orchestrator")).toBe("gemini")
    expect(brainFamilyForModel("claude-opus-5-5")).toBe("claude")
    expect(brainFamilyForModel("claude-sonnet-5-5")).toBe("claude")
  })

  test("resolves default model from picker, COMPANION_BRAIN_DEFAULT_MODEL, COMPANION_BRAIN_EFFORT_DEFAULT, or COMPANION_BRAIN_FAMILY=gemini (gemini-4-argon-low default)", () => {
    expect(DEFAULT_GEMINI_WORKER_MODEL).toBe("gemini-4-argon-high")
    expect(DEFAULT_GEMINI_BRAIN_MODEL).toBe("gemini-4-argon-low")
    expect(resolveBrainEffortDefault({})).toBe("low")
    expect(resolveBrainEffortDefault({ COMPANION_BRAIN_EFFORT_DEFAULT: "medium" })).toBe("medium")
    expect(resolveBrainEffortDefault({ COMPANION_BRAIN_EFFORT_DEFAULT: "high" })).toBe("high")

    expect(resolveBrainSessionModel("Gemini 4 Carbon (High)", {})).toBe("Gemini 4 Carbon (High)")
    expect(resolveBrainSessionModel("gemini-4-carbon-low", {})).toBe("gemini-4-carbon-low")
    expect(resolveBrainSessionModel("gemini-4-argon-low", {})).toBe("gemini-4-argon-low")
    expect(resolveBrainSessionModel("gemini-4-argon", {})).toBe("gemini-4-argon-low")
    expect(resolveBrainSessionModel("gemini-4-carbon", {})).toBe("gemini-4-carbon-low")
    expect(resolveBrainSessionModel("gemini-4-argon", { COMPANION_BRAIN_EFFORT_DEFAULT: "medium" })).toBe("gemini-4-argon-medium")
    expect(resolveBrainSessionModel("auto", { COMPANION_BRAIN_DEFAULT_MODEL: "gemini-4-argon-medium" })).toBe("gemini-4-argon-medium")
    expect(resolveBrainSessionModel("auto", { COMPANION_BRAIN_FAMILY: "gemini" })).toBe("gemini-4-argon-low")
    expect(resolveBrainSessionModel("auto", { COMPANION_BRAIN_FAMILY: "gemini", COMPANION_BRAIN_EFFORT_DEFAULT: "medium" })).toBe("gemini-4-argon-medium")
    expect(resolveBrainSessionModel("auto", {})).toBe("claude-opus-5-5")

    // Legacy KV high values downgrade to -low unless explicitly opted into high effort
    setKv("brain_model", "gemini-4-argon-high")
    setKv("brain_model_explicit_effort", "")
    expect(getBrainModel({})).toBe("gemini-4-argon-low")
    setKv("brain_model", "Gemini 4 Carbon (High)")
    expect(getBrainModel({})).toBe("gemini-4-carbon-low")
    setKv("brain_model_explicit_effort", "1")
    expect(getBrainModel({})).toBe("Gemini 4 Carbon (High)")
    setKv("brain_model_explicit_effort", "")
    setKv("brain_model", "auto")
  })

  test("normalizes Gemini 4 Argon/Carbon low, medium, and high CLI model flags cleanly", () => {
    expect(normalizeAgyCliModelFlag("gemini-4-argon-low")).toBe("gemini-4-argon-low")
    expect(normalizeAgyCliModelFlag("Gemini 4 Argon (Low)")).toBe("gemini-4-argon-low")
    expect(normalizeAgyCliModelFlag("gemini-4-argon-medium")).toBe("gemini-4-argon-medium")
    expect(normalizeAgyCliModelFlag("Gemini 4 Argon (Medium)")).toBe("gemini-4-argon-medium")
    expect(normalizeAgyCliModelFlag("gemini-4-argon-high")).toBe("gemini-4-argon-high")
    expect(normalizeAgyCliModelFlag("gemini-4-argon")).toBe("gemini-4-argon-low")
    expect(normalizeAgyCliModelFlag("gemini-4-carbon-low")).toBe("gemini-4-carbon-low")
    expect(normalizeAgyCliModelFlag("Gemini 4 Carbon (Low)")).toBe("gemini-4-carbon-low")
    expect(normalizeAgyCliModelFlag("gemini-4-carbon-medium")).toBe("gemini-4-carbon-medium")
    expect(normalizeAgyCliModelFlag("Gemini 4 Carbon (Medium)")).toBe("gemini-4-carbon-medium")
    expect(normalizeAgyCliModelFlag("gemini-4-carbon-high")).toBe("gemini-4-carbon-high")
    expect(normalizeAgyCliModelFlag("gemini-4-carbon")).toBe("gemini-4-carbon-low")
  })

  test("agyBrainSettings scopes out global ~/.agents/skills, bans schedule and sleep, and preserves tls and board MCP servers", () => {
    const raw = agyBrainSettings("/home/testuser")
    const parsed = JSON.parse(raw) as { disableSlashCommands?: boolean; permissions?: { deny?: string[] } }
    expect(parsed.disableSlashCommands).toBe(true)
    const deny = parsed.permissions?.deny ?? []
    expect(deny).toContain("schedule")
    expect(deny).toContain("command(sleep*)")
    expect(deny).toContain("command(gh pr merge*)")
    expect(deny).toContain("read_file(/home/testuser/.agents/skills)")
    expect(deny).toContain("read_file(/home/testuser/.agents)")
    expect(deny).toContain("write_file(/home/testuser)")
    expect(deny).toContain("edit_file(/home/testuser)")
    // Must NOT deny mcp(*) so tls and board MCP servers stay enabled for the Brain
    expect(deny).not.toContain("mcp(*)")

    const headlessArgs = buildHeadlessGeminiArgs({
      prompt: "hi",
      sessionId: "c1",
      resume: true,
      mode: "auto",
      model: "gemini-4-argon-low",
      settings: raw,
    })
    expect(headlessArgs.slice(-2)).toEqual(["--settings", raw])

    const persistentArgs = buildPersistentGeminiArgs({
      sessionId: "c1",
      resume: true,
      mode: "auto",
      model: "gemini-4-argon-low",
      settings: raw,
    })
    expect(persistentArgs.slice(-2)).toEqual(["--settings", raw])
  })

  test("buildBrainClaudeArgs injects runtime --allowedTools for bin/ui and ./bin/ui before -- prompt", () => {
    expect(BRAIN_RUNTIME_ALLOWED_TOOLS).toEqual(["Bash(bin/ui:*)", "Bash(./bin/ui:*)"])
    const args = buildBrainClaudeArgs({
      prompt: "render card",
      sessionId: "sid-123",
      resume: false,
      mode: "auto",
      model: "claude-opus-5-5",
    })
    expect(args.slice(0, 3)).toEqual(["--allowedTools", "Bash(bin/ui:*)", "Bash(./bin/ui:*)"])
    expect(args.slice(-2)).toEqual(["--", "render card"])
    expect(AGY_BOOT_PREFIX).toContain("./bin/ui email --to <addr>")
    expect(AGY_BOOT_PREFIX).toContain("./bin/ui pr --repo <owner/name> --pr <n>")
    expect(AGY_BOOT_PREFIX).toContain("NEVER call `schedule` or `sleep`")
    expect(AGY_BOOT_PREFIX).toContain("Delegate repo file grepping/archaeology to headless builders (`bin/worker dispatch`)")
  })

  test("buildPersistentGeminiArgs and formatGeminiStreamInput build stream-json persistent daemon args and NDJSON user event lines", () => {
    expect(buildPersistentGeminiArgs({ mode: "auto", model: "Gemini 4 Argon (High)" })).toEqual([
      "--print=",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-4-argon-high",
      "--dangerously-skip-permissions",
    ])
    expect(buildPersistentGeminiArgs({ sessionId: "agy-conv-123", resume: true, mode: "plan", model: "gemini-4-argon-high" })).toEqual([
      "--print=",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--conversation",
      "agy-conv-123",
      "--model",
      "gemini-4-argon-high",
      "--mode",
      "plan",
    ])
    expect(JSON.parse(formatGeminiStreamInput("hello brain"))).toEqual({
      event: "user",
      message: { content: "hello brain" },
    })
  })
})

describe("warm persistent Antigravity Brain session & CLI fallback", () => {
  test("keeps one warm persistent agy daemon alive across turns instead of cold-booting per turn", async () => {
    setKv("brain_model", "gemini-4-argon-high")
    setKv("agy_conversation_id", "")
    const persistentSpawns: Array<{ opts: SpawnWorkerOpts; lines: string[]; killed: boolean }> = []
    const oneShotSpawns: SpawnWorkerOpts[] = []
    const stops: Array<{ sid: string; reply: string }> = []
    const activities: Array<{ sid: string; tool?: string }> = []

    const runner = createHeadlessBrainRunner({
      noteActivity: (sid, call) => { activities.push({ sid, tool: call?.tool }) },
      onStop: async (sid, reply) => { stops.push({ sid, reply }) },
      spawnPersistentWorker: (opts): SpawnedPersistentWorkerHandle => {
        const rec = { opts, lines: [] as string[], killed: false }
        persistentSpawns.push(rec)
        // Warm daemon emits init immediately upon startup
        queueMicrotask(() => {
          opts.onStdoutLine(JSON.stringify({ event: "init", conversation_id: "agy-warm-conv-1" }))
        })
        return {
          pid: 7171,
          writeLine(line: string) {
            rec.lines.push(line.trim())
            return true
          },
          closeInput() {},
          kill() { rec.killed = true },
        }
      },
      spawnWorker: (opts) => {
        oneShotSpawns.push(opts)
        return { pid: 8181, kill() {} }
      },
      log: () => {},
    })

    await runner.spawn(null)
    await Bun.sleep(5)

    // Turn 1: spawns the warm persistent daemon once and sends AGY_BOOT_PREFIX + prompt over stdin
    const r1 = await runner.deliver("first question")
    expect(r1.status).toBe(200)
    expect(await runner.agentStatus()).toBe("busy")
    expect(persistentSpawns).toHaveLength(1)
    expect(oneShotSpawns).toHaveLength(0)
    expect(persistentSpawns[0]!.opts.args).toContain("--input-format")
    expect(persistentSpawns[0]!.opts.args).toContain("stream-json")
    expect(persistentSpawns[0]!.opts.args).toContain("--settings")
    expect(persistentSpawns[0]!.opts.args).toContain(agyBrainSettings())
    expect(persistentSpawns[0]!.lines).toHaveLength(1)
    const turn1Msg = JSON.parse(persistentSpawns[0]!.lines[0]!) as { event: string; message: { content: string } }
    expect(turn1Msg.event).toBe("user")
    expect(turn1Msg.message.content).toStartWith(AGY_BOOT_PREFIX)
    expect(turn1Msg.message.content).toEndWith("first question")

    await Bun.sleep(5)
    expect(getKv("agy_conversation_id")).toBe("agy-warm-conv-1")

    // Emit tool step and turn result on the warm daemon WITHOUT exiting
    persistentSpawns[0]!.opts.onStdoutLine(JSON.stringify({
      event: "step_update",
      conversation_id: "agy-warm-conv-1",
      step_update: { step_index: 1, step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: { parameters: { CommandLine: "bin/thread" } } },
    }))
    persistentSpawns[0]!.opts.onStdoutLine(JSON.stringify({
      event: "result",
      result: { conversation_id: "agy-warm-conv-1", status: "SUCCESS", response: "first answer" },
    }))
    await Bun.sleep(5)
    expect(await runner.agentStatus()).toBe("idle")
    expect(stops).toEqual([{ sid: expect.any(String), reply: "first answer" }])
    expect(activities.some((a) => a.tool === "run_command")).toBe(true)

    // Turn 2: reuses the exact same warm persistent daemon (persistentSpawns still 1!) without AGY_BOOT_PREFIX
    const r2 = await runner.deliver("second question")
    expect(r2.status).toBe(200)
    expect(persistentSpawns).toHaveLength(1)
    expect(oneShotSpawns).toHaveLength(0)
    expect(persistentSpawns[0]!.lines).toHaveLength(2)
    const turn2Msg = JSON.parse(persistentSpawns[0]!.lines[1]!) as { event: string; message: { content: string } }
    expect(turn2Msg.message.content).toBe("second question")

    persistentSpawns[0]!.opts.onStdoutLine(JSON.stringify({
      event: "result",
      result: { conversation_id: "agy-warm-conv-1", status: "SUCCESS", response: "second answer" },
    }))
    await Bun.sleep(5)
    expect(stops).toHaveLength(2)
    expect(stops[1]!.reply).toBe("second answer")

    await runner.stopAgent()
    expect(persistentSpawns[0]!.killed).toBe(true)
    setKv("brain_model", "auto")
  })

  test("seamlessly falls back to one-shot agy --print --conversation when the warm daemon crashes mid-turn", async () => {
    setKv("brain_model", "gemini-4-argon-high")
    setKv("agy_conversation_id", "agy-saved-conv-99")
    const persistentSpawns: SpawnWorkerOpts[] = []
    const oneShotSpawns: SpawnWorkerOpts[] = []
    const stops: Array<{ sid: string; reply: string }> = []

    const runner = createHeadlessBrainRunner({
      noteActivity: () => {},
      onStop: async (sid, reply) => { stops.push({ sid, reply }) },
      spawnPersistentWorker: (opts): SpawnedPersistentWorkerHandle => {
        persistentSpawns.push(opts)
        return {
          pid: 7272,
          writeLine() { return true },
          closeInput() {},
          kill() {},
        }
      },
      spawnWorker: (opts) => {
        oneShotSpawns.push(opts)
        queueMicrotask(() => {
          opts.onStdoutLine(JSON.stringify({
            event: "result",
            result: { conversation_id: "agy-saved-conv-99", status: "SUCCESS", response: "recovered via fallback" },
          }))
          opts.onExit(0, null)
        })
        return { pid: 8282, kill() {} }
      },
      log: () => {},
    })

    await runner.spawn("resumed-brain-sid")
    const res = await runner.deliver("urgent question")
    expect(res.status).toBe(200)
    expect(persistentSpawns).toHaveLength(1)
    expect(persistentSpawns[0]!.args).toContain("--conversation")
    expect(persistentSpawns[0]!.args).toContain("agy-saved-conv-99")

    // Simulate warm daemon crashing mid-turn before emitting result
    persistentSpawns[0]!.onExit(1, null)
    await Bun.sleep(10)

    // Seamlessly fell back to one-shot agy --print with --conversation agy-saved-conv-99
    expect(oneShotSpawns).toHaveLength(1)
    expect(oneShotSpawns[0]!.args).toContain("--print=urgent question")
    expect(oneShotSpawns[0]!.args).toContain("--conversation")
    expect(oneShotSpawns[0]!.args).toContain("agy-saved-conv-99")
    expect(oneShotSpawns[0]!.args).toContain("--settings")
    expect(oneShotSpawns[0]!.args).toContain(agyBrainSettings())
    expect(stops).toEqual([{ sid: "resumed-brain-sid", reply: "recovered via fallback" }])
    expect(await runner.agentStatus()).toBe("idle")

    await runner.stopAgent()
    setKv("brain_model", "auto")
  })
})
