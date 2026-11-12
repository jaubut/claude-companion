import { type JevOpts, type JevOutcome, type JevQuestion, systemOne } from "./jev"

// Jev (TypeSafe System One) task-based model router for Companion orchestration:
// - Judgments from Jev (atomic Choice + Noul questions on task state)
// - Decisions in code (deterministic truth table mapping judgments -> model id)
// - Never throws and never blocks dispatch on network/key failure (falls back in <= 1.2s).

export const JEV_ROUTER_TIMEOUT_MS = 1_200

export type WorkerScope = "single_spot" | "focused_feature" | "cross_module"

export interface WorkerModelInput {
  repo: string
  title: string
  prompt: string
  turnCount?: number
  explicitModel?: string | null
  existingModel?: string | null
}

export interface WorkerModelDecision {
  model: "claude-opus-5-5" | "claude-sonnet-5-5"
  reason:
    | "explicit"
    | "session_keep"
    | "retry_escalation"
    | "security_or_auth"
    | "money_or_data_integrity"
    | "cross_module"
    | "focused_feature"
    | "single_spot"
    | "fallback"
  source: "jev" | "code"
  jevMs: number
  judgments?: {
    scope: WorkerScope | null
    scopeProb: number
    securityOrAuth: number | null
    moneyOrData: number | null
  }
}

export const WORKER_SCOPE_CRITERIA: Record<WorkerScope, string> = {
  single_spot:
    "Edits one file or a few lines where the exact change is already spelled out: updating text, copy, a label, a CSS style, " +
    "a constant, a config value, or a small isolated helper.",
  focused_feature:
    "Implements or fixes one feature, API route, UI component, or test file within a single module where the target files and " +
    "expected behavior are clear.",
  cross_module:
    "Changes three or more files across different modules or packages, redesigns an architecture or concurrency/state machine, " +
    "debugs an unlocalized root cause, or coordinates client and server contracts.",
}

export const WORKER_QUESTIONS: Record<string, JevQuestion> = {
  scope: {
    type: "choice",
    instructions: "How broad is the coding task described in `brief` for repository `repo`?",
    criteria: { ...WORKER_SCOPE_CRITERIA },
  },
  security_or_auth: {
    type: "noul",
    instructions:
      "Does the coding task in `brief` modify authentication, authorization, permissions, process sandboxing, secret handling, or cryptographic verification?",
    criteria: {
      true: "The task changes login, bearer tokens, permission checks, sandbox rules, secret storage, or security gates.",
      false: "The task is regular UI, business logic, orchestration wiring, or tests that do not alter security or permissions.",
    },
  },
  money_or_data_integrity: {
    type: "noul",
    instructions:
      "Does the coding task in `brief` modify billing, payments, invoices, tax calculations, accounting ledgers, or destructive database schema migrations?",
    criteria: {
      true: "The task touches Stripe, invoices, pricing, tax math, ledger rows, or alters/drops database tables.",
      false: "The task does not compute money or run destructive schema migrations.",
    },
  },
}

export function workerRouterState(input: WorkerModelInput): Record<string, unknown> {
  return {
    repo: input.repo,
    title: input.title.slice(0, 240),
    brief: input.prompt.slice(0, 3_000),
  }
}

const isWorkerScope = (s: string): s is WorkerScope =>
  s === "single_spot" || s === "focused_feature" || s === "cross_module"

/** Deterministic truth table mapping Jev's judgments + turn count to a Claude worker model. */
export function pickWorkerModelFromOutcome(out: JevOutcome, input: WorkerModelInput): WorkerModelDecision {
  const turnCount = input.turnCount ?? 1
  if (turnCount >= 3) {
    return { model: "claude-opus-5-5", reason: "retry_escalation", source: "code", jevMs: out.latencyMs }
  }
  if (!out.ok) {
    return { model: "claude-sonnet-5-5", reason: "fallback", source: "code", jevMs: out.latencyMs }
  }

  const scopeAns = out.answers.scope
  const secAns = out.answers.security_or_auth
  const moneyAns = out.answers.money_or_data_integrity

  const scope: WorkerScope | null =
    scopeAns?.type === "choice" && isWorkerScope(scopeAns.choice) ? scopeAns.choice : null
  const scopeProb =
    scope && scopeAns?.type === "choice"
      ? (scopeAns.probabilities[scope] ?? scopeAns.confidence)
      : 0
  const securityOrAuth = secAns?.type === "noul" ? secAns.noul : null
  const moneyOrData = moneyAns?.type === "noul" ? moneyAns.noul : null

  const judgments = { scope, scopeProb, securityOrAuth, moneyOrData }

  if (securityOrAuth !== null && securityOrAuth >= 0.65) {
    return { model: "claude-opus-5-5", reason: "security_or_auth", source: "jev", jevMs: out.latencyMs, judgments }
  }
  if (moneyOrData !== null && moneyOrData >= 0.65) {
    return { model: "claude-opus-5-5", reason: "money_or_data_integrity", source: "jev", jevMs: out.latencyMs, judgments }
  }
  if (scope === "cross_module" && scopeProb >= 0.5) {
    return { model: "claude-opus-5-5", reason: "cross_module", source: "jev", jevMs: out.latencyMs, judgments }
  }
  if (scope === "single_spot") {
    return { model: "claude-sonnet-5-5", reason: "single_spot", source: "jev", jevMs: out.latencyMs, judgments }
  }
  if (scope === "focused_feature") {
    return { model: "claude-sonnet-5-5", reason: "focused_feature", source: "jev", jevMs: out.latencyMs, judgments }
  }
  return { model: "claude-sonnet-5-5", reason: "fallback", source: "code", jevMs: out.latencyMs, judgments }
}

