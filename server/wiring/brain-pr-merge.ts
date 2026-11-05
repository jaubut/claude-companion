import { BRAIN_AGENT, BRAIN_THREAD } from "../lib/brain"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { type GhFn, prState, realGh } from "../lib/triage-pr"
import { type ExecFn, TursoUnreachable } from "../lib/turso"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// bin/pr-merge (POST /hooks/brain/pr-merge): the brain merges a ROUTINE agent
// PR. The brain's word counts for nothing: every check is made here, from
// GitHub and Turso, and any doubt refuses. In order:
//   open, not draft · head `dispatch/*` (403 not_agent_branch)
//   parked (403): no do-not-merge/wip label; no live shepherd park or hold,
//     except the client-origin / tainted / sensitive-path park (the MFA
//     human-review policy, retired 2026-10-31: money, origin and paths no
//     longer gate a green, twice-approved agent PR)
//   not_green (409): MERGEABLE + mergeStateStatus CLEAN + every check passed (≥ 1)
//   not_approved (409): Claude AND Codex auto-review comments with VERDICT:
//     APPROVE stamped with the current head sha, from the PR's author (the
//     dispatch account); none with CHANGES on that head; no CHANGES_REQUESTED
//   merge_cap (429): ≤ MERGE_CAP brain merges in 24 h
// Then `gh pr merge --squash --match-head-commit <checked sha>`: a head pushed
// after the checks makes GitHub refuse. Each merge is a `brain:pr-merge`
// agent_activity row (the machine digest lists them) and a brain-thread event.

export const PR_MERGE_ACTION = "brain:pr-merge"
const REASON_MAX = 300
export const MERGE_CAP = 10

const HOLD_LABEL = /do-not-merge|dnm|(^|[^a-z])wip([^a-z]|$)/i
// The shepherd's human-review parks (pr-shepherd clientPark / taint / sensitive): retired, they no longer refuse.
// Every other park (conflict unresolved, fix budget spent, infra hold, no CI…) means the work is broken: refuse.
const RETIRED_PARK = /^(client(-origin)? PR|tainted \(|touches .+ — needs your review)/
const CLAUDE_HEADING = /^\s*🤖 \*\*Auto-review\*\*/u
const CODEX_HEADING = /^\s*🧠 \*\*Codex review\*\*/u
const reviewedSha = (sha: string) => `<!-- reviewed-sha: ${sha} -->`

interface PrMergeInput { repo: string; pr: number; reason: string }
interface PrMergeDeps { gh: GhFn; exec: ExecFn; event(text: string): void }
type Out = { status: number; body: Record<string, unknown> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } })

interface Check { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }
interface Comment { body?: string; author?: { login?: string } | null }
interface PrView {
  state: string; isDraft: boolean; headRefName: string; headRefOid: string; mergeable: string; mergeStateStatus: string
  reviewDecision: string; url: string; title: string; author: { login?: string } | null; labels: Array<{ name?: string }>
  statusCheckRollup: Check[]; comments: Comment[]
}
const FIELDS = "state,isDraft,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,url,title,author,labels,statusCheckRollup,comments"

async function view(gh: GhFn, p: PrMergeInput): Promise<PrView | Out> {
  let r: Awaited<ReturnType<GhFn>>
  try {
    r = await gh(["pr", "view", String(p.pr), "--repo", p.repo, "--json", FIELDS])
  } catch (err) {
    return fail(503, "gh_unreachable", { detail: String((err as Error)?.message ?? "").slice(0, 200) })
  }
  if (r.code !== 0) return fail(404, "pr_not_found", { detail: r.stderr.trim().slice(0, 200) })
  try {
    const v = JSON.parse(r.stdout) as Partial<PrView>
    return {
      state: String(v.state ?? ""), isDraft: v.isDraft !== false, headRefName: String(v.headRefName ?? ""), headRefOid: String(v.headRefOid ?? ""),
      mergeable: String(v.mergeable ?? ""), mergeStateStatus: String(v.mergeStateStatus ?? ""), reviewDecision: String(v.reviewDecision ?? ""),
      url: String(v.url ?? ""), title: String(v.title ?? ""), author: v.author ?? null,
      labels: Array.isArray(v.labels) ? v.labels : [], statusCheckRollup: Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [],
      comments: Array.isArray(v.comments) ? v.comments : [],
    }
  } catch {
    return fail(502, "gh_bad_json")
  }
}

