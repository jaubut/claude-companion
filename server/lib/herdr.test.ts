import { test, expect } from "bun:test"
import { type Herdr, closeHerdrWorkspaceWhenIdle, herdrKeyName, herdrPaneAtShell, herdrPaneOf, herdrPaneWidth, herdrScreen, silentSuccess } from "./herdr"
import { parseDialog } from "./dialogs"
import { inputLine, unstyle } from "./command-menu"
import { createDialogWatcher } from "./dialog-watch"
import { stages } from "./inject-verified"
import type { Session } from "./sessions"
import { releaseHerdrWorkspace } from "./herdr-workspace"
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

test("silentSuccess: exit 0 with no stdout is success (pane send-keys/send-text)", () => {
  expect(silentSuccess({ status: 0, stdout: "" })).toBe(true)
  expect(silentSuccess({ status: 0, stdout: "  \n" })).toBe(true)
  // Output present → parseCliResult decides.
  expect(silentSuccess({ status: 0, stdout: '{"result":{}}' })).toBe(false)
  // Failures stay failures.
  expect(silentSuccess({ status: 1, stdout: "" })).toBe(false)
  expect(silentSuccess({ status: null, stdout: "" })).toBe(false)
  expect(silentSuccess({ status: 0, stdout: "", error: new Error("spawn") })).toBe(false)
})

// ── screen reads (pane read → the tmux parsers) ─────────────────────────────


// What `capture-pane -p` gives for the /model picker…
const TMUX_MODEL = [
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new",
  "   ❯ 1. Default (recommended) ✔  Opus 5 with 1M context",
  "     2. Opus (1M context)        Opus 5 with 1M context",
  "     3. Sonnet                   Sonnet 5",
  "   Enter to set as default · s to use this session only · Esc to cancel",
  "",
].join("\n")

// …and what `herdr pane read --source visible --format ansi` gives for the
// same screen (shape seen live on Zettlab, herdr 0.9.3): CRLF rows, a reset
// plus truecolour run per row, trailing blanks kept.
function herdrShaped(plain: string): string {
  return plain.split("\n")
    .map((l, i) => l ? `\x1b[0m\x1b[38;2;153;153;153m${l}${i % 2 ? "\x1b[0m    " : "    \x1b[0m"}` : "")
    .join("\r\n")
}

test("herdr read → same dialog as the tmux capture of that screen", () => {
  const tmux = parseDialog(TMUX_MODEL)
  expect(tmux?.items.length).toBe(3)
  expect(parseDialog(unstyle(herdrScreen(herdrShaped(TMUX_MODEL))))).toEqual(tmux)
})

test("herdrScreen drops CR and trailing blanks; the input line reads the same", () => {
  expect(herdrScreen("a  \r\nb\r\n")).toBe("a\nb\n")
  const box = "────\n❯ /compact keep: x\n────\n"
  expect(inputLine(herdrScreen(herdrShaped(box)))).toBe(inputLine(box))
})

function herdrSession(over: Partial<Session> = {}): Session {
  return {
    key: "claude:tty:/dev/pts/9", agent: "claude", label: "work", title: "", sidConfirmed: true,
    cwd: "/home/aubut/work", sessionId: "sid", termProgram: "", tty: "/dev/pts/9", iTermSessionId: "",
    tmuxPane: "", tmuxSocket: "", herdrPane: "w6:p1", herdrAgent: "cc-work", taskId: "", waitingSince: 0,
    waitingKind: "", waitingRef: "", waitingReasons: [], pid: "100", firstSeenAt: 0, lastSeenAt: 0, model: "",
    agentStatus: "", waitingFor: "", ...over,
  }
}

test("dialog watcher mirrors a dialog on a herdr session (no tmux pane)", async () => {
  const opened: string[] = []
  const captured: Session[] = []
  const w = createDialogWatcher({
    sessions: () => [herdrSession()],
    capture: async (s) => { captured.push(s); return unstyle(herdrScreen(herdrShaped(TMUX_MODEL))) },
    sessionStatus: async () => ({ status: "waiting", waitingFor: "dialog open" }),
    hasPendingQuestion: () => false,
    isScraping: () => false,
    onDialog: (key, d) => opened.push(`${key}:${d.title}`),
    onDialogClosed: () => {},
    onStatus: () => {},
  })
  await w.tick()
  expect(captured[0]?.herdrPane).toBe("w6:p1")
  expect(opened).toEqual(["claude:tty:/dev/pts/9:Select model"])
})

