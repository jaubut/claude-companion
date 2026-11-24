import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// PR Gate card state: CI rollup and shepherd review verdicts from `gh pr view` JSON.

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
