import { BRAIN_THREAD } from "../lib/brain"
import { detectColumns, fileHandoff, getNote } from "../lib/dispatch-tasks"
import { type GithubIssueDispatch, buildGithubIssuePrompt } from "../lib/github-webhook"
import { mintHandoffClaim } from "../lib/handoff-claim"
import { repoEntriesSafe } from "../lib/live-repo"
import { type ExecFn, type QueryFn, tursoExec, tursoQuery } from "../lib/turso"

export interface GithubTaskDeps { exec: ExecFn; query: QueryFn; host: string; noteRef: (repoFull: string) => string; mint: typeof mintHandoffClaim }

/** Trusted webhook ingress only. No synthetic human turn and no weakening of the brain's origin gate. */
export function createGithubWebhookTasks(deps: GithubTaskDeps) {
  const owner = `companion:worker:webhook:${deps.host}`
  return {
    async prepare(req: GithubIssueDispatch): Promise<{ claim: string; settled: boolean }> {
      const cols = await detectColumns(deps.query)
      if (!cols.origin) throw new Error("origin_column_missing")
      const ref = deps.noteRef(req.repoFull)
      const resolved = (await deps.query("SELECT id FROM notes WHERE id = ? OR ref_code = ? LIMIT 1", [ref, ref]))[0]
      const note = resolved ? await getNote(deps.query, String(resolved.id)) : null
      if (!note) throw new Error("project_note_missing")
      const turnId = `github-${req.taskId}`
      const claim = deps.mint(req.taskId, req.repo, turnId)
      if (!claim) throw new Error("claim_unavailable")
      await fileHandoff({ exec: deps.exec, cols, host: deps.host, channel: BRAIN_THREAD }, {
        id: req.taskId, noteId: note.noteId, title: `[repo:${req.repo}] Issue #${req.issueNumber}`,
        description: buildGithubIssuePrompt(req), origin: "jeremie", claim: { repo: req.repo, turnId, kid: claim.split(".")[1]! },
      })
      const row = (await deps.query("SELECT origin, assignee, done, dispatch_status, dispatch_owner FROM tasks WHERE id = ?", [req.taskId]))[0]
      if (row?.origin !== "jeremie" || row.assignee !== "handoff") throw new Error("task_origin_conflict")
      const status = row.dispatch_status
      if (row.done === 1 || status === "running" || (!req.forceRedispatch && status && status !== "queued")) return { claim, settled: true }
      if (status === "queued" && row.dispatch_owner !== owner) throw new Error("task_owned_elsewhere")
      if (status !== "queued") {
        const result = await deps.exec("UPDATE tasks SET dispatch_status = 'queued', dispatch_owner = ?, updated_at = datetime('now') " +
          "WHERE id = ? AND origin = 'jeremie' AND assignee = 'handoff' AND done = 0 AND dispatch_status IS ? AND dispatch_owner IS ?",
        [owner, req.taskId, status ?? null, row.dispatch_owner ?? null])
        if (!result.affected) throw new Error("task_state_changed")
      }
      return { claim, settled: false }
    },
    async start(taskId: string): Promise<boolean> {
      const out = await deps.exec("UPDATE tasks SET dispatch_status = 'running', updated_at = datetime('now') " +
        "WHERE id = ? AND origin = 'jeremie' AND assignee = 'handoff' AND done = 0 AND dispatch_status = 'queued' AND dispatch_owner = ?", [taskId, owner])
      return out.affected === 1
    },
    async defer(taskId: string): Promise<void> {
      await deps.exec("UPDATE tasks SET dispatch_status = 'queued', updated_at = datetime('now') WHERE id = ? AND dispatch_status = 'running' AND dispatch_owner = ?", [taskId, owner])
    },
  }
}

export function defaultGithubWebhookTasks(host: string, env: NodeJS.ProcessEnv): ReturnType<typeof createGithubWebhookTasks> {
  return createGithubWebhookTasks({ exec: tursoExec, query: tursoQuery, host, mint: mintHandoffClaim,
    noteRef: (repo) => repoEntriesSafe().find((e) => e.github?.toLowerCase() === repo.toLowerCase())?.project ?? env.GITHUB_WEBHOOK_NOTE_ID ?? "PRJ-OR1T" })
}
