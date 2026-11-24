import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type A2UIComponent, type A2UIEngineDeps, getSurfaceDataModel } from "./a2ui"
import { findA2UITurn } from "./orchestrator-chat"

// PR Gate card state (CI rollup and shepherd review verdicts from `gh pr view` JSON)
// plus anti-forgery / readonly surface guards for outbound email and PR gate surfaces.

const CLAUDE_HEADING = /^\s*🤖 \*\*Auto-review\*\*/u
const GEMINI_HEADING = /^♊️? \*\*Gemini review\*\* \(agy\b/u
const CODEX_HEADING = /^\s*🧠 \*\*Codex review\*\*/u
const LOW_FILE = /^docs\/.+\.md$|^README\.md$|\.test\.ts$|^architecture\.(json|md)$/
const LOW_FILE_LIMIT = 100
const CLAUDE_PAUSED_FLAG = join(homedir(), ".claude", "state", "claude-review-paused")
const CLAUDE_NORMAL_FLAG = join(homedir(), ".claude", "state", "claude-review-normal")

export interface GhCheck { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }
export interface GhComment { body?: string; author?: { login?: string } | null }

function checkPassed(c: GhCheck): boolean {
  if (c.__typename === "StatusContext" || (c.state !== undefined && c.conclusion === undefined)) {
    return c.state === "SUCCESS"
  }
  return c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(c.conclusion))
}

function checkFailed(c: GhCheck): boolean {
  if (c.__typename === "StatusContext" || (c.state !== undefined && c.conclusion === undefined)) {
    return ["FAILURE", "ERROR"].includes(String(c.state))
  }
  return (
    c.status === "COMPLETED" &&
    ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(c.conclusion))
  )
}

export function computeCiState(checks: GhCheck[], mergeable: string, mergeStateStatus: string): "green" | "pending" | "failed" {
  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return "failed"
  if (checks.some(checkFailed)) return "failed"
  if (checks.length === 0) return "pending"
  if (checks.every(checkPassed) && checks.some((c) => c.conclusion === "SUCCESS" || c.state === "SUCCESS")) {
    return "green"
  }
  return "pending"
}

export function computeReviewState(
  comments: GhComment[],
  headSha: string,
  reviewDecision: string,
  authorLogin = "",
  files: Array<{ path?: string }> = [],
  opts: { claudeNormal?: boolean; clientOrigin?: boolean } = {},
): "approved" | "changes_requested" | "pending" {
  if (reviewDecision === "CHANGES_REQUESTED") return "changes_requested"
  if (!authorLogin || !headSha) return "pending"
  const stamp = `<!-- reviewed-sha: ${headSha} -->`
  const authorComments = comments.filter((c) => c.author?.login === authorLogin)
  const head = authorComments.filter((c) => String(c.body ?? "").includes(stamp)).map((c) => String(c.body))
  const claude = head.filter((b) => CLAUDE_HEADING.test(b))
  const second = head.filter((b) => GEMINI_HEADING.test(b) || CODEX_HEADING.test(b))
  if ([...claude, ...second].some((b) => /VERDICT:\s*CHANGES/i.test(b))) return "changes_requested"

  const tier = authorComments.map((c) => /<!-- review-tier: (\w+) -->/.exec(String(c.body))?.[1]).filter(Boolean).at(-1)
  if (tier === "low" && files.length > 0 && files.length < LOW_FILE_LIMIT && files.every((f) => LOW_FILE.test(String(f.path)))) {
    return "approved"
  }

  const claudePaused = existsSync(CLAUDE_PAUSED_FLAG)
  const claudeNormal = opts.claudeNormal ?? (!claudePaused && existsSync(CLAUDE_NORMAL_FLAG))
  const clientOrigin = opts.clientOrigin ?? false
  const normalClaudeOnly = claudeNormal && tier === "normal" && !clientOrigin
  const normalGeminiOnly = !claudeNormal && tier === "normal" && !clientOrigin

  if (!normalGeminiOnly && !claude.some((b) => /VERDICT:\s*APPROVE/i.test(b))) return "pending"
  if (!normalClaudeOnly && !second.some((b) => /VERDICT:\s*APPROVE/i.test(b))) return "pending"
  return "approved"
}

const RESERVED_OUTBOUND_ACTIONS = new Set(["email.confirm", "email.cancel"])
const RESERVED_PR_ACTIONS = new Set(["pr.merge", "pr.deploy", "pr.refresh"])

export const backsOutbound = (model: Record<string, unknown>): boolean => {
  const email = model.email
  return !!email && typeof email === "object" && (email as Record<string, unknown>).outboundId != null
}

export const backsPrGate = (model: Record<string, unknown>): boolean =>
  model.pr !== undefined && model.pr !== null

/** Outbound-backed email cards are server-written only: the Brain may not patch, restyle or shadow one. */
export function isOutboundSurface(surfaceId: string, engine: A2UIEngineDeps = {}): boolean {
  if (/^outbound-/.test(surfaceId)) return true
  const turn = (engine.findTurn ?? findA2UITurn)(surfaceId)
  return turn?.card?.kind === "a2ui" && backsOutbound(getSurfaceDataModel(turn.card))
}

/** PR gate cards are server-hydrated only: the Brain may not patch, restyle or shadow one. */
export function isPrGateSurface(surfaceId: string, engine: A2UIEngineDeps = {}): boolean {
  if (/^pr-/.test(surfaceId)) return true
  const turn = (engine.findTurn ?? findA2UITurn)(surfaceId)
  return turn?.card?.kind === "a2ui" && backsPrGate(getSurfaceDataModel(turn.card))
}

export function checkSurfaceWriteGuard(
  surfaceId: string,
  engine: A2UIEngineDeps = {},
): "outbound_surface_readonly" | "pr_surface_readonly" | null {
  if (isOutboundSurface(surfaceId, engine)) return "outbound_surface_readonly"
  if (isPrGateSurface(surfaceId, engine)) return "pr_surface_readonly"
  return null
}

export function checkDataModelGuard(
  model: Record<string, unknown>,
): "outbound_surface_readonly" | "pr_surface_readonly" | null {
  if (backsOutbound(model)) return "outbound_surface_readonly"
  if (backsPrGate(model)) return "pr_surface_readonly"
  return null
}

export function checkComponentActionsGuard(
  components: A2UIComponent[],
): "outbound_surface_readonly" | "pr_surface_readonly" | null {
  for (const c of components) {
    const act = c.action?.name
    if (act && RESERVED_OUTBOUND_ACTIONS.has(act)) return "outbound_surface_readonly"
    if (act && RESERVED_PR_ACTIONS.has(act)) return "pr_surface_readonly"
  }
  return null
}
