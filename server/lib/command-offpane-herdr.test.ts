import { test, expect } from "bun:test"
import { herdrScrapeRunner } from "./command-offpane-herdr"
import { fakeHerdr } from "./herdr-fake.test-util"
import { resolveClaudeLaunch } from "./command-offpane-launch"
import { killScrapeSession } from "./command-offpane"

const NAME = "cc-scrape-123-1-abcd"
const created = { root_pane: { pane_id: "w4:p1", terminal_id: "term_4" } }
const list = { workspaces: [{ workspace_id: "w4", label: NAME }, { workspace_id: "w1", label: "brain" }], panes: [{ workspace_id: "w4", pane_id: "w4:p1" }, { workspace_id: "w1", pane_id: "w1:p1" }] }

test("new-session: an unfocused workspace, the command typed with a leading space, tmux's print format", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "create" ? created : a[1] === "process-info" ? { process_info: { shell_pid: 77 } } : {} })
  const r = await herdrScrapeRunner(f.h)(["new-session", "-d", "-P", "-F", "fmt", "-x", "220", "-y", "60", "-s", NAME, "/bin/sh", "-c", "cd /x && exec claude"])
  expect(r).toEqual({ code: 0, stdout: "w4:p1||77|\n" })
  expect(f.calls[0]).toEqual(["workspace", "create", "--cwd", "/tmp", "--label", NAME, "--no-focus"])
  expect(f.calls[1]).toEqual(["pane", "run", "w4:p1", " cd /x && exec claude"])
})

const NEW = ["new-session", "-d", "-P", "-F", "fmt", "-x", "220", "-y", "60", "-s", NAME, "/bin/sh", "-c", "exec claude"]
// A scrape's pane, then whatever terminal `paneTerminal()` says it holds.
const scrapePane = (paneTerminal: () => string = () => "term_4") => fakeHerdr({ reply: (a) => a[1] === "create" ? created : a[1] === "get" ? { pane: { terminal_id: paneTerminal() } } : {} })

test("capture-pane: the screen, or a miss when unreadable", async () => {
  const f = scrapePane()
  const run = herdrScrapeRunner(f.h, async (p) => (p === "w4:p1" ? "screen" : null))
  await run(NEW)
  expect(await run(["capture-pane", "-p", "-t", "w4:p1"])).toEqual({ code: 0, stdout: "screen" })
  expect((await run(["capture-pane", "-p", "-t", "w9:p1"])).code).toBe(1)
})

test("a reused pane id: no read and no keystroke reaches the new owner", async () => {
  let terminal = "term_4"
  const f = scrapePane(() => terminal)
  let reads = 0
  const run = herdrScrapeRunner(f.h, async () => { reads++; return "their screen" })
  await run(NEW)
  terminal = "term_human"
  expect((await run(["capture-pane", "-p", "-t", "w4:p1"])).code).toBe(1)
  expect((await run(["send-keys", "-t", "w4:p1", "-l", "/help"])).code).toBe(1)
  expect(reads).toBe(0)
  expect(f.calls.some((c) => c[1] === "send-text" || c[1] === "send-keys")).toBe(false)
})

test("new-session: no terminal id to prove ownership with counts as a failure", async () => {
  const f = fakeHerdr({ reply: (a) => a[1] === "create" ? { root_pane: { pane_id: "w4:p1" } } : {} })
  expect((await herdrScrapeRunner(f.h)(NEW)).code).toBe(-1)
  expect(f.calls.some((c) => c[1] === "run")).toBe(false)
})

test("send-keys: a named key, or -l literal text", async () => {
  const f = scrapePane()
  const run = herdrScrapeRunner(f.h)
  await run(NEW)
  f.calls.length = 0
  expect((await run(["send-keys", "-t", "w4:p1", "Down"])).code).toBe(0)
  expect((await run(["send-keys", "-t", "w4:p1", "C-u"])).code).toBe(0)
  expect((await run(["send-keys", "-t", "w4:p1", "-l", "/help"])).code).toBe(0)
  expect(f.calls.filter((c) => c[1] !== "get")).toEqual([["pane", "send-keys", "w4:p1", "down"], ["pane", "send-keys", "w4:p1", "ctrl+u"], ["pane", "send-text", "w4:p1", "/help"]])
})

test("kill + has-session: closes by exact label, gone is code 1, a herdr failure proves nothing", async () => {
  let gone = false
  const f = fakeHerdr({ reply: (a) => { if (a[1] === "close") gone = true; return gone ? { workspaces: [] } : list } })
  expect(await killScrapeSession(herdrScrapeRunner(f.h), NAME, async () => {})).toBe(true)
  expect(f.calls.filter((c) => c[1] === "close")).toEqual([["workspace", "close", "w4"]])
  const down = fakeHerdr({ reply: () => { throw new Error("down") } })
  expect((await herdrScrapeRunner(down.h)(["has-session", "-t", `=${NAME}`])).code).toBe(-1)
})

test("list-panes: only cc-scrape-* workspaces, in the reaper's columns", async () => {
  const r = await herdrScrapeRunner(fakeHerdr({ reply: (a) => a[1] === "process-info" ? { process_info: { shell_pid: 77 } } : list }).h)(["list-panes", "-a", "-F", "x"])
  expect(r).toEqual({ code: 0, stdout: `${NAME}\tw4:p1\t\t77\t` })
})

test("the launch skips a shim on PATH for the real binary (the shim execs $HOME, which is throwaway)", async () => {
  const which = (_: string, path: string) => (path === "/h/.local/bin" ? "/h/.local/bin/claude" : path.includes("/h/.bun/bin") ? "/h/.bun/bin/claude" : null)
  const launch = await resolveClaudeLaunch({ tmux: herdrScrapeRunner(fakeHerdr().h), which, processEnv: { PATH: "/h/.bun/bin:/usr/bin" }, home: "/h" })
  expect(launch).toMatchObject({ bin: "/h/.local/bin/claude", env: { PATH: "/h/.bun/bin:/usr/bin" } })
})
