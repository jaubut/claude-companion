import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BRAIN_AGENT } from "../lib/brain"
import { getKv, setKv } from "../lib/brain-store"
import { extractLastAssistantMessage } from "../lib/last-assistant"
import { companionLog } from "../lib/log"
import { transcriptPath } from "../lib/session-titles"
import { type Session, listSessions, recordSession, removeSessionByKey, setSessionModel } from "../lib/sessions"
import { type SpawnResult, ensureFolderTrusted } from "../lib/spawn-session"
import { defaultKillPid } from "../lib/worker-pid"
import { type SpawnWorkerOpts, type SpawnedWorkerHandle, buildHeadlessClaudeArgs, defaultSpawnWorker, parseStreamJsonLine } from "../lib/worker-supervisor"
import { agyBin, buildHeadlessGeminiArgs, buildPersistentGeminiArgs, formatGeminiStreamInput } from "../lib/worker-invocation"
import { brainWorkers } from "./brain-workers"
import { commandCatalog } from "../lib/command-catalog"

export interface SpawnedPersistentWorkerHandle extends SpawnedWorkerHandle {
  writeLine(line: string): boolean
  closeInput(): void
}

export function defaultSpawnPersistentWorker(opts: SpawnWorkerOpts): SpawnedPersistentWorkerHandle {
  const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true })
  let outBuf = "", errBuf = "", closed = false
  child.stdin?.on("error", () => { closed = true })
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    outBuf += chunk; const lines = outBuf.split("\n"); outBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStdoutLine(l)
  })
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    errBuf += chunk; const lines = errBuf.split("\n"); errBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStderrLine(l)
  })
  child.on("error", (err) => { closed = true; opts.onStderrLine(err.message); opts.onExit(1, null) })
  child.on("close", (code, sig) => {
    closed = true
    if (outBuf.trim()) opts.onStdoutLine(outBuf)
    if (errBuf.trim()) opts.onStderrLine(errBuf)
    opts.onExit(code, sig)
  })
  return {
    pid: child.pid ?? 0,
    writeLine(line: string): boolean {
      if (closed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false
      try {
        child.stdin.write(line.endsWith("\n") ? line : `${line}\n`, "utf8")
        return true
      } catch {
        closed = true
        return false
      }
    },
    closeInput() {
      closed = true
      try { child.stdin?.end() } catch { /* ignore */ }
    },
    kill(sig: NodeJS.Signals) {
      closed = true
      try { child.stdin?.destroy() } catch { /* ignore */ }
      if (child.pid) defaultKillPid(child.pid, sig)
    },
  }
}

/** The brain's cwd: its CLAUDE.md + .claude/settings.json (repo `brain/`, or COMPANION_BRAIN_DIR). */
export const BRAIN_DIR = process.env.COMPANION_BRAIN_DIR?.trim() || join(import.meta.dir, "..", "..", "brain")
export const HEADLESS_BRAIN_PANE = "headless:brain"
/** Runtime-injected --allowedTools for headless Brain CLI tools added without touching human-merge brain/.claude/settings.json. */
export const BRAIN_RUNTIME_ALLOWED_TOOLS = ["Bash(bin/ui:*)", "Bash(./bin/ui:*)"] as const

export function buildBrainClaudeArgs(opts: {
  prompt: string
  sessionId: string
  resume: boolean
  mode: string
  model?: string
  mcpConfig?: string
}): string[] {
  return ["--allowedTools", ...BRAIN_RUNTIME_ALLOWED_TOOLS, ...buildHeadlessClaudeArgs(opts)]
}

/**
 * The brain's --mcp-config (canvas-board-sync A1): only `board`, on loopback,
 * the same definition as the user-scope entry (scripts/board-mcp-register.ts).
 * No token inside: the headersHelper reads it at connect time. Mode 0600.
 */
