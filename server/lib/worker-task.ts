import type { SpawnedWorkerHandle, PlanProgress, WorkerFamily, WorkerProgress, WorkerTaskStatus } from "./worker-invocation"
import { progressOf } from "./worker-invocation"
import type { PersistedTaskRecord, WorkerTurn } from "./worker-task-store"

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
