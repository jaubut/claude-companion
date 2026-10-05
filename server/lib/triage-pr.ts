import { existsSync } from "node:fs"
import type { ExecOutcome } from "./triage-engine"
import type { ExecFn } from "./turso"

// Triage merge / close on a dispatch PR, by its FULL URL (numbers collide across
// repos — dispatch-reconcile.ts). The state is read back from GitHub before
// anything is recorded: merge must read MERGED, close must read CLOSED. Then the
// same ledger rows dispatch-reconcile writes: merged → task done=1 +
// outcome:merged; closed → outcome:rejected "PR #N closed unmerged".
// Merge intent (2026-10-05): a Merge tap on a PR GitHub cannot merge yet
// (conflict / behind / checks pending or failing) records Jeremie's approval
// (`pr:approved-merge`) for the PR shepherd instead of failing.

export interface GhResult { code: number; stdout: string; stderr: string }
/** Runs `gh <args>`; throws when gh cannot be started at all. */
export type GhFn = (args: string[]) => Promise<GhResult>

export class GhUnreachable extends Error {
  constructor(reason: string) {
    super(`gh unreachable: ${reason}`)
    this.name = "GhUnreachable"
  }
}

export interface PrTarget { taskId: string; prUrl: string; number: number }
export interface PrActionDeps { gh: GhFn; exec: ExecFn; host: string }

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "unknown"

export async function prState(gh: GhFn, url: string): Promise<PrState> {
  const r = await gh(["pr", "view", url, "--json", "state"])
  if (r.code !== 0) return "unknown"
  try {
    const s = (JSON.parse(r.stdout) as { state?: string }).state
    return s === "OPEN" || s === "MERGED" || s === "CLOSED" ? s : "unknown"
  } catch {
    return "unknown"
  }
}

const unreachable = (detail: string): ExecOutcome => ({ kind: "error", status: 503, error: "gh_unreachable", extra: { detail: detail.slice(0, 200) } })

// ── readiness: can GitHub merge it right now? ────────────────────────────────

/** Why a merge Jeremie approved waits (docs/orchestrator-triage-api.md#merge-intent). */
export type HoldReason = "conflict" | "behind" | "ci_pending" | "ci_failing"
export type ChecksState = "pass" | "fail" | "pending" | "none"

export interface PrReadiness {
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN | "" (not reported)
  mergeState: string // CLEAN | DIRTY | BEHIND | BLOCKED | UNSTABLE | UNKNOWN | ""
  headSha: string
  checks: ChecksState
}

const READINESS_FIELDS = "mergeable,mergeStateStatus,headRefOid,statusCheckRollup"

/** One rollup entry: a CheckRun (status + conclusion) or a StatusContext (state). */
function checkOutcome(c: Record<string, unknown>): ChecksState {
  const up = (v: unknown) => (typeof v === "string" ? v.toUpperCase() : "")
  if (c.__typename === "StatusContext" || (c.state !== undefined && c.conclusion === undefined)) {
    const st = up(c.state)
    return st === "SUCCESS" ? "pass" : st === "PENDING" || st === "EXPECTED" || st === "" ? "pending" : "fail"
  }
  const status = up(c.status)
  if (status && status !== "COMPLETED") return "pending"
  const co = up(c.conclusion)
  if (co === "SUCCESS" || co === "NEUTRAL" || co === "SKIPPED") return "pass"
  return co === "" ? "pending" : "fail"
}

/** Fold the rollup: any failure → fail, anything running → pending, else pass (none when empty). */
export function rollupState(rollup: unknown): ChecksState {
  if (!Array.isArray(rollup) || !rollup.length) return "none"
  const states = rollup.filter((c): c is Record<string, unknown> => !!c && typeof c === "object").map(checkOutcome)
  if (states.includes("fail")) return "fail"
  if (states.includes("pending")) return "pending"
  return states.length ? "pass" : "none"
}

