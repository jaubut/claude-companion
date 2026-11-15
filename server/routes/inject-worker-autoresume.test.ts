import { expect, spyOn, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordSession, removeSessionByKey } from "../lib/sessions"
import * as submit from "../lib/submit-confirm"
import * as dialogs from "../wiring/dialogs"
import { workerSupervisor } from "../wiring/worker-mcp"
import { deliverInject } from "./api"

process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "inject-autoresume-")), "test.db")

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
