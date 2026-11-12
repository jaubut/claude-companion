import type { GhFn } from "./triage-pr"
import type { ExecFn } from "./turso"

// A bin/worker PR → tasks.dispatch_pr_url, the link the PR shepherd reads as the PR's origin. Written only after GitHub
// confirms the PR is jaubut/<the task's repo> with head `dispatch/<task id>` from that repo (not a fork), and only into
// an empty column: the compare-and-set never overwrites a link. Used by the worker wiring on "PR ready" and by
// scripts/backfill-worker-pr-links.ts. Never throws: every failure is an outcome the caller logs.

const PR_URL = /^https:\/\/github\.com\/jaubut\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/

export type LinkOutcome = "linked" | "would_link" | "not_linked" | "bad_url" | "repo_mismatch" | "branch_mismatch" | "gh_failed" | "write_failed"

export async function linkWorkerPr(
  deps: { gh: GhFn; exec: ExecFn },
  t: { taskId: string; repo: string; prUrl: string },
  write = true,
): Promise<LinkOutcome> {
  const m = PR_URL.exec(t.prUrl)
  if (!m) return "bad_url"
  if (m[1]!.toLowerCase() !== t.repo.toLowerCase()) return "repo_mismatch"
  let head: { headRefName?: unknown; isCrossRepository?: unknown }
  try {
    const r = await deps.gh(["pr", "view", m[2]!, "--repo", `jaubut/${m[1]}`, "--json", "headRefName,isCrossRepository"])
    if (r.code !== 0) return "gh_failed"
    head = JSON.parse(r.stdout) as typeof head
  } catch {
    return "gh_failed"
  }
  if (head.headRefName !== `dispatch/${t.taskId}` || head.isCrossRepository !== false) return "branch_mismatch"
  const empty = "id = ? AND (dispatch_pr_url IS NULL OR dispatch_pr_url = '')"
  try {
    if (!write) return (await deps.exec(`SELECT 1 FROM tasks WHERE ${empty}`, [t.taskId])).rows.length ? "would_link" : "not_linked"
    const { affected } = await deps.exec(`UPDATE tasks SET dispatch_pr_url = ?, updated_at = datetime('now') WHERE ${empty}`, [t.prUrl, t.taskId])
    return affected > 0 ? "linked" : "not_linked"
  } catch {
    return "write_failed"
  }
}
