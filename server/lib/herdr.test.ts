import { test, expect } from "bun:test"
import { type Herdr, herdrKeyName, herdrPaneOf } from "./herdr"
import { herdrAgentBaseName, spawnInHerdr, spawnLinux, spawnMacAuto, type SpawnResult } from "./spawn-session"
import { injectConfirmed, noteUserPromptSubmit } from "./submit-confirm"
import { injectText } from "./keyboard-inject"
import { deliverViaHerdr } from "./herdr-inject"

// A fake herdr: records every argv, answers from `reply` (throw to fail).
function fakeHerdr(opts: {
  gate?: string | null
  taken?: string[]
  reply?: (args: string[]) => Record<string, unknown>
} = {}) {
  const calls: string[][] = []
  const h: Herdr = {
    async gate() { return opts.gate ?? null },
    async read() { return "pane text" },
    async call(args) {
      calls.push(args)
      if (args[0] === "agent" && args[1] === "get" && !(opts.taken ?? []).includes(args[2]!)) {
        throw Object.assign(new Error("agent_not_found"), { code: "agent_not_found" })
      }
      if (opts.reply) return opts.reply(args)
      if (args[0] === "workspace" && args[1] === "create") {
        return { workspace: { workspace_id: "w7" }, root_pane: { pane_id: "w7:p1" } }
      }
      return {}
    },
  }
  return { h, calls, verbs: () => calls.map((a) => a.slice(0, 2).join(" ")) }
}

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

