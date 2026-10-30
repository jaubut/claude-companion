import { BRAIN_AGENT, BRAIN_THREAD } from "../lib/brain"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { type GhFn, prState, realGh } from "../lib/triage-pr"
import { type ExecFn, TursoUnreachable } from "../lib/turso"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// bin/pr-close (POST /hooks/brain/pr-close): the brain closes a DEAD agent PR
// so dispatch-run's per-repo cap (DISPATCH_FEATURE_CAP) frees a slot. Every
// check is made here, from GitHub and Turso, never from the brain's word:
//   open · head `dispatch/*` (never deps/*, agent/chores*, a human branch) ·
//   and dead: CONFLICTING, superseded by the task's newer PR, task done or
//   cancelled, or parked by the PR shepherd with its fix budget spent.
// The branch is kept (no --delete-branch).

export const PR_CLOSE_ACTION = "brain:pr-close"
export const REASON_MAX = 300
/** The shepherd's park reasons once a fix budget is spent (claude-config tools/pr-shepherd.ts decide()). */
const BUDGET_SPENT = /^(dep lane: )?(CI still failing after \d+ fixes|merge conflict unresolved after \d+ attempts|review verdict CHANGES after \d+ fix runs)/

export interface PrCloseInput { repo: string; pr: number; reason: string }
export interface PrCloseDeps { gh: GhFn; exec: ExecFn; event(text: string): void }
type Out = { status: number; body: Record<string, unknown> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } })

interface PrView { state: string; headRefName: string; mergeable: string; url: string }

async function view(gh: GhFn, p: PrCloseInput): Promise<PrView | Out> {
  let r: Awaited<ReturnType<GhFn>>
  try {
    r = await gh(["pr", "view", String(p.pr), "--repo", p.repo, "--json", "state,headRefName,mergeable,url"])
  } catch (err) {
    return fail(503, "gh_unreachable", { detail: String((err as Error)?.message ?? "").slice(0, 200) })
  }
  if (r.code !== 0) return fail(404, "pr_not_found", { detail: r.stderr.trim().slice(0, 200) })
  try {
    const v = JSON.parse(r.stdout) as Partial<PrView>
    return { state: String(v.state ?? ""), headRefName: String(v.headRefName ?? ""), mergeable: String(v.mergeable ?? ""), url: String(v.url ?? "") }
  } catch {
    return fail(502, "gh_bad_json")
  }
}

/** Why this PR is dead (empty = alive). Turso errors propagate. */
export async function deadReasons(exec: ExecFn, pr: PrView): Promise<{ reasons: string[]; taskId: string | null }> {
  const reasons: string[] = []
  if (pr.mergeable === "CONFLICTING") reasons.push("conflicting")
  // The task: the one whose PR this is, else the one the branch was cut for (dispatch/<id8>).
  const id8 = pr.headRefName.slice("dispatch/".length)
  const { rows } = await exec(
    "SELECT id, done, dispatch_status, dispatch_pr_url FROM tasks WHERE dispatch_pr_url = ? OR substr(id, 1, 8) = ? ORDER BY dispatch_pr_url = ? DESC LIMIT 1",
    [pr.url, id8, pr.url],
  )
  const t = rows[0]
  const taskId = t ? String(t.id) : null
  if (t) {
    const other = typeof t.dispatch_pr_url === "string" && t.dispatch_pr_url && t.dispatch_pr_url !== pr.url ? t.dispatch_pr_url : null
    if (other) reasons.push(`superseded by ${other}`)
    if (String(t.done) === "1" || t.dispatch_status === "cancelled") reasons.push(`task ${t.dispatch_status === "cancelled" ? "cancelled" : "done"}`)
  }
  // The newest park / unpark for this PR: a live park with a spent budget counts.
  const park = await exec(
    "SELECT action, meta FROM agent_activity WHERE action IN ('pr:needs-human', 'pr:unpark') AND target_id IN (?, ?) ORDER BY id DESC LIMIT 20",
    [taskId ?? pr.url, pr.url],
  )
  for (const row of park.rows) {
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(String(row.meta ?? "{}")) as Record<string, unknown> } catch { /* unreadable → ignored */ }
    if (row.action === "pr:unpark") break
    if (meta.url !== pr.url) continue
    if (typeof meta.reason === "string" && BUDGET_SPENT.test(meta.reason)) reasons.push(`parked: ${meta.reason.split(" · Opus:")[0]!.slice(0, 120)}`)
    break
  }
  return { reasons, taskId }
}

export async function closeDeadPr(p: PrCloseInput, deps: PrCloseDeps = realDeps): Promise<Out> {
  const v = await view(deps.gh, p)
  if ("status" in v) return v
  if (v.state !== "OPEN") return fail(409, "not_open", { state: v.state })
  if (!/^dispatch\/[\w.-]+$/.test(v.headRefName)) return fail(403, "not_agent_branch", { branch: v.headRefName })
  let dead: Awaited<ReturnType<typeof deadReasons>>
  try {
    dead = await deadReasons(deps.exec, v)
  } catch (err) {
    companionLog(`[brain] pr-close: turso ${err instanceof TursoUnreachable ? err.message : (err as Error)?.name ?? "error"}`)
    return fail(503, "turso_unreachable")
  }
  if (!dead.reasons.length) return fail(409, "not_dead", { branch: v.headRefName, mergeable: v.mergeable })
  const reason = redactSecrets(p.reason).slice(0, REASON_MAX)
  let run: Awaited<ReturnType<GhFn>>
  try {
    run = await deps.gh(["pr", "close", String(p.pr), "--repo", p.repo, "--comment", `Closed by the brain: ${reason}`])
  } catch (err) {
    return fail(503, "gh_unreachable", { detail: String((err as Error)?.message ?? "").slice(0, 200) })
  }
  const after = await prState(deps.gh, v.url).catch(() => "unknown")
  if (after !== "CLOSED") return fail(502, "close_unverified", { state: after, detail: (run.stderr || run.stdout).trim().slice(0, 200) })
  const evidence = dead.reasons.join("; ")
  try {
    await deps.exec(
      "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [BRAIN_AGENT, PR_CLOSE_ACTION, dead.taskId ? "task" : "pr", dead.taskId ?? v.url, `${p.repo}#${p.pr} closed by the brain: ${reason}`.slice(0, 200),
        JSON.stringify({ repo: p.repo, pr: p.pr, url: v.url, branch: v.headRefName, reason, evidence: dead.reasons, source: "companion" })],
    )
  } catch (err) {
    companionLog(`[brain] pr-close: activity row failed (${(err as Error)?.name ?? "error"})`)
  }
  deps.event(`Brain closed ${p.repo}#${p.pr} (${evidence}): ${reason}`)
  companionLog(`[brain] pr-close ${p.repo}#${p.pr} closed (${evidence})`)
  return { status: 200, body: { ok: true, closed: true, url: v.url, evidence: dead.reasons } }
}

const realDeps: PrCloseDeps = {
  gh: realGh,
  exec: (sql, args) => dispatchWiring.exec(sql, args),
  event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
}
