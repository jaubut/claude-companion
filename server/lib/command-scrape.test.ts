import { test, expect, afterEach } from "bun:test"
import {
  abortScrape, beginFlow, DIRTY_TTL_MS, endFlow, isFlowActive, isPaneDirty, isScraping, resetFlows,
  scrapeAbortRequested, waitForFlow, yieldPane,
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

// G1 — a release carries a VERDICT, and the waiters get it.
//
// The scrape's own cleanup can fail: closeHelpOverlay polls for a pane with no
// overlay and an empty input line, and answers clean:false when it never came.
// The route still has to release the claim (its `finally`), and before this
// the release said nothing — every waiter resolved freed:true, yieldPane
// reported the pane free, and the inject typed into the /help modal that was
// demonstrably still up. The verdict is what turns that into a `busy_flow`
// refusal.
test("a DIRTY release wakes the waiter with freed:false — the overlay is still up", async () => {
  beginFlow(KEY, "list")
  const y = yieldPane(KEY, { abortMs: 1_000 })
  expect(scrapeAbortRequested(KEY)).toBe(true)
  // closeHelpOverlay could not get the pane back to an empty prompt.
  setTimeout(() => endFlow(KEY, { clean: false }), 10)
  expect(await y).toEqual({ held: "list", freed: false })
  // The claim IS gone — this is not a timeout, it is a bad hand-off, and the
  // caller must be able to tell them apart only by acting the same way.
  expect(isFlowActive(KEY)).toBe(false)
})

test("a CLEAN release wakes the waiter with freed:true", async () => {
  beginFlow(KEY, "list")
  const y = yieldPane(KEY, { abortMs: 1_000 })
  setTimeout(() => endFlow(KEY, { clean: true }), 10)
  expect(await y).toEqual({ held: "list", freed: true })
})

test("waitForFlow relays the verdict too, and every waiter gets the same one", async () => {
  beginFlow(KEY, "list")
  const both = Promise.all([waitForFlow(KEY, 1_000), abortScrape(KEY, 1_000)])
  setTimeout(() => endFlow(KEY, { clean: false }), 10)
  expect(await both).toEqual([false, false])
})

test("a release with no verdict is clean — the suggest probe ends with a C-u", async () => {
  beginFlow(KEY, "suggest")
  const waited = waitForFlow(KEY, 1_000)
  setTimeout(() => endFlow(KEY), 10)
  expect(await waited).toBe(true)
})

// R1 — the verdict has to outlive the flow.
//
// A dirty release DELETES the flow, so it only ever reached the waiters that
// were already parked on it. The first inject was refused (`freed:false`), and
// the retry a millisecond later found no flow at all: yieldPane answered
// freed:true, openDialogFor answered null (the watcher had been skipping that
// session for the whole scrape, and its next sweep is up to 2s away), and the
// user's text went into the /help modal that was still on screen — the hole the
// verdict was added to close, reopened by pressing send twice.
test("R1: a dirty release keeps refusing until a capture proves the pane is clean", async () => {
  const verify = { calls: 0, clean: false }
  const check = async () => { verify.calls++; return verify.clean }

  // Inject 1 — parked on the flow, woken by the dirty release.
  beginFlow(KEY, "list")
  const first = yieldPane(KEY, { abortMs: 1_000, verify: check })
  expect(scrapeAbortRequested(KEY)).toBe(true)
  setTimeout(() => endFlow(KEY, { clean: false }), 10)
  expect(await first).toEqual({ held: "list", freed: false })
  expect(isFlowActive(KEY)).toBe(false)
  expect(isPaneDirty(KEY)).toBe(true)

  // Inject 2 — the retry. No flow left, but the pane is still dirty and the
  // capture says so: refused, NOT waved through.
  expect(await yieldPane(KEY, { verify: check })).toEqual({ held: "list", freed: false })
  expect(verify.calls).toBe(1)

  // Inject 3 — the overlay is gone and the prompt is empty. Delivered.
  verify.clean = true
  expect(await yieldPane(KEY, { verify: check })).toEqual({ held: "list", freed: true })
  expect(verify.calls).toBe(2)
  expect(isPaneDirty(KEY)).toBe(false)

  // …and the mark is spent: the next inject costs no capture at all.
  expect(await yieldPane(KEY, { verify: async () => { throw new Error("re-checked a clean pane") } }))
    .toEqual({ held: null, freed: true })
  expect(verify.calls).toBe(2)
})

test("R1: a dirty pane with no way to look at it is a busy pane", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  // No verifier (no tmux pane on the target, say): unverifiable is unusable.
  expect(await yieldPane(KEY)).toEqual({ held: "list", freed: false })
  // A verifier that blows up counts the same way.
  expect(await yieldPane(KEY, { verify: async () => { throw new Error("tmux gone") } }))
    .toEqual({ held: "list", freed: false })
})

test("R1: a flow that ends clean clears an earlier dirty mark", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  expect(isPaneDirty(KEY)).toBe(true)
  // A later scrape drives the pane again and closes properly.
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: true })
  expect(isPaneDirty(KEY)).toBe(false)
  expect(await yieldPane(KEY)).toEqual({ held: null, freed: true })
})

test("R1: a verdict-less release says nothing about a mark somebody else left", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  // The `/` suggest probe ends with a C-u and no opinion on overlays: it must
  // not launder a dirty pane clean.
  beginFlow(KEY, "suggest")
  endFlow(KEY)
  expect(isPaneDirty(KEY)).toBe(true)
  expect(await yieldPane(KEY)).toEqual({ held: "list", freed: false })
})

// The mark covers the gap until the dialog watcher notices the leftover
// overlay (it stopped skipping the session the moment the flow went away).
// Past that it could only wedge a session whose pane is fine — a user who
// typed a line of their own makes "is it clean" answer no forever.
test("R1: the dirty mark expires rather than refusing a healthy pane forever", async () => {
  expect(DIRTY_TTL_MS).toBeGreaterThan(2_000 * 2)   // more than a watcher tick or two
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  expect(isPaneDirty(KEY, 0)).toBe(false)
  expect(await yieldPane(KEY, { dirtyTtlMs: 0 })).toEqual({ held: null, freed: true })
  // Spent: the pane is not dirty under the real TTL either any more.
  expect(isPaneDirty(KEY)).toBe(false)
})

test("R1: a scrape that releases clean never marks the pane", async () => {
  beginFlow(KEY, "list")
  const y = yieldPane(KEY, { abortMs: 1_000, verify: async () => false })
  setTimeout(() => endFlow(KEY, { clean: true }), 10)
  expect(await y).toEqual({ held: "list", freed: true })
  expect(isPaneDirty(KEY)).toBe(false)
  expect(await yieldPane(KEY)).toEqual({ held: null, freed: true })
})

test("R1: a wedged scrape is a timeout, not a mark — the flow still holds the pane", async () => {
  beginFlow(KEY, "list")
  expect(await yieldPane(KEY, { abortMs: 30 })).toEqual({ held: "list", freed: false })
  expect(isScraping(KEY)).toBe(true)
  expect(isPaneDirty(KEY)).toBe(false)
})
