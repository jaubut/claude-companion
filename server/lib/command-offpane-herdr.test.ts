import { afterEach, test, expect } from "bun:test"
import { herdrScrapeRunner, resetHerdrScrapes } from "./command-offpane-herdr"
import { fakeHerdr } from "./herdr-fake.test-util"
import { resolveClaudeLaunch } from "./command-offpane-launch"
import { killScrapeSession } from "./command-offpane"
import { SCRAPE_PANE_MARK, SHELL_PANE_MARK } from "./herdr"
import { readHerdrShells } from "./shell-sessions"

afterEach(() => resetHerdrScrapes())

const NAME = "cc-scrape-123-1-abcd"
const created = { workspace: { workspace_id: "w4" }, root_pane: { pane_id: "w4:p1", terminal_id: "term_4" } }
const NEW = ["new-session", "-d", "-P", "-F", "fmt", "-x", "220", "-y", "60", "-s", NAME, "/bin/sh", "-c", "exec claude"]
const notFound = () => { throw Object.assign(new Error("pane_not_found"), { code: "pane_not_found" }) }

// A scrape's pane as herdr describes it; `pane` returns what `pane get` says it
// holds now (a throw = herdr can't say), `count` the workspace's pane count.
function scrapePane(o: { pane?: () => Record<string, unknown>; count?: () => number; pid?: () => number } = {}) {
  const pane = o.pane ?? (() => ({ pane_id: "w4:p1", workspace_id: "w4", terminal_id: "term_4", label: SCRAPE_PANE_MARK }))
  return fakeHerdr({
    reply: (a) => {
      if (a[1] === "create") return created
      if (a[0] === "pane" && a[1] === "get") return { pane: pane() }
      if (a[1] === "process-info") return { process_info: { shell_pid: (o.pid ?? (() => 77))() } }
      if (a[0] === "workspace" && a[1] === "get") return { workspace: { workspace_id: "w4", label: NAME, pane_count: (o.count ?? (() => 1))() } }
      if (a[0] === "workspace" && a[1] === "list") return { workspaces: [] }
      return {}
    },
  })
}
const writes = (calls: string[][]) => calls.filter((c) => c[0] === "pane" && ["run", "send-text", "send-keys", "close"].includes(c[1]!) || c[0] === "workspace" && c[1] === "close")

test("new-session: an unfocused workspace, its pane marked, the command typed with a leading space, tmux's print format", async () => {
  const f = scrapePane()
  const r = await herdrScrapeRunner(f.h)(["new-session", "-d", "-P", "-F", "fmt", "-x", "220", "-y", "60", "-s", NAME, "/bin/sh", "-c", "cd /x && exec claude"])
  expect(r).toEqual({ code: 0, stdout: "w4:p1||77|\n" })
  expect(f.calls[0]).toEqual(["workspace", "create", "--cwd", "/tmp", "--label", NAME, "--no-focus"])
  expect(f.calls).toContainEqual(["pane", "rename", "w4:p1", SCRAPE_PANE_MARK])
  expect(f.calls.at(-1)).toEqual(["pane", "run", "w4:p1", " cd /x && exec claude"])
})

test("new-session: no terminal or workspace id to prove ownership with counts as a failure", async () => {
  for (const reply of [{ workspace: { workspace_id: "w4" }, root_pane: { pane_id: "w4:p1" } }, { root_pane: { pane_id: "w4:p1", terminal_id: "term_4" } }]) {
    const f = fakeHerdr({ reply: (a) => a[1] === "create" ? reply : {} })
    expect((await herdrScrapeRunner(f.h)(NEW)).code).toBe(-1)
    expect(writes(f.calls)).toEqual([])
  }
})

test("new-session: the id reused before the command is typed, or herdr can't say: nothing typed", async () => {
  for (const pane of [() => ({ pane_id: "w4:p1", workspace_id: "w4", terminal_id: "term_human", label: "" }), notFound, () => { throw new Error("down") }]) {
    const f = scrapePane({ pane })
    expect((await herdrScrapeRunner(f.h)(NEW)).code).not.toBe(0)
    expect(writes(f.calls)).toEqual([])
  }
})

test("new-session: an unreadable pid launches nothing (a claude must never run without one)", async () => {
  const f = scrapePane({ pid: () => 0 })
  expect((await herdrScrapeRunner(f.h)(NEW)).code).toBe(-1)
  expect(writes(f.calls)).toEqual([])
})

test("capture-pane: the screen, or a miss when unreadable", async () => {
  const f = scrapePane()
  const run = herdrScrapeRunner(f.h, async (p) => (p === "w4:p1" ? "screen" : null))
  await run(NEW)
  expect(await run(["capture-pane", "-p", "-t", "w4:p1"])).toEqual({ code: 0, stdout: "screen" })
  expect((await run(["capture-pane", "-p", "-t", "w9:p1"])).code).toBe(1)
})

