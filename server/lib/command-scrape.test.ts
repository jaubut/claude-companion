import { test, expect, afterEach } from "bun:test"
import {
  abortScrape, beginFlow, endFlow, isFlowActive, isPaneDirty, isScraping, resetFlows,
  scrapeAbortRequested, waitForFlow, yieldPane,
} from "./command-scrape"
import { ESC_SETTLE_MS } from "./command-list"

// The chord settle is real wall-clock in production; the tests drive it with a
// sleep they own so the suite stays instant and the WAIT is assertable.
function fakeSleep(): { slept: number[]; sleep: (ms: number) => Promise<void> } {
  const slept: number[] = []
  return { slept, sleep: async (ms: number) => { slept.push(ms) } }
}

// yieldPane with the chord settle stubbed out. Every test that is not ABOUT
// the settle goes through here, so the suite does not sleep a real 250ms a
// dozen times over.
const yieldNow = (key: string, opts: Parameters<typeof yieldPane>[1] = {}) =>
  yieldPane(key, { sleep: async () => { /* instant */ }, ...opts })

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
  expect(await yieldNow(KEY)).toEqual({ held: null, freed: true })
})

test("yieldPane: a scrape that lets go reports freed", async () => {
  beginFlow(KEY, "list")
  const y = yieldNow(KEY, { abortMs: 1_000 })
  expect(scrapeAbortRequested(KEY)).toBe(true)
  setTimeout(() => endFlow(KEY), 10)
  expect(await y).toEqual({ held: "list", freed: true })
})

test("yieldPane: a wedged scrape reports NOT freed, and the flow is still held", async () => {
  beginFlow(KEY, "list")
  const y = await yieldNow(KEY, { abortMs: 30 })
  expect(y).toEqual({ held: "list", freed: false })
  // The caller must be able to tell this apart from a clean hand-off: the
  // modal is still on screen and the watcher is still skipping this session.
  expect(isScraping(KEY)).toBe(true)
})

test("yieldPane: a suggest probe that outlasts the wait also reports NOT freed", async () => {
  beginFlow(KEY, "suggest")
  expect(await yieldNow(KEY, { waitMs: 30 })).toEqual({ held: "suggest", freed: false })
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
  const y = yieldNow(KEY, { abortMs: 1_000 })
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
  const y = yieldNow(KEY, { abortMs: 1_000 })
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
  const first = yieldNow(KEY, { abortMs: 1_000, verify: check })
  expect(scrapeAbortRequested(KEY)).toBe(true)
  setTimeout(() => endFlow(KEY, { clean: false }), 10)
  expect(await first).toEqual({ held: "list", freed: false })
  expect(isFlowActive(KEY)).toBe(false)
  expect(isPaneDirty(KEY)).toBe(true)

  // Inject 2 — the retry. No flow left, but the pane is still dirty and the
  // capture says so: refused, NOT waved through.
  expect(await yieldNow(KEY, { verify: check })).toEqual({ held: "list", freed: false })
  expect(verify.calls).toBe(1)

  // Inject 3 — the overlay is gone and the prompt is empty. Delivered.
  verify.clean = true
  expect(await yieldNow(KEY, { verify: check })).toEqual({ held: "list", freed: true })
  expect(verify.calls).toBe(2)
  expect(isPaneDirty(KEY)).toBe(false)

  // …and the mark is spent: the next inject costs no capture at all.
  expect(await yieldNow(KEY, { verify: async () => { throw new Error("re-checked a clean pane") } }))
    .toEqual({ held: null, freed: true })
  expect(verify.calls).toBe(2)
})

test("R1: a dirty pane with no way to look at it is a busy pane", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  // No verifier (no tmux pane on the target, say): unverifiable is unusable.
  expect(await yieldNow(KEY)).toEqual({ held: "list", freed: false })
  // A verifier that blows up counts the same way.
  expect(await yieldNow(KEY, { verify: async () => { throw new Error("tmux gone") } }))
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
  expect(await yieldNow(KEY)).toEqual({ held: null, freed: true })
})

test("R1: a verdict-less release says nothing about a mark somebody else left", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  // The `/` suggest probe ends with a C-u and no opinion on overlays: it must
  // not launder a dirty pane clean.
  beginFlow(KEY, "suggest")
  endFlow(KEY)
  expect(isPaneDirty(KEY)).toBe(true)
  expect(await yieldNow(KEY)).toEqual({ held: "list", freed: false })
})