export function writeBrainMcpConfig(dir = join(homedir(), ".claude-companion"), port = Number(process.env.COMPANION_PORT) || 4245): string {
  const path = join(dir, "brain-mcp.json")
  const headersHelper = join(import.meta.dir, "..", "..", "scripts", "board-mcp-headers.sh")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify({ mcpServers: { board: { type: "http", url: `http://127.0.0.1:${port}/api/mcp/board`, headersHelper } } }, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function getBrainModel(): string {
  return getKv("brain_model") || "auto"
}

export type BrainFamily = "claude" | "gemini"

export function brainFamilyForModel(model: string): BrainFamily {
  const m = model.trim().toLowerCase()
  if (m.startsWith("gemini") || m.startsWith("orchestrator")) return "gemini"
  return "claude"
}

export function resolveBrainSessionModel(configured: string, env: Record<string, string | undefined> = process.env): string {
  const norm = configured.trim()
  if (norm && norm.toLowerCase() !== "auto") return norm
  const envModel = env.COMPANION_BRAIN_DEFAULT_MODEL?.trim()
  if (envModel) return envModel
  if (env.COMPANION_BRAIN_FAMILY?.trim().toLowerCase() === "gemini") return "gemini-4-argon-high"
  return "claude-opus-5-5"
}

export const AGY_BOOT_PREFIX =
  "[System: Read ./CLAUDE.md and ./AGENTS.md and follow them strictly. You are the read-only Brain: never edit or write files; use bin/* CLI tools and MCP servers. " +
  "A2UI v1.0 card rules: (1) Non-dictated outbound emails MUST be proposed with `./bin/ui email --to <addr> [--cc <csv>] [--account personal|hello] --subject \"<subj>\" --body \"<body>\" --why \"<why>\"` (tapping Send Email on the card sends directly via gmail.py with the toggled Cc list; use --dry-run only for demos). " +
  "(2) Green PRs needing Jeremie's merge approval (prod-schema, human-merge-path, pr:needs-human, or review-quota holds) MUST be accompanied by `./bin/ui pr --repo <owner/name> --pr <n> [--deploy-repo <name>] --reason \"<why>\"` so Jeremie gets a 1-tap Merge/Refresh card in the feed.]\n\n"

function extractToolCall(line: string): { phase: "pre" | "post"; tool: string; input: Record<string, unknown>; toolUseId: string } | undefined {
  try {
    const raw = JSON.parse(line) as {
      event?: string
      step_update?: { step_type?: string; state?: string; tool_name?: string; step_index?: number; tool_info?: { name?: string; parameters?: Record<string, unknown> } }
      message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }> }
    }
    const tu = Array.isArray(raw.message?.content) ? raw.message.content.find((b) => b?.type === "tool_use" && typeof b.name === "string") : undefined
    if (tu?.name) {
      return { phase: "pre", tool: tu.name, input: (tu.input && typeof tu.input === "object" ? tu.input : {}), toolUseId: tu.id || `tu_${Date.now()}` }
    }
    if (raw.event === "step_update" && raw.step_update?.step_type === "tool" && raw.step_update.state === "ACTIVE") {
      const tool = raw.step_update.tool_name || raw.step_update.tool_info?.name
      const params = raw.step_update.tool_info?.parameters
      if (typeof tool === "string" && tool) {
        return {
          phase: "pre",
          tool,
          input: (params && typeof params === "object" && !Array.isArray(params) ? params : {}),
          toolUseId: `agy_tu_${raw.step_update.step_index ?? Date.now()}`,
        }
      }
    }
  } catch { /* ignore */ }
  return undefined
}

