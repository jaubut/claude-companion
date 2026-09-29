import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildScrapeInner, enumerateCommandsOffPane, foreignScrapes, paneBlockedByWizard, pendingKills,
  reapScrapeSessions, resetOffPaneState, type HomeFactory, type OffPaneResult,
} from "./command-offpane"
import { createCommandLister, createSlots, prepareRealList } from "./command-offpane-cache"
import { createScrapeHome, removeScrapeHome, resolveHomesBase, sweepOrphanHomes, UnsafeDirError, verifyPrivateDir } from "./command-offpane-home"
import { isScrapeProcess, processEnvEntries } from "./discover"
import {
  computeFingerprint, fingerprintEntries, fingerprintSources, mainWorktreeRoot, parseTmuxEnv, tmuxNoServer, resolveClaudeLaunch, secureStorageProblem, versionAtLeast, type ClaudeLaunch, type TmuxResult,
} from "./command-offpane-launch"
import { envHasScrapeVar, isScrapeSessionName, isScrapeTarget, markScrapeTarget, resetScrapeRegistry, scrapeSessionName, scrapeSessionOwner } from "./scrape-registry"
import { DETACHED_COLS, DETACHED_ROWS } from "./spawn-session"

// ── A fake tmux server ─────────────────────────────────────────────────────
//
// Holds the user's own session (cc-user, pane %1) plus whatever the enumerator
// creates. Each created pane runs a simulated claude: blank while booting, then
// a prompt; `/help`+Enter opens the General tab, Tab walks General → Commands →
// Custom commands, Down scrolls, Escape closes. Every tmux call is recorded, so
// the tests can assert what reached WHICH pane.

type Tab = "general" | "default" | "custom"

class SimClaude {
  bootCaptures: number
  typed = ""
  overlay: Tab | null = null
  cursor = 0
  top = 0
  constructor(
    readonly lists: { default: string[]; custom: string[] },
    readonly rows: number,
    opts: { bootCaptures?: number; screen?: string; paintCaptures?: number } = {},
  ) {
    this.bootCaptures = opts.bootCaptures ?? 2
    this.screen = opts.screen
    this.paintCaptures = opts.paintCaptures ?? 0
  }
  screen?: string
  // A loaded machine: /help needs this many captures to paint, and a key
  // pressed before it has painted is lost.
  paintCaptures: number
  painting = 0

  render(): string {
    if (this.bootCaptures > 0) { this.bootCaptures--; return "" }
    if (this.screen) return this.screen
    if (this.painting > 0) { this.painting--; return ["────────────", "❯ ", "────────────"].join("\n") }
    if (!this.overlay) {
      return ["╭─ Welcome back Jeremie ─╮", "────────────", `❯ ${this.typed}`, "────────────", "  ? for shortcuts"].join("\n")
    }
    const out = ["   Help  General   Commands   Custom commands"]
    if (this.overlay === "general") return [...out, "", "   Shortcuts", "   ! for bash mode"].join("\n")
    out.push(`   Browse ${this.overlay} commands`)
    const names = this.lists[this.overlay]
    const last = Math.min(this.top + this.rows, names.length)
    for (let i = this.top; i < last; i++) {
      const marker = i === this.cursor ? "❯" : i === last - 1 && last < names.length ? "↓" : " "
      out.push(`   ${marker} ${names[i]}`, `       Description of ${names[i]}`)
    }
    out.push("   For more help: https://code.claude.com/docs/en/overview", "   Esc to cancel")
    return out.join("\n")
  }

  key(k: string): void {
    if (this.screen) return
    if (this.painting > 0) return
    if (!this.overlay) {
      if (k === "Enter" && this.typed === "/help") { this.overlay = "general"; this.typed = ""; this.cursor = 0; this.top = 0; this.painting = this.paintCaptures }
      else if (k === "C-u") this.typed = ""
      return
    }
    if (k === "Escape") { this.overlay = null; return }
    if (k === "Tab") { this.overlay = this.overlay === "general" ? "default" : this.overlay === "default" ? "custom" : "general"; return }
    if (k === "Down" && this.overlay !== "general") {
      const n = this.lists[this.overlay].length
      if (this.cursor < n - 1) this.cursor++
      if (this.cursor > this.top + this.rows - 1) this.top = this.cursor - this.rows + 1
    }
  }
}

interface FakeOpts {
  failNewSession?: boolean
  throwOnCapture?: boolean
  paneNeverUp?: boolean              // claude missing/exited: the pane is gone at once
  failCaptureAfter?: number          // hidden-pane captures that succeed before capture-pane starts failing
  failCaptureAt?: number             // exactly this one hidden-pane capture fails (a transient blip)
  failSendKey?: string               // send-keys carrying this key exits 1
  unkillable?: { count?: number }    // kill-session "succeeds" but the session survives (count times)
  lingerPolls?: number               // claude's pid outlives the kill for this many pidAlive checks
}

interface FakeSession { pane: string; tty: string; pid: number; sim: SimClaude | null }

class FakeTmux {
  sessions = new Map<string, FakeSession>()
  calls: string[][] = []
  nextPane = 10
  captures = 0
  serverPid = 5000
  // Pids of live processes: pane processes, plus other companion servers.
  livePids = new Set<number>([SELF])
  // pid → how many more pidAlive checks it survives after its session died.
  lingering = new Map<number, number>()
  constructor(readonly spawnSim: () => SimClaude, opts: FakeOpts = {}) {
    this.opts = opts
    this.sessions.set("cc-user", { pane: "%1", tty: "/dev/ttys007", pid: 101, sim: null })
    this.livePids.add(101)
  }
  opts: FakeOpts

  addSession(name: string, pane: string, tty: string, pid: number): void {
    this.sessions.set(name, { pane, tty, pid, sim: null })
    this.livePids.add(pid)
  }

  pidAlive = (pid: number): boolean => {
    const left = this.lingering.get(pid)
    if (left !== undefined) {
      if (left <= 0) { this.lingering.delete(pid); this.livePids.delete(pid); return false }
      this.lingering.set(pid, left - 1)
      return true
    }
    return this.livePids.has(pid)
  }

  private dropSession(name: string): boolean {
    const s = this.sessions.get(name)
    if (!s) return false
    this.sessions.delete(name)
    if (this.opts.lingerPolls !== undefined) this.lingering.set(s.pid, this.opts.lingerPolls)
    else this.livePids.delete(s.pid)
    return true
  }

  paneSim(target: string): SimClaude | null | undefined {
    for (const s of this.sessions.values()) if (s.pane === target) return s.sim
    return undefined
  }

  // Every send-keys, as [target, ...keys].
  keysTo(target: string): string[][] {
    return this.calls.filter((c) => c[0] === "send-keys" && c[2] === target)
  }

  run = async (args: string[]): Promise<TmuxResult> => {
    this.calls.push(args)
    const [cmd] = args
    if (cmd === "new-session") {
      if (this.opts.failNewSession) return { code: 1, stdout: "" }
      const name = args[args.indexOf("-s") + 1]!
      const pane = `%${this.nextPane++}`
      const pid = 5000 + this.nextPane
      this.sessions.set(name, { pane, tty: `/dev/ttys0${this.nextPane}`, pid, sim: this.spawnSim() })
      this.livePids.add(pid)
      return { code: 0, stdout: `${pane}\t/dev/ttys0${this.nextPane}\t${pid}\n` }
    }
    if (cmd === "list-panes") {
      // The last session closing takes the tmux server with it.
      if (this.sessions.size === 0) return { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-501/default" }
      return { code: 0, stdout: [...this.sessions].map(([n, s]) => `${n}\t${s.pane}\t${s.tty}\t${s.pid}\t${this.serverPid}`).join("\n") + "\n" }
    }
    if (cmd === "kill-session") {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "")
      if (this.opts.unkillable && (this.opts.unkillable.count ?? Infinity) > 0) {
        this.opts.unkillable.count = (this.opts.unkillable.count ?? Infinity) - 1
        return { code: 0, stdout: "" }
      }
      return { code: this.dropSession(name) ? 0 : 1, stdout: "" }
    }
    if (cmd === "has-session") {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "")
      return { code: this.sessions.has(name) ? 0 : 1, stdout: "" }
    }
    if (cmd === "show-environment") return { code: 0, stdout: "PATH=/usr/bin:/bin\n" }
    if (cmd === "capture-pane") {
      if (this.opts.throwOnCapture) throw new Error("tmux exploded")
      const target = args[args.indexOf("-t") + 1]!
      const sim = this.paneSim(target)
      if (sim === undefined) return { code: 1, stdout: "" }
      if (sim && this.opts.paneNeverUp) return { code: 1, stdout: "" }
      if (sim && this.opts.failCaptureAfter !== undefined && ++this.captures > this.opts.failCaptureAfter) return { code: 1, stdout: "" }
      if (sim && this.opts.failCaptureAt !== undefined && ++this.captures === this.opts.failCaptureAt) return { code: 1, stdout: "" }
      return { code: 0, stdout: sim ? sim.render() : "❯ user is typing here" }
    }
    if (cmd === "send-keys") {
      const target = args[2]!
      const sim = this.paneSim(target)
      if (sim && this.opts.failSendKey && args.includes(this.opts.failSendKey)) return { code: 1, stdout: "" }
      if (!sim) return { code: sim === null ? 0 : 1, stdout: "" }
      if (args[3] === "-l") sim.typed += args[4]!
      else for (const k of args.slice(3)) sim.key(k)
      return { code: 0, stdout: "" }
    }
    return { code: 0, stdout: "" }
  }
}

