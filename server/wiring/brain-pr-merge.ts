import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BRAIN_AGENT, BRAIN_THREAD } from "../lib/brain"
import { companionLog } from "../lib/log"
import { type MergeGateFn, mergeGate } from "../lib/merge-gate"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { type GhFn, prReadiness, prState, realGh } from "../lib/triage-pr"
import { type ExecFn, TursoUnreachable } from "../lib/turso"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// bin/pr-merge (POST /hooks/brain/pr-merge): the brain merges a ROUTINE agent
// PR. The brain's word counts for nothing: every check is made here, from
// GitHub and Turso, and any doubt refuses. In order:
//   open
//   merge gate (403 <stop>, 409 gate_unavailable / head_moved / base_moved, lib/merge-gate.ts):
//     before draft and the branch check, so no head is exempt, sync/* included
//   not draft · head `dispatch/*` (403 not_agent_branch)
//   parked (403): no live shepherd park or hold, except the client-origin /
//     tainted / sensitive-path park (the MFA human-review policy, retired
//     2026-10-31: money, origin and paths alone no longer gate a green,
//     twice-approved agent PR). A park that says `human merge` is a hard stop,
//     never retired.
//   not_green (409): MERGEABLE + mergeStateStatus CLEAN + every check passed (≥ 1)
//   not_approved (409): Claude AND Codex auto-review comments with VERDICT:
//     APPROVE stamped with the current head sha, from the PR's author (the
//     dispatch account); none with CHANGES on that head; no CHANGES_REQUESTED
//   merge_cap (429): ≤ MERGE_CAP brain merges in 24 h
//   base read again (409 base_moved / gate_unavailable): the gate's reads are behind all of the above
//     TEMPORARY: while the flag file ~/.claude/state/claude-review-paused exists (read on every call), a
//     `normal` tier PR needs the Codex APPROVE instead of Claude's (no CHANGES from either reviewer);
//     a client-origin one needs both.
//   caller still there (409 client_gone): nobody would hear the answer, so nothing merges
// Then `gh pr merge --squash --match-head-commit <checked sha>`: a head pushed
// after the checks makes GitHub refuse. Each merge is a `brain:pr-merge`
// agent_activity row (the machine digest lists them) and a brain-thread event.

export const PR_MERGE_ACTION = "brain:pr-merge"
const REASON_MAX = 300
export const MERGE_CAP = 10

// The shepherd's human-review parks (pr-shepherd clientPark / taint / sensitive): retired, they no longer refuse.
// Every other park (conflict unresolved, fix budget spent, infra hold, no CI…) means the work is broken: refuse.
// `human merge` marks pr-gate.ts's hard stops, C-017 among them, whatever prefix clientPark puts on them.
const RETIRED_PARK = /^(client(-origin)? PR|tainted \(|touches .+ — needs your review)/
export const retiredPark = (why: string): boolean => RETIRED_PARK.test(why) && !/human merge/i.test(why)
const CLAUDE_HEADING = /^\s*🤖 \*\*Auto-review\*\*/u
const CODEX_HEADING = /^\s*🧠 \*\*Codex review\*\*/u
/** Files the marker's low tier may cover here: a comment is writable by any agent, so the server checks. Narrower than the shepherd's rule: agent instructions (.md) need a review. */
const LOW_FILE = /^docs\/.+\.md$|^README\.md$|\.test\.ts$|^architecture\.(json|md)$/
const LOW_FILE_LIMIT = 100
const reviewedSha = (sha: string) => `<!-- reviewed-sha: ${sha} -->`

interface PrMergeInput { repo: string; pr: number; reason: string; signal?: AbortSignal }
interface PrMergeDeps { gh: GhFn; exec: ExecFn; event(text: string): void; gate: MergeGateFn; pausedFlag?: string }
const CLAUDE_PAUSED_FLAG = join(homedir(), ".claude", "state", "claude-review-paused")
type Out = { status: number; body: Record<string, unknown> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } })

