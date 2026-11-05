import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-lead-")), "test.db")
const { createBrainLead, leadArgs } = await import("./brain-lead")
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

const WRAPPER = join(import.meta.dir, "..", "..", "brain", "lead-builder")

/** Runs the real wrapper as `taskId` against a stub handoff-builder.sh; returns what the stub was asked. */
function wrapper(taskId: string | undefined, args: string[], builderRepoDir = "/home/x/claude-companion") {
  const home = mkdtempSync(join(tmpdir(), "cc-lead-builder-"))
  mkdirSync(join(home, ".claude", "tools"), { recursive: true })
  mkdirSync(join(home, ".cache", "handoff-builder"), { recursive: true })
  writeFileSync(join(home, ".cache", "handoff-builder", "builder-zettlab-claude-companion-t1"), `w1\n/wt\n${builderRepoDir}\n`)
  const stub = join(home, ".claude", "tools", "handoff-builder.sh")
  writeFileSync(stub, `#!/bin/sh\necho "$@" > "${home}/called"\n`)
  chmodSync(stub, 0o755)
  const { COMPANION_TASK_ID: _, ...env } = process.env
  const r = Bun.spawnSync([WRAPPER, ...args], { env: { ...env, HOME: home, ...(taskId ? { COMPANION_TASK_ID: taskId } : {}) } })
  let called: string | null = null
  try { called = readFileSync(join(home, "called"), "utf8").trim() } catch {}
  return { code: r.exitCode, called, err: r.stderr.toString() }
}

describe("lead-builder", () => {
  test("a lead starts a local auto builder for its own repo and closes that repo's builder", () => {
    expect(wrapper(NAME, ["claude-companion", "start", "t1"])).toMatchObject({ code: 0, called: "claude-companion local auto --task t1" })
    expect(wrapper(NAME, ["claude-companion", "close", "builder-zettlab-claude-companion-t1"])).toMatchObject({ code: 0, called: "close builder-zettlab-claude-companion-t1 local" })
  })

  test("another repo, or no lead identity, is refused before the script runs", () => {
    for (const [id, args] of [[NAME, ["tls-dashboard-v2", "start", "t1"]], [undefined, ["claude-companion", "start", "t1"]], ["builder-x", ["claude-companion", "start", "t1"]], ["brain", ["claude-companion", "start", "t1"]]] as Array<[string | undefined, string[]]>) {
      const r = wrapper(id, args)
      expect(r.code).not.toBe(0)
      expect(r.called).toBeNull()
    }
  })

  test("closing another repo's builder, or anything unknown, is refused", () => {
    expect(wrapper(NAME, ["claude-companion", "close", "builder-zettlab-claude-companion-t1"], "/home/x/claude-companion-ios")).toMatchObject({ code: 1, called: null })
    expect(wrapper(NAME, ["claude-companion", "close", "builder-zettlab-claude-companion-nope"])).toMatchObject({ code: 1, called: null })
    expect(wrapper(NAME, ["claude-companion", "close", "../../../etc/passwd"])).toMatchObject({ code: 1, called: null })
  })

  test("nothing but a plain task id reaches the script: no host, mode, profile or extra flag", () => {
    for (const args of [["claude-companion", "start", "t1", "mac"], ["claude-companion", "start", "--profile"], ["claude-companion", "start", "t 1"], ["claude-companion", "start"], ["claude-companion", "rm", "t1"]]) {
      expect(wrapper(NAME, args)).toMatchObject({ code: 1, called: null })
    }
  })
})

describe("repo lead", () => {
  test("a lead is named lead-<repo>, and its settings grant the wrapper and nothing else", () => {
    const args = leadArgs(NAME)
    expect(args.slice(args.indexOf("--name"), args.indexOf("--name") + 2)).toEqual(["--name", NAME])
    const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1]!, "utf8"))
    expect(settings).toEqual({
      permissions: { allow: ["Bash(~/claude-companion/brain/lead-builder *)"] },
      sandbox: { excludedCommands: ["~/claude-companion/brain/lead-builder *"] },
    })
  })

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
