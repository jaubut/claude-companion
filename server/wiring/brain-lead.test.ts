import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-lead-")), "test.db")
const { createBrainLead, leadArgs } = await import("./brain-lead")
const { fakeHerdr } = await import("../lib/herdr-fake.test-util")
const { spawnInHerdr } = await import("../lib/spawn-session")

const NAME = "lead-claude-companion"

/** A dead lead whose herdr record survived, in workspace w7. */
function stale(label: string, panes: string[]) {
  const f = fakeHerdr({
    reply: (a) => a[0] === "workspace" && a[1] === "list" ? { workspaces: [{ workspace_id: "w7", label }] }
      : a[0] === "pane" && a[1] === "list" ? { panes: panes.map((p) => ({ pane_id: p, workspace_id: "w7" })) } : {},
  })
  let taken = true
  const lead = createBrainLead({
    herdr: f.h, running: async () => false,
    agentOf: async () => ({ kind: "present", ref: { pane: "w7:p1", workspaceId: "w7" } }),
    spawn: async () => (taken ? (taken = false, { ok: false, error: `name_taken: ${NAME}` }) : { ok: true }),
  })
  return { f, lead }
}

describe("repo lead", () => {
  test("spawn: its args pass the real gate, and a dead lead alone in its workspace is replaced at once", async () => {
    expect(await spawnInHerdr("/srv/repo", "claude", { COMPANION_TASK_ID: NAME }, fakeHerdr().h, { name: NAME, args: leadArgs(NAME) })).toMatchObject({ ok: true })
    const { f, lead } = stale(NAME, ["w7:p1"])
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: true, state: "started" })
    expect(f.verbs()).toContain("workspace close")
  })

  test("a foreign pane or label, or an unreadable workspace, is never stopped or closed", async () => {
    for (const [label, panes] of [[NAME, ["w7:p1", "w7:p2"]], [NAME, ["w7:p2"]], ["jeremie", ["w7:p1"]], [NAME, []]] as Array<[string, string[]]>) {
      const { f, lead } = stale(label, panes)
      expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: false, state: "down" })
      expect(f.verbs().filter((v) => v === "workspace close" || v === "agent stop")).toEqual([])
    }
  })
})