test("a reused pane id: no read and no keystroke reaches the new owner", async () => {
  let terminal = "term_4"
  const f = scrapePane({ pane: () => ({ pane_id: "w4:p1", workspace_id: "w4", terminal_id: terminal, label: SCRAPE_PANE_MARK }) })
  let reads = 0
  const run = herdrScrapeRunner(f.h, async () => { reads++; return "their screen" })
  await run(NEW)
  f.calls.length = 0
  terminal = "term_human"
  expect((await run(["capture-pane", "-p", "-t", "w4:p1"])).code).toBe(1)
  expect((await run(["send-keys", "-t", "w4:p1", "-l", "/help"])).code).toBe(1)
  expect(reads).toBe(0)
  expect(writes(f.calls)).toEqual([])
})

test("ownership needs the mark, the terminal and the workspace: a shell pane or a moved pane is not ours", async () => {
  for (const other of [{ label: SHELL_PANE_MARK }, { label: "" }, { workspace_id: "w9" }]) {
    let now: Record<string, unknown> = {}
    const f = scrapePane({ pane: () => ({ pane_id: "w4:p1", workspace_id: "w4", terminal_id: "term_4", label: SCRAPE_PANE_MARK, ...now }) })
    const run = herdrScrapeRunner(f.h)
    await run(NEW)
    f.calls.length = 0
    now = other
    expect((await run(["send-keys", "-t", "w4:p1", "Enter"])).code).toBe(1)
    expect(writes(f.calls)).toEqual([])
  }
})

test("a mismatch is final: the old terminal answering again gets nothing", async () => {
  let terminal = "term_4"
  const f = scrapePane({ pane: () => ({ pane_id: "w4:p1", workspace_id: "w4", terminal_id: terminal, label: SCRAPE_PANE_MARK }) })
  const run = herdrScrapeRunner(f.h)
  await run(NEW)
  terminal = "term_human"
  expect((await run(["send-keys", "-t", "w4:p1", "Down"])).code).toBe(1)
  terminal = "term_4"
  f.calls.length = 0
  expect((await run(["send-keys", "-t", "w4:p1", "Down"])).code).toBe(1)
  expect((await run(["kill-session", "-t", `=${NAME}`])).code).toBe(0)
  expect(writes(f.calls)).toEqual([])
})

test("herdr can't say whose pane it is: unknown (-1), no write, and the scrape stays ours", async () => {
  let down = false
  const f = scrapePane({ pane: () => { if (down) throw new Error("down"); return { pane_id: "w4:p1", workspace_id: "w4", terminal_id: "term_4", label: SCRAPE_PANE_MARK } } })
  const run = herdrScrapeRunner(f.h)
  await run(NEW)
  f.calls.length = 0
  down = true
  expect((await run(["send-keys", "-t", "w4:p1", "Down"])).code).toBe(-1)
  expect((await run(["has-session", "-t", `=${NAME}`])).code).toBe(-1)
  expect(writes(f.calls)).toEqual([])
  down = false
  expect((await run(["send-keys", "-t", "w4:p1", "Down"])).code).toBe(0)
})

test("send-keys: a named key, or -l literal text", async () => {
  const f = scrapePane()
  const run = herdrScrapeRunner(f.h)
  await run(NEW)
  f.calls.length = 0
  expect((await run(["send-keys", "-t", "w4:p1", "Down"])).code).toBe(0)
  expect((await run(["send-keys", "-t", "w4:p1", "C-u"])).code).toBe(0)
  expect((await run(["send-keys", "-t", "w4:p1", "-l", "/help"])).code).toBe(0)
  expect(writes(f.calls)).toEqual([["pane", "send-keys", "w4:p1", "down"], ["pane", "send-keys", "w4:p1", "ctrl+u"], ["pane", "send-text", "w4:p1", "/help"]])
})

test("kill + has-session: closes our workspace, gone is code 1, a herdr failure proves nothing", async () => {
  const gone = () => f.calls.some((c) => c[1] === "close")
  const f = scrapePane({ pane: () => gone() ? notFound() : { pane_id: "w4:p1", workspace_id: "w4", terminal_id: "term_4", label: SCRAPE_PANE_MARK } })
  const run = herdrScrapeRunner(f.h)
  await run(NEW)
  f.calls.length = 0
  expect(await killScrapeSession(run, NAME, async () => {})).toBe(true)
  expect(writes(f.calls)).toEqual([["workspace", "close", "w4"]])
  const down = fakeHerdr({ reply: () => { throw new Error("down") } })
  expect((await herdrScrapeRunner(down.h)(["has-session", "-t", `=${NAME}`])).code).toBe(-1)
})

test("kill: a human split in the scrape's workspace survives, only our pane closes", async () => {
  const f = scrapePane({ count: () => 2 })
  const run = herdrScrapeRunner(f.h)
  await run(NEW)
  f.calls.length = 0
  await run(["kill-session", "-t", `=${NAME}`])
  expect(writes(f.calls)).toEqual([["pane", "close", "w4:p1"]])
})

