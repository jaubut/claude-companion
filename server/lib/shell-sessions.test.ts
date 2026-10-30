import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SHELL_OPTION, createShellStore, descends, linkClaude, parseProcTable, getShellSession, listShellSessions, loginShell, parseShellList,
  shellNewSessionArgv, shellWire, spawnShellSession, store, wireSessions, type ShellSession,
} from "./shell-sessions"
import { resolveSpawnCwd } from "./spawn-session"
import type { DetachedDeps } from "./tmux-spawn-confirm"

// Phone-spawned terminal sessions: a login shell in a tagged detached tmux
// session, tmux itself as the record (2026-10-25).

const NO_SOCKET: Record<string, string | undefined> = {}

test("shell new-session: cwd rides -c and the shell is an argv entry after --, no command line", () => {
  const argv = shellNewSessionArgv("sh-repo", "/Users/j/Jeremie's Films; rm -rf ~", "/bin/zsh", NO_SOCKET)
  expect(argv).toEqual([
    "tmux", "new-session", "-d", "-x", "220", "-y", "60",
    "-s", "sh-repo", "-c", "/Users/j/Jeremie's Films; rm -rf ~", "--", "/bin/zsh", "-l",
  ])
  expect(argv).not.toContain("/bin/sh")
})

test("shell new-session: a configured spawn socket leads with -L / -f", () => {
  const argv = shellNewSessionArgv("sh-x", "/x", "/bin/bash", { COMPANION_TMUX_SOCKET: "cc", COMPANION_TMUX_CONF: "/c/t.conf" })
  expect(argv.slice(0, 6)).toEqual(["tmux", "-L", "cc", "-f", "/c/t.conf", "new-session"])
})

test("loginShell: $SHELL, else the account shell, else /bin/sh; never a non-path", () => {
  expect(loginShell({ SHELL: "/bin/zsh" }, () => "/bin/bash")).toBe("/bin/zsh")
  expect(loginShell({}, () => "/usr/bin/fish")).toBe("/usr/bin/fish")
  expect(loginShell({ SHELL: "zsh; curl x" }, () => "")).toBe("/bin/sh")
  expect(loginShell({}, () => { throw new Error("no passwd entry") })).toBe("/bin/sh")
})

test("parseShellList keeps only tagged sessions, oldest first, times in ms", () => {
  const out = parseShellList([
    "cc-repo\t\t%3\t/x/repo\t1700000100",
    "sh-b\t1\t%9\t/x/b\t1700000200",
    "sh-a\t1\t%7\t/x/a\t1700000050",
    "",
  ].join("\n"), "/tmp/tmux-501/cc")
  expect(out.map((s) => s.key)).toEqual(["shell:sh-a", "shell:sh-b"])
  expect(out[0]).toEqual({ key: "shell:sh-a", name: "sh-a", cwd: "/x/a", tmuxPane: "%7", tmuxSocket: "/tmp/tmux-501/cc", createdAt: 1700000050000, panePid: 0, claudeKey: "" })
})

test("parseShellList: tmux's own socket_path wins over the fallback", () => {
  const out = parseShellList("sh-a\t1\t%7\t/x\t1\t/private/tmp/tmux-501/default\nsh-b\t1\t%8\t/y\t2\t\n", "/fallback")
  expect(out.map((s) => s.tmuxSocket)).toEqual(["/private/tmp/tmux-501/default", "/fallback"])
})

const A: ShellSession = { key: "shell:sh-a", name: "sh-a", cwd: "/x/a", tmuxPane: "%7", tmuxSocket: "", createdAt: 1, panePid: 0, claudeKey: "" }

test("store emits on a real change only: added, cd'd, removed", () => {
  const s = createShellStore()
  let emits = 0
  s.on(() => { emits++ })
  expect(s.replace([A])).toBe(true)
  expect(s.replace([{ ...A }])).toBe(false)
  expect(s.replace([{ ...A, cwd: "/x/a/sub" }])).toBe(true)
  expect(s.get("shell:sh-a")?.cwd).toBe("/x/a/sub")
  expect(s.replace([])).toBe(true)
  expect(s.get("shell:sh-a")).toBeUndefined()
  expect(emits).toBe(3)
})

