import { BRAIN_THREAD, isRoutineLeadAck } from "./brain"

/**
 * Server-side event triage for system turns appended to the Brain thread.
 *
 * Every non-user `orchestrator` turn in `BRAIN_THREAD` is classified BEFORE
 * waking the Brain session:
 * - "silent":    recorded in thread/UI only — NEVER wakes the Brain ($0).
 * - "batch":     queued and flushed after a short coalesce window (15s) so
 *                bursts of worker/shepherd events land in a single turn.
 * - "immediate": wakes the Brain right away (blocked workers, deploy errors,
 *                interactive cards, or user-facing alerts).
 */
export type BrainEventDisposition = "silent" | "batch" | "immediate"

export interface BrainEventCandidate {
  threadId: string
  role: string
  text: string
  taskId?: string | null
  card?: { kind: string } | null
}

/** Self-echoes from actions the Brain itself just executed and already got tool output for, plus A2UI email send receipts. */
const SELF_ECHO_RE = /^(?:Brain (?:merged|closed|updated) |Sent email \[)/i

/** Post-merge / terminal dispatch-poller receipts that need no Brain action. */
const DONE_RECEIPT_RE = /^done \[[0-9a-f]{6,32}\]/i

/**
 * Duplicate 8-char `PR ready [xxxxxxxx] handoff — ...` receipt from dispatch-poller.
 * Headless handoff workers already post a rich 32-char `PR ready [32-hex] ...` via worker-mcp.
 */
const DUP_HANDOFF_PR_READY_RE = /^PR ready \[[0-9a-f]{8}\]\s+handoff\b/i

/** Routine auto-deploy telemetry (keep `restart_mismatch` / unexpected head errors). */
const ROUTINE_DEPLOY_RE = /^(?:Deploying (?:claude-companion|claude-config) |claude-config deployed:|claude-companion restarted at [0-9a-f]+ \(deploy )/i
const DEPLOY_MISMATCH_RE = /expected [0-9a-f]+/i

/** Batchable receipts/events that can wait a few seconds to coalesce with siblings. */
const BATCHABLE_EVENT_RE = /^(?:PR ready \[|completed \[|stuck |More stuck PRs:|\d+ stuck PRs |\[from lead-)/i

/** Immediate-wake alerts. */
const IMMEDIATE_EVENT_RE = /^blocked \[/i

export function classifyBrainEvent(turn: BrainEventCandidate): BrainEventDisposition {
  if (turn.threadId !== BRAIN_THREAD || turn.role !== "orchestrator") return "silent"
  if (turn.card?.kind === "worker_blocked") return "immediate"
  if (turn.card?.kind === "a2ui") return "silent"

  const text = turn.text.trim()
  if (!text) return "silent"

  if (SELF_ECHO_RE.test(text)) return "silent"
  if (DONE_RECEIPT_RE.test(text)) return "silent"
  if (DUP_HANDOFF_PR_READY_RE.test(text)) return "silent"
  if (ROUTINE_DEPLOY_RE.test(text) && !DEPLOY_MISMATCH_RE.test(text)) return "silent"

  // Pure acknowledgments from repo leads (`[from lead-foo] ack`, `lead-foo: noted`, etc.)
  const leadBody = text.replace(/^\[from (lead-[\w.-]+)\]\s*/i, "$1: ")
  if (/^\[from lead-[\w.-]+\]/i.test(text) && isRoutineLeadAck(leadBody)) return "silent"

  if (IMMEDIATE_EVENT_RE.test(text)) return "immediate"
  if (BATCHABLE_EVENT_RE.test(text)) return "batch"

  return "immediate"
}
