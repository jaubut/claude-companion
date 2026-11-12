#!/usr/bin/env bun
// One-off: links open bin/worker PRs whose Turso task row has no dispatch_pr_url (the shepherd parks them as origin
// unknown). Tasks come from the worker supervisor's state file; each open `dispatch/<task id>` PR goes through the
// same check + compare-and-set as a live "PR ready" (server/lib/worker-pr-link.ts). Dry-run unless --apply.
//   bun scripts/backfill-worker-pr-links.ts [--apply] [--state <file>]
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type GhFn, realGh } from "../server/lib/triage-pr"
import { type ExecFn, tursoExec } from "../server/lib/turso"
import { type LinkOutcome, linkWorkerPr } from "../server/lib/worker-pr-link"
import { REPO_NAME_RE, TASK_ID_RE } from "../server/lib/worker-invocation"

export interface Linked { taskId: string; repo: string; prUrl: string; outcome: LinkOutcome }

export async function backfill(deps: { gh: GhFn; exec: ExecFn; log(line: string): void }, stateFile: string, apply: boolean): Promise<Linked[]> {
  let records: Array<{ taskId?: unknown; repo?: unknown }>
  try {
    records = JSON.parse(readFileSync(stateFile, "utf8")) as typeof records
  } catch (err) {
    throw new Error(`unreadable state file ${stateFile}: ${(err as Error).message}`)
  }
  const out: Linked[] = []
  for (const r of records) {
    if (typeof r.taskId !== "string" || !TASK_ID_RE.test(r.taskId) || typeof r.repo !== "string" || !REPO_NAME_RE.test(r.repo)) continue
    const { taskId, repo } = r
    const row = (await deps.exec("SELECT 1 FROM tasks WHERE id = ? AND (dispatch_pr_url IS NULL OR dispatch_pr_url = '')", [taskId])).rows
    if (!row.length) continue
    const list = await deps.gh(["pr", "list", "--repo", `jaubut/${repo}`, "--head", `dispatch/${taskId}`, "--state", "open", "--json", "url"])
    let prs: unknown = null
    try {
      if (list.code === 0) prs = JSON.parse(list.stdout)
    } catch { /* logged below */ }
    if (!Array.isArray(prs)) { deps.log(`${taskId} ${repo}: gh pr list failed`); continue }
    for (const { url } of prs as Array<{ url: string }>) {
      const outcome = await linkWorkerPr(deps, { taskId, repo, prUrl: url }, apply)
      deps.log(`${taskId} ${repo} ${url}: ${outcome}`)
      out.push({ taskId, repo, prUrl: url, outcome })
    }
  }
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = args.indexOf("--state")
  const file = at >= 0 ? args[at + 1]! : join(homedir(), ".claude", "state", "companion-worker-tasks.json")
  const apply = args.includes("--apply")
  const done = await backfill({ gh: realGh, exec: tursoExec, log: (l) => console.log(l) }, file, apply)
  console.log(`${done.length} PR(s) checked${apply ? "" : " (dry run; --apply to write)"}`)
}
