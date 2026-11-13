import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LEAD_PREFIX, isBrainInternalEvent, isRoutineLeadAck } from "../lib/brain"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-lead-")), "test.db")
const {
  createBrainLead,
  leadArgs,
  leadCheckout,
  leadDir,
  leadIsolated,
  leadSettings,
  maybeRelaySendMessageToBrain,
  prepareLeadDir,
} = await import("./brain-lead")
const { getThread } = await import("../lib/orchestrator-chat")
const { fakeHerdr } = await import("../lib/herdr-fake.test-util")
const { folderTrusted, spawnInHerdr } = await import("../lib/spawn-session")

const NAME = "lead-claude-companion"

/** A lead whose herdr record survived, in workspace w7: dead unless `live`, then in or out of its clone. */
function stale(label: string, panes: string[], info: Record<string, unknown> | null = { shell_pid: 5, foreground_process_group_id: 5 }, live = false, isolated: boolean | Error = true) {
  const f = fakeHerdr({
    reply: (a) => a[0] === "workspace" && a[1] === "list" ? { workspaces: [{ workspace_id: "w7", label }] }
      : a[0] === "pane" && a[1] === "list" ? { panes: panes.map((p) => ({ pane_id: p, workspace_id: "w7" })) }
      : a[0] === "pane" && a[1] === "process-info" ? (() => { if (!info) throw new Error("timeout"); return { process_info: info } })() : {},
  })
  const spawned: string[] = []
  const lead = createBrainLead({
    // The registry lags: a closed lead's session stays listed, as `alive()` does in production. Herdr is the truth.
    herdr: f.h, running: async () => live, isolated: () => { if (isolated instanceof Error) throw isolated; return isolated }, settleMs: 0,
    agentOf: async () => (f.verbs().includes("workspace close") ? { kind: "absent" } : { kind: "present", ref: { pane: "w7:p1", workspaceId: "w7" } }),
    spawn: async (repo) => { spawned.push(repo); return { ok: true } },
  })
  return { f, lead, spawned }
}

test("a lead has no file-editing tools: LEAD.md's \"you never edit code\" is enforced where the CLI can", () => {
  const off = leadArgs("lead-x").slice(leadArgs("lead-x").indexOf("--disallowedTools") + 1)
  expect(off).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit", "NotebookEdit", "EnterPlanMode", "ExitPlanMode"]))
})

test("a lead registers as its name: --remote-control only titles the bridge, --name is what ListAgents and SendMessage see", () => {
  const args = leadArgs(NAME)
  expect(args[args.indexOf("--name") + 1]).toBe(NAME)
  expect(args[args.indexOf("--remote-control") + 1]).toBe(NAME)
})

describe("a lead's own clone", () => {
  const home = () => mkdtempSync(join(tmpdir(), "lead-home-"))
  const excluded = () => ["docker *", "systemctl --user restart claude-companion.service"]
  const noTrust = () => true
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
    expect(written.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true })
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
    const deny = leadSettings(["docker *", "systemctl --user restart claude-companion.service"], "/d").permissions.deny
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
    await prepareLeadDir("claude-companion", h, cloned([], h), (d) => { trusted.push(d); return true }, excluded)
    expect(trusted).toEqual([leadDir("claude-companion", h)])
  })
  test("a clone that couldn't be trusted refuses the spawn", async () => {
    const h = home()
    expect(await prepareLeadDir("claude-companion", h, cloned([], h), () => false, excluded)).toMatchObject({ ok: false, error: expect.stringContaining("not trusted") })
  })
  test("a trust write that never landed reads as untrusted", () => {
    const cfg = join(home(), ".claude.json")
    expect(folderTrusted("/d", cfg)).toBe(false)
    writeFileSync(cfg, JSON.stringify({ projects: { "/d": { hasTrustDialogAccepted: true } } }))
    expect(folderTrusted("/d", cfg)).toBe(true)
    expect(folderTrusted("/other", cfg)).toBe(false)
  })
  test("is isolated only once the settings are in the clone", async () => {
    const h = home()
    expect(leadIsolated("claude-companion", h, excluded)).toBe(false)
    await prepareLeadDir("claude-companion", h, cloned([], h), noTrust, excluded)
    expect(leadIsolated("claude-companion", h, excluded)).toBe(true)
  })
  test.each(["remorquage-pelchat-web", "claude-config"])("%s lead clones its own repo into its own dir", async (repo) => {
    const h = home(), calls: string[][] = []
    const sh = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); mkdirSync(leadDir(repo, h), { recursive: true }); return { ok: true, code: 0, out: "", err: "" } }
    expect(await prepareLeadDir(repo, h, sh, noTrust, excluded)).toEqual({ ok: true, dir: leadDir(repo, h) })
    expect(calls).toEqual([["git", "clone", "-q", "--depth", "1", `https://github.com/jaubut/${repo}.git`, leadDir(repo, h)]])
    expect(`${LEAD_PREFIX}${repo}`.length).toBeLessThanOrEqual(32)
  })
  test("a repo with no lead gets nothing", async () => {
    expect(await prepareLeadDir("../other", home(), cloned([], "/x"), noTrust, excluded)).toMatchObject({ ok: false })
  })
})

