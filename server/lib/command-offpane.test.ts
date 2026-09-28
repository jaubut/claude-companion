import { afterEach, describe, expect, test } from "bun:test"
import {
  createCommandLister, enumerateCommandsOffPane, fingerprintRoots, paneBlockedByWizard, reapScrapeSessions,
  type OffPaneResult, type TmuxResult,
} from "./command-offpane"
import { isScrapeTarget, resetScrapeRegistry, SCRAPE_SESSION_PREFIX } from "./scrape-registry"
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

class FakeTmux {
  sessions = new Map<string, { pane: string; tty: string; sim: SimClaude | null }>()
  calls: string[][] = []
  nextPane = 10
  constructor(readonly spawnSim: () => SimClaude, opts: { failNewSession?: boolean; throwOnCapture?: boolean } = {}) {
    this.opts = opts
    this.sessions.set("cc-user", { pane: "%1", tty: "/dev/ttys007", sim: null })
  }
  opts: { failNewSession?: boolean; throwOnCapture?: boolean }

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
      return { code: this.sessions.delete(name) ? 0 : 1, stdout: "" }
    }
    if (cmd === "capture-pane") {
      if (this.opts.throwOnCapture) throw new Error("tmux exploded")
      const sim = this.paneSim(args[args.indexOf("-t") + 1]!)
      if (sim === undefined) return { code: 1, stdout: "" }
      return { code: 0, stdout: sim ? sim.render() : "❯ user is typing here" }
    }
    if (cmd === "send-keys") {
      const target = args[2]!
      const sim = this.paneSim(target)
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

function run(tmux: FakeTmux, timing: Record<string, number> = {}) {
  const c = clock()
  let n = 0
  return enumerateCommandsOffPane("/Users/me/proj", {
    tmux: tmux.run, sleep: c.sleep, now: c.now, timing, sessionName: () => `${SCRAPE_SESSION_PREFIX}test-${++n}`,
  })
}

afterEach(() => resetScrapeRegistry())

describe("enumerateCommandsOffPane", () => {
  test("reads the whole list from a hidden session — ZERO keystrokes reach the user's pane", async () => {
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17))
    const res = await run(tmux)

    expect(res.status).toBe("ok")
    expect(res.commands.filter((c) => c.kind === "default").map((c) => c.name)).toEqual(DEFAULTS)
    expect(res.commands.filter((c) => c.kind === "custom").map((c) => c.name)).toEqual(CUSTOMS)
    expect(res.rowsPerPage).toBe(17)

    // Acceptance (1): the send-keys spy never saw the user's pane, and never
    // read it either.
    expect(tmux.keysTo("%1")).toEqual([])
    expect(tmux.calls.some((c) => c.includes("%1"))).toBe(false)
    // Every key went to the hidden pane.
    const sends = tmux.calls.filter((c) => c[0] === "send-keys")
    expect(sends.length).toBeGreaterThan(0)
    expect(new Set(sends.map((c) => c[2]))).toEqual(new Set(["%10"]))
  })

  test("hidden session: cc-scrape-* name, 220x60, same cwd, COMPANION_SCRAPE=1, pane id printed", async () => {
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17))
    await run(tmux)
    const create = tmux.calls.find((c) => c[0] === "new-session")!
    expect(create).toContain("-d")
    expect(create[create.indexOf("-s") + 1]!.startsWith("cc-scrape-")).toBe(true)
    expect(create[create.indexOf("-x") + 1]).toBe(String(DETACHED_COLS))
    expect(create[create.indexOf("-y") + 1]).toBe(String(DETACHED_ROWS))
    expect(create[create.indexOf("-F") + 1]).toBe("#{pane_id} #{pane_tty}")
    const inner = create.at(-1)!
    expect(inner).toBe("export COMPANION_SCRAPE=1; cd '/Users/me/proj' && claude")
  })

  // Acceptance (3): no orphans after success, timeout, error.
  test("kills the hidden session after success", async () => {
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17))
    await run(tmux)
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("kills the hidden session on a boot timeout", async () => {
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17, { bootCaptures: 1_000_000 }))
    const res = await run(tmux, { bootTimeoutMs: 5_000 })
    expect(res.status).toBe("timeout")
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
    expect(tmux.keysTo("%10")).toEqual([])
  })

  test("kills the hidden session when the paging deadline hits mid-list, and reports partial", async () => {
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 5))
    const res = await run(tmux, { deadlineMs: 12_000 })
    expect(res.status).toBe("timeout")
    expect(res.commands.length).toBeGreaterThan(0)
    expect(res.commands.length).toBeLessThan(DEFAULTS.length + CUSTOMS.length)
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("kills the hidden session when tmux throws", async () => {
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17), { throwOnCapture: true })
    const res = await run(tmux)
    expect(res.status).toBe("error")
    expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
  })

  test("a failed new-session is an error, not a hang", async () => {
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17), { failNewSession: true })
    const res = await run(tmux)
    expect(res.status).toBe("error")
  })

  test("first-run wizard / trust dialog: bails without pressing anything", async () => {
    for (const screen of [
      "Welcome to Claude Code\n\nChoose the text style that looks best with your terminal",
      "Do you trust the files in this folder?\n\n❯ 1. Yes, proceed",
      "Select login method:\n ❯ 1. Claude account with subscription",
      "New MCP server found in .mcp.json: foo\nSelect any you wish to enable.",
    ]) {
      const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17, { screen }))
      const res = await run(tmux)
      expect(res.status).toBe("wizard")
      expect(res.commands).toEqual([])
      expect(tmux.calls.filter((c) => c[0] === "send-keys")).toEqual([])
      expect([...tmux.sessions.keys()]).toEqual(["cc-user"])
    }
  })

  test("the hidden pane/tty is registered while live, so hooks from it are dropped", async () => {
    let seenDuring = false
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17))
    const orig = tmux.run
    tmux.run = async (args) => {
      if (args[0] === "capture-pane") seenDuring ||= isScrapeTarget({ tmuxPane: "%10" })
      return orig(args)
    }
    await enumerateCommandsOffPane("/x", { tmux: tmux.run, ...clock(), sessionName: () => "cc-scrape-t" })
    expect(seenDuring).toBe(true)
    // After the kill the pane stays marked (late SessionEnd), the user's never is.
    expect(isScrapeTarget({ tmuxPane: "%10" })).toBe(true)
    expect(isScrapeTarget({ tmuxPane: "%1", tty: "/dev/ttys007" })).toBe(false)
  })
})

