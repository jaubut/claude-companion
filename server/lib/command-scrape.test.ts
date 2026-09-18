import { test, expect, afterEach } from "bun:test"
import {
  abortScrape, beginFlow, endFlow, isFlowActive, isScraping, resetFlows, scrapeAbortRequested, waitForFlow,
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