interface Check { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }
interface Comment { body?: string; author?: { login?: string } | null }
interface PrView {
  state: string; isDraft: boolean; headRefName: string; headRefOid: string; baseRefName: string; mergeable: string; mergeStateStatus: string
  reviewDecision: string; url: string; title: string; author: { login?: string } | null; labels: Array<{ name?: string }>
  statusCheckRollup: Check[]; comments: Comment[]; files: Array<{ path?: string }>
}
const FIELDS = "state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,url,title,author,labels,statusCheckRollup,comments,files"

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
      state: String(v.state ?? ""), isDraft: v.isDraft !== false, headRefName: String(v.headRefName ?? ""), headRefOid: String(v.headRefOid ?? ""), baseRefName: String(v.baseRefName ?? ""),
      mergeable: String(v.mergeable ?? ""), mergeStateStatus: String(v.mergeStateStatus ?? ""), reviewDecision: String(v.reviewDecision ?? ""),
      url: String(v.url ?? ""), title: String(v.title ?? ""), author: v.author ?? null,
      labels: Array.isArray(v.labels) ? v.labels : [], statusCheckRollup: Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [],
      comments: Array.isArray(v.comments) ? v.comments : [], files: Array.isArray(v.files) ? v.files : [],
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
function notApproved(v: PrView, claudePaused = false, clientOrigin = false): string[] {
  const out: string[] = []
  const login = v.author?.login
  if (!login || !v.headRefOid) return ["no PR author or head sha"]
  const head = v.comments.filter((c) => c.author?.login === login && String(c.body ?? "").includes(reviewedSha(v.headRefOid))).map((c) => String(c.body))
  const claude = head.filter((b) => CLAUDE_HEADING.test(b))
  const codex = head.filter((b) => CODEX_HEADING.test(b))
  if ([...claude, ...codex].some((b) => /VERDICT:\s*CHANGES/i.test(b))) out.push("CHANGES on this head")
  if (v.reviewDecision === "CHANGES_REQUESTED") out.push("GitHub review CHANGES_REQUESTED")
  // The shepherd's newest tier marker (claude-config PR 230); no marker counts as high.
  const tier = v.comments.filter((c) => c.author?.login === login).map((c) => /<!-- review-tier: (\w+) -->/.exec(String(c.body))?.[1]).filter(Boolean).at(-1)
  if (tier === "low" && v.files.length > 0 && v.files.length < LOW_FILE_LIMIT && v.files.every((f) => LOW_FILE.test(String(f.path)))) return out
  // Paused: a normal tier needs Codex; a client-origin one keeps Claude too (both).
  const codexOnly = claudePaused && tier === "normal" && !clientOrigin
  if (!codexOnly && !claude.some((b) => /VERDICT:\s*APPROVE/i.test(b))) out.push("no Claude APPROVE on this head")
  if ((tier !== "normal" || claudePaused) && !codex.some((b) => /VERDICT:\s*APPROVE/i.test(b))) out.push("no Codex APPROVE on this head")
  return out
}

/** Why this PR is parked as broken or held (empty = mergeable). Turso errors propagate. */
async function parked(exec: ExecFn, v: PrView): Promise<{ reasons: string[]; taskIds: string[]; clientOrigin: boolean }> {
  const reasons: string[] = []
  // Tasks linked by the PR url (a branch-name match is guessable): park rows and the digest row key on them.
  const { rows } = await exec("SELECT id, origin FROM tasks WHERE dispatch_pr_url = ?", [v.url])
  const taskIds = rows.map((r) => String(r.id))
  // The PR read doesn't carry origin: tasks.origin is the authority, the label is advisory (forgeable, so it can only tighten).
  const clientOrigin = rows.some((r) => r.origin === "client") || v.labels.some((l) => l.name === "client-origin")
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
    if (row.action === "pr:hold" || (row.action === "pr:needs-human" && !retiredPark(why))) {
      reasons.push(`${row.action === "pr:hold" ? "held" : "parked"} by the shepherd${why ? `: ${why.slice(0, 120)}` : ""}`)
    }
    break
  }
  return { reasons, taskIds, clientOrigin }
}

export async function mergeAgentPr(p: PrMergeInput, deps: PrMergeDeps = realDeps): Promise<Out> {
  const v = await view(deps.gh, p)
  if ("status" in v) return v
  if (v.state !== "OPEN") return fail(409, "not_open", { state: v.state })
  const g = await deps.gate(deps, { url: v.url })
  if (!g.ok) return fail(g.status, g.error, g.extra)
  if (g.head !== v.headRefOid) return fail(409, "head_moved")
  if (g.base !== v.baseRefName) return fail(409, "base_moved")
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
  const unapproved = notApproved(v, existsSync(deps.pausedFlag ?? CLAUDE_PAUSED_FLAG), park.clientOrigin)
  if (unapproved.length) return fail(409, "not_approved", { reasons: unapproved, head: v.headRefOid })
  if (!(recent < MERGE_CAP)) return fail(429, "merge_cap", { cap: MERGE_CAP })
  // The head has --match-head-commit behind it. The base has only this read, so no answer means no merge.
  const last = await prReadiness(deps.gh, v.url).catch(() => null)
  if (!last?.base) return fail(409, "gate_unavailable", { detail: "couldn't read the PR base" })
  if (last.base !== g.base) return fail(409, "base_moved")
  if (p.signal?.aborted) return fail(409, "client_gone")
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
  gate: mergeGate,
}