test("wire record: agent shell with its pane, the fields the phone decodes", () => {
  expect(shellWire(A)).toMatchObject({ key: "shell:sh-a", agent: "shell", label: "sh-a", cwd: "/x/a", tmuxPane: "%7", tmuxSocket: "", sessionId: "", firstSeenAt: 1 })
})

test("wireSessions: no shells → the agent list itself; shells → appended after agents", () => {
  store.replace([])
  const agents = [{ key: "a" }]
  expect(wireSessions(agents)).toBe(agents)
  store.replace([A])
  expect(wireSessions(agents).map((s) => (s as { key: string }).key)).toEqual(["a", "shell:sh-a"])
  store.replace([])
})

// A fake tmux for the spawn: names free until created, the created session
// listed (tagged) by list-sessions once the tag is set.
function fakeTmux(opts: { which?: string | null; alive?: boolean; tagFails?: boolean } = {}) {
  const calls: string[][] = []
  let created = ""
  let tagged = false
  const deps: DetachedDeps = {
    which: () => (opts.which === undefined ? "/opt/homebrew/bin/tmux" : opts.which),
    sleep: async () => {},
    run: async (argv) => {
      calls.push(argv)
      const has = (a: string) => argv.includes(a)
      if (has("new-session")) { created = argv[argv.indexOf("-s") + 1]!; return { code: 0, stdout: "", stderr: "" } }
      if (has("has-session")) return { code: created && (opts.alive ?? true) && argv.includes(`=${created}`) ? 0 : 1, stdout: "", stderr: "" }
      if (has("display-message")) return { code: 0, stdout: "0\n", stderr: "" }
      if (has("set-option") && has(SHELL_OPTION)) { tagged = !opts.tagFails; return { code: opts.tagFails ? 1 : 0, stdout: "", stderr: opts.tagFails ? "no such session" : "" } }
      if (has("list-sessions")) return { code: 0, stdout: tagged ? `${created}\t1\t%42\t/x/repo\t1700000000\t/tmp/tmux-501/default\t4242\n` : "", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
  return { deps, calls }
}

test("spawn shell: no tmux on the host → tmux_not_found, nothing run", async () => {
  const f = fakeTmux({ which: null })
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toStartWith("tmux_not_found")
  expect(f.calls).toEqual([])
})

test("spawn shell: happy path → tagged sh-<dir> session, listed, in the store", async () => {
  store.replace([])
  const f = fakeTmux()
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.session).toMatchObject({ key: "shell:sh-repo", name: "sh-repo", tmuxPane: "%42", cwd: "/x/repo" })
  const create = f.calls.find((c) => c.includes("new-session"))!
  expect(create.slice(create.indexOf("-s"), create.indexOf("--"))).toEqual(["-s", "sh-repo", "-c", "/x/repo"])
  expect(create[create.indexOf("--") + 2]).toBe("-l")
  expect(f.calls.some((c) => c.includes(SHELL_OPTION) && c.includes("sh-repo"))).toBe(true)
  expect(getShellSession("shell:sh-repo")?.tmuxPane).toBe("%42")
  expect(listShellSessions().length).toBe(1)
  store.replace([])
})

test("spawn shell with resume: types `claude --resume <id>` into its pane, then Enter", async () => {
  store.replace([])
  const f = fakeTmux()
  const id = "51794d7b-cf0f-4f63-9eaf-7b06cab5047e"
  const r = await spawnShellSession("/x/repo", f.deps, id)
  expect(r.ok).toBe(true)
  const keys = f.calls.filter((c) => c.includes("send-keys")).map((c) => c.slice(c.indexOf("send-keys")))
  expect(keys).toEqual([
    ["send-keys", "-t", "%42", "-l", `claude --resume ${id}`],
    ["send-keys", "-t", "%42", "Enter"],
  ])
  store.replace([])
})

test("spawn shell: the shell died at once → session_exited, no record", async () => {
  store.replace([])
  const f = fakeTmux({ alive: false })
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r).toEqual({ ok: false, error: "session_exited" })
  expect(listShellSessions()).toEqual([])
})

test("spawn shell: the tag can't be set → an error, not an untracked shell reported ok", async () => {
  const f = fakeTmux({ tagFails: true })
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r.ok).toBe(false)
  expect(f.calls.at(-1)).toContain("kill-session")
})