describe("repo lead", () => {
  test("spawn: its args pass the real gate, and a dead lead alone in its workspace is replaced at once", async () => {
    expect(await spawnInHerdr("/srv/repo", "claude", { COMPANION_TASK_ID: NAME }, fakeHerdr().h, { name: NAME, args: leadArgs(NAME) })).toMatchObject({ ok: true })
    const { f, lead } = stale(NAME, ["w7:p1"])
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: true, state: "started" })
    expect(f.verbs()).toContain("workspace close")
  })

  test("no positive proof of exit, nothing is stopped and the clone is left alone: a process in front or an unreadable pane", async () => {
    for (const info of [{ shell_pid: 5, foreground_process_group_id: 9 }, {}, null]) {
      const { f, lead, spawned } = stale(NAME, ["w7:p1"], info)
      expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: false, state: "down" })
      expect(f.verbs().filter((v) => v === "workspace close" || v === "agent stop")).toEqual([])
      expect(spawned).toEqual([])
    }
  })

  test("a foreign pane or label, or an unreadable workspace, is never stopped or closed", async () => {
    for (const [label, panes] of [[NAME, ["w7:p1", "w7:p2"]], [NAME, ["w7:p2"]], ["jeremie", ["w7:p1"]], [NAME, []]] as Array<[string, string[]]>) {
      for (const live of [false, true]) {
        const { f, lead, spawned } = stale(label, panes, undefined, live, false)
        expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: false, state: "down" })
        expect(f.verbs().filter((v) => v === "workspace close" || v === "agent stop")).toEqual([])
        expect(spawned).toEqual([])
      }
    }
  })

  test("a running lead in its clone is left running", async () => {
    const { f, lead, spawned } = stale(NAME, ["w7:p1"], undefined, true, true)
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: true, state: "running" })
    expect(f.verbs().filter((v) => v === "workspace close" || v === "agent stop")).toEqual([])
    expect(spawned).toEqual([])
  })

  test("a running lead outside its clone is replaced, so a restore can't keep it in the live checkout", async () => {
    const { f, lead, spawned } = stale(NAME, ["w7:p1"], { shell_pid: 5, foreground_process_group_id: 9 }, true, false)
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: true, state: "started" })
    expect(f.verbs()).toEqual(expect.arrayContaining(["agent stop", "workspace close"]))
    expect(spawned).toEqual(["claude-companion"])
  })
})