// R4b — the mark used to EXPIRE on a clock: any mark older than DIRTY_TTL_MS
// (10s) was deleted and `freed:true` returned without a single capture. That is
// the same absence-of-evidence hand-over the mark exists to prevent, just on a
// timer: a /help overlay a scrape could not close is still on the pane at
// t+10s, and the first inject after that was waved straight into it.
//
// A mark is now cleared by evidence only — a verified-clean capture, or an
// explicit clean release. The worry the TTL answered (refusing forever on a
// healthy pane) is the verifier's job, and it does it on the first try.
test("R4b: a dirty mark does NOT expire on a clock — the capture is the only way out", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  // Ten minutes of "age" changes nothing: no verifier, no hand-over.
  expect(await yieldNow(KEY)).toEqual({ held: "list", freed: false })
  expect(isPaneDirty(KEY)).toBe(true)
  // A verifier that says the overlay is still up: still refused.
  expect(await yieldNow(KEY, { verify: async () => false })).toEqual({ held: "list", freed: false })
  expect(isPaneDirty(KEY)).toBe(true)
  // Evidence, at last.
  expect(await yieldNow(KEY, { verify: async () => true })).toEqual({ held: "list", freed: true })
  expect(isPaneDirty(KEY)).toBe(false)
})

test("R1: a scrape that releases clean never marks the pane", async () => {
  beginFlow(KEY, "list")
  const y = yieldNow(KEY, { abortMs: 1_000, verify: async () => false })
  setTimeout(() => endFlow(KEY, { clean: true }), 10)
  expect(await y).toEqual({ held: "list", freed: true })
  expect(isPaneDirty(KEY)).toBe(false)
  expect(await yieldNow(KEY)).toEqual({ held: null, freed: true })
})

test("R1: a wedged scrape is a timeout, not a mark — the flow still holds the pane", async () => {
  beginFlow(KEY, "list")
  expect(await yieldNow(KEY, { abortMs: 30 })).toEqual({ held: "list", freed: false })
  expect(isScraping(KEY)).toBe(true)
  expect(isPaneDirty(KEY)).toBe(false)
})

// ── R3 — the hand-off itself must land outside the Escape chord window ──────
//
// The `/help` close path ends in an Escape, and a byte arriving within a few ms
// of an ESC is read by Claude Code as a META CHORD: the Escape does not act as
// Escape and the byte is swallowed. That is the "❯ ing" the Zettlab E2E caught.
// closeHelpOverlay settles on its own, so this is the backstop for the paths
// that do not go through it — a throw between the last key and the route's
// `finally { endFlow(...) }`, say.
test("R3: a list release is not handed over inside the Escape chord window", async () => {
  const f = fakeSleep()
  beginFlow(KEY, "list")
  const y = yieldPane(KEY, { abortMs: 1_000, sleep: f.sleep })
  setTimeout(() => endFlow(KEY, { clean: true }), 5)
  expect(await y).toEqual({ held: "list", freed: true })
  // It waited out the REMAINDER of the window, not a flat 250ms on top.
  expect(f.slept.length).toBe(1)
  expect(f.slept[0]!).toBeGreaterThan(0)
  expect(f.slept[0]!).toBeLessThanOrEqual(ESC_SETTLE_MS)
})

test("R3: a release that already settled costs the inject nothing", async () => {
  const f = fakeSleep()
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: true })
  // closeHelpOverlay's own settle has already elapsed by the time the inject
  // asks (simulated here by the release being in the past).
  await new Promise((r) => setTimeout(r, ESC_SETTLE_MS + 20))
  expect(await yieldPane(KEY, { sleep: f.sleep })).toEqual({ held: null, freed: true })
  expect(f.slept).toEqual([])
})

// ── R4a — a HELD flow's verdict is not a verdict about the KEY ─────────────
//
// yieldPane returned the wait result directly for a held flow, so the dirty
// mark was never consulted. The suggest probe is the case that bites: it
// releases clean-by-default (a C-u, and no opinion about overlays), so an
// inject that parked on a suggest probe which had started over a dirty pane was
// handed freed:true without a single capture — straight into the /help overlay
// the mark was warning about.
// Closed at the SOURCE: a suggest probe may not even start on a marked pane.
test("R4a: beginFlow refuses a suggest probe on a pane marked dirty", () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  // The probe types `/prefix` and parses the menu that pops up. On a pane with
  // our own /help overlay still on it, that is typing into somebody's modal —
  // and it has no cleanup that could fix it: it ends with a C-u, which leaves
  // an overlay exactly where it was.
  expect(beginFlow(KEY, "suggest")).toBe(false)
  // A `list` scrape drives /help deliberately and its close path is the thing
  // that can CLEAR the mark, so it is allowed through.
  expect(beginFlow(KEY, "list")).toBe(true)
  endFlow(KEY, { clean: true })
  expect(beginFlow(KEY, "suggest")).toBe(true)
})

