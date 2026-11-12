import { readFileSync } from "node:fs"
import { verifyHandoffClaim } from "./handoff-claim"
import { companionLog } from "./log"
import type { GhFn } from "./triage-pr"
import type { ExecFn } from "./turso"
import { REPO_NAME_RE, TASK_ID_RE } from "./worker-invocation"

// A bin/worker PR → tasks.dispatch_pr_url, the link the PR shepherd and merge gate read the PR's origin through.
// Proof of filing: the handoff claim (lib/handoff-claim.ts) the server minted for this task id and repo, passed through
// `bin/worker dispatch --claim`. Every half verifies it; no claim, or one for another id or repo, never links.
//  - bindWorkerTask, when the supervisor dispatches a task id with a claim: the claim verifies and the Turso row of that
//    id is OWNABLE (a brain handoff, open, never claimed by dispatch-run or the relay, unlinked). The supervisor
//    persists the answer and the claim (a failed read is retried next turn) and refuses the id under another repo.
//  - linkWorkerPr, on "PR ready" of a bound task, and the startup replay: the claim verifies again (the worker state file
//    is writable by any same-uid process, so it's not trusted), GitHub must show jaubut/<repo> with head
//    `dispatch/<task id>` from that repo (not a fork); GitHub's canonical url is written by a compare-and-set on OWNABLE,
//    so a link is never overwritten.

const PR_URL = /^https:\/\/github\.com\/jaubut\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/
export const OWNABLE = "id = ? AND done = 0 AND assignee = 'handoff' AND dispatch_status IS NULL AND (dispatch_owner IS NULL OR dispatch_owner = '') AND (dispatch_pr_url IS NULL OR dispatch_pr_url = '')"
const TRIES = 3
const RETRY_MS = 1_000

export type LinkOutcome = "claim_refused" | "linked" | "would_link" | "not_linked" | "bad_url" | "repo_mismatch" | "branch_mismatch" | "gh_failed" | "write_failed" | "timeout"

interface LinkDeps { gh: GhFn; exec: ExecFn; sleep?(ms: number): Promise<unknown> }
interface LinkTarget { taskId: string; repo: string; prUrl: string; claim: string | null | undefined }

/** The claim checks out for this id and repo; a refusal logs its reason, never the claim. */
function claimRefusal(t: { taskId: string; repo: string; claim: unknown }, log: (line: string) => void = (l) => companionLog(`[worker] ${l}`)): string | null {
  const c = verifyHandoffClaim(t.claim, t.taskId, t.repo)
  if (!c.ok) log(`${t.taskId.slice(0, 8)} ${t.repo}: claim refused: ${c.reason}`)
  return c.ok ? null : c.reason
}

async function attempt(deps: LinkDeps, t: LinkTarget, write: boolean): Promise<LinkOutcome> {
  if (claimRefusal(t)) return "claim_refused"
  const m = PR_URL.exec(t.prUrl)
  if (!m) return "bad_url"
  if (m[1]!.toLowerCase() !== t.repo.toLowerCase()) return "repo_mismatch"
  let head: { headRefName?: unknown; isCrossRepository?: unknown; url?: unknown }
  try {
    const r = await deps.gh(["pr", "view", m[2]!, "--repo", `jaubut/${m[1]}`, "--json", "headRefName,isCrossRepository,url"])
    if (r.code !== 0) return "gh_failed"
    head = JSON.parse(r.stdout) as typeof head
  } catch {
    return "gh_failed"
  }
  if (head.headRefName !== `dispatch/${t.taskId}` || head.isCrossRepository !== false) return "branch_mismatch"
  const canon = typeof head.url === "string" ? PR_URL.exec(head.url) : null
  if (!canon || canon[1]!.toLowerCase() !== t.repo.toLowerCase() || canon[2] !== m[2]) return "repo_mismatch"
  try {
    if (!write) return (await deps.exec(`SELECT 1 FROM tasks WHERE ${OWNABLE}`, [t.taskId])).rows.length ? "would_link" : "not_linked"
    const { affected } = await deps.exec(`UPDATE tasks SET dispatch_pr_url = ?, updated_at = datetime('now') WHERE ${OWNABLE}`, [head.url as string, t.taskId])
    return affected > 0 ? "linked" : "not_linked"
  } catch {
    return "write_failed"
  }
}

/** Dispatch-time binding: true when the claim is this id's and repo's and the row of this id is OWNABLE; else the refusal
 *  reason (the claim check's, or `not_ownable`). null = the read failed (no answer). */