// Virtual clock: sleep advances time instantly.
function clock() {
  let t = 1_000_000
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

const DEFAULTS = Array.from({ length: 64 }, (_, i) => `/cmd-${String(i).padStart(3, "0")}`)
const CUSTOMS = Array.from({ length: 41 }, (_, i) => `/skill-${String(i).padStart(3, "0")}`)
const SELF = 4242
const LAUNCH: ClaudeLaunch = { bin: "/opt/claude/bin/claude", env: { PATH: "/usr/bin:/bin" }, configDir: "/h/.claude", configDirExplicit: false, home: "/h" }

let n = 0
const names = () => `cc-scrape-${SELF}-${++n}-test`

// Throwaway HOMEs without the filesystem: records what was made and removed.
function fakeHomes() {
  const made: string[] = []
  const removed: string[] = []
  const homes: HomeFactory = {
    create: async (name, _launch, cwd) => { made.push(name); return { root: `/tmp/homes/${name}`, cwd, env: { HOME: `/tmp/homes/${name}` }, unset: ["CLAUDE_CONFIG_DIR"] } },
    remove: async (root) => { removed.push(root) },
  }
  return { homes, made, removed }
}

function deps(tmux: FakeTmux, timing: Record<string, number> = {}, homes = fakeHomes().homes) {
  const c = clock()
  return { tmux: tmux.run, sleep: c.sleep, now: c.now, timing, launch: LAUNCH, sessionName: names, homes, pidAlive: tmux.pidAlive, selfPid: SELF }
}

function run(tmux: FakeTmux, timing: Record<string, number> = {}, homes = fakeHomes().homes) {
  return enumerateCommandsOffPane("/Users/me/proj", deps(tmux, timing, homes))
}

const sim = (rows = 17, opts: ConstructorParameters<typeof SimClaude>[2] = {}) =>
  () => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, rows, opts)

afterEach(() => { resetScrapeRegistry(); resetOffPaneState() })

