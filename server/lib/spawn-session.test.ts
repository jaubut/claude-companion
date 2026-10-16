import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DETACHED_COLS, DETACHED_ROWS, buildInner, buildTmuxLaunch, detachedNewSessionArgs, detachedSpawnArgv, ensureFolderTrusted, homeSpawnCwd } from "./spawn-session"

// The inner command tmux runs. Both spawn paths build it here — the Mac one
// wraps it in `tmux new-session -s <sess> '<inner>'` for AppleScript, the Linux
// one hands it to `/bin/sh -c` — so pinning this string pins both.

const CWD = "/Users/jeremieaubut/claude-companion"

test("no env keeps the command byte-identical to the pre-Phase-8 form", () => {
  expect(buildInner(CWD, "claude")).toBe(`cd '${CWD}' && claude`)
  expect(buildInner(CWD, "codex", {})).toBe(`cd '${CWD}' && codex`)
})

test("the export comes FIRST, terminated by ';', before the cd", () => {
  // Load-bearing. `COMPANION_TASK_ID=abc123 cd … && claude` is a command
  // assignment in POSIX sh: it scopes to `cd` alone, so claude — and every hook
  // claude spawns — would never see it, and every worker would fall back to
  // guessing by cwd.
  const inner = buildInner(CWD, "claude", { COMPANION_TASK_ID: "abc123" })
  expect(inner).toBe(`export COMPANION_TASK_ID=abc123; cd '${CWD}' && claude`)
  expect(inner.indexOf("export COMPANION_TASK_ID=abc123;")).toBe(0)
  expect(inner.indexOf("export")).toBeLessThan(inner.indexOf("cd '"))
})

test("the export also precedes the kimi env sourcing", () => {
  expect(buildInner(CWD, "kimi", { COMPANION_TASK_ID: "abc123" }))
    .toBe(`export COMPANION_TASK_ID=abc123; cd '${CWD}' && . "$HOME/.config/kimi/kimi.env" && claude`)
})

test("a path with an apostrophe is still single-quote escaped around the export", () => {
  expect(buildInner("/Users/j/Jeremie's Films", "claude", { COMPANION_TASK_ID: "abc123" }))
    .toBe(`export COMPANION_TASK_ID=abc123; cd '/Users/j/Jeremie'\\''s Films' && claude`)
})

test("a value carrying shell metacharacters throws instead of shipping a command line", () => {
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "x; rm -rf /" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "a b" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "$(id)" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "`id`" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { "BAD KEY": "ok" })).toThrow(/unsafe key/)
})

// A detached session has no client, so tmux would size it from the host's
// `default-size` — 80x24 by default. Claude Code sizes its dialogs to the pane,
// and at 24 rows /help lists 5 commands per page instead of ~17: the full-list
// scrape took 111s and still truncated on the Linux host. The size belongs in
// the spawn, not in a machine's ~/.tmux.conf.
test("the headless spawn creates the session at an explicit size", () => {
  const args = detachedNewSessionArgs("cc-repo", "cd '/x' && claude")
  expect(args).toEqual([
    "new-session", "-d",
    "-x", "220", "-y", "60",
    "-s", "cc-repo",
    "/bin/sh", "-c", "cd '/x' && claude",
  ])
  expect(DETACHED_ROWS).toBeGreaterThan(24)
  expect(DETACHED_COLS).toBeGreaterThan(80)
  // -d must stay ahead of -x/-y/-s, and the command last: tmux reads the shell
  // command as the trailing operand.
  expect(args.indexOf("-d")).toBe(1)
  expect(args.at(-2)).toBe("-c")
})

test("a real dispatch id passes the charset", () => {
  // Task ids are crypto.randomUUID().slice(0, 8) — always 8 hex chars.
  const id = crypto.randomUUID().slice(0, 8)
  expect(buildInner(CWD, "claude", { COMPANION_TASK_ID: id })).toBe(`export COMPANION_TASK_ID=${id}; cd '${CWD}' && claude`)
})

