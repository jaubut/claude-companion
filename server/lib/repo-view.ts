import { repoMarker } from "./dispatch-tasks"
import { type ChecksState, rollupState } from "./triage-pr"
import { clip } from "./triage"

// Repo view (docs/orchestrator-triage-api.md#repo-view): the repo chip on a
// Needs you card opens one summary of the repo's open PRs, each in plain
// words, plus ONE "Get an agent on it" for the blocked ones. Pure: the gh
// list, the shepherd's parks and the Turso lookups are wiring/repo-view.ts.

export type RepoPrStatus = "ready" | "checks_failing" | "conflict" | "parked" | "review" | "checks_running" | "behind" | "draft"

export const PR_STATUS_LABEL: Record<RepoPrStatus, string> = {
  ready: "Ready to merge",
  checks_failing: "Checks failing",
  conflict: "Merge conflict",
  parked: "Parked by shepherd",
  review: "Waiting on review",
  checks_running: "Checks running",
  behind: "Behind main",
  draft: "Draft",
}

/** What an agent can resolve: "Get an agent on it" is on when one PR is in one of these. */
const BLOCKED: ReadonlySet<RepoPrStatus> = new Set(["checks_failing", "conflict", "parked"])

export const isBlocked = (status: RepoPrStatus): boolean => BLOCKED.has(status)

/** One open PR as `gh pr list --json` reports it. */
export interface GhPr {
  number: number
  title: string
  url: string
  isDraft: boolean
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN | ""
  mergeState: string // CLEAN | DIRTY | BEHIND | BLOCKED | UNSTABLE | UNKNOWN | ""
  checks: ChecksState
  reviewDecision: string // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  updatedAt: number
}

export interface RepoPr { number: number; title: string; url: string; status: RepoPrStatus; label: string; reason: string; updatedAt: number }

export const PR_LIST_FIELDS = "number,title,url,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,updatedAt"
export const PR_LIST_LIMIT = 50

/** `gh pr list --json PR_LIST_FIELDS` stdout → PRs; null when it is not a JSON array. */
export function parsePrList(stdout: string): GhPr[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const s = (v: unknown) => (typeof v === "string" ? v : "")
  const out: GhPr[] = []
  for (const o of raw) {
    if (!o || typeof o !== "object") continue
    const r = o as Record<string, unknown>
    if (typeof r.number !== "number" || !s(r.url)) continue
    const at = Date.parse(s(r.updatedAt))
    out.push({
      number: r.number, title: s(r.title), url: s(r.url), isDraft: r.isDraft === true,
      mergeable: s(r.mergeable), mergeState: s(r.mergeStateStatus), checks: rollupState(r.statusCheckRollup),
      reviewDecision: s(r.reviewDecision), updatedAt: Number.isFinite(at) ? at : 0,
    })
  }
  return out
}

/**
 * One status per PR, the most actionable first: draft → conflict → failing checks → the shepherd's park →
 * running checks / GitHub still computing → review → behind → ready. `parked` = the shepherd's park reason
 * (lib/triage-sources.ts prSources hints.parked), null when it never parked this PR.
 */
export function prStatus(pr: GhPr, parked: string | null): { status: RepoPrStatus; reason: string } {
  const park = parked?.trim() ? clip(parked.trim(), 140) : null
  if (pr.isDraft) return { status: "draft", reason: "Still a draft" }
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") return { status: "conflict", reason: park ?? "Conflicts with the base branch" }
  if (pr.checks === "fail") return { status: "checks_failing", reason: park ?? "A check failed" }
  if (park) return { status: "parked", reason: park }
  if (pr.checks === "pending") return { status: "checks_running", reason: "Checks are still running" }
  if (pr.mergeable === "UNKNOWN" || pr.mergeState === "UNKNOWN") return { status: "checks_running", reason: "GitHub is still checking it" }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { status: "review", reason: "Changes requested" }
  if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.mergeState === "BLOCKED") return { status: "review", reason: "A review is required" }
  if (pr.mergeState === "BEHIND") return { status: "behind", reason: "Needs an update from main" }
  return { status: "ready", reason: "Checks pass, no conflicts" }
}

/** Blocked first, then the most recently updated. */
export function repoPrs(prs: GhPr[], parkOf: (number: number) => string | null): RepoPr[] {
  return prs
    .map((pr) => {
      const { status, reason } = prStatus(pr, parkOf(pr.number))
      return { number: pr.number, title: clip(pr.title || `PR #${pr.number}`, 120), url: pr.url, status, label: PR_STATUS_LABEL[status], reason, updatedAt: pr.updatedAt }
    })
    .sort((a, b) => Number(isBlocked(b.status)) - Number(isBlocked(a.status)) || b.updatedAt - a.updatedAt)
}

/** The one task per repo: dispatch-run routes on the `[repo:<name>]` marker; the idempotency lookup matches it exactly. */
export function agentTaskTitle(repo: string): string {
  return `${repoMarker(repo)}Resolve blocked PRs in ${repo}`.slice(0, 120)
}

/** The builder's brief: the blocked PRs, why each one is blocked, and the rules. */
export function agentPrompt(slug: string, blocked: RepoPr[]): string {
  return [
    `Resolve the blocked pull requests in ${slug}. Jeremie tapped "Get an agent on it" on the repo view in Companion.`,
    "",
    "Blocked PRs:",
    ...blocked.map((p) => `- #${p.number} ${p.title} — ${p.label}: ${p.reason} (${p.url})`),
    "",
    "For each PR: check out its branch, fix the cause (failing checks: fix the code, never the tests; merge conflict: bring in the base branch and resolve; parked by the PR shepherd: address the park reason), run the repo's gates, and push to that PR's branch so the shepherd picks it up again.",
    "Never merge, never close a PR, never force-push the base branch. A PR that needs Jeremie's decision (secrets, auth, payments, client wording) stays as it is: say why.",
    "Report one line per PR: fixed (what) or left (why).",
  ].join("\n")
}
