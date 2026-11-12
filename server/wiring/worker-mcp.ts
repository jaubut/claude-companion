import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { BRAIN_THREAD, brainEnabled } from "../lib/brain"
import { realSh } from "../lib/live-repo"
import { appendTurn } from "../lib/orchestrator-chat"
import { recordSession, setSessionModel } from "../lib/sessions"
import { ensureFolderTrusted } from "../lib/spawn-session"
import { createWorkerMcpHandler } from "../lib/worker-mcp"
import { createWorkerSupervisor } from "../lib/worker-supervisor"
import { HOST_INFO } from "../state"
import { builderJobs } from "./builder-jobs"
import { orchEmit } from "./orchestrator"

const DEFAULT_FAMILY_MODELS = {
  claude: "claude-opus-5-5",
  codex: "gpt-5.4",
  gemini: "gemini-3.1-pro-preview",
} as const

// Live Inverted MCP worker supervisor & handler wired to Companion's BuilderJobStore and Session registry.
export const workerSupervisor = createWorkerSupervisor({
  host: HOST_INFO.name,
  home: homedir(),
  now: Date.now,
  uuid: randomUUID,
  sh: realSh,
  trust: (dir) => ensureFolderTrusted(dir),
  reportJob: (r) => builderJobs.report(r),
  syncSession: (task, pid) => {
    const model = task.model || DEFAULT_FAMILY_MODELS[task.family]
    const recorded = recordSession({
      cwd: task.worktree,
      agent: task.family,
      sessionId: task.sessionId,
      label: `${task.repo} · ${task.taskId}`,
      title: task.title,
      taskId: task.taskId,
      herdrPane: `headless:worker:${task.taskId}`,
      herdrAgent: task.builder,
      agentStatus: task.status === "running" ? "busy" : "idle",
      pid: String(pid ?? process.pid),
      model,
    }, { sessionIdConfirmed: true })
    if (recorded && model) {
      setSessionModel(recorded.key, model)
    }
  },
  onTaskTerminal: (task) => {
    if (!brainEnabled()) return
    const text = task.status === "completed"
      ? task.prUrl
        ? `PR ready [${task.taskId}] ${task.repo} — ${task.prUrl}${task.result ? `\nResult: ${task.result.slice(0, 600)}` : ""}`
        : `completed [${task.taskId}] ${task.repo} — ${task.title}${task.result ? `\nResult: ${task.result.slice(0, 600)}` : ""}`
      : `blocked [${task.taskId}] ${task.repo} — ${task.title}\nError: ${(task.error || "worker failed").slice(0, 400)}`
    orchEmit(appendTurn("orchestrator", text, task.taskId, BRAIN_THREAD))
  },
})

export const workerMcp = createWorkerMcpHandler({
  supervisor: workerSupervisor,
  localHost: HOST_INFO.name,
})