describe("enumerateCommandsOffPane", () => {
  test("reads the whole list from a hidden session — ZERO keystrokes reach the user's pane", async () => {
    const tmux = new FakeTmux(sim())
    const res = await run(tmux)

    expect(res.status).toBe("ok")
    expect(res.commands.filter((c) => c.kind === "default").map((c) => c.name)).toEqual(DEFAULTS)
    expect(res.commands.filter((c) => c.kind === "custom").map((c) => c.name)).toEqual(CUSTOMS)
    expect(res.rowsPerPage).toBe(17)

    // Acceptance (1): the send-keys spy never saw the user's pane, and never
    // read it either.
    expect(tmux.keysTo("%1")).toEqual([])
    expect(tmux.calls.some((c) => c.includes("%1") || c.includes("cc-user") || c.includes("=cc-user"))).toBe(false)
    const sends = tmux.calls.filter((c) => c[0] === "send-keys")
    expect(sends.length).toBeGreaterThan(0)
    expect(new Set(sends.map((c) => c[2]))).toEqual(new Set(["%10"]))
  })

  test("a slow /help paint (loaded machine, 2 claudes booting) does not eat the Tab — polled, not slept", async () => {
    const tmux = new FakeTmux(sim(17, { paintCaptures: 40 }))
    const res = await run(tmux)
    expect(res.status).toBe("ok")
    expect(res.commands).toHaveLength(DEFAULTS.length + CUSTOMS.length)
  })

  test("hidden session: cc-scrape-* name, 220x60, same cwd, hooks+MCP off, scrape env, pinned binary", async () => {
    const tmux = new FakeTmux(sim())
    await run(tmux)
    const create = tmux.calls.find((c) => c[0] === "new-session")!
    expect(create).toContain("-d")
    expect(isScrapeSessionName(create[create.indexOf("-s") + 1]!)).toBe(true)
    expect(create[create.indexOf("-x") + 1]).toBe(String(DETACHED_COLS))
    expect(create[create.indexOf("-y") + 1]).toBe(String(DETACHED_ROWS))
    expect(create[create.indexOf("-F") + 1]).toBe("#{pane_id}\t#{pane_tty}\t#{pane_pid}")
    const name = create[create.indexOf("-s") + 1]!
    expect(create.at(-1)).toBe(buildScrapeInner("/Users/me/proj", LAUNCH, { env: { HOME: `/tmp/homes/${name}` }, unset: ["CLAUDE_CONFIG_DIR"] }))
  })

  test("the launch line: throwaway HOME, hooks and MCP off, both scrape vars (env + cmdline), resolved binary", () => {
    const inner = buildScrapeInner(
      "/Users/me/it's",
      { bin: "/x/claude", env: { PATH: "/a:/b" }, configDir: "/cfg dir", configDirExplicit: true, home: "/h" },
      { env: { HOME: "/tmp/h 1", CLAUDE_CONFIG_DIR: "/tmp/h 1/.claude", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/cfg dir" }, unset: [] },
    )
    expect(inner).toBe(
      "export COMPANION_SCRAPE=1; export CLAUDE_CODE_SCRAPE_SESSION=1; export DISABLE_AUTOUPDATER=1; "
      + "export PATH='/a:/b'; export HOME='/tmp/h 1'; export CLAUDE_CONFIG_DIR='/tmp/h 1/.claude'; export CLAUDE_SECURESTORAGE_CONFIG_DIR='/cfg dir'; "
      + "cd '/Users/me/it'\\''s' && exec '/x/claude' --strict-mcp-config --mcp-config '{\"mcpServers\":{}}' "
      + "--settings '{\"disableAllHooks\":true,\"env\":{\"COMPANION_SCRAPE\":\"1\",\"CLAUDE_CODE_SCRAPE_SESSION\":\"1\"}}'",
    )
    const noCfg = buildScrapeInner("/p", LAUNCH, { env: { HOME: "/t" }, unset: ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] })
    expect(noCfg).toContain("unset CLAUDE_CONFIG_DIR; unset CLAUDE_SECURESTORAGE_CONFIG_DIR; cd '/p'")
  })

  // Acceptance (3): no orphans after success, timeout, error.
  test("kills the hidden session after success, confirmed with has-session, and deletes its throwaway HOME", async () => {
    const h = fakeHomes()
    const tmux = new FakeTmux(sim())
    await run(tmux, {}, h.homes)
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
    expect(tmux.calls.some((c) => c[0] === "has-session")).toBe(true)
    expect(h.made).toHaveLength(1)
    expect(h.removed).toEqual([`/tmp/homes/${h.made[0]}`])
    expect(pendingKills()).toEqual([])
  })

  test("the throwaway HOME is deleted on every failure path too", async () => {
    for (const [opts, timing] of [[{ throwOnCapture: true }, {}], [{ paneNeverUp: true }, {}], [{ failSendKey: "Down" }, {}], [{}, { bootTimeoutMs: 1_000 }]] as const) {
      const h = fakeHomes()
      const tmux = new FakeTmux("bootTimeoutMs" in timing ? sim(17, { bootCaptures: 1e9 }) : sim(5), opts)
      await run(tmux, timing, h.homes)
      expect(h.removed).toEqual(h.made.map((m) => `/tmp/homes/${m}`))
    }
  })

  test("a throwaway HOME that cannot be made is an error before any tmux session exists", async () => {
    const tmux = new FakeTmux(sim())
    const homes: HomeFactory = { create: async () => { throw new Error("ENOSPC") }, remove: async () => {} }
    const res = await run(tmux, {}, homes)
    expect(res.status).toBe("error")
    expect(res.detail).toContain("ENOSPC")
    expect(tmux.calls.some((c) => c[0] === "new-session")).toBe(false)
  })

  test("kills the hidden session on a boot timeout", async () => {
    const tmux = new FakeTmux(sim(17, { bootCaptures: 1_000_000 }))
    const res = await run(tmux, { bootTimeoutMs: 5_000 })
    expect(res.status).toBe("timeout")
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
    expect(tmux.keysTo("%10")).toEqual([])
  })

  test("kills the hidden session when the paging deadline hits mid-list, and reports partial", async () => {
    const tmux = new FakeTmux(sim(5))
    const res = await run(tmux, { deadlineMs: 12_000 })
    expect(res.status).toBe("timeout")
    expect(res.commands.length).toBeGreaterThan(0)
    expect(res.commands.length).toBeLessThan(DEFAULTS.length + CUSTOMS.length)
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("kills the hidden session when tmux throws", async () => {
    const tmux = new FakeTmux(sim(), { throwOnCapture: true })
    const res = await run(tmux)
    expect(res.status).toBe("error")
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("a failed new-session is an error, not a hang", async () => {
    const tmux = new FakeTmux(sim(), { failNewSession: true })
    const res = await run(tmux)
    expect(res.status).toBe("error")
  })

  test("a pane that never comes up (claude missing/exited) fails FAST, not at the boot timeout", async () => {
    const tmux = new FakeTmux(sim(), { paneNeverUp: true })
    const d = deps(tmux)
    const t0 = d.now()
    const res = await enumerateCommandsOffPane("/p", d)
    expect(res.status).toBe("error")
    expect(res.detail).toContain("never came up")
    expect(d.now() - t0).toBeLessThan(2_000)
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("a capture failing mid-scrape is an error — never an empty page, never a cacheable list", async () => {
    // Boot (2 blank + ready + settle) then a few pages, then capture-pane dies.
    const tmux = new FakeTmux(sim(5), { failCaptureAfter: 8 })
    const res = await run(tmux)
    expect(res.status).toBe("error")
    expect(res.detail).toBe("capture-pane failed mid-scrape")
    expect(res.commands).toEqual([])
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("a failed send-keys is an error, not a silently short list", async () => {
    const tmux = new FakeTmux(sim(5), { failSendKey: "Down" })
    const res = await run(tmux)
    expect(res.status).toBe("error")
    expect(res.detail).toContain("send-keys")
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("first-run wizard / trust dialog: bails without pressing anything", async () => {
    for (const screen of [
      "Welcome to Claude Code\n\nChoose the text style that looks best with your terminal",
      "Do you trust the files in this folder?\n\n❯ 1. Yes, proceed",
      "Select login method:\n ❯ 1. Claude account with subscription",
      "New MCP server found in .mcp.json: foo\nSelect any you wish to enable.",
    ]) {
      const tmux = new FakeTmux(sim(17, { screen }))
      const res = await run(tmux)
      expect(res.status).toBe("wizard")
      expect(res.commands).toEqual([])
      expect(tmux.calls.filter((c) => c[0] === "send-keys")).toEqual([])
      expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
    }
  })

  test("an unconfirmed kill stays tracked and marked until a later reap confirms it", async () => {
    const tmux = new FakeTmux(sim(), { unkillable: { count: 5 } })
    const res = await run(tmux, { killAttempts: 3 })
    expect(res.status).toBe("ok")
    expect(pendingKills()).toHaveLength(1)
    // Still in tmux, still marked: the hook router and ps-discovery keep dropping it.
    expect([...tmux.sessions.keys()]).toHaveLength(2)
    expect(isScrapeTarget({ tmuxPane: "%10" })).toBe(true)
    // The next reap (next enumeration, or the retry timer) finishes the job.
    await reapScrapeSessions({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes: fakeHomes().homes })
    expect(pendingKills()).toEqual([])
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("the hidden pane/tty is registered while live, so hooks from it are dropped", async () => {
    let seenDuring = false
    const tmux = new FakeTmux(sim())
    const orig = tmux.run
    tmux.run = async (args) => {
      if (args[0] === "capture-pane") seenDuring ||= isScrapeTarget({ tmuxPane: "%10" })
      return orig(args)
    }
    await enumerateCommandsOffPane("/x", deps(tmux))
    expect(seenDuring).toBe(true)
    // After the kill the pane stays marked (late SessionEnd), the user's never is.
    expect(isScrapeTarget({ tmuxPane: "%10" })).toBe(true)
    expect(isScrapeTarget({ tmuxPane: "%1", tty: "/dev/ttys007" })).toBe(false)
  })
})

describe("reapScrapeSessions", () => {
  test("kills leftover cc-scrape-* sessions and nothing else — not even a project named scrape-*", async () => {
    const tmux = new FakeTmux(sim())
    tmux.addSession("cc-scrape-999-1-ab12", "%50", "/dev/ttys050", 9001)
    tmux.livePids.delete(999) // its server is gone
    tmux.addSession("cc-scrape-tool", "%52", "/dev/ttys052", 9002) // user spawn in ~/scrape-tool
    tmux.addSession("cc-myproject", "%51", "/dev/ttys051", 9003)
    // kill-session drops the pane process with it
    const reaped = await reapScrapeSessions({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes: fakeHomes().homes })
    expect(reaped).toEqual(["cc-scrape-999-1-ab12"])
    expect([...tmux.sessions.keys()].sort()).toEqual(["cc-myproject", "cc-scrape-tool", "cc-user"])
  })

  test("another live server's hidden pane is marked while it lives, released once it is gone", async () => {
    const tmux = new FakeTmux(sim())
    tmux.livePids.add(7777) // the other companion server is alive
    tmux.addSession("cc-scrape-7777-1-ab12", "%60", "/dev/ttys060", 9060)
    const reap = () => reapScrapeSessions({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes: fakeHomes().homes })
    await reap()
    // Not ours to kill, but never listed as a user session either.
    expect(tmux.sessions.has("cc-scrape-7777-1-ab12")).toBe(true)
    expect(isScrapeTarget({ tmuxPane: "%60" })).toBe(true)
    expect(foreignScrapes()).toEqual(["cc-scrape-7777-1-ab12"])

    // A failed listing proves nothing: the mark stays.
    const orig = tmux.run
    tmux.run = async (args) => (args[0] === "list-panes" ? { code: 1, stdout: "" } : orig(args))
    tmux.sessions.delete("cc-scrape-7777-1-ab12")
    await reap()
    expect(foreignScrapes()).toEqual(["cc-scrape-7777-1-ab12"])
    expect(isScrapeTarget({ tmuxPane: "%60" })).toBe(true)

    // Gone from a good listing: released (after the grace), so an ordinary
    // session that reuses the tty is visible again.
    tmux.run = orig
    await reap()
    expect(foreignScrapes()).toEqual([])
    expect(isScrapeTarget({ tty: "/dev/ttys060" }, Date.now() + 60_000)).toBe(false)
    expect(isScrapeTarget({ tmuxPane: "%60" }, Date.now() + 11 * 60_000)).toBe(false)
  })

  test("a foreign scrape that was tmux's LAST session: 'no server running' releases it, pane mark included", async () => {
    const tmux = new FakeTmux(sim())
    tmux.sessions.delete("cc-user")
    tmux.livePids.add(7777)
    tmux.addSession("cc-scrape-7777-1-ab12", "%0", "/dev/ttys060", 9060)
    const reap = () => reapScrapeSessions({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes: fakeHomes().homes })
    await reap()
    expect(isScrapeTarget({ tmuxPane: "%0" })).toBe(true)
    tmux.sessions.clear() // it exits; the server goes with it
    await reap()
    expect(foreignScrapes()).toEqual([])
    // The next server hands out %0 again: no mark may survive on it.
    expect(isScrapeTarget({ tmuxPane: "%0" })).toBe(false)
    expect(isScrapeTarget({ tty: "/dev/ttys060" }, Date.now() + 60_000)).toBe(false)
  })

  test("a replaced tmux server (new pid) drops old pane marks; ids it reuses are not hidden", async () => {
    const tmux = new FakeTmux(sim())
    tmux.livePids.add(7777)
    tmux.addSession("cc-scrape-7777-1-ab12", "%60", "/dev/ttys060", 9060)
    const reap = () => reapScrapeSessions({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes: fakeHomes().homes })
    await reap()
    expect(isScrapeTarget({ tmuxPane: "%60" })).toBe(true)
    // Server restarted: a user's session now owns %60.
    tmux.serverPid = 6000
    tmux.sessions.clear()
    tmux.addSession("cc-myproject", "%60", "/dev/ttys061", 9061)
    await reap()
    expect(isScrapeTarget({ tmuxPane: "%60" })).toBe(false)
  })

  test("tmuxNoServer: only a missing server/socket is an empty inventory", () => {
    expect(tmuxNoServer({ code: 1, stdout: "", stderr: "no server running on /tmp/tmux-501/default" })).toBe(true)
    expect(tmuxNoServer({ code: 1, stdout: "", stderr: "error connecting to /tmp/tmux-501/default (No such file or directory)" })).toBe(true)
    expect(tmuxNoServer({ code: 1, stdout: "", stderr: "error connecting to /tmp/tmux-501/default (Operation not permitted)" })).toBe(false)
    expect(tmuxNoServer({ code: 1, stdout: "", stderr: "error connecting to /tmp/tmux-501/default (Permission denied)" })).toBe(false)
    expect(tmuxNoServer({ code: -1, stdout: "", stderr: "no server running" })).toBe(false)
  })

  test("no inventory (tmux failed for another reason): nothing is released and no HOME is swept", async () => {
    const tmux = new FakeTmux(sim())
    let sweeps = 0
    const homes: HomeFactory = { ...fakeHomes().homes, sweep: async () => { sweeps++ } }
    const orig = tmux.run
    tmux.run = async (args) => (args[0] === "list-panes" ? { code: 1, stdout: "", stderr: "server exited unexpectedly" } : orig(args))
    await reapScrapeSessions({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes })
    expect(sweeps).toBe(0)
    tmux.run = orig
    await reapScrapeSessions({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes })
    expect(sweeps).toBe(1)
  })

  test("generated names always match the reaper's pattern", () => {
    for (let i = 0; i < 50; i++) expect(isScrapeSessionName(scrapeSessionName())).toBe(true)
  })
})

describe("hidden session never reaches the picker (acceptance 4)", () => {
  test("a scrape pane or tty is recognised while live (ps-discovery skips it); a real session is not", async () => {
    let checked = false
    const tmux = new FakeTmux(sim())
    const orig = tmux.run
    tmux.run = async (args) => {
      if (args[0] === "capture-pane" && !checked) {
        checked = true
        expect(isScrapeTarget({ tmuxPane: "%10" })).toBe(true)
        expect(isScrapeTarget({ tty: "ttys011" })).toBe(true)
        expect(isScrapeTarget({ tty: "/dev/ttys011" })).toBe(true)
      }
      return orig(args)
    }
    await enumerateCommandsOffPane("/x", deps(tmux))
    expect(checked).toBe(true)
    expect(isScrapeTarget({ tmuxPane: "%1", tty: "/dev/ttys007" })).toBe(false)
  })

  test("hooks from a scrape pane get a bare passthrough; others fall through", async () => {
    const { markScrapeTarget } = await import("./scrape-registry")
    const { scrapeHookPassthrough } = await import("./hook-common")
    markScrapeTarget({ pane: "%77" })
    const res = scrapeHookPassthrough(new Headers({ "X-Companion-Tmux-Pane": "%77" }))
    expect(res).not.toBeNull()
    expect(await res!.json()).toEqual({})
    expect(scrapeHookPassthrough(new Headers({ "X-Companion-Tmux-Pane": "%1" }))).toBeNull()
  })

  test("hooks/_lib.sh: a hook sourcing it exits 0 silently under either scrape var", async () => {
    const lib = join(import.meta.dir, "..", "..", "hooks", "_lib.sh")
    for (const env of [{ COMPANION_SCRAPE: "1" }, { CLAUDE_CODE_SCRAPE_SESSION: "1" }]) {
      const p = Bun.spawnSync(["bash", "-c", `source '${lib}'; echo SHOULD-NOT-PRINT`], { env: { ...process.env, ...env }, stdout: "pipe" })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toBe("")
    }
  })
})

describe("resolveClaudeLaunch", () => {
  const whichIn = (bins: Record<string, string>) => (_: string, path: string) => {
    for (const dir of path.split(":")) if (bins[dir]) return bins[dir]!
    return null
  }

  test("resolves on the tmux SERVER's PATH and takes CLAUDE_CONFIG_DIR from it", async () => {
    const tmux = async () => ({ code: 0, stdout: "PATH=/tmuxbin:/usr/bin\nCLAUDE_CONFIG_DIR=/cfg\n-REMOVED\n" })
    const launch = await resolveClaudeLaunch({
      tmux, which: whichIn({ "/tmuxbin": "/tmuxbin/claude", "/procbin": "/procbin/claude" }),
      processEnv: { PATH: "/procbin", CLAUDE_CONFIG_DIR: "/proc-cfg" }, home: "/h",
    })
    expect(launch).toEqual({ bin: "/tmuxbin/claude", env: { PATH: "/tmuxbin:/usr/bin" }, configDir: "/cfg", configDirExplicit: true, home: "/h" })
  })

  test("CLAUDE_CONFIG_DIR absent from, or removed (-VAR) in, the tmux env stays unset — the process env is NOT consulted", async () => {
    for (const out of ["PATH=/usr/bin\n", "PATH=/usr/bin\n-CLAUDE_CONFIG_DIR\n"]) {
      const launch = await resolveClaudeLaunch({
        tmux: async () => ({ code: 0, stdout: out }), which: () => "/usr/bin/claude",
        processEnv: { PATH: "/procbin", CLAUDE_CONFIG_DIR: "/proc-cfg" }, home: "/h",
      })
      expect(launch?.configDir).toBe("/h/.claude")
      expect(launch?.configDirExplicit).toBe(false)
    }
  })

  test("no tmux server yet: falls back to the process env (what new-session would inherit)", async () => {
    const launch = await resolveClaudeLaunch({
      tmux: async () => ({ code: 1, stdout: "" }), which: whichIn({ "/procbin": "/procbin/claude" }),
      processEnv: { PATH: "/procbin" }, home: "/h",
    })
    expect(launch?.bin).toBe("/procbin/claude")
    expect(launch?.configDir).toBe("/h/.claude")
    const withCfg = await resolveClaudeLaunch({
      tmux: async () => ({ code: 1, stdout: "" }), which: whichIn({ "/procbin": "/procbin/claude" }),
      processEnv: { PATH: "/procbin", CLAUDE_CONFIG_DIR: "/proc-cfg" }, home: "/h",
    })
    expect(withCfg?.configDir).toBe("/proc-cfg")
    expect(withCfg?.configDirExplicit).toBe(true)
  })

  test("claude nowhere → null (the route answers at once, not after a timeout)", async () => {
    const launch = await resolveClaudeLaunch({ tmux: async () => ({ code: 1, stdout: "" }), which: () => null, processEnv: {}, home: "/h" })
    expect(launch).toBeNull()
  })

  test("parseTmuxEnv keeps values with '=' and skips removed vars", () => {
    expect(parseTmuxEnv("A=1\nB=x=y\n-C\n")).toEqual({ A: "1", B: "x=y" })
  })
})

describe("createCommandLister", () => {
  const ok = (n: number): OffPaneResult => ({
    status: "ok", rowsPerPage: 17, session: "s",
    commands: Array.from({ length: n }, (_, i) => ({ name: `/c${i}`, description: "", kind: "default" as const })),
  })
  const lister = (enumerate: (cwd: string) => Promise<OffPaneResult>, fingerprint: (cwd: string) => string, extra: Record<string, unknown> = {}) =>
    createCommandLister({ prepare: async (cwd) => ({ fingerprint: fingerprint(cwd), enumerate: () => enumerate(cwd) }), ...extra })

  test("caches on the fingerprint: same fingerprint → no re-run; changed → re-run", async () => {
    let fp = "v1"
    let runs = 0
    const l = lister(async () => { runs++; return ok(3) }, () => fp)
    expect((await l.list("/p")).cached).toBe(false)
    expect((await l.list("/p")).cached).toBe(true)
    expect(runs).toBe(1)
    fp = "v2" // a skill was added / claude updated
    expect((await l.list("/p")).cached).toBe(false)
    expect(runs).toBe(2)
  })

  test("24h safety TTL re-runs even when the fingerprint is unchanged", async () => {
    let t = 0
    let runs = 0
    const l = lister(async () => { runs++; return ok(3) }, () => "v", { now: () => t })
    await l.list("/p")
    t += 23 * 3600_000
    expect((await l.list("/p")).cached).toBe(true)
    t += 2 * 3600_000
    expect((await l.list("/p")).cached).toBe(false)
    expect(runs).toBe(2)
  })

  test("force bypasses the cache", async () => {
    let runs = 0
    const l = lister(async () => { runs++; return ok(3) }, () => "v")
    await l.list("/p")
    await l.list("/p", { force: true })
    expect(runs).toBe(2)
  })

  test("never caches incomplete, nor an empty ok — they re-run", async () => {
    for (const [status, count] of [["incomplete", 3], ["ok", 0]] as const) {
      let runs = 0
      const l = lister(async () => { runs++; return { ...ok(count), status } }, () => "v")
      await l.list("/p")
      await l.list("/p")
      expect(runs).toBe(2)
    }
  })

  test("prepare error (claude not on PATH) answers at once as an error", async () => {
    const l = createCommandLister({ prepare: async () => ({ error: "claude not on PATH" }) })
    const { cached, result } = await l.list("/p")
    expect(cached).toBe(false)
    expect(result.status).toBe("error")
    expect(result.detail).toBe("claude not on PATH")
  })

  test("concurrent callers for one fingerprint share one hidden claude", async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const l = lister(async () => { runs++; await gate; return ok(5) }, () => "v")
    const a = l.list("/p")
    const b = l.list("/p")
    await new Promise((r) => setTimeout(r, 1))
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(runs).toBe(1)
    expect(ra.result.commands).toHaveLength(5)
    expect(rb.result.commands).toHaveLength(5)
  })

  test("different cwds run in parallel, capped at 2", async () => {
    let live = 0, peak = 0
    const l = lister(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 10)); live--; return ok(1) }, (cwd) => cwd)
    const all = await Promise.all(["/a", "/b", "/c", "/d"].map((c) => l.list(c)))
    expect(peak).toBe(2)
    expect(all.every((o) => o.result.status === "ok")).toBe(true)
  })

  test("negative cache: a wizard/error is answered from memory for 10 min — same shape, no new claude", async () => {
    for (const status of ["wizard", "error"] as const) {
      let t = 0
      let runs = 0
      const l = lister(async () => { runs++; return { status, commands: [], rowsPerPage: 0, session: "s", detail: "boot: wizard" } }, () => "v", { now: () => t })
      const first = await l.list("/p")
      expect(first.result.status).toBe(status)
      t += 9 * 60_000
      const again = await l.list("/p")
      expect(again.cached).toBe(false)
      expect(again.result.status).toBe(status)
      expect(again.result.commands).toEqual([])
      expect(again.result.detail).toContain("remembered")
      expect(runs).toBe(1)
      t += 2 * 60_000 // past 10 min → one fresh try
      await l.list("/p")
      expect(runs).toBe(2)
    }
  })

  test("negative cache is per fingerprint: a change (skill fixed, claude updated) retries at once", async () => {
    let fp = "v1"
    let runs = 0
    const l = lister(async () => { runs++; return { status: "wizard", commands: [], rowsPerPage: 0, session: "s" } }, () => fp)
    await l.list("/p")
    await l.list("/p")
    expect(runs).toBe(1)
    fp = "v2"
    await l.list("/p")
    expect(runs).toBe(2)
  })

  test("slot hand-off: a released slot goes to the waiter, never to a newcomer (no over-subscription)", async () => {
    const slots = createSlots(2)
    await slots.acquire()
    await slots.acquire()
    let thirdIn = false
    const third = slots.acquire().then(() => { thirdIn = true })
    expect(slots.waiting).toBe(1)
    slots.release()
    // Before the waiter even resumes, the slot is already its: still 2 held,
    // so a newcomer arriving right now has to queue.
    expect(slots.running).toBe(2)
    let fourthIn = false
    const fourth = slots.acquire().then(() => { fourthIn = true })
    await third
    expect(thirdIn).toBe(true)
    await Promise.resolve()
    expect(fourthIn).toBe(false)
    expect(slots.running).toBe(2)
    slots.release()
    await fourth
    expect(fourthIn).toBe(true)
    slots.release()
    slots.release()
    expect(slots.running).toBe(0)
  })

  test("3 concurrent cwds under cap 2: never more than 2 hidden claudes, all 3 answered, a late 4th still capped", async () => {
    let live = 0, peak = 0, started = 0
    const gates: Array<() => void> = []
    const l = lister(async () => {
      started++; live++; peak = Math.max(peak, live)
      await new Promise<void>((r) => gates.push(r))
      live--
      return ok(1)
    }, (cwd) => cwd)
    const flush = () => new Promise((r) => setTimeout(r, 1))
    const three = ["/a", "/b", "/c"].map((c) => l.list(c))
    await flush()
    expect(started).toBe(2)
    gates.shift()!()             // /a done → its slot goes to /c
    const late = l.list("/d")    // arrives in the same breath
    await flush()
    expect(started).toBe(3)
    expect(peak).toBe(2)
    while (gates.length) { gates.shift()!(); await flush() }
    const all = await Promise.all([...three, late])
    expect(peak).toBe(2)
    expect(all.every((o) => o.result.status === "ok")).toBe(true)
  })

  test("a request stops waiting at waitMs with `pending`; the run still finishes and caches", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let runs = 0
    const l = lister(async () => { runs++; await gate; return ok(4) }, () => "v", { waitMs: 5 })
    const first = await l.list("/p")
    expect(first.result.status).toBe("pending")
    release()
    await new Promise((r) => setTimeout(r, 5))
    const second = await l.list("/p")
    expect(second.cached).toBe(true)
    expect(second.result.commands).toHaveLength(4)
    expect(runs).toBe(1)
  })
})

describe("fingerprint", () => {
  let root = ""
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = "" })

  function tree() {
    root = mkdtempSync(join(tmpdir(), "cc-fp-"))
    const cfg = join(root, "cfg"), cwd = join(root, "proj")
    for (const d of [join(cfg, "skills", "alpha"), join(cfg, "commands", "ns"), join(cfg, "plugins"), join(cwd, ".claude", "skills", "beta"), join(cwd, ".claude", "commands"), join(root, "linked")]) {
      mkdirSync(d, { recursive: true })
    }
    writeFileSync(join(cfg, "skills", "alpha", "SKILL.md"), "a")
    writeFileSync(join(cfg, "commands", "ns", "deep.md"), "c")
    writeFileSync(join(cfg, "settings.json"), "{}")
    writeFileSync(join(cfg, "plugins", "installed_plugins.json"), "{}")
    writeFileSync(join(cwd, ".claude", "skills", "beta", "SKILL.md"), "b")
    writeFileSync(join(cwd, ".claude", "settings.local.json"), "{}")
    writeFileSync(join(root, "linked", "SKILL.md"), "l")
    symlinkSync(join(root, "linked"), join(cfg, "skills", "linked"))
    return { cfg, cwd, launch: { bin: "/b/claude", env: {}, configDir: cfg, configDirExplicit: true, home: root } as ClaudeLaunch }
  }

  const bump = (p: string) => { const t = new Date(Date.now() + 60_000); utimesSync(p, t, t) }

  test("covers nested SKILL.md (symlinked too), namespaced commands, settings and installed_plugins", async () => {
    const { cfg, cwd } = tree()
    const entries = (await fingerprintEntries(cwd, cfg)).map((e) => e.slice(0, e.lastIndexOf(":")))
    for (const p of [
      join(cfg, "skills", "alpha", "SKILL.md"), join(cfg, "skills", "linked", "SKILL.md"), join(cfg, "commands", "ns", "deep.md"),
      join(cfg, "settings.json"), join(cfg, "plugins", "installed_plugins.json"),
      join(cwd, ".claude", "skills", "beta", "SKILL.md"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"),
    ]) expect(entries).toContain(p)
  })

  test("ancestors' .claude skills/commands (monorepo) are sources; the user config dir is not repeated", () => {
    const src = fingerprintSources("/repo/packages/frontend", "/home/me/.claude")
    const dirs = src.walk.map((w) => w.dir)
    expect(dirs).toContain("/repo/packages/.claude/skills")
    expect(dirs).toContain("/repo/.claude/skills")
    expect(dirs).toContain("/repo/.claude/commands")
    expect(dirs).toContain("/.claude/skills")
    const home = fingerprintSources("/home/me/proj", "/home/me/.claude").walk.map((w) => w.dir)
    expect(home.filter((d) => d === "/home/me/.claude/skills")).toHaveLength(1)
  })

  test("a linked git worktree also fingerprints the main worktree's .claude", async () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), "cc-wt-")))
    mkdirSync(join(r, "main", ".git", "worktrees", "feat"), { recursive: true })
    mkdirSync(join(r, "main", ".claude", "skills", "s"), { recursive: true })
    writeFileSync(join(r, "main", ".claude", "skills", "s", "SKILL.md"), "s")
    mkdirSync(join(r, "wt", "sub"), { recursive: true })
    writeFileSync(join(r, "wt", ".git"), `gitdir: ${join(r, "main", ".git", "worktrees", "feat")}\n`)
    expect(await mainWorktreeRoot(join(r, "wt", "sub"))).toBe(join(r, "main"))
    expect(await mainWorktreeRoot(join(r, "main"))).toBeNull()
    const entries = (await fingerprintEntries(join(r, "wt"), join(r, "cfg"))).map((e) => e.slice(0, e.lastIndexOf(":")))
    expect(entries).toContain(join(r, "main", ".claude", "skills", "s", "SKILL.md"))
    rmSync(r, { recursive: true, force: true })
  })

  test("moves when any source file changes, and with the version / binary", async () => {
    const { cfg, cwd, launch } = tree()
    const base = await computeFingerprint(cwd, launch, "2.1.0")
    expect(await computeFingerprint(cwd, launch, "2.1.0")).toBe(base)
    expect(await computeFingerprint(cwd, launch, "2.1.1")).not.toBe(base)
    expect(await computeFingerprint(cwd, { ...launch, bin: "/other/claude" }, "2.1.0")).not.toBe(base)
    for (const p of [join(cfg, "skills", "alpha", "SKILL.md"), join(cfg, "settings.json"), join(cfg, "plugins", "installed_plugins.json"), join(cwd, ".claude", "settings.local.json")]) {
      const before = await computeFingerprint(cwd, launch, "2.1.0")
      bump(p)
      expect(await computeFingerprint(cwd, launch, "2.1.0")).not.toBe(before)
    }
  })

  test("a directory mtime alone does not move it (claude re-syncs skills/synced/<id>/ on every start)", async () => {
    const { cfg, cwd, launch } = tree()
    const before = await computeFingerprint(cwd, launch, "2.1.0")
    bump(join(cfg, "skills", "alpha"))
    bump(join(cfg, "skills"))
    expect(await computeFingerprint(cwd, launch, "2.1.0")).toBe(before)
    // …but adding or removing a skill does.
    mkdirSync(join(cfg, "skills", "gamma"))
    writeFileSync(join(cfg, "skills", "gamma", "SKILL.md"), "g")
    const added = await computeFingerprint(cwd, launch, "2.1.0")
    expect(added).not.toBe(before)
    rmSync(join(cfg, "skills", "gamma"), { recursive: true })
    expect(await computeFingerprint(cwd, launch, "2.1.0")).toBe(before)
  })

})

describe("wizard detection", () => {
  test("a normal prompt is not a wizard", () => {
    expect(paneBlockedByWizard("╭─ Welcome back ─╮\n❯ \n? for shortcuts")).toBe(false)
  })
})

describe("throwaway HOME (never race-write ~/.claude.json / history.jsonl)", () => {
  let root = ""
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = "" })

  function userTree() {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cc-home-")))
    const home = join(root, "home"), cfg = join(home, ".claude"), proj = join(root, "proj")
    for (const d of [join(cfg, "skills", "a"), join(cfg, "commands"), join(cfg, "plugins"), join(cfg, "projects"), join(home, "Library"), proj]) mkdirSync(d, { recursive: true })
    writeFileSync(join(cfg, "skills", "a", "SKILL.md"), "a")
    writeFileSync(join(cfg, "settings.json"), "{}")
    writeFileSync(join(cfg, "history.jsonl"), "")
    writeFileSync(join(cfg, ".credentials.json"), "{}")
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 1, projects: { [home]: { hasTrustDialogAccepted: true } } }))
    const base = join(root, "homes")
    mkdirSync(base, { mode: 0o700 })
    return { home, cfg, base, proj }
  }

  test("links only the list's sources, COPIES .claude.json (0600), and leaves history/projects/credentials out", async () => {
    const { home, cfg, base, proj } = userTree()
    const h = await createScrapeHome("cc-scrape-1-1-abcd", { home, configDir: cfg, configDirExplicit: false, platform: "darwin", cwd: proj }, base)
    const hc = join(h.root, ".claude")
    expect(lstatSync(h.root).mode & 0o777).toBe(0o700)
    expect(h.cwd).toBe(proj)
    for (const name of ["skills", "commands", "plugins", "settings.json"]) expect(readlinkSync(join(hc, name))).toBe(join(cfg, name))
    for (const name of ["history.jsonl", "projects", ".credentials.json", "sessions"]) expect(existsSync(join(hc, name))).toBe(false)
    const copy = join(h.root, ".claude.json")
    expect(lstatSync(copy).isSymbolicLink()).toBe(false)
    expect(lstatSync(copy).mode & 0o777).toBe(0o600)
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(home, ".claude.json"), "utf8"))
    expect(readlinkSync(join(h.root, "Library"))).toBe(join(home, "Library"))
    // macOS, default config dir: the keychain item has no suffix → leave secure storage unset.
    expect(h.env).toEqual({ HOME: h.root })
    expect(h.unset).toEqual(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"])

    // What the hidden boot writes stays in the copy; the user's file is untouched.
    const before = readFileSync(join(home, ".claude.json"), "utf8")
    writeFileSync(copy, '{"numStartups":2}')
    writeFileSync(join(hc, "history.jsonl"), '{"display":"/help"}\n')
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before)
    expect(readFileSync(join(cfg, "history.jsonl"), "utf8")).toBe("")

    // Removal never follows the links.
    await removeScrapeHome(h.root)
    expect(existsSync(h.root)).toBe(false)
    expect(existsSync(join(cfg, "skills", "a", "SKILL.md"))).toBe(true)
    expect(existsSync(join(home, "Library"))).toBe(true)
  })

  test("Linux: secure storage points at the REAL config dir (claude refuses a symlinked .credentials.json)", async () => {
    const { home, cfg, base, proj } = userTree()
    const h = await createScrapeHome("cc-scrape-1-2-abcd", { home, configDir: cfg, configDirExplicit: false, platform: "linux", cwd: proj }, base)
    expect(h.env).toEqual({ HOME: h.root, CLAUDE_SECURESTORAGE_CONFIG_DIR: cfg })
    expect(existsSync(join(h.root, "Library"))).toBe(false)
  })

  test("explicit CLAUDE_CONFIG_DIR: copies <dir>/.claude.json into the throwaway config dir", async () => {
    const { home, base, proj } = userTree()
    const custom = join(root, "custom-cfg")
    mkdirSync(join(custom, "skills"), { recursive: true })
    writeFileSync(join(custom, ".claude.json"), '{"custom":true}')
    const h = await createScrapeHome("cc-scrape-1-3-abcd", { home, configDir: custom, configDirExplicit: true, platform: "darwin", cwd: proj }, base)
    expect(h.env.CLAUDE_CONFIG_DIR).toBe(join(h.root, ".claude"))
    expect(h.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(custom)
    expect(readFileSync(join(h.root, ".claude", ".claude.json"), "utf8")).toBe('{"custom":true}')
    expect(readlinkSync(join(h.root, ".claude", "skills"))).toBe(join(custom, "skills"))
  })

  // Finding 1: cwd == real HOME. Launched there, the real ~/.claude would be
  // PROJECT config on top of the user-level symlinks (double skills, project
  // writes into the real dir). Launched in the throwaway HOME instead.
  test("cwd == real HOME (or a symlink to it): launched in the throwaway HOME, trust carried over", async () => {
    const { home, cfg, base } = userTree()
    const viaLink = join(root, "home-link")
    symlinkSync(home, viaLink)
    for (const [i, cwd] of [home, viaLink].entries()) {
      const h = await createScrapeHome(`cc-scrape-1-${10 + i}-abcd`, { home, configDir: cfg, configDirExplicit: false, platform: "darwin", cwd }, base)
      expect(h.cwd).toBe(h.root)
      // The one .claude under the launch dir is the throwaway one (links), not the real dir.
      expect(lstatSync(join(h.cwd, ".claude")).isSymbolicLink()).toBe(false)
      expect(readlinkSync(join(h.cwd, ".claude", "skills"))).toBe(join(cfg, "skills"))
      const copy = JSON.parse(readFileSync(join(h.root, ".claude.json"), "utf8"))
      expect(copy.projects[h.root]).toEqual({ hasTrustDialogAccepted: true })
      expect(copy.projects[home]).toEqual({ hasTrustDialogAccepted: true })
      const inner = buildScrapeInner(cwd, LAUNCH, h)
      expect(inner).toContain(`cd '${h.root}' && exec`)
      expect(inner).not.toContain(`cd '${cwd}'`)
    }
    // The user's own file is never rewritten by the remap.
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects).toEqual({ [home]: { hasTrustDialogAccepted: true } })
  })

  test("any other cwd is launched as-is", async () => {
    const { home, cfg, base, proj } = userTree()
    const h = await createScrapeHome("cc-scrape-1-20-abcd", { home, configDir: cfg, configDirExplicit: false, platform: "darwin", cwd: proj }, base)
    expect(h.cwd).toBe(proj)
    expect(buildScrapeInner(proj, LAUNCH, h)).toContain(`cd '${proj}' && exec`)
  })
})