test("kill: a workspace with the scrape's label that is not ours is never closed, and never reads as gone", async () => {
  // Nothing recorded (a failed create, a restart): the label alone proves nothing.
  const f = fakeHerdr({ reply: () => ({ workspaces: [{ workspace_id: "w4", label: NAME, pane_count: 1 }], panes: [{ workspace_id: "w4", pane_id: "w4:p1", terminal_id: "term_x", label: "" }] }) })
  expect(await killScrapeSession(herdrScrapeRunner(f.h), NAME, async () => {}, 2, 0)).toBe(false)
  expect(writes(f.calls)).toEqual([])
})

const listing = (panes: Array<Record<string, unknown>>, workspaces = [{ workspace_id: "w4", label: NAME, pane_count: panes.filter((p) => p.workspace_id === "w4").length }, { workspace_id: "w1", label: "brain", pane_count: 1 }]) =>
  (a: string[]) => a[1] === "process-info" ? { process_info: { shell_pid: 77 } } : a[1] === "list" ? { workspaces, panes } : {}

test("list-panes: only cc-scrape-* workspaces, in the reaper's columns, with the claude's pid", async () => {
  const f = fakeHerdr({ reply: listing([{ workspace_id: "w4", pane_id: "w4:p1", terminal_id: "term_4", label: SCRAPE_PANE_MARK }, { workspace_id: "w1", pane_id: "w1:p1", terminal_id: "term_1", label: "" }]) })
  expect(await herdrScrapeRunner(f.h)(["list-panes", "-a", "-F", "x"])).toEqual({ code: 0, stdout: `${NAME}\tw4:p1\t\t77\t` })
})

test("after a restart: a listed scrape is adopted by its mark and terminal, so the reaper can close it and nothing else", async () => {
  let terminal = "term_4"
  const f = fakeHerdr({
    reply: (a) => a[0] === "pane" && a[1] === "get" ? { pane: { pane_id: "w4:p1", workspace_id: "w4", terminal_id: terminal, label: SCRAPE_PANE_MARK } }
      : a[0] === "workspace" && a[1] === "get" ? { workspace: { pane_count: 1 } }
      : listing([{ workspace_id: "w4", pane_id: "w4:p1", terminal_id: "term_4", label: SCRAPE_PANE_MARK }])(a),
  })
  const run = herdrScrapeRunner(f.h)
  await run(["list-panes", "-a", "-F", "x"])
  terminal = "term_human"
  f.calls.length = 0
  await run(["kill-session", "-t", `=${NAME}`])
  expect(writes(f.calls)).toEqual([])
})

test("list-panes: an unmarked cc-scrape-* workspace (a human's, an old build's) is listed with no pane, never adopted", async () => {
  const f = fakeHerdr({ reply: listing([{ workspace_id: "w4", pane_id: "w4:p1", terminal_id: "term_4", label: "" }]) })
  const run = herdrScrapeRunner(f.h)
  expect(await run(["list-panes", "-a", "-F", "x"])).toEqual({ code: 0, stdout: `${NAME}\t\t\t\t` })
  f.calls.length = 0
  await run(["kill-session", "-t", `=${NAME}`])
  expect((await run(["has-session", "-t", `=${NAME}`])).code).toBe(-1)
  expect(writes(f.calls)).toEqual([])
})

test("list-panes: an unreadable pid or two marked panes under one label is no inventory (-1)", async () => {
  const marked = { workspace_id: "w4", pane_id: "w4:p1", terminal_id: "term_4", label: SCRAPE_PANE_MARK }
  const noPid = fakeHerdr({ reply: (a) => a[1] === "process-info" ? (() => { throw new Error("down") })() : listing([marked])(a) })
  expect((await herdrScrapeRunner(noPid.h)(["list-panes", "-a", "-F", "x"])).code).toBe(-1)
  const two = fakeHerdr({ reply: listing([marked, { ...marked, pane_id: "w4:p2", terminal_id: "term_5" }]) })
  expect((await herdrScrapeRunner(two.h)(["list-panes", "-a", "-F", "x"])).code).toBe(-1)
})

test("a scrape-marked pane is never a phone shell row", async () => {
  const f = fakeHerdr({ reply: listing([{ workspace_id: "w4", pane_id: "w4:p1", terminal_id: "term_4", label: SCRAPE_PANE_MARK }]) })
  expect(await readHerdrShells(f.h, [])).toEqual([])
})

test("the launch skips a shim on PATH for the real binary (the shim execs $HOME, which is throwaway)", async () => {
  const which = (_: string, path: string) => (path === "/h/.local/bin" ? "/h/.local/bin/claude" : path.includes("/h/.bun/bin") ? "/h/.bun/bin/claude" : null)
  const launch = await resolveClaudeLaunch({ tmux: herdrScrapeRunner(fakeHerdr().h), which, processEnv: { PATH: "/h/.bun/bin:/usr/bin" }, home: "/h" })
  expect(launch).toMatchObject({ bin: "/h/.local/bin/claude", env: { PATH: "/h/.bun/bin:/usr/bin" } })
})
