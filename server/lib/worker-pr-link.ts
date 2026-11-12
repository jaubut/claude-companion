import type { GhFn } from "./triage-pr"
import type { ExecFn } from "./turso"

// A bin/worker PR → tasks.dispatch_pr_url, the link the PR shepherd and merge gate read the PR's origin through. Written
// only after GitHub confirms the PR is jaubut/<the task's repo> with head `dispatch/<task id>` from that repo (not a
// fork), as GitHub's canonical url, and only into a row a bin/worker dispatch can own (OWNABLE): a handoff the brain
// filed (fileHandoff), not done, never claimed by dispatch-run or the relay, link still empty. The compare-and-set never
// overwrites a link. Used by the worker wiring on "PR ready" and by scripts/backfill-worker-pr-links.ts. Never throws.
// ponytail: a caller of worker MCP dispatch_task can still pick the id of another unclaimed handoff row; closing that
// needs the brain to hand the supervisor a proof of the filing (no such token exists today).

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
