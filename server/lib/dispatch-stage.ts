import { type DispatchTask, parseTs } from "./dispatch-tasks"
import { APPROVED_MERGE, NEEDS_HUMAN, parkPrefix, parsePrUrl } from "./triage-sources"
import type { QueryFn, Row, SqlArg } from "./turso"

// Pipeline stage of a Turso agent task (brain-tab-queue-graph F1): the graph
// Queue → Dispatch → Builder → Shepherd → Merged (+ Blocked, Failed, Cancelled),
// derived server-side from the task row and the PR shepherd's agent_activity
// ledger. Pure over what it is given; the poller reads the ledger once per poll.
// Contract: docs/orchestrator-dispatch-api.md#pipeline-stage.

export type TaskStage = "queue" | "dispatch" | "builder" | "shepherd" | "merged" | "blocked" | "failed" | "cancelled"

export interface ShepherdState {
  ci: "pending" | "passing" | "failing" | "none"
  review: "pending" | "approved" | "changes" | "none"
  parked: boolean
  parkedReason?: string
}

export interface StageFields {
  stage: TaskStage | null
  shepherd?: ShepherdState
  mergedAt?: number
  prNumber?: number
}

/** The ledger actions the stage reads (newest first per task). */
export const LEDGER_ACTIONS = [NEEDS_HUMAN, "pr:unpark", APPROVED_MERGE, "pr:local-gates", "pr:review", "outcome:merged"] as const
const PARK_ACTIONS: readonly string[] = [NEEDS_HUMAN, "pr:unpark", APPROVED_MERGE]

/**
 * queued → queue; running → dispatch while a headless claim waits for its runner's
 * start (dispatch-run claims, then `dispatch.sh running` sets dispatch_run_id), else
 * builder (live rows are their own runner); completed + PR → shepherd until done=1,
 * then merged; completed without a PR → merged (no prNumber / mergedAt).
 */
export function taskStage(t: Pick<DispatchTask, "status" | "done" | "prUrl" | "owner" | "runId">): TaskStage | null {
  switch (t.status) {
    case "queued": return "queue"
    case "running": return t.runId || t.owner?.startsWith("companion:") ? "builder" : "dispatch"
    case "completed": return t.prUrl && !t.done ? "shepherd" : "merged"
    case "blocked":
    case "failed":
    case "cancelled": return t.status
    default: return null
  }
}

function meta(r: Row): Record<string, unknown> {
  try {
    const m = JSON.parse(String(r.meta ?? "{}")) as unknown
    return m && typeof m === "object" && !Array.isArray(m) ? m as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const newest = (rows: Row[], actions: readonly string[]): Row | undefined => rows.find((r) => actions.includes(String(r.action)))

function ciOf(rows: Row[]): ShepherdState["ci"] {
  const r = newest(rows, ["pr:local-gates"])
  if (!r) return "pending"
  const m = meta(r)
  const checks = [m.tests, m.build]
  if (checks.includes("fail")) return "failing"
  return checks.includes("pass") ? "passing" : "none"
}

function reviewOf(rows: Row[]): ShepherdState["review"] {
  const r = newest(rows, ["pr:review", APPROVED_MERGE])
  if (!r) return "pending"
  if (r.action === APPROVED_MERGE) return "approved"
  const v = meta(r).verdict
  return v === "APPROVE" ? "approved" : v === "CHANGES" ? "changes" : "none"
}

/** The shepherd's view of one PR from its ledger rows (newest first). Parked = a park newer than any unpark / approval. */
export function shepherdOf(rows: Row[]): ShepherdState {
  const park = newest(rows, PARK_ACTIONS)
  const parked = park?.action === NEEDS_HUMAN
  const reason = parked ? parkPrefix(String(meta(park).reason ?? "")).trim() : ""
  return { ci: ciOf(rows), review: reviewOf(rows), parked, ...(reason ? { parkedReason: reason } : {}) }
}

/** Optional DTO fields for one task. `mergedAt` = the outcome:merged row, else the done=1 row's updated_at. */
export function stageFields(t: DispatchTask, rows: Row[] = []): StageFields {
  const stage = taskStage(t)
  const prNumber = parsePrUrl(t.prUrl)?.number
  const out: StageFields = { stage, ...(prNumber ? { prNumber } : {}) }
  if (stage === "shepherd") out.shepherd = shepherdOf(rows)
  if (stage === "merged" && t.prUrl) {
    const merged = newest(rows, ["outcome:merged"])
    const at = merged ? parseTs(merged.ts) : 0
    out.mergedAt = at || t.updatedAt
  }
  return out
}

/** Ledger rows per task id (newest first) for the tasks that carry a PR. One query; the ids come from Turso, never input. */
export async function listPrLedger(query: QueryFn, tasks: DispatchTask[]): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>()
  const ids: SqlArg[] = tasks.filter((t) => t.prUrl && t.status === "completed").map((t) => t.id)
  if (!ids.length) return out
  const rows = await query(
    "SELECT id, target_id, action, meta, ts FROM agent_activity WHERE target_kind = 'task' " +
      `AND action IN (${LEDGER_ACTIONS.map(() => "?").join(", ")}) AND target_id IN (${ids.map(() => "?").join(", ")}) ` +
      "ORDER BY id DESC LIMIT 2000",
    [...LEDGER_ACTIONS, ...ids],
  )
  for (const r of rows) {
    const id = String(r.target_id)
    const list = out.get(id)
    if (list) list.push(r)
    else out.set(id, [r])
  }
  return out
}
