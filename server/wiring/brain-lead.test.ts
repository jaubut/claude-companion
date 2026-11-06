import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-lead-")), "test.db")
const { LEAD_SETTINGS, createBrainLead, leadArgs, leadDir, prepareLeadDir } = await import("./brain-lead")
const { fakeHerdr } = await import("../lib/herdr-fake.test-util")
const { spawnInHerdr } = await import("../lib/spawn-session")

const NAME = "lead-claude-companion"

/** A dead lead whose herdr record survived, in workspace w7. */
function stale(label: string, panes: string[], info: Record<string, unknown> | null = { shell_pid: 5, foreground_process_group_id: 5 }) {
  const f = fakeHerdr({
    reply: (a) => a[0] === "workspace" && a[1] === "list" ? { workspaces: [{ workspace_id: "w7", label }] }
      : a[0] === "pane" && a[1] === "list" ? { panes: panes.map((p) => ({ pane_id: p, workspace_id: "w7" })) }
      : a[0] === "pane" && a[1] === "process-info" ? (() => { if (!info) throw new Error("timeout"); return { process_info: info } })() : {},
  })
  let taken = true
  const lead = createBrainLead({
    herdr: f.h, running: async () => false,
    agentOf: async () => ({ kind: "present", ref: { pane: "w7:p1", workspaceId: "w7" } }),
    spawn: async () => (taken ? (taken = false, { ok: false, error: `name_taken: ${NAME}` }) : { ok: true }),
  })
  return { f, lead }
}

test("a lead has no file-editing tools: LEAD.md's \"you never edit code\" is enforced where the CLI can", () => {
  const off = leadArgs("lead-x").slice(leadArgs("lead-x").indexOf("--disallowedTools") + 1)
  expect(off).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit", "NotebookEdit", "EnterPlanMode", "ExitPlanMode"]))
})

describe("a lead's own clone", () => {
  const home = () => mkdtempSync(join(tmpdir(), "lead-home-"))
  test("is outside the live checkout, so the sandbox keeps its Bash out of brain/", () => {
    expect(leadDir("claude-companion", "/h")).toBe("/h/leads/claude-companion")
  })
  test("first spawn clones the repo from GitHub, then writes the settings that survive a restore", async () => {
    const h = home(), calls: string[][] = []
    const out = await prepareLeadDir("claude-companion", h, async (cmd, args) => {
      calls.push([cmd, ...args])
      mkdirSync(join(leadDir("claude-companion", h), ".git"), { recursive: true })
      return { ok: true, code: 0, out: "", err: "" }
    })
    expect(out).toEqual({ ok: true, dir: leadDir("claude-companion", h) })
    expect(calls[0]!.slice(0, 2)).toEqual(["git", "clone"])
    expect(calls[0]).toContain("https://github.com/jaubut/claude-companion.git")
    const written = JSON.parse(readFileSync(join(leadDir("claude-companion", h), ".claude/settings.local.json"), "utf8"))
    expect(written).toEqual(LEAD_SETTINGS)
    expect(written.permissions.deny).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit", "NotebookEdit"]))
    expect(written.sandbox.failIfUnavailable).toBe(true)
  })
  test("a later spawn fast-forwards the clone and rewrites the settings", async () => {
    const h = home(), dir = leadDir("claude-companion", h), calls: string[][] = []
    mkdirSync(join(dir, ".git"), { recursive: true })
    await prepareLeadDir("claude-companion", h, async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, code: 0, out: "", err: "" } })
    expect(calls).toEqual([["git", "-C", dir, "pull", "-q", "--ff-only"]])
    expect(existsSync(join(dir, ".claude/settings.local.json"))).toBe(true)
  })
  test("a failed clone refuses the spawn, and a stale clone still starts", async () => {
    const fail = async () => ({ ok: false, code: 1, out: "", err: "no network" })
    expect(await prepareLeadDir("claude-companion", home(), fail)).toMatchObject({ ok: false, error: expect.stringContaining("no network") })
    const h = home()
    mkdirSync(join(leadDir("claude-companion", h), ".git"), { recursive: true })
    expect(await prepareLeadDir("claude-companion", h, fail)).toMatchObject({ ok: true })
  })
  test("a repo with no lead gets nothing", async () => {
    expect(await prepareLeadDir("other", home(), async () => ({ ok: true, code: 0, out: "", err: "" }))).toMatchObject({ ok: false })
  })
})

describe("repo lead", () => {
  test("spawn: its args pass the real gate, and a dead lead alone in its workspace is replaced at once", async () => {
    expect(await spawnInHerdr("/srv/repo", "claude", { COMPANION_TASK_ID: NAME }, fakeHerdr().h, { name: NAME, args: leadArgs(NAME) })).toMatchObject({ ok: true })
    const { f, lead } = stale(NAME, ["w7:p1"])
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: true, state: "started" })
    expect(f.verbs()).toContain("workspace close")
  })

  test("no positive proof of exit, nothing is stopped: a process in front or an unreadable pane", async () => {
    for (const info of [{ shell_pid: 5, foreground_process_group_id: 9 }, {}, null]) {
      const { f, lead } = stale(NAME, ["w7:p1"], info)
      expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: false, state: "down" })
      expect(f.verbs().filter((v) => v === "workspace close" || v === "agent stop")).toEqual([])
    }
  })

  test("a foreign pane or label, or an unreadable workspace, is never stopped or closed", async () => {
    for (const [label, panes] of [[NAME, ["w7:p1", "w7:p2"]], [NAME, ["w7:p2"]], ["jeremie", ["w7:p1"]], [NAME, []]] as Array<[string, string[]]>) {
      const { f, lead } = stale(label, panes)
      expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: false, state: "down" })
      expect(f.verbs().filter((v) => v === "workspace close" || v === "agent stop")).toEqual([])
    }
  })
})
