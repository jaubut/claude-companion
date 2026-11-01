import { test, expect } from "bun:test"
import { fakeHerdr } from "./herdr-fake.test-util"
import { APP_RETIRED_HINT, ghosttyOpenArgv, herdrAgentBaseName, spawnCompanionSession, spawnInGhostty, spawnInHerdr, spawnLinux, spawnMacAuto } from "./spawn-session"

const CWD = "/Users/j/Claude Companion"

// ── spawn ─────────────────────────────────────────────────────────────────

test("claude spawn: workspace with --env, then agent start --kind claude in its root pane", async () => {
  const f = fakeHerdr()
  const r = await spawnInHerdr(CWD, "claude", { COMPANION_TASK_ID: "ab12cd34" }, f.h)
  expect(r).toEqual({ ok: true, app: "herdr", sessionName: "cc-claude-companion", herdrPane: "w7:p1" })
  const create = f.calls.find((a) => a[1] === "create")!
  expect(create).toEqual(["workspace", "create", "--cwd", CWD, "--label", "cc-claude-companion", "--env", "COMPANION_TASK_ID=ab12cd34", "--no-focus"])
  const start = f.calls.find((a) => a[1] === "start")!
  expect(start.slice(0, 7)).toEqual(["agent", "start", "cc-claude-companion", "--kind", "claude", "--pane", "w7:p1"])
  expect(f.verbs()).not.toContain("pane run")
})

test("env is still held to ENV_TOKEN: metacharacters throw before herdr is touched", async () => {
  const f = fakeHerdr()
  await expect(spawnInHerdr(CWD, "claude", { COMPANION_TASK_ID: "x; rm -rf /" }, f.h)).rejects.toThrow(/unsafe value/)
  await expect(spawnInHerdr(CWD, "claude", { "BAD KEY": "ok" }, f.h)).rejects.toThrow(/unsafe key/)
  expect(f.calls).toEqual([])
})

test("kimi: sources the same kimi.env in the pane's shell, then starts claude", async () => {
  const f = fakeHerdr()
  const r = await spawnInHerdr(CWD, "kimi", undefined, f.h)
  expect(r.ok).toBe(true)
  const run = f.calls.find((a) => a[1] === "run")!
  expect(run).toEqual(["pane", "run", "w7:p1", `. "$HOME/.config/kimi/kimi.env"`])
  const start = f.calls.find((a) => a[1] === "start")!
  expect(start[2]).toBe("km-claude-companion")
  expect(start[4]).toBe("claude")
  expect(f.verbs().indexOf("pane run")).toBeLessThan(f.verbs().indexOf("agent start"))
})

test("codex: --kind codex, cx- name", async () => {
  const f = fakeHerdr()
  await spawnInHerdr(CWD, "codex", undefined, f.h)
  const start = f.calls.find((a) => a[1] === "start")!
  expect(start[2]).toBe("cx-claude-companion")
  expect(start[4]).toBe("codex")
})

