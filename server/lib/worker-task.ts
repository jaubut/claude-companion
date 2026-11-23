import type { PlanProgress, WorkerFamily, WorkerProgress, WorkerTaskStatus } from "./worker-invocation"
import type { SpawnedWorkerHandle } from "./worker-spawn"
import { progressOf, resolveWorkerFamily } from "./worker-invocation"
import type { PersistedTaskRecord, WorkerTurn, loadTaskRecords } from "./worker-task-store"
import { refreshResult, restoreTurns } from "./worker-turns"
import { TARGET_BRANCH_RE } from "./worker-worktree"

// A supervised worker task as the supervisor holds it, and the snapshot it hands out.

export interface SupervisedTaskSnapshot {
  taskId: string; repo: string; title: string; builder: string; family: WorkerFamily; model: string | null; branch: string; worktree: string; sessionId: string
  status: WorkerTaskStatus; turnCount: number; step: string | null; pct: number | null; result: string; prUrl: string | null
  error: string | null; startedAt: number; updatedAt: number; completedAt: number | null
  progress?: WorkerProgress // absent on records written before it existed (state file, peer receipts)
}

export interface InternalTask extends PersistedTaskRecord {
  pid: number | null; pidIdentity: string | null; reloadedFromDisk: boolean; sessionStarted: boolean; prLinkBound: boolean | null; handoffClaim: string | null; modelPinned: boolean
  activeTurn: number; jobId: string; turnReportedTerminal: boolean; turns: WorkerTurn[]; turnsRead: number; dispatchTurn: number
  handle: SpawnedWorkerHandle | null; exitPromise: Promise<void> | null
  timeoutTimer: ReturnType<typeof setTimeout> | null; killTimer: ReturnType<typeof setTimeout> | null
  /** Armed on each `result` event: the process must exit after its turn (reapGraceMs). `lingered`: it didn't, and was stopped. */
  reapTimer: ReturnType<typeof setTimeout> | null; lingered: boolean
  waiters: Set<() => void>; stderrTail: string[]
  plan?: PlanProgress | null // this turn's plan, from the worker's own todo list; not persisted
}
export function toSnapshot(t: InternalTask): SupervisedTaskSnapshot {
  const { taskId, repo, title, builder, family, model, branch, worktree, sessionId, status, turnCount, step, pct, result, prUrl, error, startedAt, updatedAt, completedAt } = t
  return { taskId, repo, title, builder, family, model, branch, worktree, sessionId, status, turnCount, step, pct, result, prUrl, error, startedAt, updatedAt, completedAt, progress: progressOf(t) }
}

/** A task from the state file. `attached`: its worker survived the restart and keeps running (worker-spawn.ts); otherwise
 *  a running record reads interrupted, or completed when its turn had already reported. */
export function restoreTask(r: ReturnType<typeof loadTaskRecords>[number], now: number, attached: boolean, pid: number | null, pidIdentity: string | null): InternalTask {
  const wasRunning = r.status === "running" && !attached
  const turnCount = typeof r.turnCount === "number" && r.turnCount > 0 ? Math.floor(r.turnCount) : 1
  const loadedFamily = !r.family?.trim() && !r.model?.trim() ? "claude" : (resolveWorkerFamily({ family: r.family, model: r.model ?? undefined }) ?? "claude")
  // The restart killed the process, but a turn that already ended completed (its `result` event came) delivered its report.
  const { turns, reported } = restoreTurns(r, wasRunning, now)
  const t: InternalTask = {
    taskId: r.taskId, repo: r.repo, repoDir: r.repoDir,
    title: typeof r.title === "string" ? r.title : r.taskId,
    builder: typeof r.builder === "string" ? r.builder : `builder-${r.repo}-${r.taskId}`,
    family: loadedFamily,
    model: typeof r.model === "string" && r.model ? r.model : null,
    branch: typeof r.branch === "string" ? r.branch : `dispatch/${r.taskId}`,
    worktree: r.worktree, sessionId: r.sessionId,
    status: reported ? "completed" : wasRunning ? "interrupted" : (r.status ?? "interrupted"),
    turnCount,
    step: reported ? "Turn completed (server restarted before the worker exited)" : wasRunning ? "Interrupted (server restarted)" : (typeof r.step === "string" ? r.step : null),
    pct: reported ? 100 : typeof r.pct === "number" ? r.pct : null,
    result: "",
    prUrl: typeof r.prUrl === "string" ? r.prUrl : null,
    error: reported ? null : wasRunning ? "server restarted while task was running" : (typeof r.error === "string" ? r.error : null),
    startedAt: typeof r.startedAt === "number" ? r.startedAt : now,
    updatedAt: wasRunning ? now : (typeof r.updatedAt === "number" ? r.updatedAt : now),
    completedAt: wasRunning ? now : (typeof r.completedAt === "number" ? r.completedAt : null),
    pid, pidIdentity, reloadedFromDisk: pid !== null,
    sessionStarted: typeof r.sessionStarted === "boolean" ? r.sessionStarted : r.status === "completed",
    prLinkBound: typeof r.prLinkBound === "boolean" ? r.prLinkBound : null,
    handoffClaim: typeof r.handoffClaim === "string" && r.handoffClaim ? r.handoffClaim : null,
    modelPinned: r.modelPinned === true,
    routeReason: typeof r.routeReason === "string" ? r.routeReason : null,
    targetBranch: typeof r.targetBranch === "string" && TARGET_BRANCH_RE.test(r.targetBranch) ? r.targetBranch : null,
    activeTurn: turnCount, jobId: turnCount <= 1 ? r.taskId : `${r.taskId}:t${turnCount}`,
    turnReportedTerminal: !attached, handle: null, exitPromise: null, timeoutTimer: null, killTimer: null, reapTimer: null, lingered: false, waiters: new Set(), stderrTail: [],
    turns, turnsRead: typeof r.turnsRead === "number" ? r.turnsRead : turns.at(-1)?.turn ?? 0,
    dispatchTurn: typeof r.dispatchTurn === "number" ? r.dispatchTurn : 0,
    ...(attached ? { logFile: r.logFile, logOffset: typeof r.logOffset === "number" ? r.logOffset : 0 } : {}),
  }
  refreshResult(t)
  return t
}

/** A task by id, or by the short / long form of its hex id (`0bb587b3` vs `0bb587b3d29b…`, the branch a worker names
 *  `dispatch/0bb587b3`): exact first, else the one 8+ hex task whose id extends or prefixes it, so every
 *  by-id call lands on the same record, worktree and branch while slugs / suffixed ids stay distinct. */
export function findTask<T extends { taskId: string }>(tasks: Map<string, T>, id: string): T | undefined {
  const exact = tasks.get(id)
  if (exact || !/^[0-9a-f]{8,}$/i.test(id)) return exact
  const hits = [...tasks.values()].filter((t) => t.taskId.length >= 8 && /^[0-9a-f]+$/i.test(t.taskId) && (t.taskId.startsWith(id) || id.startsWith(t.taskId)))
  return hits.length === 1 ? hits[0] : undefined
}

export function notifyWaiters(t: InternalTask): void {
  for (const fn of [...t.waiters]) { t.waiters.delete(fn); fn() }
}

export function clearTimers(t: InternalTask): void {
  if (t.timeoutTimer) { clearTimeout(t.timeoutTimer); t.timeoutTimer = null }
  if (t.killTimer) { clearTimeout(t.killTimer); t.killTimer = null }
  if (t.reapTimer) { clearTimeout(t.reapTimer); t.reapTimer = null }
}
