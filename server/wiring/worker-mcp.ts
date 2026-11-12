import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { BRAIN_THREAD, LEAD_PREFIX, brainEnabled } from "../lib/brain"
import { realSh } from "../lib/live-repo"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { listSessions, recordSession, setSessionModel } from "../lib/sessions"
import { ensureFolderTrusted } from "../lib/spawn-session"
import { realGh } from "../lib/triage-pr"
import { tursoExec } from "../lib/turso"
import { createWorkerMcpHandler } from "../lib/worker-mcp"
import { backfillWorkerPrLinks, bindWorkerTask, linkWorkerPr, workerReceipt } from "../lib/worker-pr-link"
import { type SupervisedTaskSnapshot, createWorkerSupervisor, workerStateFile } from "../lib/worker-supervisor"
import { HOST_INFO } from "../state"
import { getBrainDeliver } from "./brain"
import { builderJobs } from "./builder-jobs"
import { orchEmit } from "./orchestrator"

const DEFAULT_FAMILY_MODELS = {
  claude: "claude-sonnet-5-5",
  codex: "gpt-5.4",
  gemini: "gemini-3.1-pro-preview",
} as const
/** How long a "PR ready" turn waits for its PR link before it reads completed. */
const LINK_DEADLINE_MS = 20_000

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
  // Bind at dispatch on a verified handoff claim, link before the turn reads completed (lib/worker-pr-link.ts); bounded, never fails the turn.
  bindTask: (taskId, repo, claim) => bindWorkerTask(tursoExec, taskId, repo, claim),
  linkPr: (task, claim) => linkWorkerPr({ gh: realGh, exec: tursoExec }, { taskId: task.taskId, repo: task.repo, prUrl: task.prUrl ?? "", claim }, { deadlineMs: LINK_DEADLINE_MS })
    .then((outcome) => { companionLog(`[worker] ${task.taskId.slice(0, 8)} pr link ${task.prUrl}: ${outcome}`); return outcome }),
  onTaskTerminal: (task) => notifyBrain(task),
})

/** A link lost to a restart or past the retries: once at server start, tasks whose claim verifies and row is still unlinked. */
export function replayWorkerPrLinks(): void {
  if (process.env.NODE_ENV === "test") return // real gh + the real state file
  void backfillWorkerPrLinks({ gh: realGh, exec: tursoExec, log: (l) => companionLog(`[worker] pr link replay ${l}`) }, workerStateFile(homedir()), { write: true })
}

function notifyBrain(task: SupervisedTaskSnapshot): void {
  if (!brainEnabled()) return
  const text = workerReceipt(task)
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
}

export const workerMcp = createWorkerMcpHandler({
  supervisor: workerSupervisor,
  localHost: HOST_INFO.name,
})