describe("reapScrapeSessions", () => {
  test("kills leftover cc-scrape-* sessions and nothing else", async () => {
    const tmux = new FakeTmux(() => new SimClaude({ default: [], custom: [] }, 17))
    tmux.sessions.set("cc-scrape-999-1", { pane: "%50", tty: "", sim: null })
    tmux.sessions.set("cc-myproject", { pane: "%51", tty: "", sim: null })
    const reaped = await reapScrapeSessions(tmux.run)
    expect(reaped).toEqual(["cc-scrape-999-1"])
    expect([...tmux.sessions.keys()].sort()).toEqual(["cc-myproject", "cc-user"])
  })
})

describe("hidden session never reaches the picker (acceptance 4)", () => {
  test("a scrape pane or tty is recognised while live (ps-discovery skips it); a real session is not", async () => {
    let checked = false
    const tmux = new FakeTmux(() => new SimClaude({ default: DEFAULTS, custom: CUSTOMS }, 17))
    const orig = tmux.run
    tmux.run = async (args) => {
      if (args[0] === "capture-pane" && !checked) {
        checked = true
        // What SessionStart (pane header) / ps-discovery (bare tty) would carry.
        expect(isScrapeTarget({ tmuxPane: "%10" })).toBe(true)
        expect(isScrapeTarget({ tty: "ttys011" })).toBe(true)
        expect(isScrapeTarget({ tty: "/dev/ttys011" })).toBe(true)
      }
      return orig(args)
    }
    await enumerateCommandsOffPane("/x", { tmux: tmux.run, ...clock(), sessionName: () => "cc-scrape-t" })
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
})

describe("createCommandLister", () => {
  const ok = (n: number): OffPaneResult => ({
    status: "ok", rowsPerPage: 17, session: "s",
    commands: Array.from({ length: n }, (_, i) => ({ name: `/c${i}`, description: "", kind: "default" as const })),
  })

  test("caches on the fingerprint: same fingerprint → no re-run; changed → re-run", async () => {
    let fp = "v1"
    let runs = 0
    const lister = createCommandLister({ enumerate: async () => { runs++; return ok(3) }, fingerprint: async () => fp })
    expect((await lister.list("/p")).cached).toBe(false)
    expect((await lister.list("/p")).cached).toBe(true)
    expect(runs).toBe(1)
    fp = "v2" // a skill was added / claude updated
    expect((await lister.list("/p")).cached).toBe(false)
    expect(runs).toBe(2)
  })

  test("force bypasses the cache", async () => {
    let runs = 0
    const lister = createCommandLister({ enumerate: async () => { runs++; return ok(3) }, fingerprint: async () => "v" })
    await lister.list("/p")
    await lister.list("/p", { force: true })
    expect(runs).toBe(2)
  })

  test("never caches incomplete / wizard / timeout", async () => {
    for (const status of ["incomplete", "wizard", "timeout", "error"] as const) {
      let runs = 0
      const lister = createCommandLister({
        enumerate: async () => { runs++; return { ...ok(3), status } },
        fingerprint: async () => "v",
      })
      await lister.list("/p")
      await lister.list("/p")
      expect(runs).toBe(2)
    }
  })

  test("concurrent callers share one hidden claude", async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const lister = createCommandLister({
      enumerate: async () => { runs++; await gate; return ok(5) },
      fingerprint: async () => "v",
    })
    const a = lister.list("/p")
    const b = lister.list("/p")
    await Promise.resolve(); await Promise.resolve()
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(runs).toBe(1)
    expect(ra.result.commands).toHaveLength(5)
    expect(rb.result.commands).toHaveLength(5)
  })

  test("different cwds run one at a time", async () => {
    let live = 0, peak = 0
    const lister = createCommandLister({
      enumerate: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return ok(1) },
      fingerprint: async (cwd) => cwd,
    })
    await Promise.all([lister.list("/a"), lister.list("/b"), lister.list("/c")])
    expect(peak).toBe(1)
  })
})

describe("fingerprint + wizard detection", () => {
  test("fingerprint covers global and project skill/command roots", () => {
    const roots = fingerprintRoots("/p", "/h")
    expect(roots).toContain("/h/.claude/skills")
    expect(roots).toContain("/h/.claude/commands")
    expect(roots).toContain("/p/.claude")
  })

  test("a normal prompt is not a wizard", () => {
    expect(paneBlockedByWizard("╭─ Welcome back ─╮\n❯ \n? for shortcuts")).toBe(false)
  })
})