// …and closed again at the HAND-OFF, which is the general fix: any held flow
// whose wait succeeds still has to clear the mark before the pane changes
// hands. The reachable shape of it is a VERDICT-LESS release — `endFlow(key)`
// with no `clean` argument is "no statement about the pane", and the waiters
// used to read that as "free".
test("R4a: a held flow releasing verdict-less does not launder a dirty pane", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })          // scrape 1 leaves the overlay up
  expect(beginFlow(KEY, "list")).toBe(true)  // scrape 2 claims the marked pane
  const y = yieldNow(KEY, { abortMs: 1_000, verify: async () => false })
  expect(scrapeAbortRequested(KEY)).toBe(true)
  setTimeout(() => endFlow(KEY), 10)      // …and says nothing on the way out
  expect(await y).toEqual({ held: "list", freed: false })
  expect(isPaneDirty(KEY)).toBe(true)
})

test("R4a: the same inject is delivered once a capture clears the mark", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  beginFlow(KEY, "list")
  const y = yieldNow(KEY, { abortMs: 1_000, verify: async () => true })
  setTimeout(() => endFlow(KEY), 10)
  expect(await y).toEqual({ held: "list", freed: true })
  expect(isPaneDirty(KEY)).toBe(false)
})

// ── R4c — the world moves while verify() is in flight ──────────────────────
//
// verify() is a real `tmux capture-pane` against a real pane: it takes time. A
// scrape that began during it now holds the keyboard, and the verdict describes
// a screen from before it started typing. Clearing the mark on that and
// answering freed:true hands an inject a pane somebody else is driving.
test("R4c: a flow that starts during verify() makes the verification stale", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  // The verifier looks at a pane that IS clean — and a new scrape claims it
  // before the answer comes back.
  const y = await yieldNow(KEY, {
    verify: async () => { beginFlow(KEY, "list"); return true },
  })
  expect(y).toEqual({ held: "list", freed: false })
  // …and the mark was NOT cleared on the strength of a stale look.
  expect(isPaneDirty(KEY)).toBe(true)
  expect(isScraping(KEY)).toBe(true)
})

test("R4c: a flow that came AND WENT during verify() re-marks, and is refused", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  const y = await yieldNow(KEY, {
    verify: async () => {
      beginFlow(KEY, "list")
      endFlow(KEY, { clean: false })   // a second scrape, also dirty
      return true
    },
  })
  expect(y).toEqual({ held: "list", freed: false })
  expect(isPaneDirty(KEY)).toBe(true)
})

test("R4c: an explicit CLEAN release during verify() is stronger evidence than our capture", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  const y = await yieldNow(KEY, {
    verify: async () => {
      beginFlow(KEY, "list")
      endFlow(KEY, { clean: true })    // that scrape closed its overlay properly
      return false
    },
  })
  expect(y).toEqual({ held: null, freed: true })
  expect(isPaneDirty(KEY)).toBe(false)
})

// ── Ownership across the hand-off's awaits (Codex HIGH, PR #38) ────────────
//
// Every await in yieldPane — the flow wait, the chord settle, the verify
// capture — is a window in which the route can begin a new flow on the key.
// The no-dirty-mark shortcut used to answer freed:true after the settle
// without looking, so an inject was handed a pane a fresh scrape was driving.
test("ownership: a flow that starts during the release settle is not handed over", async () => {
  beginFlow(KEY, "list")
  const y = yieldPane(KEY, {
    abortMs: 1_000,
    // The settle is where the new scrape arrives.
    sleep: async () => { beginFlow(KEY, "list") },
  })
  setTimeout(() => endFlow(KEY, { clean: true }), 5)
  expect(await y).toEqual({ held: "list", freed: false })
  // The new flow still owns the pane; nothing released it on our behalf.
  expect(isScraping(KEY)).toBe(true)
  expect(isPaneDirty(KEY)).toBe(false)
})

