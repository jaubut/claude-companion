import { test, expect, beforeEach } from "bun:test"
import { beginFlow, isPaneDirty, resetFlows, yieldPane } from "./command-scrape"
import { type ClearablePane, finishSuggestProbe, leaveInputEmpty } from "./suggest-cleanup"

// Claude Code's input box as a `capture-pane -e` / styled herdr read shows it.
const box = (typed: string) => `\n────────\n❯ ${typed}\n────────\n`
const noSleep = async () => {}
const KEY = "claude:tty:/dev/pts/9"

// A pane whose input line is `line`; C-u empties it only when `clears`.
function fakePane(opts: { line: string; keyOk?: boolean; clears?: boolean }) {
  let line = opts.line
  const keys: string[] = []
  const pane: ClearablePane = {
    async capture() { return box(line) },
    async key(k) {
      keys.push(k)
      if (opts.keyOk === false) return false
      if (opts.clears !== false) line = ""
      return true
    },
  }
  return { pane, keys }
}

beforeEach(() => resetFlows())

test("cleanup send fails (herdr key killed at the gate): flow ends clean:false and the next inject is held", async () => {
  const { pane, keys } = fakePane({ line: "/mo", keyOk: false })
  expect(beginFlow(KEY, "suggest")).toBe(true)
  expect(await finishSuggestProbe(KEY, pane, ["/mo"], "work", noSleep)).toBe(false)
  expect(keys).toEqual(["C-u"])
  expect(isPaneDirty(KEY)).toBe(true)
  // The inject's hand-over must verify the pane; a pane still showing /mo fails it.
  const y = await yieldPane(KEY, { verify: async () => false, sleep: noSleep })
  expect(y.freed).toBe(false)
  expect(beginFlow(KEY, "suggest")).toBe(false) // a dirty pane refuses the next probe too
})

test("cleanup 'succeeds' but the box still shows /prefix: clean:false", async () => {
  const { pane } = fakePane({ line: "/mo", clears: false })
  expect(beginFlow(KEY, "suggest")).toBe(true)
  expect(await finishSuggestProbe(KEY, pane, ["/mo"], "work", noSleep)).toBe(false)
  expect(isPaneDirty(KEY)).toBe(true)
})

test("happy path: C-u empties the line → clean release, the next inject is handed the pane", async () => {
  const { pane, keys } = fakePane({ line: "/mo" })
  expect(beginFlow(KEY, "suggest")).toBe(true)
  expect(await finishSuggestProbe(KEY, pane, ["/mo"], "work", noSleep)).toBe(true)
  expect(keys).toEqual(["C-u"])
  expect(isPaneDirty(KEY)).toBe(false)
  expect((await yieldPane(KEY, { verify: async () => false, sleep: noSleep })).freed).toBe(true)
})

test("an unreadable pane after the clear is not clean", async () => {
  let reads = 0
  const pane: ClearablePane = { async capture() { return ++reads === 1 ? box("/mo") : null }, async key() { return true } }
  expect(await leaveInputEmpty(pane, ["/mo"], "work", noSleep)).toBe(false)
})

test("text that is not the probe's own is never cleared, and not reported clean", async () => {
  const { pane, keys } = fakePane({ line: "fix the build" })
  expect(await leaveInputEmpty(pane, ["/mo"], "work", noSleep)).toBe(false)
  expect(keys).toEqual([])
})

test("dim ghost text after the clear reads as empty (styled read)", async () => {
  let reads = 0
  const pane: ClearablePane = {
    async capture() { return ++reads === 1 ? box("/mo") : box("\x1b[2mtry \"fix the build\"\x1b[0m") },
    async key() { return true },
  }
  expect(await leaveInputEmpty(pane, ["/mo"], "work", noSleep)).toBe(true)
})