test("pane width from `pane layout`; unknown when herdr can't say", async () => {
  const f = fakeHerdr({ reply: () => ({ layout: { panes: [{ pane_id: "w1:p2", rect: { width: 30 } }, { pane_id: "w6:p1", rect: { width: 284 } }] } }) })
  expect(await herdrPaneWidth("w6:p1", f.h)).toBe(284)
  expect(f.calls[0]).toEqual(["pane", "layout", "--pane", "w6:p1"])
  expect(await herdrPaneWidth("w9:p9", f.h)).toBeNull()
  const down = fakeHerdr({ reply: () => { throw new Error("down") } })
  expect(await herdrPaneWidth("w6:p1", down.h)).toBeNull()
})

test("staged chunks never start with '-' (herdr send-text has no `--`)", () => {
  const text = `/compact keep: ${"a".repeat(184)}--b${"c".repeat(300)}`
  const { chunks } = stages(text)
  expect(chunks.join("")).toBe(text.slice("/compact".length))
  for (const c of chunks) expect(c.startsWith("-")).toBe(false)
})

// ── workspace close on exit ─────────────────────────────────────────────────

// process-info as herdr 0.9.3 answers it: the shell (bash) or claude in front.
const AT_SHELL = { process_info: { shell_pid: 500, foreground_process_group_id: 500, foreground_processes: [{ name: "bash", pid: 500 }] } }
const IN_CLAUDE = { process_info: { shell_pid: 500, foreground_process_group_id: 612, foreground_processes: [{ name: "claude", pid: 612 }] } }

function closeHerdr(front: () => Record<string, unknown>, paneCount = 1) {
  return fakeHerdr({
    reply: (args) => {
      if (args[1] === "process-info") return front()
      if (args[0] === "pane" && args[1] === "get") return { pane: { pane_id: args[2], workspace_id: "w6" } }
      if (args[0] === "workspace" && args[1] === "get") return { workspace: { workspace_id: "w6", pane_count: paneCount } }
      return {}
    },
  })
}
const noSleep = { sleep: async () => {} }

test("pane at its shell: workspace closed", async () => {
  const f = closeHerdr(() => AT_SHELL)
  expect(await herdrPaneAtShell("w6:p1", f.h)).toBe(true)
  expect(await closeHerdrWorkspaceWhenIdle("w6:p1", { h: f.h, ...noSleep })).toBe("w6")
  expect(f.calls.at(-1)).toEqual(["workspace", "close", "w6"])
})

test("claude still in front: polled, closed once the shell is back (twice in a row)", async () => {
  let n = 0
  const f = closeHerdr(() => (++n <= 2 ? IN_CLAUDE : AT_SHELL))
  expect(await closeHerdrWorkspaceWhenIdle("w6:p1", { h: f.h, ...noSleep })).toBe("w6")
  expect(f.verbs().filter((v) => v === "pane process-info").length).toBe(4)
})

test("never closed while a command holds the pane, the pane is shared, or a session is back in it", async () => {
  const busy = closeHerdr(() => IN_CLAUDE)
  expect(await closeHerdrWorkspaceWhenIdle("w6:p1", { h: busy.h, tries: 5, ...noSleep })).toBe("")
  expect(busy.verbs()).not.toContain("workspace close")

  const split = closeHerdr(() => AT_SHELL, 2)
  expect(await closeHerdrWorkspaceWhenIdle("w6:p1", { h: split.h, ...noSleep })).toBe("")
  expect(split.verbs()).not.toContain("workspace close")

  const forked = closeHerdr(() => AT_SHELL)
  expect(await closeHerdrWorkspaceWhenIdle("w6:p1", { h: forked.h, stillFree: () => false, ...noSleep })).toBe("")
  expect(forked.verbs()).not.toContain("workspace close")

  const unreadable = fakeHerdr({ reply: () => { throw new Error("pane_not_found") } })
  expect(await herdrPaneAtShell("w6:p1", unreadable.h)).toBe(false)
})

test("only a session this server spawned in herdr releases its workspace", () => {
  const panes: string[] = []
  const close = async (pane: string) => { panes.push(pane); return "" }
  releaseHerdrWorkspace(herdrSession({ herdrAgent: "" }), () => [], close)
  releaseHerdrWorkspace(herdrSession({ tmuxPane: "%3" }), () => [], close)
  releaseHerdrWorkspace(herdrSession(), () => [], close)
  expect(panes).toEqual(["w6:p1"])
})