// Linux: a spawn in the bare home dir moves to ~/work so Claude Code's sandbox
// stops building a fake ~/.git (see homeSpawnCwd).
test("linux: home → ~/work, with or without a trailing slash", () => {
  const env = { platform: "linux", home: "/home/aubut" }
  expect(homeSpawnCwd("/home/aubut", env)).toBe("/home/aubut/work")
  expect(homeSpawnCwd("/home/aubut/", env)).toBe("/home/aubut/work")
})

test("linux: any other dir is left alone, including subdirs of home", () => {
  const env = { platform: "linux", home: "/home/aubut" }
  expect(homeSpawnCwd("/home/aubut/claude-companion", env)).toBe("/home/aubut/claude-companion")
  expect(homeSpawnCwd("/home/aubutx", env)).toBe("/home/aubutx")
  expect(homeSpawnCwd("/tmp", env)).toBe("/tmp")
})

test("linux: COMPANION_HOME_SPAWN_DIR overrides the target, ~ expanded", () => {
  expect(homeSpawnCwd("/home/aubut", { platform: "linux", home: "/home/aubut", override: "~/sessions" }))
    .toBe("/home/aubut/sessions")
  expect(homeSpawnCwd("/home/aubut", { platform: "linux", home: "/home/aubut", override: "/srv/cc" }))
    .toBe("/srv/cc")
})

test("macOS keeps ~, and no HOME means no remap", () => {
  expect(homeSpawnCwd("/Users/jeremieaubut", { platform: "darwin", home: "/Users/jeremieaubut" }))
    .toBe("/Users/jeremieaubut")
  expect(homeSpawnCwd("/home/aubut", { platform: "linux" })).toBe("/home/aubut")
})

// ── Spawn server (COMPANION_TMUX_SOCKET) ─────────────────────────────────
// Unset must be argv-for-argv the pre-socket spawn (the Mac); set, every spawn
// path lands on `tmux -L <name>` and -f rides only on the creating call.

test("headless spawn argv: unset → bare tmux, sized new-session", () => {
  expect(detachedSpawnArgv("cc-repo", "cd '/x' && claude", {})).toEqual([
    "tmux", "new-session", "-d", "-x", "220", "-y", "60", "-s", "cc-repo", "/bin/sh", "-c", "cd '/x' && claude",
  ])
})

test("headless spawn argv: set → -L <name> -f <conf> ahead of new-session, size kept", () => {
  const argv = detachedSpawnArgv("cc-repo", "cd '/x' && claude", {
    COMPANION_TMUX_SOCKET: "cc", COMPANION_TMUX_CONF: "/home/a/.tmux/cc.conf",
  })
  expect(argv).toEqual([
    "tmux", "-L", "cc", "-f", "/home/a/.tmux/cc.conf",
    "new-session", "-d", "-x", "220", "-y", "60", "-s", "cc-repo", "/bin/sh", "-c", "cd '/x' && claude",
  ])
})

test("Terminal/iTerm launch line: unset → byte-identical to the pre-socket form", () => {
  expect(buildTmuxLaunch("/x", "cc-x", "claude", undefined, {})).toBe(
    `tmux new-session -s 'cc-x' 'cd '\\''/x'\\'' && claude' \\; set-option -t 'cc-x' detach-on-destroy on`,
  )
})

test("Terminal/iTerm launch line: set → quoted -L/-f before new-session", () => {
  const line = buildTmuxLaunch("/x", "cc-x", "claude", undefined, {
    COMPANION_TMUX_SOCKET: "cc", COMPANION_TMUX_CONF: "/Users/j/My Conf's/cc.conf",
  })
  expect(line.startsWith(`tmux -L 'cc' -f '/Users/j/My Conf'\\''s/cc.conf' new-session -s 'cc-x' `)).toBe(true)
  expect(line.endsWith(` \\; set-option -t 'cc-x' detach-on-destroy on`)).toBe(true)
})