/** null = GitHub would merge it now (or does not say otherwise). */
export function holdReason(r: PrReadiness): HoldReason | null {
  if (r.mergeable === "CONFLICTING" || r.mergeState === "DIRTY") return "conflict"
  if (r.checks === "fail") return "ci_failing"
  if (r.checks === "pending") return "ci_pending"
  if (r.mergeState === "BEHIND") return "behind"
  return null
}

/** Mergeable state, head and checks; null when gh answers nothing usable. Throws GhUnreachable. */
export async function prReadiness(gh: GhFn, url: string): Promise<PrReadiness | null> {
  const r = await gh(["pr", "view", url, "--json", READINESS_FIELDS])
  if (r.code !== 0) return null
  try {
    const o = JSON.parse(r.stdout) as Record<string, unknown>
    const s = (v: unknown) => (typeof v === "string" ? v : "")
    return { mergeable: s(o.mergeable), mergeState: s(o.mergeStateStatus), headSha: s(o.headRefOid), checks: rollupState(o.statusCheckRollup) }
  } catch {
    return null
  }
}

// ── merge intent: Jeremie's Merge tap, recorded when GitHub cannot merge yet ──

export const APPROVED_MERGE = "pr:approved-merge"

export interface ApprovalInput {
  taskId: string | null
  url: string
  /** Repo name (last path segment), as the shepherd's park rows carry it. */
  repo: string
  number: number
  headSha: string
  reason: HoldReason | null
  agent: string
  via: "triage" | "cli"
  host: string
  at?: Date
}

/** The `pr:approved-merge` row the PR shepherd honours (claude-config tools/pr-shepherd-approval.ts reads it). */
export function approvalRow(a: ApprovalInput): { agentSlug: string; targetKind: string; targetId: string; summary: string; meta: string } {
  const approvedAt = (a.at ?? new Date()).toISOString()
  return {
    agentSlug: a.agent,
    targetKind: a.taskId ? "task" : "pr",
    targetId: a.taskId ?? a.url,
    summary: `${a.repo}#${a.number}: merge approved by Jeremie${a.reason ? ` (waits: ${a.reason})` : ""}`.slice(0, 200),
    meta: JSON.stringify({
      repo: a.repo, pr: a.number, url: a.url, approvedHeadSha: a.headSha, approvedAt, by: "jeremie", via: a.via,
      ...(a.reason ? { reason: a.reason } : {}), host: a.host, source: "companion",
    }),
  }
}

async function recordApproval(deps: PrActionDeps, t: PrTarget, ready: PrReadiness, reason: HoldReason): Promise<ExecOutcome> {
  const repo = /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(t.prUrl)?.[1] ?? "repo"
  const row = approvalRow({ taskId: t.taskId, url: t.prUrl, repo, number: t.number, headSha: ready.headSha, reason, agent: await agentOf(deps.exec, t.taskId), via: "triage", host: deps.host })
  await deps.exec(
    "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
    [row.agentSlug, APPROVED_MERGE, row.targetKind, row.targetId, row.summary, row.meta],
  )
  return { kind: "queued", detail: { state: "approved_pending", reason, approvedHeadSha: ready.headSha } }
}

async function agentOf(exec: ExecFn, taskId: string): Promise<string> {
  const { rows } = await exec("SELECT assignee FROM tasks WHERE id = ?", [taskId])
  return String(rows[0]?.assignee ?? "").replace(/^(agent:)+/, "") || "unknown"
}

async function ledger(deps: PrActionDeps, t: PrTarget, action: string, summary: string): Promise<void> {
  const meta = JSON.stringify({ source: "companion", via: "triage", host: deps.host, pr_url: t.prUrl })
  await deps.exec(
    "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, 'task', ?, ?, ?)",
    [await agentOf(deps.exec, t.taskId), action, t.taskId, summary, meta],
  )
}

/** OPEN → null (go on); else the outcome to return (503 unreachable / stale). */
async function mustBeOpen(gh: GhFn, url: string): Promise<ExecOutcome | null> {
  let before: PrState
  try {
    before = await prState(gh, url)
  } catch (err) {
    return unreachable((err as Error)?.message ?? "gh failed")
  }
  if (before === "unknown") return unreachable("gh pr view failed")
  return before === "OPEN" ? null : { kind: "stale", reason: `PR is ${before.toLowerCase()}` }
}

