import { expect, spyOn, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordSession, removeSessionByKey } from "../lib/sessions"
import type { SupervisedTaskSnapshot } from "../lib/worker-supervisor"
import * as submit from "../lib/submit-confirm"
import * as dialogs from "../wiring/dialogs"
import { workerSupervisor } from "../wiring/worker-mcp"
import { deliverInject } from "./api"

process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "inject-autoresume-")), "test.db")

for (const model of [null, "gpt-6-astra"]) test(`explicit worker inject preserves the recorded model (${model ?? "config default"}) and inherits its claim`, async () => {
  const task: SupervisedTaskSnapshot = {
    taskId: "cx-followup", repo: "claude-companion", title: "Fix resume", builder: "builder-test",
    family: "codex", model, branch: "dispatch/cx-followup", worktree: "/tmp/wt/claude-companion/cx-followup",
    sessionId: "cx-followup-thread", status: "completed", turnCount: 1, step: null, pct: 100,
    result: "Done", prUrl: null, error: null, startedAt: 1, updatedAt: 2, completedAt: 2,
  }
  const worker = recordSession({
    cwd: task.worktree, agent: "codex", sessionId: task.sessionId, taskId: task.taskId,
    herdrPane: `headless:worker:${task.taskId}`, agentStatus: "idle", model: "claude-opus-5-5",
  }, { sessionIdConfirmed: true })!
  const lookup = spyOn(workerSupervisor, "getTask").mockReturnValue(task)
  const dispatch = spyOn(workerSupervisor, "dispatchTask").mockResolvedValue({ ok: true, task, claim: "verified" })
  try {
    const response = await deliverInject("Follow up", worker.key)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, confirmed: true })
    expect(dispatch.mock.calls).toEqual([[{
      taskId: task.taskId, repo: task.repo, title: task.title, prompt: "Follow up", mode: "auto", inheritClaim: true,
    }]])
  } finally {
    lookup.mockRestore()
    dispatch.mockRestore()
    removeSessionByKey(worker.key)
  }
})

test("an untargeted inject never resumes a just-completed headless worker", async () => {
  // The worker's completion sync makes it the most recently seen session.
  const worker = recordSession({
    cwd: "/tmp/wt/claude-companion/cx-done", agent: "codex", sessionId: "cx-thread-done", taskId: "cx-done",
    herdrPane: "headless:worker:cx-done", agentStatus: "idle", model: "claude-opus-5-5",
  }, { sessionIdConfirmed: true })!
  const spies = [
    spyOn(workerSupervisor, "dispatchTask"),
    spyOn(dialogs, "yieldPaneForInject").mockResolvedValue(true),
    spyOn(dialogs, "openDialogFor").mockResolvedValue(null),
    spyOn(dialogs, "screenSnapshotFor").mockResolvedValue(undefined),
    spyOn(dialogs, "paneWidthFor").mockResolvedValue(undefined),
    spyOn(submit, "injectConfirmed").mockResolvedValue({ ok: false, error: "deliver_failed" }),
  ]
  try {
    await deliverInject("DONE t-1")
    expect(spies[0]).not.toHaveBeenCalled()
    expect(spies[5]!.mock.calls[0]?.[1]).toBeUndefined()
  } finally {
    for (const s of spies) s.mockRestore()
    removeSessionByKey(worker.key)
  }
})