test("gate failure: nothing created, fallback reason set", async () => {
  const f = fakeHerdr({ gate: "herdr-version-unpinned (0.9.4 not in 0.9.3)" })
  const r = await spawnInHerdr(CWD, "claude", undefined, f.h)
  expect(r.ok).toBe(false)
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

test("mac auto: gate failure → tmux fallback (logged); post-gate failure → no fallback", async () => {
  const logs: string[] = []
  const legacy = async (): Promise<SpawnResult> => ({ ok: true, app: "Terminal", sessionName: "cc-x" })
  const gated = await spawnMacAuto(CWD, "claude", undefined, {
    herdr: async () => ({ ok: false, app: "herdr", error: "herdr-down", fallback: "herdr-down" }),
    legacy, log: (l) => logs.push(l),
  })
  expect(gated.app).toBe("Terminal")
  expect(logs[0]).toContain("herdr-down")

  const failed = await spawnMacAuto(CWD, "claude", undefined, {
    herdr: async () => ({ ok: false, app: "herdr", error: "agent start: timeout" }),
    legacy, log: (l) => logs.push(l),
  })
  expect(failed).toEqual({ ok: false, app: "herdr", error: "agent start: timeout" })
})

// Linux (Zettlab): the real spawnInHerdr against a fake herdr, tmux faked.
function linuxDeps(gate: string | null) {
  const f = fakeHerdr({ gate })
  const tmuxCalls: string[] = []
  const deps = {
    herdr: (c: string, a: "claude" | "codex" | "kimi", e?: Record<string, string>) => spawnInHerdr(c, a, e, f.h),
    tmux: async (c: string): Promise<SpawnResult> => { tmuxCalls.push(c); return { ok: true, app: "tmux", sessionName: "cc-x" } },
    log: () => undefined,
  }
  return { f, tmuxCalls, deps }
}

test("linux auto: gate passes → herdr workspace, tmux untouched", async () => {
  const { f, tmuxCalls, deps } = linuxDeps(null)
  const r = await spawnLinux("/home/aubut/work", "auto", "claude", undefined, deps)
  expect(r).toEqual({ ok: true, app: "herdr", sessionName: "cc-work", herdrPane: "w7:p1" })
  expect(f.verbs()).toContain("agent start")
  expect(tmuxCalls).toEqual([])
})

test("linux auto: gate fails → detached tmux, herdr never called", async () => {
  const { f, tmuxCalls, deps } = linuxDeps("herdr-down: no socket")
  const r = await spawnLinux("/home/aubut/work", "auto", "claude", undefined, deps)
  expect(r.app).toBe("tmux")
  expect(tmuxCalls).toEqual(["/home/aubut/work"])
  expect(f.calls).toEqual([])
})

test("linux: explicit tmux skips herdr; terminal/iterm stay macOS-only", async () => {
  const { f, tmuxCalls, deps } = linuxDeps(null)
  expect((await spawnLinux("/w", "tmux", "claude", undefined, deps)).app).toBe("tmux")
  expect(f.calls).toEqual([])
  expect(tmuxCalls).toEqual(["/w"])
  expect((await spawnLinux("/w", "iterm", "claude", undefined, deps)).error).toContain("macOS-only")
})

// ── inject routing ────────────────────────────────────────────────────────

test("herdrPaneOf: herdr only without a tmux pane, and only a sane id", () => {
  expect(herdrPaneOf({ herdrPane: "w1:p2" })).toBe("w1:p2")
  expect(herdrPaneOf({ herdrPane: "w1:p2", tmuxPane: "%3" })).toBe("")
  expect(herdrPaneOf({ herdrPane: "--help" })).toBe("")
  expect(herdrPaneOf({ tmuxPane: "%3" })).toBe("")
  expect(herdrPaneOf(null)).toBe("")
})

test("key names map to herdr's logical keys", () => {
  expect(herdrKeyName("Escape")).toBe("esc")
  expect(herdrKeyName("Enter")).toBe("enter")
  expect(herdrKeyName("C-u")).toBe("ctrl+u")
  expect(herdrKeyName("Down")).toBe("down")
})

const TARGET = { key: "claude:tty:/dev/ttys021", sessionId: "s-herdr-1", tty: "/dev/ttys021", herdrPane: "w2:p1", agent: "claude" }

test("a herdr session's message goes through `agent prompt` and is confirmed by the hook", async () => {
  const f = fakeHerdr({
    reply: (a) => {
      if (a[0] === "agent" && a[1] === "prompt") queueMicrotask(() => noteUserPromptSubmit({ tty: TARGET.tty }))
      return {}
    },
  })
  const r = await injectConfirmed("fix the build", TARGET, f.h)
  expect(r).toEqual({ ok: true, confirmed: true, retried: false })
  expect(f.calls[0]).toEqual(["agent", "prompt", "w2:p1", "fix the build"])
})

test("agent_blocked from herdr → pane_not_ready", async () => {
  const f = fakeHerdr({
    reply: (a) => {
      if (a[1] === "prompt") throw Object.assign(new Error("agent is blocked"), { code: "agent_blocked" })
      return {}
    },
  })
  const r = await injectConfirmed("hello", TARGET, f.h)
  expect(r).toEqual({ ok: false, error: "pane_not_ready", reason: "agent_blocked", excerpt: "pane text" })
})

test("a slash command is typed (send-text + enter), never pasted", async () => {
  const f = fakeHerdr({ taken: ["w2:p1"], reply: (a) => (a[1] === "get" ? { agent: { agent_status: "idle" } } : {}) })
  const r = await injectConfirmed("/clear", { ...TARGET, agent: "codex" }, f.h)
  expect(r.ok).toBe(true)
  expect(f.calls).toEqual([
    ["agent", "get", "w2:p1"],
    ["pane", "send-text", "w2:p1", "/clear"],
    ["pane", "send-keys", "w2:p1", "enter"],
  ])
})

test("injectText with a herdr pane never falls back when herdr fails", async () => {
  const f = fakeHerdr({ reply: () => { throw Object.assign(new Error("down"), { code: "server_unreachable" }) } })
  let tmuxUsed = false
  const ok = await injectText("hi", TARGET, { herdr: f.h, sendKeys: async () => { tmuxUsed = true; return { ok: true, reason: "" } } })
  expect(ok).toBe(false)
  expect(f.calls).toEqual([["agent", "prompt", "w2:p1", "hi"]])
  expect(tmuxUsed).toBe(false)
})

test("a tmux pane wins over a herdr pane (tmux inside herdr)", async () => {
  const f = fakeHerdr()
  const sent: string[][] = []
  await injectText("hi", { ...TARGET, tmuxPane: "%4" }, { herdr: f.h, sendKeys: async (a) => { sent.push([...a]); return { ok: true, reason: "" } } })
  expect(f.calls).toEqual([])
  expect(sent.length).toBe(2)
})

// herdr 0.9.3 has no `--` separator: leading-dash text would parse as an option.
test("text starting with '-' is refused before herdr is called", async () => {
  const f = fakeHerdr()
  const r = await deliverViaHerdr("w2:p1", "-h", { herdr: f.h })
  expect(r).toEqual({ ok: false, blocked: false, reason: "leading_dash" })
  expect(f.calls).toEqual([])
})
