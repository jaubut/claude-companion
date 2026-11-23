import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SupervisedTaskSnapshot } from "./worker-supervisor"
import { REPO_NAME_RE, TASK_ID_RE, type WorkerTaskStatus } from "./worker-invocation"

// The worker supervisor's state file: one record per task, so a restart can resume or reap them. It holds handoff
// claims, so it's written 0600; readers still treat it as untrusted (any same-uid process can write it).

export const workerStateFile = (home: string): string => join(home, ".claude", "state", "companion-worker-tasks.json")

/** One worker turn: each `result` event, or the process exit, closes one. Append-only; `result` is never truncated. */
export interface WorkerTurn { turn: number; startedAt: number; endedAt: number | null; status: WorkerTaskStatus; result: string; prUrl: string | null }

export const LINK_RE = /https?:\/\/[^\s)>\]"'`]+/g

/** The ended turn the brain reads as the task's report: the latest one, unless it is shorter than the report before it
 *  and brings no new PR or link (a background-task notification turn after the real report). */
export function reportTurn(turns: readonly WorkerTurn[]): WorkerTurn | null {
  let best: WorkerTurn | null = null
  for (const t of turns) {
    if (t.endedAt === null || !t.result) continue
    const prev = best
    if (!prev || t.result.length >= prev.result.length || (!!t.prUrl && t.prUrl !== prev.prUrl) ||
      (t.result.match(LINK_RE) ?? []).some((l) => !prev.result.includes(l))) best = t
  }
  return best
}

/** Turns from an untrusted state file: well-formed ones only. */
export function parseTurns(raw: unknown): WorkerTurn[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is WorkerTurn => !!t && typeof t === "object" && typeof t.turn === "number" && typeof t.startedAt === "number" &&
    (t.endedAt === null || typeof t.endedAt === "number") && typeof t.status === "string" && typeof t.result === "string" && (t.prUrl === null || typeof t.prUrl === "string"))
}

export interface PersistedTaskRecord extends SupervisedTaskSnapshot {
  repoDir: string; pid?: number | null; pidIdentity?: string | null; sessionStarted?: boolean
  /** bindTask's answer for this id: only true with a handoffClaim links the PR to the notes DB row. Absent / null = not answered yet. */
  prLinkBound?: boolean | null
  /** The claim it was bound with (or a pending one): never in a snapshot, so no tool result or callback carries it. */
  handoffClaim?: string | null
  /** The model was chosen (dispatch `model` or the picker via setTaskModel), not routed: later turns keep it, no retry escalation. */
  modelPinned?: boolean
  /** Every turn of the task, oldest first. */
  turns?: WorkerTurn[]
  /** The last turn `await_task` already returned. */
  turnsRead?: number
  /** The turn the current dispatch opened: the report is picked from it onward, never from an earlier dispatch. */
  dispatchTurn?: number
  /** Completed with no PR, its receipt not queued yet (waits on git status): a reload queues it. */
  receiptDue?: boolean
  /** The Companion process that spawned the worker: a worker still parented to it belongs to that live server, not to a reloading one. */
  ownerPid?: number | null
  /** The router's reason for the last routed turn (lib/jev-model-router.ts): a security or money task keeps Opus on follow-ups. */
  routeReason?: string | null
  /** Set on a task started on an existing PR's head (the conflict resolver): its follow-ups keep that PR's footer. */
  targetBranch?: string | null
  /** The running turn's output files (`<logFile>.out` / `.err`, worker-spawn.ts) and the stdout bytes this record reflects:
   *  a restart re-attaches to the worker from there instead of killing it. */
  logFile?: string | null; logOffset?: number
}

/** Best effort: a failed write keeps the previous file. */
function saveJson(file: string, data: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    renameSync(tmp, file)
  } catch { /* best-effort persistence */ }
}

function loadJsonArray(file: string): unknown[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function saveTaskRecords(file: string, records: PersistedTaskRecord[]): void { saveJson(file, records) }

/** The records with a valid id, repo, repo dir, worktree and session; anything else in the file is dropped. */
export function loadTaskRecords(file: string): Array<Partial<PersistedTaskRecord> & Pick<PersistedTaskRecord, "taskId" | "repo" | "repoDir" | "worktree" | "sessionId">> {
  return loadJsonArray(file).filter((item): item is PersistedTaskRecord => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const r = item as Partial<PersistedTaskRecord>
    return typeof r.taskId === "string" && TASK_ID_RE.test(r.taskId) && typeof r.repo === "string" && REPO_NAME_RE.test(r.repo) &&
      typeof r.repoDir === "string" && !!r.repoDir && typeof r.worktree === "string" && !!r.worktree && typeof r.sessionId === "string" && !!r.sessionId
  })
}

// Receipt outbox: one entry per finished turn, kept on disk until the brain host acks it (lib/worker-mcp.ts relay), so a
// restart on either side or a brain outage never drops one.

export const workerReceiptFile = (home: string): string => join(home, ".claude", "state", "companion-worker-receipts.json")

export interface WorkerReceipt {
  /** `<taskId>#<turnCount>@<dispatch start>`: unique per finished dispatch turn, stable across restarts. */
  id: string; at: number
  /** The newest ended turn's text when it isn't the one `task.result` reports (a notification turn after the report). */
  latest: string | null
  /** What the worker host did after the turn: the process stopped for lingering, a dirty worktree kept. */
  note?: string | null
  task: SupervisedTaskSnapshot
}

export function saveReceipts(file: string, receipts: WorkerReceipt[]): void { saveJson(file, receipts) }

/** Receipts come from a file or a peer host: shape-checked before use. */
export function isWorkerReceipt(r: unknown): r is WorkerReceipt {
  if (!r || typeof r !== "object") return false
  const x = r as Partial<WorkerReceipt>
  const str = (v: unknown): boolean => typeof v === "string"
  const opt = (v: unknown): boolean => v === null || typeof v === "string"
  return typeof x.id === "string" && typeof x.at === "number" && opt(x.latest) && (x.note === undefined || opt(x.note)) && !!x.task && typeof x.task === "object" &&
    typeof x.task.taskId === "string" && TASK_ID_RE.test(x.task.taskId) && typeof x.task.repo === "string" && REPO_NAME_RE.test(x.task.repo) &&
    str(x.task.title) && str(x.task.status) && str(x.task.result) && opt(x.task.step) && opt(x.task.prUrl) && opt(x.task.error)
}

export function loadReceipts(file: string): WorkerReceipt[] { return loadJsonArray(file).filter(isWorkerReceipt) }

/** The brain host's delivered receipt keys (`<host>|<id>`): an ack lost after delivery never posts it twice. */
export const deliveredReceiptsFile = (home: string): string => join(home, ".claude", "state", "companion-worker-receipts-delivered.json")
export function loadDeliveredKeys(file: string): string[] { return loadJsonArray(file).filter((k): k is string => typeof k === "string") }
export function saveDeliveredKeys(file: string, keys: string[]): void { saveJson(file, keys) }