describe("the last round's three checks", () => {
  test("the clone's .claude and .git are read-only as whole folders, so neither can be moved or filled", () => {
    expect(leadSettings([], "/h/leads/r").sandbox.filesystem).toEqual({ denyWrite: ["/h/leads/r/.claude", "/h/leads/r/.git"], denyRead: ["/h/.claude-companion/handoff-claim.keys"] })
  })
  test("a lead can't read the handoff claim keys, and a live lead from before that deny gets it in place", () => {
    expect(leadSettings([], "/h/leads/r").permissions.deny).toContain("Read(/h/.claude-companion/handoff-claim.keys)")
    const h = mkdtempSync(join(tmpdir(), "lead-iso-keys-")), dir = leadDir("r", h), none = () => [] as string[]
    mkdirSync(join(dir, ".claude"), { recursive: true })
    const file = join(dir, ".claude/settings.local.json")
    const prev = leadSettings([], dir)
    prev.permissions.deny = prev.permissions.deny.filter((d) => !d.startsWith("Read("))
    writeFileSync(file, JSON.stringify({ ...prev, sandbox: { ...prev.sandbox, filesystem: { denyWrite: prev.sandbox.filesystem.denyWrite } } }, null, 2))
    expect(leadIsolated("r", h, none)).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(leadSettings([], dir), null, 2))
  })
  test("a lead only counts as isolated if its settings are exactly what the server wrote", () => {
    const h = mkdtempSync(join(tmpdir(), "lead-iso-")), dir = leadDir("r", h), none = () => [] as string[]
    mkdirSync(join(dir, ".claude"), { recursive: true })
    const file = join(dir, ".claude/settings.local.json")
    expect(leadIsolated("r", h, none)).toBe(false)
    writeFileSync(file, "{}")
    expect(leadIsolated("r", h, none)).toBe(false)
    writeFileSync(file, JSON.stringify(leadSettings([], dir), null, 2))
    expect(leadIsolated("r", h, none)).toBe(true)
  })
  test("a stale registry entry can't leave a closed lead unreplaced: first call or a retry", async () => {
    const { lead, spawned } = stale(NAME, ["w7:p1"], { shell_pid: 5, foreground_process_group_id: 9 }, true, false)
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: true, state: "started" })
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: true, state: "started" })
    expect(spawned).toHaveLength(2)
  })
  test("a user settings read that fails proves nothing: the lead counts as neither safe nor unsafe, whatever its clone holds", () => {
    const h = mkdtempSync(join(tmpdir(), "lead-iso-")), dir = leadDir("r", h)
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(join(dir, ".claude/settings.local.json"), "{}")
    expect(() => leadIsolated("r", h, () => { throw new Error("user settings unreadable: x") })).toThrow("user settings unreadable")
  })
  test("a lead that can't be verified answers down: nothing is stopped, spawned or deleted under it", async () => {
    const { f, lead, spawned } = stale(NAME, ["w7:p1"], undefined, true, new Error("user settings unreadable: x"))
    expect(await lead.ensure("claude-companion", NAME)).toEqual({ ok: false, name: NAME, state: "down", error: "user settings unreadable: x" })
    expect(spawned).toEqual([])
    expect(f.verbs()).toEqual([])
  })
  test("a lead that won't stop keeps its clone: nothing is spawned or deleted under it", async () => {
    let spawned = 0
    const f = fakeHerdr({ reply: (a) => a[0] === "workspace" && a[1] === "list" ? { workspaces: [{ workspace_id: "w7", label: NAME }] } : a[0] === "pane" && a[1] === "list" ? { panes: [{ pane_id: "w7:p1", workspace_id: "w7" }] } : {} })
    const lead = createBrainLead({
      herdr: f.h, running: async () => true, isolated: () => false, settleMs: 0,
      agentOf: async () => ({ kind: "present", ref: { pane: "w7:p1", workspaceId: "w7" } }),
      spawn: async () => { spawned++; return { ok: true } },
    })
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: false, state: "down" })
    expect(spawned).toBe(0)
  })
})

