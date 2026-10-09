import { test, expect, beforeEach } from "bun:test"
import { herdrScreen } from "./herdr"
import { beginFlow, isPaneDirty, resetFlows, yieldPane } from "./command-scrape"
import { finishSuggestProbe, type ClearablePane } from "./suggest-cleanup"
import { type PaneReadDeps, paneReadsClean } from "./pane-clean"

// What herdr's `pane read --format ansi` gives (after herdrScreen): every row
// behind an SGR run, CRLF ends.
function herdrStyled(rows: string[]): string {
  return herdrScreen(rows.map((l) => (l ? `\x1b[0m\x1b[38;2;153;153;153m${l}\x1b[0m   ` : "")).join("\r\n"))
}
const DIV = "─".repeat(40)
const GHOST = herdrStyled(["", DIV, "❯ \x1b[2mtry \"fix the failing build\"\x1b[0m", DIV, "  ? for shortcuts", ""])
const TYPED = herdrStyled(["", DIV, "❯ fix the failing build", DIV, "  ? for shortcuts", ""])
// The /help overlay with its title split by styling runs.
const OVERLAY = herdrStyled(["", "\x1b[1mHelp\x1b[0m  \x1b[7mGeneral\x1b[0m   Commands   Custom commands", "", "Claude understands your codebase", "", DIV, "❯ ", DIV, ""])

const HERDR = { herdrPane: "w6:p1" }
const live = () => new AbortController().signal
function reads(screen: string | null): PaneReadDeps {
  return { herdrRead: async () => screen, tmuxCapture: async () => { throw new Error("tmux must not be read for a herdr session") } }
}

test("herdr pane with only dim ghost text in the box reads clean", async () => {
  expect(await paneReadsClean(HERDR, live(), reads(GHOST))).toBe(true)
})

test("herdr pane with real typed text is not clean", async () => {
  expect(await paneReadsClean(HERDR, live(), reads(TYPED))).toBe(false)
})

test("a styled /help overlay is still detected (not clean)", async () => {
  expect(await paneReadsClean(HERDR, live(), reads(OVERLAY))).toBe(false)
})

test("tmux panes are read styled too (capture-pane -e)", async () => {
  const seen: string[] = []
  const deps: PaneReadDeps = {
    herdrRead: async () => { throw new Error("no herdr read for tmux") },
    tmuxCapture: async (pane) => { seen.push(pane); return GHOST },
  }
  expect(await paneReadsClean({ tmuxPane: "%4" }, live(), deps)).toBe(true)
  expect(seen).toEqual(["%4"])
})

beforeEach(() => resetFlows())

// Codex's reproduction: a failed suggest cleanup marks the pane dirty; the
// user clears it and Claude Code shows a predicted reply (dim) in the box.
// The next phone inject's verify must hand the pane over.
test("failed suggest cleanup, then a cleared herdr pane with ghost text → the next inject gets the pane", async () => {
  const KEY = "claude:tty:/dev/pts/9"
  const failing: ClearablePane = { async capture() { return herdrStyled([DIV, "❯ /mo", DIV]) }, async key() { return false } }
  expect(beginFlow(KEY, "suggest")).toBe(true)
  expect(await finishSuggestProbe(KEY, failing, ["/mo"], "work", async () => {})).toBe(false)
  expect(isPaneDirty(KEY)).toBe(true)
  const y = await yieldPane(KEY, { verify: (signal) => paneReadsClean(HERDR, signal, reads(GHOST)), sleep: async () => {} })
  expect(y.freed).toBe(true)
  expect(isPaneDirty(KEY)).toBe(false)
})