export async function bindWorkerTask(exec: ExecFn, taskId: string, repo: string, claim: unknown): Promise<true | string | null> {
  const refused = claimRefusal({ taskId, repo, claim })
  if (refused) return refused
  try {
    return (await exec(`SELECT 1 FROM tasks WHERE ${OWNABLE}`, [taskId])).rows.length > 0 || "not_ownable"
  } catch {
    return null
  }
}

/** Retries gh_failed / write_failed twice. With deadlineMs, answers "timeout" by then and lets the link finish behind. */
export function linkWorkerPr(deps: LinkDeps, t: LinkTarget, opts: { write?: boolean; deadlineMs?: number } = {}): Promise<LinkOutcome> {
  const sleep = deps.sleep ?? Bun.sleep
  const run = (async () => {
    for (let i = 1; ; i++) {
      const out = await attempt(deps, t, opts.write ?? true)
      if ((out !== "gh_failed" && out !== "write_failed") || i === TRIES) return out
      await sleep(RETRY_MS * i)
    }
  })()
  if (opts.deadlineMs === undefined) return run
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<LinkOutcome>((resolve) => { timer = setTimeout(() => resolve("timeout"), opts.deadlineMs) })
  return Promise.race([run, deadline]).finally(() => clearTimeout(timer))
}

/** The brain's terminal message for a worker turn. "PR ready [" stays first (lib/brain.ts receipt match); the step's
 *  link note, e.g. "(PR link still pending)", follows the url so the brain hears when the link hasn't landed. */
export function workerReceipt(t: { taskId: string; repo: string; title: string; status: string; step: string | null; prUrl: string | null; result: string; error: string | null }): string {
  const result = t.result ? `\nResult: ${t.result.slice(0, 600)}` : ""
  if (t.status !== "completed") return `blocked [${t.taskId}] ${t.repo} — ${t.title}\nError: ${(t.error || "worker failed").slice(0, 400)}`
  if (!t.prUrl) return `completed [${t.taskId}] ${t.repo} — ${t.title}${result}`
  const head = `PR ready: ${t.prUrl}`
  const note = t.step?.startsWith(head) ? t.step.slice(head.length) : ""
  return `PR ready [${t.taskId}] ${t.repo} — ${t.prUrl}${note}${result}`
}

export interface Linked { taskId: string; repo: string; prUrl: string; outcome: LinkOutcome }

/**
 * Open `dispatch/<id>` PRs of the worker state file's tasks whose claim verifies and whose row is still OWNABLE, through
 * linkWorkerPr. A record with no claim (bound before claims existed, or never) is skipped. Used by
 * scripts/backfill-worker-pr-links.ts and the startup replay.
 */
export async function backfillWorkerPrLinks(
  deps: LinkDeps & { log(line: string): void },
  stateFile: string,
  opts: { write: boolean },
): Promise<Linked[]> {
  let records: Array<{ taskId?: unknown; repo?: unknown; handoffClaim?: unknown }>
  try {
    records = JSON.parse(readFileSync(stateFile, "utf8")) as typeof records
  } catch (err) {
    deps.log(`unreadable worker state file ${stateFile}: ${(err as Error).message}`)
    return []
  }
  const out: Linked[] = []
  for (const r of Array.isArray(records) ? records : []) {
    if (typeof r.taskId !== "string" || !TASK_ID_RE.test(r.taskId) || typeof r.repo !== "string" || !REPO_NAME_RE.test(r.repo)) continue
    const { taskId, repo } = r
    const claim = typeof r.handoffClaim === "string" ? r.handoffClaim : null
    if (!claim || claimRefusal({ taskId, repo, claim }, deps.log)) continue
    if (!await deps.exec(`SELECT 1 FROM tasks WHERE ${OWNABLE}`, [taskId]).then((x) => x.rows.length > 0, () => false)) continue
    const list = await deps.gh(["pr", "list", "--repo", `jaubut/${repo}`, "--head", `dispatch/${taskId}`, "--state", "open", "--json", "url"]).catch(() => null)
    let prs: unknown = null
    try {
      if (list?.code === 0) prs = JSON.parse(list.stdout)
    } catch { /* logged below */ }
    if (!Array.isArray(prs)) { deps.log(`${taskId} ${repo}: gh pr list failed`); continue }
    for (const { url } of prs as Array<{ url: string }>) {
      const outcome = await linkWorkerPr(deps, { taskId, repo, prUrl: url, claim }, { write: opts.write })
      deps.log(`${taskId} ${repo} ${url}: ${outcome}`)
      out.push({ taskId, repo, prUrl: url, outcome })
    }
  }
  return out
}