test("resolveSpawnCwd: required, absolute, existing, a directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-cwd-"))
  const file = join(dir, "f.txt")
  writeFileSync(file, "x")
  expect(resolveSpawnCwd("  ")).toEqual({ error: "cwd required" })
  expect(resolveSpawnCwd("repo")).toEqual({ error: "cwd must be absolute" })
  expect(resolveSpawnCwd(join(dir, "nope"))).toEqual({ error: `cwd does not exist: ${join(dir, "nope")}` })
  expect(resolveSpawnCwd(file)).toEqual({ error: `cwd is not a directory: ${file}` })
  expect(resolveSpawnCwd(dir)).toEqual({ dir })
})

// ── Which Claude runs inside a shell (process ancestry, Moshi-style) ──

// launchd(1) → tmux server(500) → zsh pane(600) → claude(700) → node child(701);
// an unrelated claude(900) under another shell(800).
const TABLE = parseProcTable(["  1     0", "500 1", "600 500", "700 600", "701 700", "800 500", "900 800", "junk"].join("\n"))
const SHELL: ShellSession = { ...A, tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/default", panePid: 600 }

test("parseProcTable / descends: walks parents, bounded, self counts", () => {
  expect(TABLE.get(700)).toBe(600)
  expect(descends(701, 600, TABLE)).toBe(true)
  expect(descends(600, 600, TABLE)).toBe(true)
  expect(descends(900, 600, TABLE)).toBe(false)
  expect(descends(12345, 600, TABLE)).toBe(false)
  const loop = parseProcTable("10 11\n11 10")
  expect(descends(10, 600, loop)).toBe(false)
})

test("linkClaude: same pane AND a pid under the shell → linked", () => {
  const [s] = linkClaude([SHELL], [{ key: "claude:x", pid: "700", tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/default" }], TABLE)
  expect(s!.claudeKey).toBe("claude:x")
})

test("linkClaude: same pane but the pid is not under the shell (stale record, reused pane id) → not linked", () => {
  const [s] = linkClaude([SHELL], [{ key: "claude:y", pid: "900", tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/default" }], TABLE)
  expect(s!.claudeKey).toBe("")
})

test("linkClaude: a pid under the shell on another tmux server or pane → not linked (pane is the fast path)", () => {
  const agents = [
    { key: "claude:a", pid: "700", tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/cc" },
    { key: "claude:b", pid: "700", tmuxPane: "%5", tmuxSocket: "/tmp/tmux-501/default" },
  ]
  expect(linkClaude([SHELL], agents, TABLE)[0]!.claudeKey).toBe("")
})

test("linkClaude: no pid, or no process table → the pane match decides", () => {
  const agent = { key: "claude:x", pid: "", tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/default" }
  expect(linkClaude([SHELL], [agent], TABLE)[0]!.claudeKey).toBe("claude:x")
  expect(linkClaude([SHELL], [{ ...agent, pid: "900" }], null)[0]!.claudeKey).toBe("claude:x")
})

test("store: a link appearing or going is a change (re-sent to phones)", () => {
  const s = createShellStore()
  s.replace([SHELL])
  expect(s.replace([{ ...SHELL, claudeKey: "claude:x" }])).toBe(true)
  expect(s.replace([{ ...SHELL, claudeKey: "claude:x" }])).toBe(false)
})
