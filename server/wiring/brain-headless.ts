import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BRAIN_AGENT } from "../lib/brain"
import { getKv, setKv } from "../lib/brain-store"
import {
  type PreparedBrainTurn,
  type SpawnedPersistentWorkerHandle,
  type TurnMetricsTracker,
  defaultSpawnPersistentWorker,
  extractBrainStreamToolCall,
  prepareBrainTurn,
  startBrainTurnMetrics,
} from "../lib/brain-turn-harness"
import { extractLastAssistantMessage } from "../lib/last-assistant"
import { companionLog } from "../lib/log"
import type { TelemetrySink } from "../lib/orchestrator-telemetry"
import { transcriptPath } from "../lib/session-titles"
import { type Session, listSessions, recordSession, removeSessionByKey, setSessionModel } from "../lib/sessions"
import type { DynamicSkillRegistry } from "../lib/skill-retrieval"
import { type SpawnResult, ensureFolderTrusted } from "../lib/spawn-session"
import { type SpawnWorkerOpts, type SpawnedWorkerHandle, buildHeadlessClaudeArgs, defaultSpawnWorker, parseStreamJsonLine } from "../lib/worker-supervisor"
import { DEFAULT_GEMINI_BRAIN_MODEL, agyBin, agyBrainSettings, buildHeadlessGeminiArgs, buildPersistentGeminiArgs, formatGeminiStreamInput } from "../lib/worker-invocation"
import { brainWorkers } from "./brain-workers"
import { commandCatalog } from "../lib/command-catalog"

export { type SpawnedPersistentWorkerHandle, defaultSpawnPersistentWorker }

/** The brain's cwd: its CLAUDE.md + .claude/settings.json (repo `brain/`, or COMPANION_BRAIN_DIR). */
export const BRAIN_DIR = process.env.COMPANION_BRAIN_DIR?.trim() || join(import.meta.dir, "..", "..", "brain")
export const HEADLESS_BRAIN_PANE = "headless:brain"
/** Runtime-injected --allowedTools for headless Brain CLI tools added without touching human-merge brain/.claude/settings.json. */
export const BRAIN_RUNTIME_ALLOWED_TOOLS = [
  "Bash(bin/ui:*)",
  "Bash(./bin/ui:*)",
  "Bash(bin/load-skill:*)",
  "Bash(./bin/load-skill:*)",
] as const

export function buildBrainClaudeArgs(opts: { prompt: string; sessionId: string; resume: boolean; mode: string; model?: string; mcpConfig?: string }): string[] {
  return ["--allowedTools", ...BRAIN_RUNTIME_ALLOWED_TOOLS, ...buildHeadlessClaudeArgs(opts)]
}