test("leadCheckout: the lead's own clone, a worker-resolvable checkout or a REPO_MAP checkout counts, a bare name alone does not", () => {
  const h = mkdtempSync(join(tmpdir(), "lead-home-")), repo = "tls-dashboard-v2"
  expect(leadCheckout(repo, h, [])).toBe(false)
  mkdirSync(join(h, ".cache", "dispatch-repos", "cached-site", ".git"), { recursive: true })
  expect(leadCheckout("cached-site", h, [])).toBe(true)
  const mapped = join(h, "elsewhere"); mkdirSync(mapped)
  expect(leadCheckout(repo, h, [{ match: /x/, path: mapped, github: `jaubut/${repo}` }])).toBe(true)
  mkdirSync(leadDir(repo, h), { recursive: true })
  expect(leadCheckout(repo, h, [])).toBe(true)
})

describe("brain ↔ lead relay and sandbox exemptions", () => {
  test("leadSettings exempts brain/bin/worker, brain/bin/sessions, and brain/bin/pr-update-branch from bwrap so loopback 127.0.0.1:4245 is reachable", () => {
    const s = leadSettings([], "/h/leads/tls-dashboard-v2")
    expect(s.permissions.allow).toEqual(expect.arrayContaining([
      "Bash(~/claude-companion/brain/bin/worker:*)",
      "Bash(~/claude-companion/brain/bin/sessions:*)",
      "Bash(~/claude-companion/brain/bin/pr-update-branch:*)",
    ]))
    expect(s.sandbox.excludedCommands).toEqual(expect.arrayContaining([
      "~/claude-companion/brain/bin/worker *",
      "~/claude-companion/brain/bin/sessions *",
      "~/claude-companion/brain/bin/pr-update-branch *",
    ]))
  })

  test("leadIsolated refreshes an existing valid lead clone in place when model or allowlist updates without killing the live lead", () => {
    const h = mkdtempSync(join(tmpdir(), "lead-iso-upgrade-")), dir = leadDir("r", h), none = () => [] as string[]
    mkdirSync(join(dir, ".claude"), { recursive: true })
    const file = join(dir, ".claude/settings.local.json")
    const prev = leadSettings([], dir)
    prev.model = "claude-opus-4-7"
    prev.permissions.allow = ["Bash(~/claude-companion/brain/bin/worker:*)"]
    writeFileSync(file, JSON.stringify(prev, null, 2))
    expect(leadIsolated("r", h, none)).toBe(true)
    const refreshed = JSON.parse(readFileSync(file, "utf8"))
    expect(refreshed.model).toBe("claude-sonnet-5-5")
    expect(refreshed.permissions.allow).toContain("Bash(~/claude-companion/brain/bin/pr-update-branch:*)")
  })

  test("maybeRelaySendMessageToBrain relays actionable lead messages, drops routine ACKs, and hides internal events from chat bubbles", () => {
    const before = getThread("brain").length
    expect(maybeRelaySendMessageToBrain({
      tool: "SendMessage",
      input: { to: "uds:/tmp/nonexistent-brain-2666705.sock", message: "lead report: #421 needs split" },
      senderTaskId: "lead-tls-dashboard-v2",
      sessionId: "sid-lead-1",
      enabled: true,
    })).toBe(true)
    const afterSend = getThread("brain")
    expect(afterSend.length).toBe(before + 1)
    const relayedTurn = afterSend.at(-1)!
    expect(relayedTurn.text).toBe("[from lead-tls-dashboard-v2] lead report: #421 needs split")
    expect(isBrainInternalEvent(relayedTurn)).toBe(true)
    expect(isBrainInternalEvent({
      threadId: "brain",
      role: "orchestrator",
      text: "All three are underway on tls-dashboard-v2.",
      taskId: null,
    })).toBe(false)

    // Routine ACKs do not wake the brain or append a turn
    expect(isRoutineLeadAck("lead-tls-dashboard-v2: ack all three. I'm holding #421 until Jeremie decides.")).toBe(true)
    expect(maybeRelaySendMessageToBrain({
      tool: "SendMessage",
      input: { to: "brain", message: "lead-tls-dashboard-v2: ack all three. I'm holding #421." },
      senderTaskId: "lead-tls-dashboard-v2",
      sessionId: "sid-lead-1",
      enabled: true,
    })).toBe(false)
    expect(getThread("brain").length).toBe(before + 1)
  })
})