test("ownership: the no-flow path settles a fresh list release, then re-checks", async () => {
  // A scrape released from the route's `finally` after a throw: already gone
  // when the inject asks, its Escape a few ms old.
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: true })
  const slept: number[] = []
  const y = await yieldPane(KEY, {
    sleep: async (ms) => { slept.push(ms); beginFlow(KEY, "suggest") },
  })
  // It waited out the window (Claude auto-review #3)…
  expect(slept.length).toBe(1)
  expect(slept[0]!).toBeGreaterThan(0)
  // …and the probe that began during it keeps the pane.
  expect(y).toEqual({ held: "suggest", freed: false })
  expect(isFlowActive(KEY)).toBe(true)
})

test("ownership: a suggest release opens no chord window and costs no settle", async () => {
  beginFlow(KEY, "suggest")
  endFlow(KEY)
  const f = fakeSleep()
  expect(await yieldPane(KEY, { sleep: f.sleep })).toEqual({ held: null, freed: true })
  expect(f.slept).toEqual([])
})

test("ownership: a clean release during verify() is settled, and a flow starting then keeps the pane", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  await new Promise((r) => setTimeout(r, ESC_SETTLE_MS + 20))  // first window long gone
  const slept: number[] = []
  const y = await yieldPane(KEY, {
    verify: async () => {
      beginFlow(KEY, "list")
      endFlow(KEY, { clean: true })   // a scrape closed properly: its Escape is fresh
      return true
    },
    sleep: async (ms) => { slept.push(ms); beginFlow(KEY, "list") },
  })
  expect(slept.length).toBe(1)
  expect(y).toEqual({ held: "list", freed: false })
  expect(isScraping(KEY)).toBe(true)
})

// ── Codex HIGH round 2 ──────────────────────────────────────────────────────
//
// (a) The key gate's Escape windows count too: an Escape the phone sent
// through /api/dialog/key leaves the pane unusable for ESC_SETTLE_MS, and
// yieldPane answered freed:true inside it.
test("gate: yieldPane does not report freed while the pane's key gate has an Escape window open", async () => {
  const until = Date.now() + 200
  const slept: number[] = []
  const y = await yieldPane(KEY, {
    pane: "%7",
    gate: { earliestNextSend: () => until },
    sleep: async (ms) => { slept.push(ms) },
  })
  expect(slept.length).toBe(1)
  expect(slept[0]!).toBeGreaterThan(150)
  expect(y).toEqual({ held: null, freed: true })
})

test("gate: a flow that starts while the gate window is waited out keeps the pane", async () => {
  const y = await yieldPane(KEY, {
    pane: "%7",
    gate: { earliestNextSend: () => Date.now() + 200 },
    sleep: async () => { beginFlow(KEY, "suggest") },
  })
  expect(y).toEqual({ held: "suggest", freed: false })
})

test("gate: Escapes that keep re-opening the window end in a refusal, not a hand-over", async () => {
  const y = await yieldPane(KEY, {
    pane: "%7",
    // A NEW Escape every look: each window ends later than the last.
    gate: { earliestNextSend: (() => { let n = 0; return () => Date.now() + 200 + 10 * n++ })() },
    sleep: async () => { /* instant */ },
  })
  expect(y.freed).toBe(false)
})

// (b) Ownership can change across the final `await yieldDirty()` itself. The
// old code swapped `held` for the new holder's kind but kept that call's
// freed:true — reproduced as {held:"suggest", freed:true}. The inject waits
// on a /help scrape; a suggest probe begins N microtasks after the release.
// Swept over N so one of them lands between yieldDirty's last check and the
// outer continuation, whatever the exact await depth of the implementation.
test("stale-freed: freed is recomputed after the last await — a new holder is never handed over", async () => {
  let refused = 0
  for (let depth = 0; depth < 60; depth++) {
    resetFlows()
    beginFlow(KEY, "list")
    const y = yieldNow(KEY, { abortMs: 1_000 })
    endFlow(KEY, { clean: true })
    let p: Promise<void> = Promise.resolve()
    for (let i = 0; i < depth; i++) p = p.then(() => {})
    void p.then(() => { beginFlow(KEY, "suggest") })
    const r = await y
    // freed:true must come with the flow we waited out, never with a new one.
    if (r.freed) expect(r.held).toBe("list")
    else { refused++; expect(r).toEqual({ held: "suggest", freed: false }) }
  }
  // Some depth landed the probe inside the hand-over, or this proved nothing.
  expect(refused).toBeGreaterThan(0)
})
