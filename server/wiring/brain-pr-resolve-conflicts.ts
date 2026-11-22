import { BRAIN_AGENT, BRAIN_THREAD } from "../lib/brain"
import { CONFLICT_RESOLVER_MODEL, buildConflictResolverPrompt, conflictTaskId } from "../lib/conflict-resolver"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { type GhFn, realGh } from "../lib/triage-pr"
import type { ExecFn } from "../lib/turso"
import type { DispatchTaskInput } from "../lib/worker-supervisor"
import { REASON_MAX } from "./brain-pr-close"
import { hasRecentUserMergeApproval } from "./brain-pr-merge"
import { parked } from "./brain-pr-park"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// bin/pr-resolve-conflicts (POST /hooks/brain/pr-resolve-conflicts): a conflicting agent PR gets a fresh, neutral
// claude-sonnet-5-5 worker on its own head branch, never a resumed builder session. Every check is made here from
// GitHub and the notes DB, never from the caller's word:
//   open (409 not_open) · head `dispatch/*` (403 not_agent_branch) ·
//   no client origin (403 client_origin), no live park or hold (403 parked) ·
//   notes DB must answer (503 turso_unreachable) ·
//   mergeable CONFLICTING (409 not_conflicting when MERGEABLE; 409 mergeable_unknown when UNKNOWN after one retry).
// The worker merges the base into the head locally and pushes the head branch; the new head voids the reviewed-sha
// stamps, so bin/pr-merge answers not_approved until the cascade reviews it again.

export const PR_RESOLVE_ACTION = "brain:pr-resolve-conflicts"
const UNKNOWN_RETRY_MS = 3_000

interface ResolveInput { repo: string; pr: number; reason: string }
interface ResolveDeps {
  gh: GhFn; exec: ExecFn; event(text: string): void; sleep(ms: number): Promise<unknown>; humanApproved?(pr: number, repo: string): boolean
  dispatch(input: DispatchTaskInput): Promise<{ ok: true } | { ok: false; status: number; error: string }>
}
interface Out { status: number; body: Record<string, unknown> }
interface PrView { state: string; headRefName: string; baseRefName: string; headRefOid: string; mergeable: string; url: string; title: string; labels: Array<{ name?: string }> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } })

async function view(gh: GhFn, p: ResolveInput): Promise<PrView | Out> {
  let r: Awaited<ReturnType<GhFn>>
  try {
    r = await gh(["pr", "view", String(p.pr), "--repo", p.repo, "--json", "state,headRefName,baseRefName,headRefOid,mergeable,url,title,labels"])
  } catch (err) {
    return fail(503, "gh_unreachable", { detail: String((err as Error)?.message ?? "").slice(0, 200) })
  }
  if (r.code !== 0) return fail(404, "pr_not_found", { detail: r.stderr.trim().slice(0, 200) })
  try {
    const v = JSON.parse(r.stdout) as Partial<PrView>
    return {
      state: String(v.state ?? ""), headRefName: String(v.headRefName ?? ""), baseRefName: String(v.baseRefName ?? ""), headRefOid: String(v.headRefOid ?? ""),
      mergeable: String(v.mergeable ?? ""), url: String(v.url ?? ""), title: String(v.title ?? ""), labels: Array.isArray(v.labels) ? v.labels : [],
    }
  } catch {
    return fail(502, "gh_bad_json")
  }
}

export async function resolveAgentPrConflicts(p: ResolveInput, deps: ResolveDeps = realDeps): Promise<Out> {
  let v = await view(deps.gh, p)
  if ("status" in v) return v
  if (v.state !== "OPEN") return fail(409, "not_open", { state: v.state })
  if (!/^dispatch\/[\w.-]+$/.test(v.headRefName)) return fail(403, "not_agent_branch", { branch: v.headRefName })
  const humanApproved = deps.humanApproved?.(p.pr, p.repo) === true
  let park: Awaited<ReturnType<typeof parked>>
  try {
    park = await parked(deps.exec, v, humanApproved)
  } catch (err) {
    companionLog(`[brain] pr-resolve-conflicts: turso ${(err as Error)?.name ?? "error"}`)
    return fail(503, "turso_unreachable")
  }
  if (park.clientOrigin) return fail(403, "client_origin")
  if (park.reasons.length) return fail(403, "parked", { reasons: park.reasons })
  if (v.mergeable === "UNKNOWN") {
    // GitHub computes mergeability lazily: ask once more before giving up.
    await deps.sleep(UNKNOWN_RETRY_MS)
    const again = await view(deps.gh, p)
    if ("status" in again) return again
    if (again.state !== "OPEN") return fail(409, "not_open", { state: again.state })
    if (again.headRefName !== v.headRefName) return fail(409, "head_moved", { branch: again.headRefName })
    v = again
  }
  if (v.mergeable === "UNKNOWN") return fail(409, "mergeable_unknown")
  if (v.mergeable !== "CONFLICTING") return fail(409, "not_conflicting", { mergeable: v.mergeable })

  const reason = redactSecrets(p.reason).slice(0, REASON_MAX)
  const taskId = conflictTaskId(p.repo, p.pr, v.headRefOid)
  const run = await deps.dispatch({
    taskId, repo: p.repo.split("/")[1]!, family: "claude", model: CONFLICT_RESOLVER_MODEL, mode: "auto",
    title: `Resolve conflicts: ${v.title}`.slice(0, 200), targetBranch: v.headRefName,
    prompt: buildConflictResolverPrompt({ ...p, reason, url: v.url, title: v.title, headRefName: v.headRefName, baseRefName: v.baseRefName, headRefOid: v.headRefOid }),
  }).catch((err: unknown) => ({ ok: false as const, status: 500, error: String((err as Error)?.message ?? err).slice(0, 200) }))
  if (!run.ok) return run.error === "task_already_running" ? fail(409, "already_resolving", { taskId }) : fail(502, "dispatch_failed", { detail: run.error.slice(0, 200) })
  try {
    await deps.exec(
      "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [BRAIN_AGENT, PR_RESOLVE_ACTION, "pr", v.url, `${p.repo}#${p.pr} conflict resolver dispatched: ${reason}`.slice(0, 200),
        JSON.stringify({ repo: p.repo, pr: p.pr, url: v.url, branch: v.headRefName, base: v.baseRefName, head: v.headRefOid, taskId, reason, source: "companion" })],
    )
  } catch (err) {
    companionLog(`[brain] pr-resolve-conflicts: activity row failed (${(err as Error)?.name ?? "error"})`)
  }
  deps.event(`Brain dispatched a neutral conflict resolver (${taskId}) for ${p.repo}#${p.pr} (${v.title.slice(0, 80)}): ${reason}`)
  companionLog(`[brain] pr-resolve-conflicts ${p.repo}#${p.pr} ${v.headRefOid.slice(0, 7)} → ${taskId}`)
  return { status: 200, body: { ok: true, dispatched: true, taskId, url: v.url, branch: v.headRefName, head: v.headRefOid } }
}

const realDeps: ResolveDeps = {
  gh: realGh,
  exec: (sql, args) => dispatchWiring.exec(sql, args),
  event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
  sleep: (ms) => Bun.sleep(ms),
  humanApproved: (pr) => hasRecentUserMergeApproval(pr),
  // Lazy: the supervisor loads its state file on import, which a gate test never wants.
  dispatch: async (input) => (await import("./worker-mcp")).workerSupervisor.dispatchTask(input),
}
