import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { BRAIN_THREAD, LEAD_PREFIX, brainEnabled } from "../lib/brain"
import { DISPATCH_ID } from "../lib/dispatch-tasks"
import { realSh } from "../lib/live-repo"
import { appendTurn } from "../lib/orchestrator-chat"
import { listSessions, recordSession, setSessionModel } from "../lib/sessions"
import { ensureFolderTrusted } from "../lib/spawn-session"
import { createWorkerMcpHandler } from "../lib/worker-mcp"
import { type SupervisedTaskSnapshot, createWorkerSupervisor } from "../lib/worker-supervisor"
import { HOST_INFO } from "../state"
import { getBrainDeliver } from "./brain"
import { builderJobs } from "./builder-jobs"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

const DEFAULT_FAMILY_MODELS = {
  claude: "claude-sonnet-5-5",
  codex: "gpt-5.4",
  gemini: "gemini-3.1-pro-preview",
} as const

/** Track last synced Turso state per taskId so we don't spam identical SQL updates on every progress event. */
const lastTursoSync = new Map<string, string>()

/**
 * Keep the Turso `tasks` row in sync when a headless worker starts, opens a PR, or finishes.
 * Linking `dispatch_pr_url` as soon as the worker outputs a PR URL ensures `pr-shepherd` and `merge-gate`
 * see the task's `origin` (e.g. `jeremie`) instead of treating the PR as an unlinked `tainted (unknown)` PR.
 */
export async function syncWorkerTaskToTurso(
  task: Pick<SupervisedTaskSnapshot, "taskId" | "status" | "prUrl" | "error">,
  exec: typeof dispatchWiring.exec = (sql, args) => dispatchWiring.exec(sql, args),
): Promise<void> {
  if (!DISPATCH_ID.test(task.taskId)) return
  const key = `${task.status}|${task.prUrl ?? ""}|${task.error ?? ""}`
  if (lastTursoSync.get(task.taskId) === key) return
  lastTursoSync.set(task.taskId, key)
  const owner = `companion:worker:${HOST_INFO.name.toLowerCase()}`
  try {
    if (task.status === "running") {
      await exec(
        "UPDATE tasks SET dispatch_status = 'running', dispatch_started_at = COALESCE(dispatch_started_at, datetime('now')), dispatch_owner = ?, dispatch_pr_url = COALESCE(?, dispatch_pr_url), dispatch_blocker = NULL, updated_at = datetime('now') WHERE id = ? AND done = 0",
        [owner, task.prUrl ?? null, task.taskId],
      )
    } else if (task.status === "completed") {
      await exec(
        "UPDATE tasks SET dispatch_status = 'completed', dispatch_completed_at = datetime('now'), dispatch_owner = COALESCE(dispatch_owner, ?), dispatch_pr_url = COALESCE(?, dispatch_pr_url), dispatch_blocker = NULL, updated_at = datetime('now') WHERE id = ? AND done = 0",
        [owner, task.prUrl ?? null, task.taskId],
      )
    } else if (task.status === "failed") {
      await exec(
        "UPDATE tasks SET dispatch_status = 'failed', dispatch_completed_at = datetime('now'), dispatch_blocker = ?, updated_at = datetime('now') WHERE id = ? AND done = 0",
        [(task.error || "worker failed").slice(0, 400), task.taskId],
      )
    }
  } catch {
    lastTursoSync.delete(task.taskId)
  }
}

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
      title: task.status === "running" && task.step ? `${task.title} · ${task.step}` : task.title,
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
    void syncWorkerTaskToTurso(task)
  },
  onTaskTerminal: (task) => {
    void syncWorkerTaskToTurso(task)
    if (!brainEnabled()) return
    const text = task.status === "completed"
      ? task.prUrl
        ? `PR ready [${task.taskId}] ${task.repo} — ${task.prUrl}${task.result ? `\nResult: ${task.result.slice(0, 600)}` : ""}`
        : `completed [${task.taskId}] ${task.repo} — ${task.title}${task.result ? `\nResult: ${task.result.slice(0, 600)}` : ""}`
      : `blocked [${task.taskId}] ${task.repo} — ${task.title}\nError: ${(task.error || "worker failed").slice(0, 400)}`
    const leadTask = `${LEAD_PREFIX}${task.repo}`
    const leadSession = listSessions().find((s) => s.taskId === leadTask)
    const deliver = getBrainDeliver()
    if (leadSession && deliver) {
      void deliver(`[from worker] ${text}\n(Inspect CI/reviews and run any fix rounds; only tell-brain when ready to merge/close or if Jeremie must decide.)`, leadSession.key)
        .then(async (res) => {
          const out = await res.json().catch(() => ({})) as { ok?: unknown }
          if (!res.ok || out.ok !== true) {
            orchEmit(appendTurn("orchestrator", text, task.taskId, BRAIN_THREAD))
          }
        })
        .catch(() => {
          orchEmit(appendTurn("orchestrator", text, task.taskId, BRAIN_THREAD))
        })
      return
    }
    orchEmit(appendTurn("orchestrator", text, task.taskId, BRAIN_THREAD))
  },
})

export const workerMcp = createWorkerMcpHandler({
  supervisor: workerSupervisor,
  localHost: HOST_INFO.name,
})
