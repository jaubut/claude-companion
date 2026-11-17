import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { BRAIN_THREAD, LEAD_PREFIX, brainEnabled } from "../lib/brain"
import { DISPATCH_ID } from "../lib/dispatch-tasks"
import { realSh } from "../lib/live-repo"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { startGoneSessionPrune } from "../lib/session-prune-gone"
import { listSessions, recordSession, setSessionModel } from "../lib/sessions"
import { ensureFolderTrusted } from "../lib/spawn-session"
import { realGh } from "../lib/triage-pr"
import { tursoExec } from "../lib/turso"
import { createWorkerMcpHandler, defaultResolvePeer, isLocalTarget, relayWorkerReceipts } from "../lib/worker-mcp"
import { backfillWorkerPrLinks, bindWorkerTask, linkWorkerPr } from "../lib/worker-pr-link"
import { createWorkerProgressTrace } from "../lib/worker-progress-trace"
import { type SupervisedTaskSnapshot, createWorkerSupervisor, workerStateFile } from "../lib/worker-supervisor"
import { type WorkerReceipt, deliveredReceiptsFile, loadDeliveredKeys, saveDeliveredKeys } from "../lib/worker-task-store"
import { HOST_INFO } from "../state"
import { emitTrace, getBrainDeliver } from "./brain"
import { builderJobs } from "./builder-jobs"
import { designStateHookContext } from "./design-state"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

const DEFAULT_FAMILY_MODELS = {
  claude: "claude-sonnet-5-5",
  codex: "gpt-5.4",
  gemini: "gemini-3.1-pro-preview",
} as const
/** How long a "PR ready" turn waits for its PR link before it reads completed. */
const LINK_DEADLINE_MS = 20_000

/** Track last synced notes DB state per taskId so we don't spam identical SQL updates on every progress event. */
const lastTursoSync = new Map<string, string>()

/**
 * Keep the notes DB `tasks` row's dispatch status in sync when a headless worker starts or finishes. Only a task bound by
 * a verified handoff claim writes its row: a worker dispatched under a borrowed id never touches it. The PR url is not
 * written here: `dispatch_pr_url` is what pr-shepherd and merge-gate read origin through, so only the claim-checked
 * link (lib/worker-pr-link.ts) sets it.
 */