// Takeover worktree: carry the main checkout's MCP choices, else disable every .mcp.json server.
function mcpFixture(projects: Record<string, Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), "trust-"))
  const wt = join(dir, "wt")
  mkdirSync(wt)
  writeFileSync(join(wt, ".mcp.json"), JSON.stringify({ mcpServers: { perplexity: {}, railway: {} } }))
  const cfgPath = join(dir, ".claude.json")
  writeFileSync(cfgPath, JSON.stringify({ numStartups: 7, projects }))
  const read = () => JSON.parse(readFileSync(cfgPath, "utf8"))
  return { dir, wt, cfgPath, read }
}

test("ensureFolderTrusted copies the main checkout's MCP choices onto the worktree entry", () => {
  const main = { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["railway"], disabledMcpjsonServers: ["perplexity"], enableAllProjectMcpServers: false, allowedTools: ["x"] }
  const f = mcpFixture({ "/repo": main, "/other": { a: 1 } })
  ensureFolderTrusted(f.wt, "/repo", f.cfgPath)
  const cfg = f.read()
  expect(cfg.projects[f.wt]).toEqual({ hasTrustDialogAccepted: true, enabledMcpjsonServers: ["railway"], disabledMcpjsonServers: ["perplexity"], enableAllProjectMcpServers: false })
  expect(cfg.projects["/repo"]).toEqual(main)
  expect(cfg.projects["/other"]).toEqual({ a: 1 })
  expect(cfg.numStartups).toBe(7)
  expect(readdirSync(f.dir).filter((n) => n.includes(".companion-"))).toEqual([]) // atomic tmp+rename leaves no tmp
})

test("ensureFolderTrusted disables every .mcp.json server when the main checkout has no entry", () => {
  const f = mcpFixture({ "/other": { a: 1 } })
  ensureFolderTrusted(f.wt, "/repo", f.cfgPath)
  const cfg = f.read()
  expect(cfg.projects[f.wt]).toEqual({ hasTrustDialogAccepted: true, disabledMcpjsonServers: ["perplexity", "railway"] })
  expect(cfg.projects["/repo"]).toBeUndefined()
  expect(cfg.projects["/other"]).toEqual({ a: 1 })
})

test("ensureFolderTrusted keeps MCP choices already on the worktree entry and skips MCP without mcpFrom", () => {
  const f = mcpFixture({ "/repo": { enabledMcpjsonServers: ["railway"] } })
  const wtEntry = { hasTrustDialogAccepted: true, disabledMcpjsonServers: ["railway", "perplexity"] }
  writeFileSync(f.cfgPath, JSON.stringify({ projects: { "/repo": { enabledMcpjsonServers: ["railway"] }, [f.wt]: wtEntry } }))
  ensureFolderTrusted(f.wt, "/repo", f.cfgPath)
  expect(f.read().projects[f.wt]).toEqual(wtEntry)
  const g = mcpFixture({})
  ensureFolderTrusted(g.wt, undefined, g.cfgPath)
  expect(g.read().projects[g.wt]).toEqual({ hasTrustDialogAccepted: true })
})

test("ensureFolderTrusted disables .mcp.json servers the copied choices leave unanswered", () => {
  const f = mcpFixture({ "/repo": { enabledMcpjsonServers: ["railway"], disabledMcpjsonServers: [], enableAllProjectMcpServers: false } })
  ensureFolderTrusted(f.wt, "/repo", f.cfgPath)
  expect(f.read().projects[f.wt]).toEqual({ hasTrustDialogAccepted: true, enabledMcpjsonServers: ["railway"], disabledMcpjsonServers: ["perplexity"], enableAllProjectMcpServers: false })
})

test("ensureFolderTrusted treats empty lists on a retried worktree entry as unanswered", () => {
  const f = mcpFixture({})
  writeFileSync(f.cfgPath, JSON.stringify({ projects: { "/repo": { enabledMcpjsonServers: ["railway"] }, [f.wt]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: [], disabledMcpjsonServers: [] } } }))
  ensureFolderTrusted(f.wt, "/repo", f.cfgPath)
  const e = f.read().projects[f.wt]
  expect(e.enabledMcpjsonServers).toEqual(["railway"])
  expect(e.disabledMcpjsonServers).toEqual(["perplexity"])
})
