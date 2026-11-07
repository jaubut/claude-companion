import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-lead-")), "test.db")
const { createBrainLead, leadArgs, leadDir, leadSettings, prepareLeadDir } = await import("./brain-lead")
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
  const excluded = () => ["docker *", "systemctl --user restart claude-companion.service"]
  const noTrust = () => {}
  const cloned = (calls: string[][], h: string) => async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    mkdirSync(leadDir("claude-companion", h), { recursive: true })
    return { ok: true, code: 0, out: "", err: "" }
  }
  test("is outside the live checkout, so the sandbox keeps its Bash out of brain/", () => {
    expect(leadDir("claude-companion", "/h")).toBe("/h/leads/claude-companion")
  })
  test("each spawn clones shallow from GitHub and writes settings that survive a restore", async () => {
    const h = home(), calls: string[][] = []
    const out = await prepareLeadDir("claude-companion", h, cloned(calls, h), noTrust, excluded)
    expect(out).toEqual({ ok: true, dir: leadDir("claude-companion", h) })
    expect(calls).toEqual([["git", "clone", "-q", "--depth", "1", "https://github.com/jaubut/claude-companion.git", leadDir("claude-companion", h)]])
    const written = JSON.parse(readFileSync(join(leadDir("claude-companion", h), ".claude/settings.local.json"), "utf8"))
    expect(written.sandbox).toEqual({ enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true })
    expect(written.permissions.deny).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit", "NotebookEdit", "EnterPlanMode", "ExitPlanMode"]))
  })
  test("a tampered tree doesn't survive the next spawn", async () => {
    const h = home(), dir = leadDir("claude-companion", h)
    mkdirSync(join(dir, ".git/hooks"), { recursive: true })
    writeFileSync(join(dir, ".git/hooks/post-merge"), "planted")
    await prepareLeadDir("claude-companion", h, cloned([], h), noTrust, excluded)
    expect(existsSync(join(dir, ".git/hooks/post-merge"))).toBe(false)
  })
  test("the deny list follows the user's excludedCommands, in both rule forms", () => {
    const deny = leadSettings(["docker *", "systemctl --user restart claude-companion.service"]).permissions.deny
    expect(deny).toEqual(expect.arrayContaining(["Bash(docker *)", "Bash(docker:*)", "Bash(systemctl --user restart claude-companion.service)"]))
  })
  test("an unreadable settings file or a failed clone refuses the spawn", async () => {
    const h = home()
    expect(await prepareLeadDir("claude-companion", h, cloned([], h), noTrust)).toMatchObject({ ok: false, error: expect.stringContaining("lead setup failed") })
    const fail = async () => ({ ok: false, code: 1, out: "", err: "no network" })
    expect(await prepareLeadDir("claude-companion", home(), fail, noTrust, excluded)).toMatchObject({ ok: false, error: expect.stringContaining("no network") })
  })
  test("the clone is trusted before the spawn, or a new lead stalls at the trust dialog", async () => {
    const h = home(), trusted: string[] = []
    await prepareLeadDir("claude-companion", h, cloned([], h), (d) => { trusted.push(d) }, excluded)
    expect(trusted).toEqual([leadDir("claude-companion", h)])
  })
  test("a repo with no lead gets nothing", async () => {
    expect(await prepareLeadDir("other", home(), cloned([], "/x"), noTrust, excluded)).toMatchObject({ ok: false })
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