/** Readiness, or null when gh cannot say (the merge is then simply tried, as before). */
async function readiness(gh: GhFn, url: string): Promise<PrReadiness | null> {
  try {
    return await prReadiness(gh, url)
  } catch {
    return null
  }
}

/** Jeremie's approval of a PR GitHub cannot merge now: the shepherd lands it once the reason clears. */
async function approveOrMerge(deps: PrActionDeps, t: PrTarget): Promise<ExecOutcome> {
  const closed = await mustBeOpen(deps.gh, t.prUrl)
  if (closed) return closed
  const ready = await readiness(deps.gh, t.prUrl)
  const hold = ready ? holdReason(ready) : null
  if (ready && hold) return recordApproval(deps, t, ready, hold)
  const run = await deps.gh(["pr", "merge", t.prUrl, "--squash"])
  const after = await prState(deps.gh, t.prUrl)
  if (after === "MERGED") return { kind: "done", detail: { state: after } }
  // GitHub refused: if it now says why (conflict, CI…), the tap still counts as the approval.
  const late = after === "OPEN" ? await readiness(deps.gh, t.prUrl) : null
  const lateHold = late ? holdReason(late) : null
  if (late && lateHold) return recordApproval(deps, t, late, lateHold)
  const detail = (run.stderr || run.stdout).trim().slice(0, 200)
  return { kind: "error", status: 502, error: "merge_unverified", extra: { state: after, detail } }
}

async function closeIt(deps: PrActionDeps, t: PrTarget): Promise<ExecOutcome> {
  const closed = await mustBeOpen(deps.gh, t.prUrl)
  if (closed) return closed
  const run = await deps.gh(["pr", "close", t.prUrl])
  const after = await prState(deps.gh, t.prUrl)
  if (after !== "CLOSED") {
    const detail = (run.stderr || run.stdout).trim().slice(0, 200)
    return { kind: "error", status: 502, error: "close_unverified", extra: { state: after, detail } }
  }
  return { kind: "done", detail: { state: after } }
}

/**
 * Merge tap: mergeable + checks green → gh pr merge --squash, verified MERGED, then the task is done
 * (guarded) and outcome:merged recorded. Conflicting / behind / checks pending or failing → the
 * approval is recorded (`pr:approved-merge`) and the outcome is `queued`: the PR shepherd merges it.
 */
export async function mergePr(deps: PrActionDeps, t: PrTarget): Promise<ExecOutcome> {
  const out = await approveOrMerge(deps, t)
  if (out.kind !== "done") return out
  await deps.exec(
    "UPDATE tasks SET done = 1, updated_at = datetime('now') WHERE id = ? AND done = 0 AND dispatch_status IN ('completed', 'pr')",
    [t.taskId],
  )
  await ledger(deps, t, "outcome:merged", `PR #${t.number} merged`)
  return out
}

/** gh pr close, verified CLOSED, then outcome:rejected (dispatch-reconcile's wording, so it never logs it twice). */
export async function closePr(deps: PrActionDeps, t: PrTarget): Promise<ExecOutcome> {
  const out = await closeIt(deps, t)
  if (out.kind !== "done") return out
  await ledger(deps, t, "outcome:rejected", `PR #${t.number} closed unmerged`)
  return out
}

function ghBin(): string {
  return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find((p) => existsSync(p)) ?? "gh"
}

export const GH_TIMEOUT_MS = 60_000

/** The real `gh` (absolute path: the launchd PATH is minimal). Throws GhUnreachable when it cannot start. */
export const realGh: GhFn = async (args) => {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([ghBin(), ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GH_PROMPT_DISABLED: "1" } })
  } catch (err) {
    throw new GhUnreachable((err as Error)?.message ?? "spawn failed")
  }
  const timer = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, GH_TIMEOUT_MS)
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()])
    return { code: await proc.exited, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}