// Finding 2: never a fixed /tmp path; every dir verified before use.
describe("throwaway HOME base: private, ours, not a symlink", () => {
  let root = ""
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = "" })
  const uid = process.getuid!()
  const fresh = () => { root = realpathSync(mkdtempSync(join(tmpdir(), "cc-base-"))); return root }

  test("XDG_RUNTIME_DIR (ours, 0700) → <xdg>/cc-scrape-homes, created 0700", async () => {
    const xdg = join(fresh(), "run"); mkdirSync(xdg, { mode: 0o700 })
    const base = await resolveHomesBase({ env: { XDG_RUNTIME_DIR: xdg }, uid })
    expect(base).toBe(join(xdg, "cc-scrape-homes"))
    expect(statSync(base).mode & 0o777).toBe(0o700)
    // Idempotent: the same dir passes again.
    expect(await resolveHomesBase({ env: { XDG_RUNTIME_DIR: xdg }, uid })).toBe(base)
  })

  test("no XDG_RUNTIME_DIR → a fresh mkdtemp dir (random name, 0700), never a fixed path", async () => {
    const tmp = fresh()
    const a = await resolveHomesBase({ env: {}, tmp, uid, pid: 77 })
    const b = await resolveHomesBase({ env: {}, tmp, uid, pid: 77 })
    expect(a).not.toBe(b)
    expect(a.startsWith(join(tmp, "cc-scrape-homes-77-"))).toBe(true)
    expect(statSync(a).mode & 0o777).toBe(0o700)
  })

  test("an XDG_RUNTIME_DIR that is foreign, group-readable or a symlink is not used (mkdtemp instead)", async () => {
    const tmp = fresh()
    const loose = join(tmp, "loose"); mkdirSync(loose); chmodSync(loose, 0o755)
    const target = join(tmp, "t"); mkdirSync(target, { mode: 0o700 })
    const link = join(tmp, "link"); symlinkSync(target, link)
    const own = join(tmp, "own"); mkdirSync(own, { mode: 0o700 })
    for (const [xdg, asUid] of [[loose, uid], [link, uid], [own, uid + 1]] as const) {
      const base = await resolveHomesBase({ env: { XDG_RUNTIME_DIR: xdg }, tmp, uid: asUid === uid ? uid : -1, pid: 1 }).catch(() => null)
      if (asUid !== uid) {
        // Foreign owner: simulated by verifying as another uid.
        await expect(verifyPrivateDir(xdg, asUid)).rejects.toBeInstanceOf(UnsafeDirError)
        continue
      }
      expect(base?.startsWith(join(tmp, "cc-scrape-homes-1-"))).toBe(true)
    }
  })

  test("a PRE-CREATED <xdg>/cc-scrape-homes that is a symlink, loose or foreign is REFUSED", async () => {
    const tmp = fresh()
    const elsewhere = join(tmp, "attacker"); mkdirSync(elsewhere, { mode: 0o700 })
    const x1 = join(tmp, "x1"); mkdirSync(x1, { mode: 0o700 }); symlinkSync(elsewhere, join(x1, "cc-scrape-homes"))
    await expect(resolveHomesBase({ env: { XDG_RUNTIME_DIR: x1 }, uid })).rejects.toBeInstanceOf(UnsafeDirError)
    const x2 = join(tmp, "x2"); mkdirSync(x2, { mode: 0o700 }); mkdirSync(join(x2, "cc-scrape-homes")); chmodSync(join(x2, "cc-scrape-homes"), 0o777)
    await expect(resolveHomesBase({ env: { XDG_RUNTIME_DIR: x2 }, uid })).rejects.toBeInstanceOf(UnsafeDirError)
    const x3 = join(tmp, "x3"); mkdirSync(x3, { mode: 0o700 }); mkdirSync(join(x3, "cc-scrape-homes"), { mode: 0o700 })
    await expect(verifyPrivateDir(join(x3, "cc-scrape-homes"), uid + 1)).rejects.toBeInstanceOf(UnsafeDirError)
  })

  test("createScrapeHome refuses a symlinked or foreign base before copying .claude.json", async () => {
    const tmp = fresh()
    const home = join(tmp, "home"); mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(join(home, ".claude.json"), '{"secret":1}')
    const real = join(tmp, "real"); mkdirSync(real, { mode: 0o700 })
    const link = join(tmp, "link"); symlinkSync(real, link)
    const src = { home, configDir: join(home, ".claude"), configDirExplicit: false, platform: "linux" as const, cwd: tmp }
    await expect(createScrapeHome("cc-scrape-1-1-abcd", src, link)).rejects.toBeInstanceOf(UnsafeDirError)
    await expect(createScrapeHome("cc-scrape-1-2-abcd", src, real, uid + 1)).rejects.toBeInstanceOf(UnsafeDirError)
    const loose = join(tmp, "loose"); mkdirSync(loose); chmodSync(loose, 0o755)
    await expect(createScrapeHome("cc-scrape-1-3-abcd", src, loose)).rejects.toBeInstanceOf(UnsafeDirError)
    // Nothing was copied anywhere.
    expect(existsSync(join(real, "cc-scrape-1-1-abcd"))).toBe(false)
    expect(existsSync(join(real, "cc-scrape-1-2-abcd"))).toBe(false)
    expect(existsSync(join(loose, "cc-scrape-1-3-abcd"))).toBe(false)
  })

  test("sweep: removes a dead server's mkdtemp base, keeps ours, a live server's, and foreign-looking ones", async () => {
    const tmp = fresh()
    const dead = join(tmp, "cc-scrape-homes-6666-abc123"); mkdirSync(dead, { mode: 0o700 })
    const live = join(tmp, "cc-scrape-homes-7777-abc123"); mkdirSync(live, { mode: 0o700 })
    const self = join(tmp, "cc-scrape-homes-4242-abc123"); mkdirSync(self, { mode: 0o700 })
    const loose = join(tmp, "cc-scrape-homes-5555-abc123"); mkdirSync(loose); chmodSync(loose, 0o755)
    await sweepOrphanHomes({ keep: () => false, reapable: () => true, ownerDead: (pid) => pid !== 7777, selfPid: 4242, env: {}, tmp, uid })
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(self)).toBe(true)
    expect(existsSync(loose)).toBe(true)
  })
  test("sweep: a dead server's base keeps a pending-kill session's HOME, and goes only once empty", async () => {
    const tmp = fresh()
    const dead = join(tmp, "cc-scrape-homes-6666-abc123"); mkdirSync(dead, { mode: 0o700 })
    const pending = join(dead, "cc-scrape-6666-1-ab12"); mkdirSync(pending, { mode: 0o700 })
    const stale = join(dead, "cc-scrape-6666-2-cd34"); mkdirSync(stale, { mode: 0o700 })
    const keep = (name: string) => name === "cc-scrape-6666-1-ab12"
    await sweepOrphanHomes({ keep, reapable: () => true, ownerDead: () => true, selfPid: 4242, env: {}, tmp, uid })
    expect(existsSync(pending)).toBe(true)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(dead)).toBe(true)
    // Once its kill is confirmed nothing keeps it: the base goes too.
    await sweepOrphanHomes({ keep: () => false, reapable: () => true, ownerDead: () => true, selfPid: 4242, env: {}, tmp, uid })
    expect(existsSync(dead)).toBe(false)
  })
})