test("agent names are herdr-valid and unique: cc-<dir>, then -2, -3", async () => {
  expect(herdrAgentBaseName("/Users/j/My.Repo v2", "claude")).toBe("cc-my-repo-v2")
  expect(herdrAgentBaseName(`/x/${"a".repeat(60)}`, "claude")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
  const f = fakeHerdr({ taken: ["cc-claude-companion", "cc-claude-companion-2"] })
  const r = await spawnInHerdr(CWD, "claude", undefined, f.h)
  expect(r.sessionName).toBe("cc-claude-companion-3")
})

test("gate failure: nothing created, herdr_unavailable error with the reason", async () => {
  const f = fakeHerdr({ gate: "herdr-version-unpinned (0.9.4 not in 0.9.3)" })
  const r = await spawnInHerdr(CWD, "claude", undefined, f.h)
  expect(r.ok).toBe(false)
  expect(r.error).toBe("herdr_unavailable: herdr-version-unpinned (0.9.4 not in 0.9.3)")
  expect(r.fallback).toContain("0.9.4")
  expect(f.calls).toEqual([])
})

test("agent start failure after the gate closes the workspace and does NOT set fallback", async () => {
  const f = fakeHerdr({
    reply: (a) => {
      if (a[1] === "create") return { workspace: { workspace_id: "w7" }, root_pane: { pane_id: "w7:p1" } }
      if (a[1] === "start") throw Object.assign(new Error("timeout"), { code: "timeout" })
      return {}
    },
  })
  const r = await spawnInHerdr(CWD, "claude", undefined, f.h)
  expect(r.ok).toBe(false)
  expect(r.fallback).toBeUndefined()
  expect(f.calls.at(-1)).toEqual(["workspace", "close", "w7"])
})

test("agent_not_ready at start (blocked on a dialog) still counts as spawned", async () => {
  const f = fakeHerdr({
    reply: (a) => {
      if (a[1] === "create") return { workspace: { workspace_id: "w7" }, root_pane: { pane_id: "w7:p1" } }
      if (a[1] === "start") throw Object.assign(new Error("blocked"), { code: "agent_not_ready" })
      return {}
    },
  })
  expect((await spawnInHerdr(CWD, "claude", undefined, f.h)).ok).toBe(true)
})

test("mac auto: gate failure → herdr_unavailable error (logged), no tmux; post-gate failure passes through", async () => {
  const logs: string[] = []
  const gated = await spawnMacAuto(CWD, "claude", undefined, {
    herdr: async () => ({ ok: false, app: "herdr", error: "herdr_unavailable: herdr-down", fallback: "herdr-down" }),
    log: (l) => logs.push(l),
  })
  expect(gated).toEqual({ ok: false, app: "herdr", error: "herdr_unavailable: herdr-down" })
  expect(logs[0]).toContain("herdr-down")
  expect(logs[0]).toContain("no tmux fallback")

  const failed = await spawnMacAuto(CWD, "claude", undefined, {
    herdr: async () => ({ ok: false, app: "herdr", error: "agent start: timeout" }),
    log: (l) => logs.push(l),
  })
  expect(failed).toEqual({ ok: false, app: "herdr", error: "agent start: timeout" })
  expect(logs).toHaveLength(1)
})

// Linux (Zettlab): the real spawnInHerdr against a fake herdr.
function linuxDeps(gate: string | null) {
  const f = fakeHerdr({ gate })
  const deps = {
    herdr: (c: string, a: "claude" | "codex" | "kimi", e?: Record<string, string>) => spawnInHerdr(c, a, e, f.h),
    log: () => undefined,
  }
  return { f, deps }
}

test("linux auto: gate passes → herdr workspace", async () => {
  const { f, deps } = linuxDeps(null)
  const r = await spawnLinux("/home/aubut/work", "auto", "claude", undefined, deps)
  expect(r).toEqual({ ok: true, app: "herdr", sessionName: "cc-work", herdrPane: "w7:p1" })
  expect(f.verbs()).toContain("agent start")
})

// spawnLinux has no tmux dep any more: herdr is the only thing it can call.
test("linux auto: gate fails → herdr_unavailable, nothing created, no tmux", async () => {
  const { f, deps } = linuxDeps("herdr-version-unpinned (0.9.6 not in 0.9.5)")
  const r = await spawnLinux("/home/aubut/work", "auto", "claude", undefined, deps)
  expect(r).toEqual({ ok: false, app: "herdr", error: "herdr_unavailable: herdr-version-unpinned (0.9.6 not in 0.9.5)" })
  expect(f.calls).toEqual([])
})

test("linux: ghostty is macOS-only", async () => {
  const { f, deps } = linuxDeps(null)
  expect((await spawnLinux("/w", "ghostty", "claude", undefined, deps)).error).toContain("macOS-only")
  expect(f.calls).toEqual([])
})

test("app tmux → tmux_retired before any side effect (route answers 400)", async () => {
  const r = await spawnCompanionSession({ cwd: "/definitely/not/a/dir", app: "tmux", agent: "codex" })
  expect(r).toEqual({ ok: false, error: "tmux_retired" })
})

test("app terminal / iterm → app_retired with a hint, before any side effect (route answers 400)", async () => {
  for (const app of ["terminal", "iterm"]) {
    const r = await spawnCompanionSession({ cwd: "/definitely/not/a/dir", app, agent: "codex" })
    expect(r).toEqual({ ok: false, error: "app_retired", hint: APP_RETIRED_HINT })
  }
  expect(APP_RETIRED_HINT).toContain('"ghostty"')
  expect(APP_RETIRED_HINT).toContain('"auto"')
})

// ── ghostty (Mac) ─────────────────────────────────────────────────────────

function ghosttyDeps(code = 0) {
  const f = fakeHerdr()
  const runs: string[][] = []
  const logs: string[] = []
  const deps = {
    herdr: (cwd: string, agent: "claude", env?: Record<string, string>) => spawnInHerdr(cwd, agent, env, f.h),
    h: f.h,
    run: async (argv: string[]) => { runs.push(argv); return { code, stdout: "", stderr: code ? "LSOpenURLsWithRole() failed" : "" } },
    log: (l: string) => logs.push(l),
  }
  return { f, runs, logs, deps }
}

test("ghostty open argv: new Ghostty instance running herdr (attach) via -e", () => {
  expect(ghosttyOpenArgv("/opt/homebrew/bin/herdr")).toEqual(["open", "-na", "Ghostty.app", "--args", "-e", "/opt/homebrew/bin/herdr"])
})

test("ghostty: herdr spawn like auto, then focus its workspace, then open Ghostty attached", async () => {
  const { f, runs, deps } = ghosttyDeps()
  const r = await spawnInGhostty(CWD, "claude", undefined, deps)
  expect(r).toEqual({ ok: true, app: "Ghostty", sessionName: "cc-claude-companion", herdrPane: "w7:p1" })
  expect(f.verbs()).toEqual(["agent get", "workspace create", "agent start", "workspace focus"])
  expect(f.calls.at(-1)).toEqual(["workspace", "focus", "w7"])
  expect(runs).toEqual([ghosttyOpenArgv()])
})

test("ghostty: open fails → agent still runs, spawn ok as herdr, failure logged", async () => {
  const { runs, logs, deps } = ghosttyDeps(1)
  const r = await spawnInGhostty(CWD, "claude", undefined, deps)
  expect(r).toEqual({ ok: true, app: "herdr", sessionName: "cc-claude-companion", herdrPane: "w7:p1" })
  expect(runs.length).toBe(1)
  expect(logs.join()).toContain("Ghostty open failed")
})

test("ghostty: herdr gate fails → herdr_unavailable, no Ghostty window", async () => {
  const f = fakeHerdr({ gate: "herdr-version-unpinned (0.9.6 not in 0.9.5)" })
  const runs: string[][] = []
  const r = await spawnInGhostty(CWD, "claude", undefined, {
    herdr: (cwd, agent, env) => spawnInHerdr(cwd, agent, env, f.h),
    h: f.h,
    run: async (argv) => { runs.push(argv); return { code: 0, stdout: "", stderr: "" } },
    log: () => {},
  })
  expect(r).toEqual({ ok: false, app: "herdr", error: "herdr_unavailable: herdr-version-unpinned (0.9.6 not in 0.9.5)" })
  expect(runs).toEqual([])
})
