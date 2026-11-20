import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BRAIN_AGENT } from "../lib/brain"
import { getKv, setKv } from "../lib/brain-store"
import { extractLastAssistantMessage } from "../lib/last-assistant"
import { companionLog } from "../lib/log"
import { transcriptPath } from "../lib/session-titles"
import { type Session, listSessions, recordSession, removeSessionByKey, setSessionModel } from "../lib/sessions"
import { type SpawnResult, ensureFolderTrusted } from "../lib/spawn-session"
import { type SpawnedWorkerHandle, buildHeadlessClaudeArgs, defaultSpawnWorker, parseStreamJsonLine } from "../lib/worker-supervisor"
import { agyBin, buildHeadlessGeminiArgs } from "../lib/worker-invocation"
import { brainWorkers } from "./brain-workers"
import { commandCatalog } from "../lib/command-catalog"

/** The brain's cwd: its CLAUDE.md + .claude/settings.json (repo `brain/`, or COMPANION_BRAIN_DIR). */
export const BRAIN_DIR = process.env.COMPANION_BRAIN_DIR?.trim() || join(import.meta.dir, "..", "..", "brain")
export const HEADLESS_BRAIN_PANE = "headless:brain"

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
  if (env.COMPANION_BRAIN_FAMILY?.trim().toLowerCase() === "gemini") return "gemini-4-carbon-high"
  return "claude-opus-5-5"
}

const AGY_BOOT_PREFIX =
  "[System: Read ./CLAUDE.md and ./AGENTS.md and follow them strictly. You are the read-only Brain: never edit or write files; use bin/* CLI tools and MCP servers.]\n\n"

export function createHeadlessBrainRunner(hooks: {
  noteActivity(sid: string, call?: { phase: "pre" | "post"; tool: string; input: Record<string, unknown>; toolUseId: string }): void
  onStop(sid: string, reply: string): Promise<void>
}) {
  let currentSessionId = ""
  let agyConversationId = ""
  let sessionModel: string | null = null
  let sessionStarted = false
  let brainAlive = false
  let activeHandle: SpawnedWorkerHandle | null = null
  let activePid: number | null = null
  let delivering = false
  let lastTurnReply = ""
  let sweptLegacyHerdr = false
  let mcpConfig = ""

  function purgeStaleBrainSessions(): void {
    for (const s of listSessions()) {
      if (s.taskId === BRAIN_AGENT || s.herdrPane === HEADLESS_BRAIN_PANE) {
        removeSessionByKey(s.key)
      }
    }
  }

  function syncSession(activeTurnModel?: string): Session | null {
    if (!brainAlive || !currentSessionId) return null
    const model = activeTurnModel || sessionModel || resolveBrainSessionModel(getBrainModel())
    const family = brainFamilyForModel(model)
    const busyNow = activeHandle !== null || delivering
    const s = recordSession({
      cwd: BRAIN_DIR,
      agent: family,
      sessionId: currentSessionId,
      label: "brain",
      title: "Brain",
      taskId: BRAIN_AGENT,
      herdrPane: HEADLESS_BRAIN_PANE,
      herdrAgent: BRAIN_AGENT,
      agentStatus: busyNow ? "busy" : "idle",
      pid: String(activePid ?? process.pid),
      model,
    }, { sessionIdConfirmed: true })
    if (s) setSessionModel(s.key, model)
    return s
  }

  return {
    syncSession,
    setModel(model: string): void {
      const m = model.trim()
      if (!m) return
      const prevFamily = sessionModel ? brainFamilyForModel(sessionModel) : null
      const nextModel = resolveBrainSessionModel(m)
      const nextFamily = brainFamilyForModel(nextModel)
      setKv("brain_model", m)
      sessionModel = nextModel
      if (prevFamily && prevFamily !== nextFamily) {
        // Family switched (Claude <-> Gemini): start a fresh CLI conversation without
        // breaking brain.ts's adopted sessionId or leaking a Claude UUID into agy.
        agyConversationId = ""
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
        setKv("agy_conversation_id", "")
      } else if (family === "gemini") {
        agyConversationId = savedAgyConv
      }
      currentSessionId = hasResumeTranscript && resume ? resume : randomUUID()
      sessionStarted = hasResumeTranscript
      brainAlive = true
      lastTurnReply = ""
      syncSession(sessionModel)
      return { ok: true, app: "herdr", herdrPane: HEADLESS_BRAIN_PANE, sessionName: BRAIN_AGENT }
    },
    async stopAgent(): Promise<void> {
      brainAlive = false
      const h = activeHandle
      activeHandle = null
      activePid = null
      if (h) h.kill("SIGTERM")
    },
    async interrupt(): Promise<void> {
      const h = activeHandle
      activeHandle = null
      activePid = null
      if (h) h.kill("SIGTERM")
      syncSession()
    },
    agentStatus(): Promise<string> {
      return Promise.resolve(activeHandle !== null || delivering ? "busy" : "idle")
    },
    async lastReply(s: Session): Promise<string> {
      if (lastTurnReply) return lastTurnReply
      return extractLastAssistantMessage(transcriptPath(s.cwd, s.sessionId))
    },
    async deliver(text: string): Promise<Response> {
      if (!brainAlive || !currentSessionId) {
        return Response.json({ ok: false, error: "brain_not_running" }, { status: 503 })
      }
      if (activeHandle !== null || delivering) {
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
      const cmd = family === "gemini" ? agyBin() : "claude"
      const args = family === "gemini"
        ? buildHeadlessGeminiArgs({
            prompt: agyConversationId ? text : `${AGY_BOOT_PREFIX}${text}`,
            sessionId: agyConversationId,
            resume: !!agyConversationId,
            mode: "auto",
            model: turnModel,
          })
        : buildHeadlessClaudeArgs({
            prompt: text,
            sessionId: turnSid,
            resume: sessionStarted,
            mode: "auto",
            model: turnModel,
            mcpConfig: mcpConfig || undefined,
          })
      lastTurnReply = ""
      let settled = false
      try {
        const handle = defaultSpawnWorker({
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
              let call: { phase: "pre" | "post"; tool: string; input: Record<string, unknown>; toolUseId: string } | undefined
              try {
                const raw = JSON.parse(line) as { message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }> } }
                const tu = Array.isArray(raw.message?.content) ? raw.message.content.find((b) => b?.type === "tool_use" && typeof b.name === "string") : undefined
                if (tu?.name) {
                  call = { phase: "pre", tool: tu.name, input: (tu.input && typeof tu.input === "object" ? tu.input : {}), toolUseId: tu.id || `tu_${Date.now()}` }
                }
              } catch { /* ignore */ }
              hooks.noteActivity(currentSessionId, call)
            }
          },
          onStderrLine() {
            if (!settled) hooks.noteActivity(currentSessionId)
          },
          onExit(code, sig) {
            if (settled) return
            settled = true
            delivering = false
            activeHandle = null
            activePid = null
            if (code === 0 && !sig) sessionStarted = true
            syncSession()
            void (async () => {
              const reply = lastTurnReply || await extractLastAssistantMessage(transcriptPath(BRAIN_DIR, currentSessionId)).catch(() => "")
              await hooks.onStop(currentSessionId, reply)
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
        settled = true
        delivering = false
        activeHandle = null
        activePid = null
        syncSession()
        return Response.json({ ok: false, error: (err as Error)?.message ?? String(err) }, { status: 500 })
      }
    },
  }
}
