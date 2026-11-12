import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { BRAIN_AGENT } from "../lib/brain"
import { getKv, setKv } from "../lib/brain-store"
import { decideBrainTurnModel } from "../lib/jev-model-router"
import { extractLastAssistantMessage } from "../lib/last-assistant"
import { companionLog } from "../lib/log"
import { transcriptPath } from "../lib/session-titles"
import { type Session, recordSession, setSessionModel } from "../lib/sessions"
import { type SpawnResult, ensureFolderTrusted } from "../lib/spawn-session"
import { type SpawnedWorkerHandle, buildHeadlessClaudeArgs, defaultSpawnWorker, parseStreamJsonLine } from "../lib/worker-supervisor"
import { brainWorkers } from "./brain-workers"

/** The brain's cwd: its CLAUDE.md + .claude/settings.json (repo `brain/`, or COMPANION_BRAIN_DIR). */
export const BRAIN_DIR = process.env.COMPANION_BRAIN_DIR?.trim() || join(import.meta.dir, "..", "..", "brain")
export const HEADLESS_BRAIN_PANE = "headless:brain"

export function getBrainModel(): string {
  return getKv("brain_model") || "auto"
}

export function createHeadlessBrainRunner(hooks: {
  noteActivity(sid: string): void
  onStop(sid: string, reply: string): Promise<void>
}) {
  let currentSessionId = ""
  let sessionStarted = false
  let brainAlive = false
  let activeHandle: SpawnedWorkerHandle | null = null
  let activePid: number | null = null
  let delivering = false
  let lastTurnReply = ""
  let sweptLegacyHerdr = false

  function syncSession(activeTurnModel?: string): Session | null {
    if (!brainAlive || !currentSessionId) return null
    const model = activeTurnModel || getBrainModel()
    const busyNow = activeHandle !== null || delivering
    const s = recordSession({
      cwd: BRAIN_DIR,
      agent: "claude",
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
      setKv("brain_model", m)
      syncSession()
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
      const hasResumeTranscript = !!resume && existsSync(transcriptPath(BRAIN_DIR, resume))
      currentSessionId = hasResumeTranscript ? resume! : randomUUID()
      sessionStarted = hasResumeTranscript
      brainAlive = true
      lastTurnReply = ""
      syncSession()
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
      let turnModel = getBrainModel()
      try {
        const decision = await decideBrainTurnModel(text, turnModel)
        turnModel = decision.model
        if (decision.source === "jev" || decision.reason === "control_turn") {
          companionLog(`brain model-router → ${turnModel} (${decision.reason}, ${decision.jevMs}ms)`)
        }
      } catch {
        // Fallback to configured model on any unexpected error.
      }
      if (!brainAlive || currentSessionId !== turnSid) {
        delivering = false
        return Response.json({ ok: false, error: "brain_not_running" }, { status: 503 })
      }
      const args = buildHeadlessClaudeArgs({
        prompt: text,
        sessionId: turnSid,
        resume: sessionStarted,
        mode: "auto",
        model: turnModel,
      })
      lastTurnReply = ""
      let settled = false
      try {
        const handle = defaultSpawnWorker({
          cmd: "claude",
          args,
          cwd: BRAIN_DIR,
          env: { ...process.env, COMPANION_TASK_ID: BRAIN_AGENT, DISPATCH_HEADLESS: "1" },
          onStdoutLine(line) {
            if (settled) return
            const ev = parseStreamJsonLine(line)
            if (!ev) return
            if (ev.sessionId) {
              currentSessionId = ev.sessionId
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
              hooks.noteActivity(currentSessionId)
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