/** A check run or a commit status that finished green; anything else (pending, failed, unknown) is not. */
function checkPassed(c: Check): boolean {
  if (c.__typename === "StatusContext" || (c.state !== undefined && c.conclusion === undefined)) return c.state === "SUCCESS"
  return c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(c.conclusion))
}

/** Why CI is not green (empty = green). */
function notGreen(v: PrView): string[] {
  const out: string[] = []
  if (v.mergeable !== "MERGEABLE") out.push(`mergeable ${v.mergeable || "unknown"}`)
  if (v.mergeStateStatus !== "CLEAN") out.push(`mergeStateStatus ${v.mergeStateStatus || "unknown"}`)
  if (!v.statusCheckRollup.length) out.push("no CI checks")
  for (const c of v.statusCheckRollup) if (!checkPassed(c)) out.push(`check ${c.name ?? c.context ?? "?"}: ${c.conclusion || c.state || c.status || "?"}`)
  if (!v.statusCheckRollup.some((c) => c.conclusion === "SUCCESS" || c.state === "SUCCESS")) out.push("no passing check")
  return out
}

/** Why the review cascade has not approved this head (empty = approved). */
function notApproved(v: PrView): string[] {
  const out: string[] = []
  const login = v.author?.login
  if (!login || !v.headRefOid) return ["no PR author or head sha"]
  const head = v.comments.filter((c) => c.author?.login === login && String(c.body ?? "").includes(reviewedSha(v.headRefOid))).map((c) => String(c.body))
  const claude = head.filter((b) => CLAUDE_HEADING.test(b))
  const codex = head.filter((b) => CODEX_HEADING.test(b))
  if ([...claude, ...codex].some((b) => /VERDICT:\s*CHANGES/i.test(b))) out.push("CHANGES on this head")
  if (!claude.some((b) => /VERDICT:\s*APPROVE/i.test(b))) out.push("no Claude APPROVE on this head")
  if (!codex.some((b) => /VERDICT:\s*APPROVE/i.test(b))) out.push("no Codex APPROVE on this head")
  if (v.reviewDecision === "CHANGES_REQUESTED") out.push("GitHub review CHANGES_REQUESTED")
  return out
}

/** Why this PR is parked as broken or held (empty = mergeable). Turso errors propagate. */
async function parked(exec: ExecFn, v: PrView): Promise<{ reasons: string[]; taskIds: string[] }> {
  const reasons: string[] = []
  const labels = v.labels.map((l) => String(l.name ?? "")).filter((l) => HOLD_LABEL.test(l))
  if (labels.length) reasons.push(`label ${labels.join(", ")}`)
  // Tasks linked by the PR url (a branch-name match is guessable): park rows and the digest row key on them.
  const { rows } = await exec("SELECT id FROM tasks WHERE dispatch_pr_url = ?", [v.url])
  const taskIds = rows.map((r) => String(r.id))
  // The newest shepherd park / hold / unpark for this PR: a live one refuses unless it is a retired human-review park.
  const last = await exec(
    "SELECT action, meta FROM agent_activity WHERE action IN ('pr:needs-human', 'pr:hold', 'pr:unpark') AND target_id IN (" + [v.url, ...taskIds].map(() => "?").join(", ") + ") ORDER BY id DESC LIMIT 20",
    [v.url, ...taskIds],
  )
  for (const row of last.rows) {
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(String(row.meta ?? "{}")) as Record<string, unknown> } catch { /* unreadable → counts */ }
    if (meta.url !== undefined && meta.url !== v.url) continue
    const why = typeof meta.reason === "string" ? meta.reason : ""
    if (row.action === "pr:hold" || (row.action === "pr:needs-human" && !RETIRED_PARK.test(why))) {
      reasons.push(`${row.action === "pr:hold" ? "held" : "parked"} by the shepherd${why ? `: ${why.slice(0, 120)}` : ""}`)
    }
    break
  }
  return { reasons, taskIds }
}

