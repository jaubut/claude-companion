import { test, expect, afterEach } from "bun:test"
import {
  beginFlow, endFlow, isFlowActive, isPaneDirty, isScraping, resetFlows, yieldPane,
} from "./command-scrape"
import { ESC_SETTLE_MS } from "./command-list"

// The hand-off races found in review of PR #38 (Codex rounds 1-3): ownership
// changing across an await, Escape windows from the key gate, and bounded
// verification. The basics live in command-scrape.test.ts.

function fakeSleep(): { slept: number[]; sleep: (ms: number) => Promise<void> } {
  const slept: number[] = []
  return { slept, sleep: async (ms: number) => { slept.push(ms) } }
}

const yieldNow = (key: string, opts: Parameters<typeof yieldPane>[1] = {}) =>
  yieldPane(key, { sleep: async () => { /* instant */ }, ...opts })

const KEY = "claude:tty:/dev/pts/8"

afterEach(() => resetFlows())

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

// ── Codex HIGH round 3: every return after an await re-reads ownership ─────
//
// Parametrised over the await sites. Each scenario drives yieldPane through a
// different set of awaits (flow wait, chord settle, verify capture, second
// settle); a suggest probe then begins N microtasks later, for N = 0..79, so
// it lands in every gap between an await and the return that follows it.
// The oracle is exact: Bun.peek.status tells whether yieldPane had already
// resolved when the probe began. If it had NOT, the answer must be freed:false.
interface AwaitScenario { name: string; setup: () => void; opts: () => Parameters<typeof yieldPane>[1] }
const instant = async () => { /* instant */ }
const scenarios: AwaitScenario[] = [
  {
    name: "no flow, fresh list release (settle await)",
    setup: () => { beginFlow(KEY, "list"); endFlow(KEY, { clean: true }) },
    opts: () => ({ sleep: instant }),
  },
  {
    name: "no flow, dirty mark (settle + verify + settle awaits)",
    setup: () => { beginFlow(KEY, "list"); endFlow(KEY, { clean: false }) },
    opts: () => ({ sleep: instant, verify: async () => true }),
  },
  {
    name: "no flow, clean release during verify (second settle await)",
    setup: () => { beginFlow(KEY, "list"); endFlow(KEY, { clean: false }) },
    opts: () => ({
      sleep: instant,
      verify: async () => { beginFlow(KEY, "list"); endFlow(KEY, { clean: true }); return false },
    }),
  },
  {
    name: "no flow, key-gate window open (gate settle await)",
    setup: () => {},
    opts: () => ({ sleep: instant, pane: "%7", gate: { earliestNextSend: () => Date.now() + 50 } }),
  },
]

for (const sc of scenarios) {
  test(`await sites: ${sc.name} — never freed while a flow began before the answer`, async () => {
    let raced = 0
    for (let depth = 0; depth < 80; depth++) {
      resetFlows()
      sc.setup()
      const y = yieldPane(KEY, sc.opts())
      let beganWhilePending = false
      let p: Promise<void> = Promise.resolve()
      for (let i = 0; i < depth; i++) p = p.then(() => {})
      void p.then(() => {
        const pending = Bun.peek.status(y) === "pending"
        if (beginFlow(KEY, "suggest") && pending) beganWhilePending = true
      })
      const r = await y
      if (beganWhilePending) {
        raced++
        expect(r.freed).toBe(false)
      }
    }
    // The sweep did reach inside the hand-over.
    expect(raced).toBeGreaterThan(0)
  })
}

test("await sites: held flows (wait + yieldDirty awaits) — never freed while a new flow began first", async () => {
  for (const kind of ["list", "suggest"] as const) {
    let raced = 0
    for (let depth = 0; depth < 80; depth++) {
      resetFlows()
      beginFlow(KEY, kind)
      const y = yieldPane(KEY, { sleep: instant, abortMs: 1_000, waitMs: 1_000 })
      endFlow(KEY, { clean: true })
      let beganWhilePending = false
      let p: Promise<void> = Promise.resolve()
      for (let i = 0; i < depth; i++) p = p.then(() => {})
      void p.then(() => {
        const pending = Bun.peek.status(y) === "pending"
        if (beginFlow(KEY, "suggest") && pending) beganWhilePending = true
      })
      const r = await y
      if (beganWhilePending) { raced++; expect(r.freed).toBe(false) }
    }
    expect(raced).toBeGreaterThan(0)
  }
})

// ── Codex MEDIUM round 3: the dirty-pane verification is bounded ───────────
test("verify timeout: a stalled capture is aborted, the mark stays, and the inject is refused", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  let aborted = false
  const t0 = Date.now()
  const y = await yieldPane(KEY, {
    sleep: instant,
    verifyTimeoutMs: 40,
    verify: (signal) => new Promise<boolean>(() => {
      signal.addEventListener("abort", () => { aborted = true })   // the capture is killed here
    }),
  })
  expect(y).toEqual({ held: "list", freed: false })
  expect(isPaneDirty(KEY)).toBe(true)
  expect(aborted).toBe(true)
  expect(Date.now() - t0).toBeLessThan(1_000)
})

test("verify timeout: a verify that finishes in time still clears the mark", async () => {
  beginFlow(KEY, "list")
  endFlow(KEY, { clean: false })
  const y = await yieldPane(KEY, { sleep: instant, verifyTimeoutMs: 500, verify: async () => true })
  expect(y).toEqual({ held: "list", freed: true })
  expect(isPaneDirty(KEY)).toBe(false)
})