export function createHeadlessBrainRunner(hooks: {
  noteActivity(sid: string, call?: { phase: "pre" | "post"; tool: string; input: Record<string, unknown>; toolUseId: string }): void
  onStop(sid: string, reply: string): Promise<void>
  spawnWorker?: (opts: SpawnWorkerOpts) => SpawnedWorkerHandle
  spawnPersistentWorker?: (opts: SpawnWorkerOpts) => SpawnedPersistentWorkerHandle
  prewarm?: boolean
  log?: (msg: string) => void
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
  let warmAgy: { handle: SpawnedPersistentWorkerHandle; model: string } | null = null
  let activeWarmTurn: { prompt: string; turnModel: string; settled: boolean; cancelReason: "interrupt" | "stop" | null } | null = null

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
    const model = activeTurnModel || sessionModel || resolveBrainSessionModel(getBrainModel())
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

  function startOneShotTurn(prompt: string, turnModel: string, family: BrainFamily): Response {
    let tempPromptDir: string | null = null
    const cleanupPromptDir = (): void => {
      if (!tempPromptDir) return
      const dir = tempPromptDir
      tempPromptDir = null
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    const cmd = family === "gemini" ? agyBin() : "claude"
    const args = family === "gemini"
      ? buildHeadlessGeminiArgs({
          prompt,
          sessionId: agyConversationId,
          resume: !!agyConversationId,
          mode: "auto",
          model: turnModel,
          onTempDir: (d) => { tempPromptDir = d },
        })
      : buildBrainClaudeArgs({
          prompt,
          sessionId: currentSessionId,
          resume: sessionStarted,
          mode: "auto",
          model: turnModel,
          mcpConfig: mcpConfig || undefined,
        })
    lastTurnReply = ""
    turnInFlight = true
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
            hooks.noteActivity(currentSessionId, extractToolCall(line))
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
            hooks.noteActivity(currentSessionId, extractToolCall(line))
          }
          if (ev.done) {
            turn.settled = true
            activeWarmTurn = null
            if (ev.isError && !lastTurnReply) {
              log(`[brain] warm agy turn error (${ev.resultText || "unknown"}), falling back to agy --print`)
              stopWarmAgy("stop")
              startOneShotTurn(turn.prompt, turn.turnModel, "gemini")
              return
            }
            delivering = false
            turnInFlight = false
            sessionStarted = true
            syncSession(turn.turnModel)
            const sid = currentSessionId
            const captured = lastTurnReply
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
          startOneShotTurn(turn.prompt, turn.turnModel, "gemini")
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
      const nextModel = resolveBrainSessionModel(m)
      const nextFamily = brainFamilyForModel(nextModel)
      setKv("brain_model", m)
      sessionModel = nextModel
      if (prevModel && prevModel !== nextModel && !isBusy()) {
        stopWarmAgy("stop")
      }
      if (prevFamily && prevFamily !== nextFamily) {
        // Family switched (Claude <-> Gemini): start a fresh CLI conversation without
        // breaking brain.ts's adopted sessionId or leaking a Claude UUID into agy.
        stopWarmAgy("stop")
        agyConversationId = ""
        agyBootPrefixSent = false
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
      sessionModel = resolveBrainSessionModel(getBrainModel())
      const family = brainFamilyForModel(sessionModel)
      const savedAgyConv = resume ? (getKv("agy_conversation_id") || "").trim() : ""
      const hasResumeTranscript = family === "gemini"
        ? !!savedAgyConv
        : !!resume && existsSync(transcriptPath(BRAIN_DIR, resume))
      if (!hasResumeTranscript) {
        // Purge stale brain sessions from the in-memory registry so tick() never
        // re-adopts the previous session id after a rollover or fresh restart.
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
      // Keep one consistent model for the lifetime of a session so Anthropic's
      // per-model prompt cache stays warm (no Opus <-> Sonnet mid-session thrashing).
      const turnModel = sessionModel ?? resolveBrainSessionModel(getBrainModel())
      sessionModel = turnModel
      const family = brainFamilyForModel(turnModel)
      if (!brainAlive || currentSessionId !== turnSid) {
        delivering = false
        return Response.json({ ok: false, error: "brain_not_running" }, { status: 503 })
      }
      if (family === "gemini") {
        const prompt = agyBootPrefixSent ? text : `${AGY_BOOT_PREFIX}${text}`
        agyBootPrefixSent = true
        lastTurnReply = ""
        const warmHandle = ensureWarmAgy(turnModel)
        if (warmHandle) {
          turnInFlight = true
          activeWarmTurn = { prompt, turnModel, settled: false, cancelReason: null }
          if (warmHandle.writeLine(formatGeminiStreamInput(prompt))) {
            clearWarmWatchdog()
            const maxTurnMs = Number(process.env.COMPANION_BRAIN_TURN_MAX_MS ?? 60_000)
            if (maxTurnMs > 0) {
              const watchedTurn = activeWarmTurn
              warmTurnWatchdog = setTimeout(() => {
                warmTurnWatchdog = null
                if (!activeWarmTurn || activeWarmTurn !== watchedTurn || activeWarmTurn.settled) return
                log(`[brain] warm agy turn exceeded ${maxTurnMs}ms watchdog — aborting stuck turn`)
                const captured = lastTurnReply
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
            syncSession(turnModel)
            return Response.json({ ok: true })
          }
          log("[brain] warm agy stdin write failed, falling back to agy --print")
          stopWarmAgy("stop")
        }
        return startOneShotTurn(prompt, turnModel, "gemini")
      }
      return startOneShotTurn(text, turnModel, "claude")
    },
  }
}
