import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildScrapeInner, createCommandLister, enumerateCommandsOffPane, paneBlockedByWizard, pendingKills,
  reapScrapeSessions, removeTranscriptFile, resetOffPaneState, type OffPaneResult,
} from "./command-offpane"
import {
  computeFingerprint, fingerprintEntries, parseTmuxEnv, resolveClaudeLaunch, type ClaudeLaunch, type TmuxResult,
} from "./command-offpane-launch"
import { isScrapeSessionName, isScrapeTarget, resetScrapeRegistry, scrapeSessionName } from "./scrape-registry"
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
    opts: { bootCaptures?: number; screen?: string } = {},
  ) {
    this.bootCaptures = opts.bootCaptures ?? 2
    this.screen = opts.screen
  }
  screen?: string

  render(): string {
    if (this.bootCaptures > 0) { this.bootCaptures--; return "" }
    if (this.screen) return this.screen
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
    if (!this.overlay) {
      if (k === "Enter" && this.typed === "/help") { this.overlay = "general"; this.typed = ""; this.cursor = 0; this.top = 0 }
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
  failSendKey?: string               // send-keys carrying this key exits 1
  unkillable?: { count?: number }    // kill-session "succeeds" but the session survives (count times)
}

class FakeTmux {
  sessions = new Map<string, { pane: string; tty: string; sim: SimClaude | null }>()
  calls: string[][] = []
  nextPane = 10
  captures = 0
  constructor(readonly spawnSim: () => SimClaude, opts: FakeOpts = {}) {
    this.opts = opts
    this.sessions.set("cc-user", { pane: "%1", tty: "/dev/ttys007", sim: null })
  }
  opts: FakeOpts

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
      this.sessions.set(name, { pane, tty: `/dev/ttys0${this.nextPane}`, sim: this.spawnSim() })
      return { code: 0, stdout: `${pane} /dev/ttys0${this.nextPane}\n` }
    }
    if (cmd === "list-sessions") return { code: 0, stdout: [...this.sessions.keys()].join("\n") + "\n" }
    if (cmd === "kill-session") {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "")
      if (this.opts.unkillable && (this.opts.unkillable.count ?? Infinity) > 0) {
        this.opts.unkillable.count = (this.opts.unkillable.count ?? Infinity) - 1
        return { code: 0, stdout: "" }
      }
      return { code: this.sessions.delete(name) ? 0 : 1, stdout: "" }
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
const LAUNCH: ClaudeLaunch = { bin: "/opt/claude/bin/claude", env: { PATH: "/usr/bin:/bin" }, configDir: "/h/.claude" }

let n = 0
const names = () => `cc-scrape-4242-${++n}-test`

function run(tmux: FakeTmux, timing: Record<string, number> = {}, extra: { removed?: string[] } = {}) {
  const c = clock()
  return enumerateCommandsOffPane("/Users/me/proj", {
    tmux: tmux.run, sleep: c.sleep, now: c.now, timing, launch: LAUNCH, sessionName: names,
    sessionId: () => "11111111-2222-3333-4444-555555555555",
    removeTranscript: async (dir, id) => { extra.removed?.push(`${dir}/${id}`) },
  })
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

  test("hidden session: cc-scrape-* name, 220x60, same cwd, hooks+MCP off, scrape env, pinned binary", async () => {
    const tmux = new FakeTmux(sim())
    await run(tmux)
    const create = tmux.calls.find((c) => c[0] === "new-session")!
    expect(create).toContain("-d")
    expect(isScrapeSessionName(create[create.indexOf("-s") + 1]!)).toBe(true)
    expect(create[create.indexOf("-x") + 1]).toBe(String(DETACHED_COLS))
    expect(create[create.indexOf("-y") + 1]).toBe(String(DETACHED_ROWS))
    expect(create[create.indexOf("-F") + 1]).toBe("#{pane_id} #{pane_tty}")
    expect(create.at(-1)).toBe(buildScrapeInner("/Users/me/proj", LAUNCH, "11111111-2222-3333-4444-555555555555"))
  })

  test("the launch line disables hooks and MCP, exports both scrape vars, and execs the resolved binary", () => {
    const inner = buildScrapeInner("/Users/me/it's", { bin: "/x/claude", env: { PATH: "/a:/b", CLAUDE_CONFIG_DIR: "/cfg dir" }, configDir: "/cfg dir" }, "abc")
    expect(inner).toBe(
      "export COMPANION_SCRAPE=1; export CLAUDE_CODE_SCRAPE_SESSION=1; export DISABLE_AUTOUPDATER=1; "
      + "export PATH='/a:/b'; export CLAUDE_CONFIG_DIR='/cfg dir'; "
      + "cd '/Users/me/it'\\''s' && exec '/x/claude' --strict-mcp-config --mcp-config '{\"mcpServers\":{}}' "
      + "--settings '{\"disableAllHooks\":true}' --session-id 'abc'",
    )
  })

  // Acceptance (3): no orphans after success, timeout, error.
  test("kills the hidden session after success, confirmed with has-session, and cleans its transcript", async () => {
    const removed: string[] = []
    const tmux = new FakeTmux(sim())
    await run(tmux, {}, { removed })
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
    expect(tmux.calls.some((c) => c[0] === "has-session")).toBe(true)
    expect(removed).toEqual(["/h/.claude/11111111-2222-3333-4444-555555555555"])
    expect(pendingKills()).toEqual([])
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
    const c = clock()
    const t0 = c.now()
    const res = await enumerateCommandsOffPane("/p", { tmux: tmux.run, ...c, launch: LAUNCH, sessionName: names, removeTranscript: async () => {} })
    expect(res.status).toBe("error")
    expect(res.detail).toContain("never came up")
    expect(c.now() - t0).toBeLessThan(2_000)
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
    await reapScrapeSessions(tmux.run, async () => {})
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
    await enumerateCommandsOffPane("/x", { tmux: tmux.run, ...clock(), launch: LAUNCH, sessionName: names, removeTranscript: async () => {} })
    expect(seenDuring).toBe(true)
    // After the kill the pane stays marked (late SessionEnd), the user's never is.
    expect(isScrapeTarget({ tmuxPane: "%10" })).toBe(true)
    expect(isScrapeTarget({ tmuxPane: "%1", tty: "/dev/ttys007" })).toBe(false)
  })
})

