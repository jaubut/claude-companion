import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SupervisedTaskSnapshot } from "./worker-supervisor"
import { REPO_NAME_RE, TASK_ID_RE } from "./worker-invocation"

// The worker supervisor's state file: one record per task, so a restart can resume or reap them. It holds handoff
// claims, so it's written 0600; readers still treat it as untrusted (any same-uid process can write it).

export const workerStateFile = (home: string): string => join(home, ".claude", "state", "companion-worker-tasks.json")

export interface PersistedTaskRecord extends SupervisedTaskSnapshot {
  repoDir: string; pid?: number | null; pidIdentity?: string | null; sessionStarted?: boolean
  /** bindTask's answer for this id: only true with a handoffClaim links the PR to the Turso row. Absent / null = not answered yet. */
  prLinkBound?: boolean | null
  /** The claim it was bound with (or a pending one): never in a snapshot, so no tool result or callback carries it. */
  handoffClaim?: string | null
}

/** Best effort: a failed write keeps the previous file. */
export function saveTaskRecords(file: string, records: PersistedTaskRecord[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 })
    renameSync(tmp, file)
  } catch { /* best-effort persistence */ }
}

/** The records with a valid id, repo, repo dir, worktree and session; anything else in the file is dropped. */
export function loadTaskRecords(file: string): Array<Partial<PersistedTaskRecord> & Pick<PersistedTaskRecord, "taskId" | "repo" | "repoDir" | "worktree" | "sessionId">> {
  if (!existsSync(file)) return []
  let parsed: unknown = null
  try { parsed = JSON.parse(readFileSync(file, "utf8")) as unknown } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is PersistedTaskRecord => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const r = item as Partial<PersistedTaskRecord>
    return typeof r.taskId === "string" && TASK_ID_RE.test(r.taskId) && typeof r.repo === "string" && REPO_NAME_RE.test(r.repo) &&
      typeof r.repoDir === "string" && !!r.repoDir && typeof r.worktree === "string" && !!r.worktree && typeof r.sessionId === "string" && !!r.sessionId
  })
}
