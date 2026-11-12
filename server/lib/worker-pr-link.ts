import { readFileSync } from "node:fs"
import type { GhFn } from "./triage-pr"
import type { ExecFn } from "./turso"
import { REPO_NAME_RE, TASK_ID_RE } from "./worker-invocation"

// A bin/worker PR → tasks.dispatch_pr_url, the link the PR shepherd and merge gate read the PR's origin through.
// Two halves, both needed:
//  - bindWorkerTask, once, when the supervisor first dispatches a task id (the trusted side): the Turso row of that id
//    must be OWNABLE (a brain handoff, open, never claimed by dispatch-run or the relay, unlinked) and its description
//    must name the repo. The supervisor persists a definitive answer (a failed read is retried next turn); an unbound worker task never links, and the supervisor
//    refuses the same id under another repo (task_repo_mismatch).
//  - linkWorkerPr, on "PR ready" of a bound task: GitHub must show jaubut/<repo> with head `dispatch/<task id>` from that
//    repo (not a fork); GitHub's canonical url is written by a compare-and-set on OWNABLE, so a link is never overwritten.
// ponytail: residual risk, stated plainly: a worker MCP caller that dispatches first under the id of ANOTHER open,
// unclaimed handoff row whose description names the same repo binds it, and its PR inherits that row's origin. Nothing
// the supervisor holds can tell that dispatch from the legitimate one (the handoff has no filing token, and the first
// dispatch wins); the bind is per host, so the Mac and Zettlab supervisors don't see each other's bindings. Closing it
// needs the brain to pass a proof of the filing (a per-handoff secret) through dispatch_task.

const PR_URL = /^https:\/\/github\.com\/jaubut\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/
export const OWNABLE = "id = ? AND done = 0 AND assignee = 'handoff' AND dispatch_status IS NULL AND (dispatch_owner IS NULL OR dispatch_owner = '') AND (dispatch_pr_url IS NULL OR dispatch_pr_url = '')"
const TRIES = 3
const RETRY_MS = 1_000

export type LinkOutcome = "linked" | "would_link" | "not_linked" | "bad_url" | "repo_mismatch" | "branch_mismatch" | "gh_failed" | "write_failed" | "timeout"

interface LinkDeps { gh: GhFn; exec: ExecFn; sleep?(ms: number): Promise<unknown> }
interface LinkTarget { taskId: string; repo: string; prUrl: string }

async function attempt(deps: LinkDeps, t: LinkTarget, write: boolean): Promise<LinkOutcome> {
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

/** Dispatch-time binding: the row of this id is OWNABLE and its description names the repo. null = the read failed (no answer). */
export async function bindWorkerTask(exec: ExecFn, taskId: string, repo: string): Promise<boolean | null> {
  try {
    return (await exec(`SELECT 1 FROM tasks WHERE ${OWNABLE} AND instr(lower(COALESCE(description, '')), lower(?)) > 0`, [taskId, repo])).rows.length > 0
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
 * Open `dispatch/<id>` PRs of the worker state file's tasks whose row is still OWNABLE, through linkWorkerPr. Bound
 * tasks only; `includeUnbound` (the one-off backfill of tasks dispatched before binding existed, run by hand after a dry
 * run) checks bindWorkerTask now instead. Used by scripts/backfill-worker-pr-links.ts and the startup replay.
 */
export async function backfillWorkerPrLinks(
  deps: LinkDeps & { log(line: string): void },
  stateFile: string,
  opts: { write: boolean; includeUnbound?: boolean },
): Promise<Linked[]> {
  let records: Array<{ taskId?: unknown; repo?: unknown; prLinkBound?: unknown }>
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
    const eligible = r.prLinkBound === true
      ? await deps.exec(`SELECT 1 FROM tasks WHERE ${OWNABLE}`, [taskId]).then((x) => x.rows.length > 0, () => false)
      : opts.includeUnbound === true && await bindWorkerTask(deps.exec, taskId, repo) === true
    if (!eligible) continue
    const list = await deps.gh(["pr", "list", "--repo", `jaubut/${repo}`, "--head", `dispatch/${taskId}`, "--state", "open", "--json", "url"]).catch(() => null)
    let prs: unknown = null
    try {
      if (list?.code === 0) prs = JSON.parse(list.stdout)
    } catch { /* logged below */ }
    if (!Array.isArray(prs)) { deps.log(`${taskId} ${repo}: gh pr list failed`); continue }
    for (const { url } of prs as Array<{ url: string }>) {
      const outcome = await linkWorkerPr(deps, { taskId, repo, prUrl: url }, { write: opts.write })
      deps.log(`${taskId} ${repo} ${url}: ${outcome}`)
      out.push({ taskId, repo, prUrl: url, outcome })
    }
  }
  return out
}