describe("reapScrapeSessions", () => {
  test("kills leftover cc-scrape-* sessions and nothing else — not even a project named scrape-*", async () => {
    const tmux = new FakeTmux(sim())
    tmux.sessions.set("cc-scrape-999-1-ab12", { pane: "%50", tty: "", sim: null })
    tmux.sessions.set("cc-scrape-tool", { pane: "%52", tty: "", sim: null }) // user spawn in ~/scrape-tool
    tmux.sessions.set("cc-myproject", { pane: "%51", tty: "", sim: null })
    const reaped = await reapScrapeSessions(tmux.run, async () => {})
    expect(reaped).toEqual(["cc-scrape-999-1-ab12"])
    expect([...tmux.sessions.keys()].sort()).toEqual(["cc-myproject", "cc-scrape-tool", "cc-user"])
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
    await enumerateCommandsOffPane("/x", { tmux: tmux.run, ...clock(), launch: LAUNCH, sessionName: names, removeTranscript: async () => {} })
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

  test("resolves on the tmux SERVER's PATH and passes CLAUDE_CONFIG_DIR through", async () => {
    const tmux = async () => ({ code: 0, stdout: "PATH=/tmuxbin:/usr/bin\nCLAUDE_CONFIG_DIR=/cfg\n-REMOVED\n" })
    const launch = await resolveClaudeLaunch({
      tmux, which: whichIn({ "/tmuxbin": "/tmuxbin/claude", "/procbin": "/procbin/claude" }),
      processEnv: { PATH: "/procbin" }, home: "/h",
    })
    expect(launch).toEqual({ bin: "/tmuxbin/claude", env: { PATH: "/tmuxbin:/usr/bin", CLAUDE_CONFIG_DIR: "/cfg" }, configDir: "/cfg" })
  })

  test("no tmux server yet: falls back to the process env (what new-session would inherit)", async () => {
    const launch = await resolveClaudeLaunch({
      tmux: async () => ({ code: 1, stdout: "" }), which: whichIn({ "/procbin": "/procbin/claude" }),
      processEnv: { PATH: "/procbin" }, home: "/h",
    })
    expect(launch?.bin).toBe("/procbin/claude")
    expect(launch?.configDir).toBe("/h/.claude")
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

  test("never caches incomplete / wizard / timeout / error, nor an empty ok", async () => {
    for (const [status, count] of [["incomplete", 3], ["wizard", 0], ["timeout", 3], ["error", 0], ["ok", 0]] as const) {
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
    return { cfg, cwd, launch: { bin: "/b/claude", env: {}, configDir: cfg } as ClaudeLaunch }
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

  test("removeTranscriptFile deletes exactly <configDir>/projects/*/<id>.jsonl", async () => {
    const { cfg } = tree()
    const dir = join(cfg, "projects", "-Users-me")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "abc.jsonl"), "{}")
    writeFileSync(join(dir, "other.jsonl"), "{}")
    await removeTranscriptFile(cfg, "abc")
    const { readdirSync } = await import("node:fs")
    expect(readdirSync(dir)).toEqual(["other.jsonl"])
  })
})

describe("wizard detection", () => {
  test("a normal prompt is not a wizard", () => {
    expect(paneBlockedByWizard("╭─ Welcome back ─╮\n❯ \n? for shortcuts")).toBe(false)
  })
})
