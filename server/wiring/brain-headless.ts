import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { BRAIN_AGENT } from "../lib/brain"
import { getKv } from "../lib/brain-store"
import { type Session, recordSession, setSessionModel } from "../lib/sessions"
import { type SpawnResult, ensureFolderTrusted } from "../lib/spawn-session"
import { extractLastAssistantMessage } from "../lib/last-assistant"
import { transcriptPath } from "../lib/session-titles"
import { type SpawnedWorkerHandle, buildHeadlessClaudeArgs, defaultSpawnWorker, parseStreamJsonLine } from "../lib/worker-supervisor"
import { brainWorkers } from "./brain-workers"

// Headless brain runner (BKM-Q24R: stream-json supervisor, zero herdr/tmux). Split out of brain.ts;
// the supervisor's hooks are injected so this module never imports brain.ts.

/** The brain's cwd: its CLAUDE.md + .claude/settings.json (repo `brain/`, or COMPANION_BRAIN_DIR). */
export const BRAIN_DIR = process.env.COMPANION_BRAIN_DIR?.trim() || join(import.meta.dir, "..", "..", "brain")
export const HEADLESS_BRAIN_PANE = "headless:brain"

export function getBrainModel(): string {
  return getKv("brain_model") || "claude-sonnet-5-5"
}

/** What the runner tells the supervisor: the brain is alive (stream output), and its turn ended with this reply. */
export interface HeadlessBrainHooks { noteActivity(sid: string): void; onStop(sid: string, reply: string): Promise<void> }

export function createHeadlessBrainRunner(hooks: HeadlessBrainHooks) {
  let currentSessionId = ""
  let sessionStarted = false
  let brainAlive = false
  let activeHandle: SpawnedWorkerHandle | null = null
  let activePid: number | null = null
  let lastTurnReply = ""
  let sweptLegacyHerdr = false

  function syncSession(): Session | null {
    if (!brainAlive || !currentSessionId) return null
    const model = getBrainModel()
    const busyNow = activeHandle !== null
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
      return Promise.resolve(activeHandle !== null ? "busy" : "idle")
    },
    async lastReply(s: Session): Promise<string> {
      if (lastTurnReply) return lastTurnReply
      return extractLastAssistantMessage(transcriptPath(s.cwd, s.sessionId))
    },
    async deliver(text: string): Promise<Response> {
      if (!brainAlive || !currentSessionId) {
        return Response.json({ ok: false, error: "brain_not_running" }, { status: 503 })
      }
      if (activeHandle !== null) {
        return Response.json({ ok: false, error: "busy" }, { status: 409 })
      }
      const turnSid = currentSessionId
      const args = buildHeadlessClaudeArgs({
        prompt: text,
        sessionId: turnSid,
        resume: sessionStarted,
        mode: "auto",
        model: getBrainModel(),
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
        if (!settled) {
          activeHandle = handle
          activePid = handle.pid > 1 ? handle.pid : null
          syncSession()
        }
        return Response.json({ ok: true })
      } catch (err) {
        settled = true
        activeHandle = null
        activePid = null
        syncSession()
        return Response.json({ ok: false, error: (err as Error)?.message ?? String(err) }, { status: 500 })
      }
    },
  }
}