/** The brain's --mcp-config (canvas-board-sync A1): only `board`, on loopback, mode 0600, no token inside. */
export function writeBrainMcpConfig(dir = join(homedir(), ".claude-companion"), port = Number(process.env.COMPANION_PORT) || 4245): string {
  const path = join(dir, "brain-mcp.json")
  const headersHelper = join(import.meta.dir, "..", "..", "scripts", "board-mcp-headers.sh")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify({ mcpServers: { board: { type: "http", url: `http://127.0.0.1:${port}/api/mcp/board`, headersHelper } } }, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export type BrainEffortTier = "low" | "medium" | "high"

export function resolveBrainEffortDefault(env: Record<string, string | undefined> = process.env): BrainEffortTier {
  const raw = env.COMPANION_BRAIN_EFFORT_DEFAULT?.trim().toLowerCase()
  return raw === "medium" || raw === "high" || raw === "low" ? raw : "low"
}

function mapBareGeminiBrainModel(raw: string, effort: BrainEffortTier): string {
  const lower = raw.trim().toLowerCase()
  if (lower === "gemini-4-argon" || lower === "gemini 4 argon") return `gemini-4-argon-${effort}`
  if (lower === "gemini-4-carbon" || lower === "gemini 4 carbon") return `gemini-4-carbon-${effort}`
  return raw.trim()
}

export function getBrainModel(env: Record<string, string | undefined> = process.env): string {
  const stored = (getKv("brain_model") || "").trim()
  if (!stored) return "auto"
  const effort = resolveBrainEffortDefault(env)
  if (effort !== "high" && getKv("brain_model_explicit_effort") !== "1") {
    const lower = stored.toLowerCase()
    if (lower === "gemini-4-argon-high" || lower === "gemini 4 argon (high)") return `gemini-4-argon-${effort}`
    if (lower === "gemini-4-carbon-high" || lower === "gemini 4 carbon (high)") return `gemini-4-carbon-${effort}`
  }
  return mapBareGeminiBrainModel(stored, effort)
}

export type BrainFamily = "claude" | "gemini"

export function brainFamilyForModel(model: string): BrainFamily {
  const m = model.trim().toLowerCase()
  return m.startsWith("gemini") || m.startsWith("orchestrator") ? "gemini" : "claude"
}

export function resolveBrainSessionModel(configured: string, env: Record<string, string | undefined> = process.env): string {
  const effort = resolveBrainEffortDefault(env)
  const norm = mapBareGeminiBrainModel(configured, effort)
  if (norm && norm.toLowerCase() !== "auto") return norm
  const envModel = env.COMPANION_BRAIN_DEFAULT_MODEL?.trim()
  if (envModel) return mapBareGeminiBrainModel(envModel, effort)
  if (env.COMPANION_BRAIN_FAMILY?.trim().toLowerCase() === "gemini") {
    return effort === "low" ? DEFAULT_GEMINI_BRAIN_MODEL : `gemini-4-argon-${effort}`
  }
  return "claude-opus-5-5"
}

export const AGY_BOOT_PREFIX =
  "[System: Read ./CLAUDE.md and ./AGENTS.md and follow them strictly. You are the read-only Brain: never edit or write files; use bin/* CLI tools and MCP servers. " +
  "A2UI v1.0 card rules: (1) Non-dictated outbound emails MUST be proposed with `./bin/ui email --to <addr> [--cc <csv>] [--account personal|hello] --subject \"<subj>\" --body \"<body>\" --why \"<why>\"` (tapping Send Email on the card sends directly via gmail.py with the toggled Cc list; use --dry-run only for demos). " +
  "(2) Green PRs needing Jeremie's merge approval (prod-schema, human-merge-path, pr:needs-human, or review-quota holds) MUST be accompanied by `./bin/ui pr --repo <owner/name> --pr <n> [--deploy-repo <name>] --reason \"<why>\"` so Jeremie gets a 1-tap Merge/Refresh card in the feed. " +
  "(3) NEVER call `schedule` or `sleep` (CI and worker completions wake you automatically via `[event]`). " +
  "(4) Delegate repo file grepping/archaeology to headless builders (`bin/worker dispatch`) — inspect only what is required to understand Jeremie's intent (e.g. Canvas screenshot) so Brain turns finish in 1 tool pass.]\n\n"

export function createHeadlessBrainRunner(hooks: {
  noteActivity(sid: string, call?: { phase: "pre" | "post"; tool: string; input: Record<string, unknown>; toolUseId: string }): void
  onStop(sid: string, reply: string): Promise<void>
  spawnWorker?: (opts: SpawnWorkerOpts) => SpawnedWorkerHandle
  spawnPersistentWorker?: (opts: SpawnWorkerOpts) => SpawnedPersistentWorkerHandle
  prewarm?: boolean
  log?: (msg: string) => void
  telemetrySink?: TelemetrySink
  skillRegistry?: DynamicSkillRegistry
  env?: Record<string, string | undefined>
  now?: () => number
}) {
  const spawnOneShot = hooks.spawnWorker ?? defaultSpawnWorker
  const spawnPersistent = hooks.spawnPersistentWorker ?? defaultSpawnPersistentWorker
  const log = hooks.log ?? companionLog
  let currentSessionId = ""
  let agyConversationId = ""
  let agyBootPrefixSent = false
  let sessionModel: string | null = null
  let sessionStarted = false
  let brainAlive = false
  let activeHandle: SpawnedWorkerHandle | null = null
  let activePid: number | null = null
  let delivering = false
  let turnInFlight = false
  let lastTurnReply = ""
  let sweptLegacyHerdr = false
  let mcpConfig = ""
  const sessionInjectedSkills = new Set<string>()
  let warmAgy: { handle: SpawnedPersistentWorkerHandle; model: string } | null = null
  let activeWarmTurn: { prompt: string; turnModel: string; prepared: PreparedBrainTurn; metrics: TurnMetricsTracker; settled: boolean; cancelReason: "interrupt" | "stop" | null } | null = null

  function purgeStaleBrainSessions(): void {
    for (const s of listSessions()) {
      if (s.taskId === BRAIN_AGENT || s.herdrPane === HEADLESS_BRAIN_PANE) {
        removeSessionByKey(s.key)
      }
    }
  }

  function effectivePid(): number {
    if (activePid && activePid > 1) return activePid
    if (warmAgy && warmAgy.handle.pid > 1) return warmAgy.handle.pid
    return process.pid
  }

  function isBusy(): boolean {
    return turnInFlight || activeHandle !== null || delivering
  }

  function syncSession(activeTurnModel?: string): Session | null {
    if (!brainAlive || !currentSessionId) return null
    const model = activeTurnModel || sessionModel || resolveBrainSessionModel(getBrainModel(hooks.env), hooks.env)
    const family = brainFamilyForModel(model)
    const s = recordSession({
      cwd: BRAIN_DIR,
      agent: family,
      sessionId: currentSessionId,
      label: "brain",
      title: "Brain",
      taskId: BRAIN_AGENT,
      herdrPane: HEADLESS_BRAIN_PANE,
      herdrAgent: BRAIN_AGENT,
      agentStatus: isBusy() ? "busy" : "idle",
      pid: String(effectivePid()),
      model,
    }, { sessionIdConfirmed: true })
    if (s) setSessionModel(s.key, model)
    return s
  }

  let warmTurnWatchdog: ReturnType<typeof setTimeout> | null = null
  const clearWarmWatchdog = (): void => {
    if (warmTurnWatchdog) { clearTimeout(warmTurnWatchdog); warmTurnWatchdog = null }
  }

  function stopWarmAgy(reason: "interrupt" | "stop" = "stop"): void {
    clearWarmWatchdog()
    if (activeWarmTurn && !activeWarmTurn.settled) {
      activeWarmTurn.cancelReason = reason
      clearWarmWatchdog(); activeWarmTurn.settled = true
    }
    activeWarmTurn = null
    if (!activeHandle) turnInFlight = false
    const w = warmAgy
    warmAgy = null
    if (!activeHandle) activePid = null
    if (w) {
      w.handle.closeInput()
      w.handle.kill("SIGTERM")
    }
  }

  function newMetrics(sid: string, turnModel: string, prepared: PreparedBrainTurn): TurnMetricsTracker {
    return startBrainTurnMetrics({
      sessionId: sid,
      routeTier: prepared.routeTier,
      modelId: turnModel,
      thinkingLevel: prepared.thinkingLevel,
      injectedSkillCount: prepared.injectedSkillCount,
      estimatedPromptTokens: prepared.estimatedPromptTokens,
      now: hooks.now,
    })
  }

  function startOneShotTurn(prompt: string, turnModel: string, family: BrainFamily, prepared: PreparedBrainTurn): Response {
    let tempPromptDir: string | null = null
    const cleanupPromptDir = (): void => {
      if (!tempPromptDir) return
      const dir = tempPromptDir
      tempPromptDir = null
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    const cmd = family === "gemini" ? agyBin() : "claude"
    const args = family === "gemini"
      ? buildHeadlessGeminiArgs({ prompt, sessionId: agyConversationId, resume: !!agyConversationId, mode: "auto", model: turnModel, settings: agyBrainSettings(), onTempDir: (d) => { tempPromptDir = d } })
      : buildBrainClaudeArgs({ prompt, sessionId: currentSessionId, resume: sessionStarted, mode: "auto", model: turnModel, mcpConfig: mcpConfig || undefined })
    lastTurnReply = ""
    turnInFlight = true
    const metrics = newMetrics(currentSessionId, turnModel, prepared)
    let settled = false
    try {
      const handle = spawnOneShot({
        cmd,
        args,
        cwd: BRAIN_DIR,
        env: { ...process.env, COMPANION_TASK_ID: BRAIN_AGENT, DISPATCH_HEADLESS: "1", COMPANION_BOARD_CALLER: "brain" },
        onStdoutLine(line) {
          commandCatalog.noteLine(BRAIN_DIR, line)
          if (settled) return
          metrics.noteStreamLine(line)
          const ev = parseStreamJsonLine(line)
          if (!ev) return
          if (ev.sessionId) {
            if (family === "gemini") {
              agyConversationId = ev.sessionId
              setKv("agy_conversation_id", ev.sessionId)
            } else {
              currentSessionId = ev.sessionId
            }
            sessionStarted = true
          }
          if (ev.assistantText) {
            lastTurnReply = ev.assistantText
            sessionStarted = true
          }
          if (ev.resultText) {
            lastTurnReply = ev.resultText
            sessionStarted = true
          }
          if (ev.step) {
            hooks.noteActivity(currentSessionId, extractBrainStreamToolCall(line))
          }
        },
        onStderrLine() {
          if (!settled) hooks.noteActivity(currentSessionId)
        },
        onExit(code, sig) {
          cleanupPromptDir()
          if (settled) return
          settled = true
          delivering = false
          turnInFlight = false
          activeHandle = null
          activePid = null
          if (code === 0 && !sig) sessionStarted = true
          syncSession()
          const sid = currentSessionId
          const captured = lastTurnReply
          void metrics.finish({ isError: code !== 0 || !!sig, telemetrySink: hooks.telemetrySink }).catch(() => undefined)
          void (async () => {
            const reply = captured || await extractLastAssistantMessage(transcriptPath(BRAIN_DIR, sid)).catch(() => "")
            await hooks.onStop(sid, reply)
          })()
        },
      })
      delivering = false
      if (!settled) {
        activeHandle = handle
        activePid = handle.pid > 1 ? handle.pid : null
        syncSession(turnModel)
      }
      return Response.json({ ok: true })
    } catch (err) {
      cleanupPromptDir()
      settled = true
      delivering = false
      turnInFlight = false
      activeHandle = null
      activePid = null
      syncSession()
      return Response.json({ ok: false, error: (err as Error)?.message ?? String(err) }, { status: 500 })
    }
  }

  function ensureWarmAgy(turnModel: string): SpawnedPersistentWorkerHandle | null {
    if (warmAgy && warmAgy.model === turnModel) return warmAgy.handle
    if (warmAgy) stopWarmAgy("stop")
    const args = buildPersistentGeminiArgs({
      sessionId: agyConversationId,
      resume: !!agyConversationId,
      mode: "auto",
      model: turnModel,
      settings: agyBrainSettings(),
    })
    try {
      let spawnedHandle: SpawnedPersistentWorkerHandle | null = null
      const handle = spawnPersistent({
        cmd: agyBin(),
        args,
        cwd: BRAIN_DIR,
        env: { ...process.env, COMPANION_TASK_ID: BRAIN_AGENT, DISPATCH_HEADLESS: "1", COMPANION_BOARD_CALLER: "brain" },
        onStdoutLine(line) {
          commandCatalog.noteLine(BRAIN_DIR, line)
          const ev = parseStreamJsonLine(line)
          if (!ev) return
          if (ev.sessionId) {
            agyConversationId = ev.sessionId
            setKv("agy_conversation_id", ev.sessionId)
          }
          const turn = activeWarmTurn
          if (!turn || turn.settled) return
          turn.metrics.noteStreamLine(line)
          if (ev.sessionId) sessionStarted = true
          if (ev.assistantText) {
            lastTurnReply = ev.assistantText
            sessionStarted = true
          }
          if (ev.resultText && !ev.isError) {
            lastTurnReply = ev.resultText
            sessionStarted = true
          }
          if (ev.step) {
            hooks.noteActivity(currentSessionId, extractBrainStreamToolCall(line))
          }
          if (ev.done) {
            turn.settled = true
            activeWarmTurn = null
            if (ev.isError && !lastTurnReply) {
              log(`[brain] warm agy turn error (${ev.resultText || "unknown"}), falling back to agy --print`)
              stopWarmAgy("stop")
              startOneShotTurn(turn.prompt, turn.turnModel, "gemini", turn.prepared)
              return
            }
            delivering = false
            turnInFlight = false
            sessionStarted = true
            syncSession(turn.turnModel)
            const sid = currentSessionId
            const captured = lastTurnReply
            void turn.metrics.finish({ isError: !!ev.isError, telemetrySink: hooks.telemetrySink }).catch(() => undefined)
            void (async () => {
              const reply = captured || await extractLastAssistantMessage(transcriptPath(BRAIN_DIR, sid)).catch(() => "")
              await hooks.onStop(sid, reply)
            })()
          }
        },
        onStderrLine() {
          if (activeWarmTurn && !activeWarmTurn.settled) {
            hooks.noteActivity(currentSessionId)
          }
        },
        onExit(code, sig) {
          if (warmAgy?.handle === spawnedHandle) {
            warmAgy = null
            if (!activeHandle) activePid = null
          }
          const turn = activeWarmTurn
          if (!turn || turn.settled) {
            syncSession()
            return
          }
          turn.settled = true
          activeWarmTurn = null
          if (turn.cancelReason || !brainAlive) {
            delivering = false
            turnInFlight = false
            syncSession()
            return
          }
          log(`[brain] warm agy exited mid-turn (code=${code ?? "null"} sig=${sig ?? "none"}), falling back to agy --print`)
          startOneShotTurn(turn.prompt, turn.turnModel, "gemini", turn.prepared)
        },
      })
      spawnedHandle = handle
      warmAgy = { handle, model: turnModel }
      if (!activeHandle) activePid = handle.pid > 1 ? handle.pid : null
      syncSession(turnModel)
      return handle
    } catch (err) {
      log(`[brain] failed to start warm agy daemon (${(err as Error)?.message ?? String(err)}), will use agy --print fallback`)
      warmAgy = null
      return null
    }
  }

  return {
    syncSession,
    setModel(model: string): void {
      const m = model.trim()
      if (!m) return
      const prevModel = sessionModel
      const prevFamily = sessionModel ? brainFamilyForModel(sessionModel) : null
      const nextModel = resolveBrainSessionModel(m, hooks.env)
      const nextFamily = brainFamilyForModel(nextModel)
      setKv("brain_model", m)
      setKv("brain_model_explicit_effort", /(?:-high|\(high\))$/i.test(m) ? "1" : "")
      sessionModel = nextModel
      if (prevModel && prevModel !== nextModel && !isBusy()) {
        stopWarmAgy("stop")
      }
      if (prevFamily && prevFamily !== nextFamily) {
        stopWarmAgy("stop")
        agyConversationId = ""
        agyBootPrefixSent = false
        sessionInjectedSkills.clear()
        setKv("agy_conversation_id", "")
        sessionStarted = false
      }
      syncSession(sessionModel)
    },
    async alive(): Promise<boolean> {
      if (brainAlive && currentSessionId) {
        syncSession()
        return true
      }
      return false
    },
    async agentPane(): Promise<string> {
      return brainAlive ? HEADLESS_BRAIN_PANE : ""
    },
    async spawn(resume: string | null): Promise<SpawnResult> {
      if (!sweptLegacyHerdr) {
        sweptLegacyHerdr = true
        void brainWorkers.stopBrain().catch(() => undefined)
      }
      stopWarmAgy("stop")
      ensureFolderTrusted(BRAIN_DIR)
      mcpConfig = writeBrainMcpConfig()
      sessionModel = resolveBrainSessionModel(getBrainModel(hooks.env), hooks.env)
      const family = brainFamilyForModel(sessionModel)
      const savedAgyConv = resume ? (getKv("agy_conversation_id") || "").trim() : ""
      const hasResumeTranscript = family === "gemini"
        ? !!savedAgyConv
        : !!resume && existsSync(transcriptPath(BRAIN_DIR, resume))
      sessionInjectedSkills.clear()
      if (!hasResumeTranscript) {
        purgeStaleBrainSessions()
        agyConversationId = ""
        agyBootPrefixSent = false
        setKv("agy_conversation_id", "")
      } else if (family === "gemini") {
        agyConversationId = savedAgyConv
        agyBootPrefixSent = true
      }
      currentSessionId = hasResumeTranscript && resume ? resume : randomUUID()
      sessionStarted = hasResumeTranscript
      brainAlive = true
      lastTurnReply = ""
      if (family === "gemini" && (hooks.prewarm ?? process.env.NODE_ENV !== "test")) {
        ensureWarmAgy(sessionModel)
      }
      syncSession(sessionModel)
      return { ok: true, app: "herdr", herdrPane: HEADLESS_BRAIN_PANE, sessionName: BRAIN_AGENT }
    },
    async stopAgent(): Promise<void> {
      brainAlive = false
      stopWarmAgy("stop")
      const h = activeHandle
      activeHandle = null
      activePid = null
      turnInFlight = false
      delivering = false
      if (h) h.kill("SIGTERM")
    },
    async interrupt(): Promise<void> {
      stopWarmAgy("interrupt")
      const h = activeHandle
      activeHandle = null
      activePid = null
      turnInFlight = false
      delivering = false
      if (h) h.kill("SIGTERM")
      syncSession()
    },
    agentStatus(): Promise<string> {
      return Promise.resolve(isBusy() ? "busy" : "idle")
    },
    async lastReply(s: Session): Promise<string> {
      if (lastTurnReply) return lastTurnReply
      return extractLastAssistantMessage(transcriptPath(s.cwd, s.sessionId))
    },
    async deliver(text: string): Promise<Response> {
      if (!brainAlive || !currentSessionId) {
        return Response.json({ ok: false, error: "brain_not_running" }, { status: 503 })
      }
      if (isBusy()) {
        return Response.json({ ok: false, error: "busy" }, { status: 409 })
      }
      delivering = true
      const turnSid = currentSessionId
      const turnModel = sessionModel ?? resolveBrainSessionModel(getBrainModel(hooks.env), hooks.env)
      sessionModel = turnModel
      const family = brainFamilyForModel(turnModel)
      if (!brainAlive || currentSessionId !== turnSid) {
        delivering = false
        return Response.json({ ok: false, error: "brain_not_running" }, { status: 503 })
      }
      const bootSent = family === "gemini" ? agyBootPrefixSent : sessionStarted
      const prepared = prepareBrainTurn({
        userText: text,
        family,
        bootPrefixSent: bootSent,
        legacyAgyBootPrefix: AGY_BOOT_PREFIX,
        brainDir: BRAIN_DIR,
        sessionId: turnSid,
        alreadyInjectedSkillIds: sessionInjectedSkills,
        registry: hooks.skillRegistry,
        env: hooks.env,
      })
      for (const sid of prepared.newlyInjectedSkillIds) sessionInjectedSkills.add(sid)
      const effectiveModel = family === "gemini" && prepared.routedModelId && getKv("brain_model_explicit_effort") !== "1"
        ? prepared.routedModelId
        : turnModel
      if (family === "gemini") {
        const prompt = prepared.promptToSend
        agyBootPrefixSent = true
        lastTurnReply = ""
        const warmHandle = ensureWarmAgy(effectiveModel)
        if (warmHandle) {
          turnInFlight = true
          activeWarmTurn = { prompt, turnModel: effectiveModel, prepared, metrics: newMetrics(turnSid, effectiveModel, prepared), settled: false, cancelReason: null }
          if (warmHandle.writeLine(formatGeminiStreamInput(prompt))) {
            clearWarmWatchdog()
            const baseMaxMs = Number(process.env.COMPANION_BRAIN_TURN_MAX_MS ?? 300_000)
            const maxTurnMs = baseMaxMs > 0 && prepared.timeoutMs ? Math.max(baseMaxMs, prepared.timeoutMs) : baseMaxMs
            if (maxTurnMs > 0) {
              const watchedTurn = activeWarmTurn
              warmTurnWatchdog = setTimeout(() => {
                warmTurnWatchdog = null
                if (!activeWarmTurn || activeWarmTurn !== watchedTurn || activeWarmTurn.settled) return
                log(`[brain] warm agy turn exceeded ${maxTurnMs}ms watchdog — aborting stuck turn`)
                const captured = lastTurnReply
                void watchedTurn.metrics.finish({ isError: true, telemetrySink: hooks.telemetrySink }).catch(() => undefined)
                stopWarmAgy("interrupt")
                turnInFlight = false
                delivering = false
                syncSession()
                void hooks.onStop(turnSid, captured || "")
              }, maxTurnMs)
              warmTurnWatchdog.unref?.()
            }
            delivering = false
            activePid = warmHandle.pid > 1 ? warmHandle.pid : null
            syncSession(effectiveModel)
            return Response.json({ ok: true })
          }
          log("[brain] warm agy stdin write failed, falling back to agy --print")
          stopWarmAgy("stop")
        }
        return startOneShotTurn(prompt, effectiveModel, "gemini", prepared)
      }
      return startOneShotTurn(prepared.promptToSend, effectiveModel, "claude", prepared)
    },
  }
}