export async function decideWorkerModel(
  input: WorkerModelInput,
  opts: { jev?: JevOpts; enabled?: boolean } = {},
): Promise<WorkerModelDecision> {
  const explicit = input.explicitModel?.trim()
  if (explicit && explicit.toLowerCase() !== "auto") {
    return {
      model: explicit as "claude-opus-5-5" | "claude-sonnet-5-5",
      reason: "explicit",
      source: "code",
      jevMs: 0,
    }
  }
  const turnCount = input.turnCount ?? 1
  if (turnCount >= 3) {
    return { model: "claude-opus-5-5", reason: "retry_escalation", source: "code", jevMs: 0 }
  }
  if (turnCount >= 2 && input.existingModel && input.existingModel.toLowerCase() !== "auto") {
    return {
      model: input.existingModel as "claude-opus-5-5" | "claude-sonnet-5-5",
      reason: "session_keep",
      source: "code",
      jevMs: 0,
    }
  }
  const enabled = opts.enabled ?? (process.env.NODE_ENV !== "test" && process.env.COMPANION_JEV_MODEL_ROUTER?.trim() !== "0")
  if (!enabled) {
    return { model: "claude-sonnet-5-5", reason: "fallback", source: "code", jevMs: 0 }
  }
  const out = await systemOne(workerRouterState(input), WORKER_QUESTIONS, {
    timeoutMs: JEV_ROUTER_TIMEOUT_MS,
    ...opts.jev,
  })
  return pickWorkerModelFromOutcome(out, input)
}

// ── Brain per-turn model router ──────────────────────────────────────────────

export interface BrainTurnModelDecision {
  model: string
  reason: "pinned_custom" | "control_turn" | "routine_turn" | "planning_turn" | "fallback"
  source: "jev" | "code"
  jevMs: number
}

export const BRAIN_TURN_QUESTIONS: Record<string, JevQuestion> = {
  needs_deep_planning: {
    type: "noul",
    instructions:
      "Does `message` ask the orchestrator Brain to scope new coding work, write a technical brief for a repo lead, investigate a bug, or weigh an architectural, product, or security decision?",
    criteria: {
      true: "The message asks for new work to be planned or briefed, reports a blocker or merge refusal that needs judgment, or asks a design/strategy question.",
      false: "The message is a routine merge request from a lead (`merge owner/repo#123`), a short confirmation (`yes`, `go`, `thanks`), a simple status check, or a compaction control turn.",
    },
  },
  is_routine_merge_or_ack: {
    type: "noul",
    instructions:
      "Is `message` a routine PR merge request (`merge owner/repo#123: ...`), a short confirmation (`yes`, `approve`, `do it`, `noted`), or a simple queue status check?",
    criteria: {
      true: "The message only asks to run `pr-merge` on an approved green PR, confirms a previous question in a few words, or asks what is currently running.",
      false: "The message introduces a new task, asks for a plan or brief, reports a conflict or failure, or asks a multi-part question.",
    },
  },
}

const CONTROL_TURN_RE = /^\[(flush|rollover)\]/i

export function pickBrainTurnModelFromOutcome(
  out: JevOutcome,
  configuredModel: string,
): BrainTurnModelDecision {
  if (!out.ok) {
    return { model: configuredModel, reason: "fallback", source: "code", jevMs: out.latencyMs }
  }
  const deep = out.answers.needs_deep_planning?.type === "noul" ? out.answers.needs_deep_planning.noul : null
  const routine = out.answers.is_routine_merge_or_ack?.type === "noul" ? out.answers.is_routine_merge_or_ack.noul : null

  if (routine !== null && routine >= 0.7 && (deep === null || deep < 0.35)) {
    return { model: "claude-sonnet-5-5", reason: "routine_turn", source: "jev", jevMs: out.latencyMs }
  }
  return { model: "claude-opus-5-5", reason: "planning_turn", source: "jev", jevMs: out.latencyMs }
}

export async function decideBrainTurnModel(
  text: string,
  configuredModel: string,
  opts: { jev?: JevOpts; enabled?: boolean } = {},
): Promise<BrainTurnModelDecision> {
  const trimmed = text.trim()
  // Fast-path: [flush] and [rollover] compaction turns never need Opus.
  if (CONTROL_TURN_RE.test(trimmed)) {
    return { model: "claude-sonnet-5-5", reason: "control_turn", source: "code", jevMs: 0 }
  }
  const norm = configuredModel.trim().toLowerCase()
  // If the user explicitly pinned Fable or Haiku in the picker, honor it verbatim.
  if (norm && norm !== "auto" && norm !== "claude-opus-5-5" && norm !== "opus") {
    return { model: configuredModel, reason: "pinned_custom", source: "code", jevMs: 0 }
  }
  const enabled = opts.enabled ?? (process.env.NODE_ENV !== "test" && process.env.COMPANION_JEV_MODEL_ROUTER?.trim() !== "0")
  if (!enabled) {
    return { model: "claude-opus-5-5", reason: "fallback", source: "code", jevMs: 0 }
  }
  const out = await systemOne({ message: trimmed.slice(0, 2_000) }, BRAIN_TURN_QUESTIONS, {
    timeoutMs: JEV_ROUTER_TIMEOUT_MS,
    ...opts.jev,
  })
  return pickBrainTurnModelFromOutcome(out, "claude-opus-5-5")
}
