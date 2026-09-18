import { test, expect, afterEach } from "bun:test"
import {
  abortScrape, beginFlow, endFlow, isFlowActive, isScraping, resetFlows, scrapeAbortRequested, waitForFlow, yieldPane,
} from "./command-scrape"

const KEY = "claude:tty:/dev/pts/8"

afterEach(() => resetFlows())

test("one flow at a time per session; the second caller is told to back off", () => {
  expect(beginFlow(KEY, "list")).toBe(true)
  expect(beginFlow(KEY, "suggest")).toBe(false)
  expect(beginFlow("other", "suggest")).toBe(true)
  endFlow(KEY)
  expect(beginFlow(KEY, "suggest")).toBe(true)
})

test("only the /help scrape counts as scraping — the suggest probe opens no dialog", () => {
  beginFlow(KEY, "suggest")
  expect(isFlowActive(KEY)).toBe(true)
  expect(isScraping(KEY)).toBe(false)
  endFlow(KEY)
  beginFlow(KEY, "list")
  expect(isScraping(KEY)).toBe(true)
})

test("an inject aborting a scrape resolves when the scrape releases the pane", async () => {
  beginFlow(KEY, "list")
  const waited = abortScrape(KEY, 1_000)
  // The scrape sees the flag between keystrokes and cleans up (Escape + C-u)
  // before releasing.
  expect(scrapeAbortRequested(KEY)).toBe(true)
  setTimeout(() => endFlow(KEY), 20)
  expect(await waited).toBe(true)
  expect(isScraping(KEY)).toBe(false)
})

test("a wedged scrape times out rather than holding the inject forever", async () => {
  beginFlow(KEY, "list")
  expect(await abortScrape(KEY, 30)).toBe(false)
})

test("aborting when nothing is running is a no-op that resolves immediately", async () => {
  expect(await abortScrape(KEY, 30)).toBe(true)
})

// The `/` suggestion probe ends with a C-u; a message injected while it runs
// would be cleared by it. No abort points there — the inject just waits.
test("waiting out the suggest probe needs no abort flag", async () => {
  beginFlow(KEY, "suggest")
  const waited = waitForFlow(KEY, 1_000)
  expect(scrapeAbortRequested(KEY)).toBe(false)
  setTimeout(() => endFlow(KEY), 10)
  expect(await waited).toBe(true)
})

test("several waiters on one abort all wake up", async () => {
  beginFlow(KEY, "list")
  const all = Promise.all([abortScrape(KEY, 1_000), abortScrape(KEY, 1_000)])
  setTimeout(() => endFlow(KEY), 10)
  expect(await all).toEqual([true, true])
})

// F1 — yieldPane reports whether the pane is ACTUALLY free. The first cut of
// yieldPaneForInject returned void: a timed-out abort logged "(timed out)"
// and fell straight through to the refusal checks with the flow still held.
// The watcher skips a scraping session, so openDialogFor() answered null, the
// dialog_open check passed, and the user's text was typed into the open /help
// modal. The boolean is what makes that a `busy_flow` refusal instead.
test("yieldPane: a free pane needs no yielding", async () => {
  expect(await yieldPane(KEY)).toEqual({ held: null, freed: true })
})

test("yieldPane: a scrape that lets go reports freed", async () => {
  beginFlow(KEY, "list")
  const y = yieldPane(KEY, { abortMs: 1_000 })
  expect(scrapeAbortRequested(KEY)).toBe(true)
  setTimeout(() => endFlow(KEY), 10)
  expect(await y).toEqual({ held: "list", freed: true })
})

test("yieldPane: a wedged scrape reports NOT freed, and the flow is still held", async () => {
  beginFlow(KEY, "list")
  const y = await yieldPane(KEY, { abortMs: 30 })
  expect(y).toEqual({ held: "list", freed: false })
  // The caller must be able to tell this apart from a clean hand-off: the
  // modal is still on screen and the watcher is still skipping this session.
  expect(isScraping(KEY)).toBe(true)
})

test("yieldPane: a suggest probe that outlasts the wait also reports NOT freed", async () => {
  beginFlow(KEY, "suggest")
  expect(await yieldPane(KEY, { waitMs: 30 })).toEqual({ held: "suggest", freed: false })
  expect(isFlowActive(KEY)).toBe(true)
})