describe("discover guard: the tty mark outlives claude's process", () => {
  test("after the kill, the tty stays marked until the pane pid has exited", async () => {
    const tmux = new FakeTmux(sim(), { lingerPolls: 4 })
    const marks: boolean[] = []
    const alive = tmux.pidAlive
    tmux.pidAlive = (pid) => { marks.push(isScrapeTarget({ tty: "/dev/ttys011" })); return alive(pid) }
    const res = await enumerateCommandsOffPane("/p", { ...deps(tmux), pidAlive: tmux.pidAlive })
    expect(res.status).toBe("ok")
    // Every check while the pid lived saw the tty still marked…
    expect(marks.length).toBeGreaterThanOrEqual(5)
    expect(marks.every(Boolean)).toBe(true)
    // …and only then was it released (short tty grace).
    expect(isScrapeTarget({ tty: "/dev/ttys011" }, Date.now() + 60_000)).toBe(false)
    expect(pendingKills()).toEqual([])
  })

  test("a pid that outlives the bounded wait keeps the record tracked and the tty marked", async () => {
    const tmux = new FakeTmux(sim(), { lingerPolls: 1_000 })
    await run(tmux, { pidExitMs: 600 })
    expect(pendingKills()).toHaveLength(1)
    expect(isScrapeTarget({ tty: "/dev/ttys011" }, Date.now() + 60 * 60_000)).toBe(true)
    // Once it is gone, the next reap releases it.
    tmux.lingering.clear()
    tmux.livePids.delete(5011)
    await reapScrapeSessions({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes: fakeHomes().homes })
    expect(pendingKills()).toEqual([])
  })

  test("envHasScrapeVar: exact NAME=value entries only", () => {
    expect(envHasScrapeVar(["PATH=/bin", "COMPANION_SCRAPE=1", "HOME=/h"])).toBe(true)
    expect(envHasScrapeVar(["TERM=xterm", "CLAUDE_CODE_SCRAPE_SESSION=1"])).toBe(true)
    expect(envHasScrapeVar(["MY_COMPANION_SCRAPE=1", "COMPANION_SCRAPE=", "X=COMPANION_SCRAPE=1"])).toBe(false)
  })

  // A REAL process, identified by its environment — and a REAL process whose
  // argv (a `claude -p` prompt) merely mentions the var is still a session.
  test("isScrapeProcess reads a REAL process's env (ps eww / /proc), never its command line", async () => {
    const clean: Record<string, string | undefined> = { ...process.env }
    delete clean.COMPANION_SCRAPE
    delete clean.CLAUDE_CODE_SCRAPE_SESSION
    // Not /bin/sleep: macOS hides a platform binary's env from ps; claude is not one.
    const dir = mkdtempSync(join(tmpdir(), "cc-idle-"))
    const script = join(dir, "idle.ts")
    writeFileSync(script, "await Bun.sleep(5000)\n")
    const idle = [process.execPath, script]
    const withVar = Bun.spawn(idle, { env: { ...clean, COMPANION_SCRAPE: "1" } })
    const without = Bun.spawn(idle, { env: clean })
    // What `claude -p "…"` with that text in the prompt looks like to ps.
    const prompt = Bun.spawn([...idle, "-p", "run with COMPANION_SCRAPE=1 CLAUDE_CODE_SCRAPE_SESSION=1 set"], { env: clean })
    const mine = { ownsTty: async () => true }
    try {
      await Bun.sleep(300) // past exec
      // The env WAS read (so "false" below is a real answer, not a blind one)…
      const env = await processEnvEntries(String(prompt.pid))
      expect(env?.some((e) => e.startsWith("PATH="))).toBe(true)
      // …and the prompt's words are not in it.
      expect(env?.some((e) => e.startsWith("COMPANION_SCRAPE="))).toBe(false)
      expect(await isScrapeProcess(String(withVar.pid), "/dev/ttys900", mine)).toBe(true)
      expect(await isScrapeProcess(String(without.pid), "/dev/ttys901", mine)).toBe(false)
      expect(await isScrapeProcess(String(prompt.pid), "/dev/ttys902", mine)).toBe(false)
    } finally {
      withVar.kill()
      without.kill()
      prompt.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("isScrapeProcess: a registered tty needs no env read; a tty not ours is never env-read", async () => {
    let reads = 0
    const envOf = async () => { reads++; return ["COMPANION_SCRAPE=1"] }
    markScrapeTarget({ tty: "/dev/ttys950" })
    expect(await isScrapeProcess("1", "/dev/ttys950", { ownsTty: async () => true, envOf })).toBe(true)
    expect(reads).toBe(0)
    expect(await isScrapeProcess("1", "/dev/ttys951", { ownsTty: async () => false, envOf })).toBe(false)
    expect(reads).toBe(0)
    expect(await isScrapeProcess("1", "/dev/ttys951", { ownsTty: async () => true, envOf })).toBe(true)
    expect(reads).toBe(1)
  })
})

describe("reaper: owner-aware, registers before it kills", () => {
  const lifecycle = (tmux: FakeTmux) => ({ tmux: tmux.run, sleep: async () => {}, pidAlive: tmux.pidAlive, selfPid: SELF, homes: fakeHomes().homes })

  test("reaps only this server's and dead servers' sessions — never another LIVE server's", async () => {
    const tmux = new FakeTmux(sim())
    tmux.livePids.add(7777) // another companion server, alive
    tmux.addSession(`cc-scrape-${SELF}-9-mine`, "%60", "/dev/ttys060", 9100)
    tmux.addSession("cc-scrape-7777-1-live", "%61", "/dev/ttys061", 9101)
    tmux.addSession("cc-scrape-6666-1-dead", "%62", "/dev/ttys062", 9102)
    const reaped = await reapScrapeSessions(lifecycle(tmux))
    expect(reaped.sort()).toEqual(["cc-scrape-4242-9-mine", "cc-scrape-6666-1-dead"])
    expect(tmux.sessions.has("cc-scrape-7777-1-live")).toBe(true)
    // …but still hidden from this server's picker.
    expect(isScrapeTarget({ tmuxPane: "%61" })).toBe(true)
    expect(isScrapeTarget({ tty: "/dev/ttys061" })).toBe(true)
  })

  test("startup: every orphan pane/tty is registered hidden BEFORE any kill is sent", async () => {
    const tmux = new FakeTmux(sim())
    tmux.addSession("cc-scrape-6666-1-orph", "%70", "/dev/ttys070", 9200)
    tmux.addSession("cc-scrape-6666-2-orph", "%71", "/dev/ttys071", 9201)
    const seenAtKill: boolean[] = []
    const orig = tmux.run
    tmux.run = async (args) => {
      if (args[0] === "kill-session") seenAtKill.push(isScrapeTarget({ tmuxPane: "%70", tty: "" }) && isScrapeTarget({ tty: "/dev/ttys071" }))
      return orig(args)
    }
    await reapScrapeSessions(lifecycle(tmux))
    expect(seenAtKill.length).toBeGreaterThan(0)
    expect(seenAtKill.every(Boolean)).toBe(true)
  })

  test("startup: a failed kill is retained (tracked + marked) and retried until confirmed", async () => {
    const tmux = new FakeTmux(sim(), { unkillable: { count: 5 } })
    tmux.addSession("cc-scrape-6666-3-orph", "%72", "/dev/ttys072", 9202)
    await reapScrapeSessions({ ...lifecycle(tmux), timing: { killAttempts: 2 } })
    expect(pendingKills()).toEqual(["cc-scrape-6666-3-orph"])
    expect(isScrapeTarget({ tmuxPane: "%72" })).toBe(true)
    await reapScrapeSessions(lifecycle(tmux))
    expect(pendingKills()).toEqual([])
    expect(tmux.sessions.has("cc-scrape-6666-3-orph")).toBe(false)
  })

  test("scrapeSessionOwner parses the pid, and only from a real scrape name", () => {
    expect(scrapeSessionOwner("cc-scrape-4242-3-ab12")).toBe(4242)
    expect(scrapeSessionOwner("cc-scrape-tool")).toBeNull()
    expect(scrapeSessionOwner("cc-myproject")).toBeNull()
  })
})

// ── Revision 3 findings ────────────────────────────────────────────────────

describe("finding 4: the 50s budget covers the WHOLE request", () => {
  const ok = (n: number): OffPaneResult => ({ status: "ok", rowsPerPage: 17, session: "s", commands: Array.from({ length: n }, (_, i) => ({ name: `/c${i}`, description: "", kind: "default" as const })) })

  test("a slow prepare (tmux env / --version / fingerprint walk) alone answers pending at waitMs", async () => {
    let enumerated = 0
    const l = createCommandLister({
      prepare: async () => { await Bun.sleep(80); return { fingerprint: "v", enumerate: async () => { enumerated++; return ok(1) } } },
      waitMs: 20,
    })
    const t0 = performance.now()
    const { result } = await l.list("/p")
    expect(result.status).toBe("pending")
    expect(performance.now() - t0).toBeLessThan(70)
    await Bun.sleep(100)
    expect(enumerated).toBe(1) // it still runs and caches in the background
  })

  test("prepare + enumeration share one clock: neither alone exceeds waitMs, together they do → pending", async () => {
    const l = createCommandLister({
      prepare: async () => { await Bun.sleep(30); return { fingerprint: "v", enumerate: async () => { await Bun.sleep(30); return ok(1) } } },
      waitMs: 45,
    })
    const t0 = performance.now()
    const { result } = await l.list("/p")
    expect(result.status).toBe("pending")
    expect(performance.now() - t0).toBeLessThan(58)
  })

  test("a prepare that throws is an immediate error, not a wait", async () => {
    const l = createCommandLister({ prepare: async () => { throw new Error("boom") }, waitMs: 5_000 })
    const { result } = await l.list("/p")
    expect(result.status).toBe("error")
    expect(result.detail).toBe("boom")
  })
})

describe("finding 5: negative cache per status, transient capture retry", () => {
  test("a timeout is remembered for 2 min (not 10): same shape, no new claude, then one retry", async () => {
    let t = 0
    let runs = 0
    const l = createCommandLister({
      prepare: async () => ({ fingerprint: "v", enumerate: async () => { runs++; return { status: "timeout", commands: [], rowsPerPage: 0, session: "s", detail: "boot: timeout" } } }),
      now: () => t,
    })
    expect((await l.list("/p")).result.status).toBe("timeout")
    t += 90_000
    const again = await l.list("/p")
    expect(again.result.status).toBe("timeout")
    expect(again.result.detail).toContain("remembered")
    expect(runs).toBe(1)
    t += 60_000 // 2.5 min
    await l.list("/p")
    expect(runs).toBe(2)
  })

  test("wizard/error stay remembered past 2 min (10 min TTL)", async () => {
    let t = 0
    let runs = 0
    const l = createCommandLister({
      prepare: async () => ({ fingerprint: "v", enumerate: async () => { runs++; return { status: "wizard", commands: [], rowsPerPage: 0, session: "s" } } }),
      now: () => t,
    })
    await l.list("/p")
    t += 5 * 60_000
    await l.list("/p")
    expect(runs).toBe(1)
  })

  test("ONE failed capture mid-scrape is retried and the list completes (cacheable ok)", async () => {
    for (const at of [3, 6, 9, 15, 25]) {
      const tmux = new FakeTmux(sim(5), { failCaptureAt: at })
      const res = await run(tmux)
      expect(res.status).toBe("ok")
      expect(res.commands).toHaveLength(DEFAULTS.length + CUSTOMS.length)
      expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
    }
  })

  test("two failed captures in a row is still an error (never an empty page)", async () => {
    const tmux = new FakeTmux(sim(5), { failCaptureAfter: 8 })
    const res = await run(tmux)
    expect(res.status).toBe("error")
    expect(res.commands).toEqual([])
  })
})

describe("finding 6: claude too old for the throwaway HOME's credentials", () => {
  test("versionAtLeast", () => {
    expect(versionAtLeast("2.1.284 (Claude Code)", "2.1.284")).toBe(true)
    expect(versionAtLeast("2.1.290 (Claude Code)", "2.1.284")).toBe(true)
    expect(versionAtLeast("2.2.0", "2.1.284")).toBe(true)
    expect(versionAtLeast("2.1.281 (Claude Code)", "2.1.284")).toBe(false)
    expect(versionAtLeast("1.9.999", "2.1.284")).toBe(false)
    expect(versionAtLeast("unknown", "2.1.284")).toBe(false)
  })

  test("Linux < 2.1.284 (or unreadable) is refused; macOS default config dir is not affected", () => {
    const l = { bin: "/usr/bin/claude", configDirExplicit: false }
    expect(secureStorageProblem(l, "2.1.281 (Claude Code)", "linux")).toContain("update claude to ≥2.1.284 for off-pane command list")
    expect(secureStorageProblem(l, "unknown", "linux")).not.toBeNull()
    expect(secureStorageProblem(l, "2.1.284 (Claude Code)", "linux")).toBeNull()
    expect(secureStorageProblem(l, "2.1.200 (Claude Code)", "darwin")).toBeNull()
    // macOS with CLAUDE_CONFIG_DIR relies on the same variable (keychain item name).
    expect(secureStorageProblem({ ...l, configDirExplicit: true }, "2.1.281 (Claude Code)", "darwin")).not.toBeNull()
  })

  test("prepare refuses up front — nothing to spawn — and warns ONCE, however often the phone asks", async () => {
    const logs: string[] = []
    const launch = { ...LAUNCH, bin: "/zettlab/claude-old" }
    const deps = { platform: "linux" as const, launch: async () => launch, version: async () => "2.1.281 (Claude Code)", log: (m: string) => logs.push(m) }
    for (let i = 0; i < 3; i++) {
      const prep = await prepareRealList("/p", deps)
      expect("error" in prep && prep.status).toBe("unsupported")
      expect("enumerate" in prep).toBe(false)
    }
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("update claude to ≥2.1.284 for off-pane command list")
  })

  test("the lister answers `unsupported` at once (the route maps it to the same 409 aborted shape)", async () => {
    let enumerated = 0
    const l = createCommandLister({ prepare: async () => ({ error: "too old", status: "unsupported" as const }) })
    const { cached, result } = await l.list("/p")
    expect(cached).toBe(false)
    expect(result.status).toBe("unsupported")
    expect(result.commands).toEqual([])
    expect(enumerated).toBe(0)
  })
})