export async function mergeAgentPr(p: PrMergeInput, deps: PrMergeDeps = realDeps): Promise<Out> {
  const v = await view(deps.gh, p)
  if ("status" in v) return v
  if (v.state !== "OPEN") return fail(409, "not_open", { state: v.state })
  if (v.isDraft) return fail(409, "draft")
  if (!/^dispatch\/[\w.-]+$/.test(v.headRefName)) return fail(403, "not_agent_branch", { branch: v.headRefName })
  let park: Awaited<ReturnType<typeof parked>>
  let recent: number
  try {
    park = await parked(deps.exec, v)
    const c = await deps.exec("SELECT COUNT(*) AS n FROM agent_activity WHERE action = ? AND ts >= datetime('now', '-1 day')", [PR_MERGE_ACTION])
    recent = Number(c.rows[0]?.n ?? NaN)
  } catch (err) {
    companionLog(`[brain] pr-merge: turso ${err instanceof TursoUnreachable ? err.message : (err as Error)?.name ?? "error"}`)
    return fail(503, "turso_unreachable")
  }
  if (park.reasons.length) return fail(403, "parked", { reasons: park.reasons })
  const red = notGreen(v)
  if (red.length) return fail(409, "not_green", { reasons: red })
  const unapproved = notApproved(v)
  if (unapproved.length) return fail(409, "not_approved", { reasons: unapproved, head: v.headRefOid })
  if (!(recent < MERGE_CAP)) return fail(429, "merge_cap", { cap: MERGE_CAP })
  const reason = redactSecrets(p.reason).slice(0, REASON_MAX)
  let run: Awaited<ReturnType<GhFn>>
  try {
    run = await deps.gh(["pr", "merge", String(p.pr), "--repo", p.repo, "--squash", "--delete-branch", "--match-head-commit", v.headRefOid])
  } catch (err) {
    return fail(503, "gh_unreachable", { detail: String((err as Error)?.message ?? "").slice(0, 200) })
  }
  const after = await prState(deps.gh, v.url).catch(() => "unknown")
  if (after !== "MERGED") return fail(502, "merge_unverified", { state: after, detail: (run.stderr || run.stdout).trim().slice(0, 200) })
  const taskId = park.taskIds[0] ?? null
  try {
    await deps.exec(
      "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [BRAIN_AGENT, PR_MERGE_ACTION, taskId ? "task" : "pr", taskId ?? v.url, `${p.repo}#${p.pr} merged by the brain: ${reason}`.slice(0, 200),
        JSON.stringify({ repo: p.repo, pr: p.pr, url: v.url, branch: v.headRefName, head: v.headRefOid, title: v.title.slice(0, 200), reason, tasks: park.taskIds, source: "companion" })],
    )
  } catch (err) {
    companionLog(`[brain] pr-merge: activity row failed (${(err as Error)?.name ?? "error"})`)
  }
  deps.event(`Brain merged ${p.repo}#${p.pr} (${v.title.slice(0, 80)}): ${reason}`)
  companionLog(`[brain] pr-merge ${p.repo}#${p.pr} merged at ${v.headRefOid.slice(0, 7)}`)
  return { status: 200, body: { ok: true, merged: true, url: v.url, head: v.headRefOid } }
}

const realDeps: PrMergeDeps = {
  gh: realGh,
  exec: (sql, args) => dispatchWiring.exec(sql, args),
  event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
}