export async function syncWorkerTaskToTurso(
  task: Pick<SupervisedTaskSnapshot, "taskId" | "status" | "prUrl" | "error">,
  linkBound: boolean,
  exec: typeof dispatchWiring.exec = (sql, args) => dispatchWiring.exec(sql, args),
): Promise<void> {
  if (!linkBound || !DISPATCH_ID.test(task.taskId)) return
  const key = `${task.status}|${task.error ?? ""}`
  if (lastTursoSync.get(task.taskId) === key) return
  lastTursoSync.set(task.taskId, key)
  const owner = `companion:worker:${HOST_INFO.name.toLowerCase()}`
  try {
    if (task.status === "running") {
      await exec(
        "UPDATE tasks SET dispatch_status = 'running', dispatch_started_at = COALESCE(dispatch_started_at, datetime('now')), dispatch_owner = ?, dispatch_blocker = NULL, updated_at = datetime('now') WHERE id = ? AND done = 0",
        [owner, task.taskId],
      )
    } else if (task.status === "completed") {
      await exec(
        "UPDATE tasks SET dispatch_status = 'completed', dispatch_completed_at = datetime('now'), dispatch_owner = COALESCE(dispatch_owner, ?), dispatch_blocker = NULL, updated_at = datetime('now') WHERE id = ? AND done = 0",
        [owner, task.taskId],
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

/** Receipt relay pass interval (brain host): how fast a peer's (Mac) receipt lands; a local turn end kicks a pass at once. */
const RECEIPT_POLL_MS = 10_000
/** Finished tasks' worktrees close once their PR is merged or closed (supervisor.sweepWorktrees). */
const WORKTREE_SWEEP_MS = 5 * 60_000
const DELIVERED_MAX = 1_000
let relayStarted = false
let relaying = false
let relayAgain = false

// The live progress card in the brain thread: brain_trace frames only, never a turn, so the brain isn't woken.
const progressTrace = createWorkerProgressTrace({ host: HOST_INFO.name, now: Date.now, trace: emitTrace })

// Live Inverted MCP worker supervisor & handler wired to Companion's BuilderJobStore and Session registry.
export const workerSupervisor = createWorkerSupervisor({
  host: HOST_INFO.name,
  home: homedir(),
  now: Date.now,
  uuid: randomUUID,
  sh: realSh,
  trust: (dir) => ensureFolderTrusted(dir),
  reportJob: (r) => builderJobs.report(r),
  designContext: () => designStateHookContext(),
  syncSession: (task, pid, linkBound) => {
    // A finished worker leaves the drawer (pruneGoneSessions drops its row); a follow-up dispatch records it again.
    if (task.status !== "running") { void syncWorkerTaskToTurso(task, linkBound); return }
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
    void syncWorkerTaskToTurso(task, linkBound)
  },
  // Bind at dispatch on a verified handoff claim, link before the turn reads completed (lib/worker-pr-link.ts); bounded, never fails the turn.
  bindTask: (taskId, repo, claim) => bindWorkerTask(tursoExec, taskId, repo, claim),
  linkPr: (task, claim) => linkWorkerPr({ gh: realGh, exec: tursoExec }, { taskId: task.taskId, repo: task.repo, prUrl: task.prUrl ?? "", claim }, { deadlineMs: LINK_DEADLINE_MS })
    .then((outcome) => { companionLog(`[worker] ${task.taskId.slice(0, 8)} pr link ${task.prUrl}: ${outcome}`); return outcome }),
  onTaskProgress: (task) => { if (brainEnabled()) progressTrace.update(task) },
  onTaskTerminal: (task, linkBound) => {
    void syncWorkerTaskToTurso(task, linkBound)
    if (brainEnabled()) progressTrace.finish(task)
  },
  // The receipt itself goes through the outbox, on every host: the brain host's relay posts it (kickReceiptRelay).
  onReceipt: () => kickReceiptRelay(),
})

/** Boot (cli.ts): drop finished workers' sessions every few seconds, and close their worktrees once done with. */
export function startWorkerSessionPrune(): void {
  startGoneSessionPrune((id) => workerSupervisor.getTask(id)?.status === "running")
  if (process.env.NODE_ENV === "test") return
  const sweep = () => void workerSupervisor.sweepWorktrees()
    .then((ids) => { if (ids.length) companionLog(`[worker] worktree closed: ${ids.join(", ")}`) })
    .catch((err: unknown) => companionLog(`[worker] worktree sweep: ${(err as Error)?.message ?? String(err)}`))
  sweep()
  setInterval(sweep, WORKTREE_SWEEP_MS).unref?.()
}

/** A link lost to a restart or past the retries: once at server start, tasks whose claim verifies and row is still unlinked. */
export function replayWorkerPrLinks(): void {
  if (process.env.NODE_ENV === "test") return // real gh + the real state file
  void backfillWorkerPrLinks({ gh: realGh, exec: tursoExec, log: (l) => companionLog(`[worker] pr link replay ${l}`) }, workerStateFile(homedir()), { write: true })
}

/** Into the repo lead when one is live, else the brain thread. True once written. */
async function deliverReceipt(text: string, r: WorkerReceipt): Promise<boolean> {
  const leadTask = `${LEAD_PREFIX}${r.task.repo}`
  const leadSession = listSessions().find((s) => s.taskId === leadTask)
  const deliver = getBrainDeliver()
  if (leadSession && deliver) {
    try {
      const res = await deliver(`[from worker] ${text}\n(Inspect CI/reviews and run any fix rounds; only tell-brain when ready to merge/close or if Jeremie must decide.)`, leadSession.key)
      const out = await res.json().catch(() => ({})) as { ok?: unknown }
      if (res.ok && out.ok === true) return true
    } catch { /* the thread below */ }
  }
  orchEmit(appendTurn("orchestrator", text, r.task.taskId, BRAIN_THREAD))
  return true
}

const delivered = (() => {
  const file = deliveredReceiptsFile(homedir())
  const keys = loadDeliveredKeys(file)
  const set = new Set(keys)
  return {
    has: (k: string) => set.has(k),
    add: (k: string) => {
      set.add(k); keys.push(k)
      if (keys.length > DELIVERED_MAX) keys.splice(0, keys.length - DELIVERED_MAX)
      saveDeliveredKeys(file, keys)
    },
  }
})()

/** One relay pass now (or right after the running one). Brain host only, after startWorkerReceiptRelay. */
function kickReceiptRelay(): void {
  if (!relayStarted) return
  if (relaying) { relayAgain = true; return }
  relaying = true
  const peers = (["mac", "zettlab"] as const).filter((h) => !isLocalTarget(h, HOST_INFO.name) && defaultResolvePeer(h))
  void relayWorkerReceipts({ mcp: workerMcp, hosts: ["local", ...peers], delivered, deliver: deliverReceipt })
    .then((n) => { if (n) companionLog(`[worker] ${n} receipt(s) posted`) })
    .catch((err: unknown) => companionLog(`[worker] receipt relay: ${(err as Error)?.message ?? String(err)}`))
    .finally(() => { relaying = false; if (relayAgain) { relayAgain = false; kickReceiptRelay() } })
}

/** Boot (cli.ts), brain host: post every host's worker receipts into the brain thread until each is acked. */
export function startWorkerReceiptRelay(): void {
  if (!brainEnabled() || process.env.NODE_ENV === "test") return
  relayStarted = true
  kickReceiptRelay()
  setInterval(kickReceiptRelay, RECEIPT_POLL_MS).unref?.()
}

export const workerMcp = createWorkerMcpHandler({
  supervisor: workerSupervisor,
  localHost: HOST_INFO.name,
})
