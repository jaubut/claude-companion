import { type ShepherdState, type TaskStage, listPrLedger, stageFields } from "./dispatch-stage"
import { type DispatchColumns, type DispatchTask, approveUrl, listDispatchTasks } from "./dispatch-tasks"
import type { QueryFn, Row } from "./turso"

// One pipeline list (one work stream, docs/one-stream-plan.md slice D): every
// agent task, open or touched in the last 7 days, as ONE state. Read-only; the
// dashboard /tasks release stamp stays the only approval surface (approveUrl
// deep-links there). Contract: docs/orchestrator-dispatch-api.md#pipeline-list.

export type PipelineState =
  | "pending_approval" | "queued" | "running" | "pr_open" | "merged" | "blocked" | "failed" | "cancelled"

export interface PipelineItem {
  id: string
  title: string
  agent: string | null
  noteId: string | null
  state: PipelineState
  prUrl: string | null
  /** pr_open only: the PR shepherd's view (latest pr:* ledger rows); null otherwise. */
  shepherd: ShepherdState | null
  updatedAt: number
  /** pending_approval only: the dashboard /tasks release-stamp link. */
  approveUrl?: string
}

/**
 * The one state mapper. `stage` is dispatch-stage's derivation, which decides
 * whether a completed PR is still open (shepherd) or merged. Completed without
 * a PR counts as merged (dispatch-stage does the same). Unknown status → null.
 */
export function pipelineState(t: Pick<DispatchTask, "status">, stage: TaskStage | null): PipelineState | null {
  switch (t.status) {
    case "pending": return "pending_approval"
    case "queued":
    case "running":
    case "blocked":
    case "failed":
    case "cancelled": return t.status
    case "completed": return stage === "shepherd" ? "pr_open" : "merged"
    default: return null
  }
}

/** One task + its PR ledger rows (newest first) → a list item, or null when its state is unknown. */
export function pipelineItem(t: DispatchTask, ledger: Row[], now: number): PipelineItem | null {
  const fields = stageFields(t, ledger, now)
  const state = pipelineState(t, fields.stage)
  if (!state) return null
  return {
    id: t.id, title: t.title, agent: t.agent, noteId: t.noteId || null, state, prUrl: t.prUrl,
    shepherd: state === "pr_open" ? fields.shepherd ?? null : null,
    updatedAt: t.updatedAt || t.createdAt,
    ...(state === "pending_approval" ? { approveUrl: approveUrl(t.id) } : {}),
  }
}

/** The list, newest first: two Turso reads (tasks, then the PR ledger). Throws TursoUnreachable like any query. */
export async function listPipeline(query: QueryFn, cols: DispatchColumns, now: number): Promise<PipelineItem[]> {
  const tasks = await listDispatchTasks(query, cols)
  const ledger = await listPrLedger(query, tasks)
  return tasks.flatMap((t) => {
    const item = pipelineItem(t, ledger.get(t.id) ?? [], now)
    return item ? [item] : []
  })
}
