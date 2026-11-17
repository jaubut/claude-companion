import type { WorkerTaskStatus } from "./worker-invocation"
import { type PersistedTaskRecord, type WorkerTurn, parseTurns, reportTurn } from "./worker-task-store"

// A worker task's append-only turn history: each turn keeps its own text, so a later turn never overwrites a report.

interface TurnHolder { turns: WorkerTurn[]; result: string }

/** The open turn, or a new one: output after a `result` event is a turn the harness started on its own. */
export function openTurn(t: TurnHolder, now: number): WorkerTurn {
  const last = t.turns.at(-1)
  if (last && last.endedAt === null) return last
  const turn: WorkerTurn = { turn: (last?.turn ?? 0) + 1, startedAt: now, endedAt: null, status: "running", result: "", prUrl: null }
  t.turns.push(turn)
  return turn
}

export function closeTurn(t: TurnHolder, status: WorkerTaskStatus, now: number): boolean {
  const last = t.turns.at(-1)
  if (!last || last.endedAt !== null) return false
  last.endedAt = now; last.status = status
  return true
}

/** `result` = the report (reportTurn); while no turn has ended, the open turn's live text. */
export function refreshResult(t: TurnHolder): void {
  const last = t.turns.at(-1)
  t.result = reportTurn(t.turns)?.result || (last?.endedAt === null ? last.result : "")
}

/** A persisted record's turns (a pre-history record's `result` becomes turn 1). `reported`: the restart found the
 *  last turn already completed (its `result` event came), so its report was delivered; an open turn reads interrupted. */
export function restoreTurns(r: Partial<PersistedTaskRecord>, wasRunning: boolean, now: number): { turns: WorkerTurn[]; reported: boolean } {
  const legacyResult = typeof r.result === "string" ? r.result : ""
  const turns = r.turns !== undefined ? parseTurns(r.turns) : legacyResult
    ? [{ turn: 1, startedAt: r.startedAt ?? now, endedAt: r.completedAt ?? r.updatedAt ?? now, status: wasRunning ? "interrupted" as const : r.status ?? "completed", result: legacyResult, prUrl: r.prUrl ?? null }]
    : []
  const lastTurn = turns.at(-1)
  const reported = wasRunning && lastTurn?.endedAt != null && lastTurn.status === "completed"
  if (wasRunning && lastTurn?.endedAt === null) { lastTurn.endedAt = now; lastTurn.status = "interrupted" }
  return { turns, reported }
}
