import { test, expect, afterEach } from "bun:test"
import { ESC_SETTLE_MS } from "./command-list"
import { createKeyGate, KeyGateTimeout, keyGate, opensChordWindow } from "./key-gate"

// A virtual clock: sleep advances it, so spacing is asserted on timestamps
// without the suite waiting 250ms per case.
function rig() {
  let t = 1_000
  const sent: Array<{ key: string; at: number }> = []
  const gate = createKeyGate({
    now: () => t,
    sleep: async (ms) => { t += ms },
  })
  const tap = (pane: string, key: string, sendMs = 0) =>
    gate.send(pane, key, async () => {
      sent.push({ key, at: t })
      t += sendMs                       // tmux takes a moment to return
      return true
    })
  return { gate, sent, tap, advance: (ms: number) => { t += ms } }
}

afterEach(() => keyGate.reset())

test("two back-to-back key requests to one pane are spaced by >= ESC_SETTLE_MS after an Escape", async () => {
  const r = rig()
  // Fired together, as two HTTP requests landing in the same tick would be.
  await Promise.all([r.tap("%1", "Escape"), r.tap("%1", "Enter")])
  expect(r.sent.map((s) => s.key)).toEqual(["Escape", "Enter"])
  expect(r.sent[1]!.at - r.sent[0]!.at).toBeGreaterThanOrEqual(ESC_SETTLE_MS)
})

test("the window is measured from when the Escape's send-keys RETURNED", async () => {
  const r = rig()
  await Promise.all([r.tap("%1", "Escape", 40), r.tap("%1", "Enter")])
  expect(r.sent[1]!.at - (r.sent[0]!.at + 40)).toBeGreaterThanOrEqual(ESC_SETTLE_MS)
})

test("several concurrent senders all queue behind the Escape, in arrival order", async () => {
  const r = rig()
  await Promise.all([
    r.tap("%1", "Escape"),   // e.g. /api/model/cancel
    r.tap("%1", "Escape"),   // the /help close path
    r.tap("%1", "Down"),     // a phone's dialog arrow
  ])
  expect(r.sent.map((s) => s.key)).toEqual(["Escape", "Escape", "Down"])
  expect(r.sent[1]!.at - r.sent[0]!.at).toBeGreaterThanOrEqual(ESC_SETTLE_MS)
  expect(r.sent[2]!.at - r.sent[1]!.at).toBeGreaterThanOrEqual(ESC_SETTLE_MS)
})

test("non-Escape keys open no window — dialog arrows do not crawl", async () => {
  const r = rig()
  await Promise.all([r.tap("%1", "Down"), r.tap("%1", "Down"), r.tap("%1", "Enter")])
  expect(r.sent.map((s) => s.at)).toEqual([1_000, 1_000, 1_000])
})

test("a key sent after the window has passed pays nothing", async () => {
  const r = rig()
  await r.tap("%1", "Escape")
  r.advance(ESC_SETTLE_MS + 10)
  const before = r.sent.length
  await r.tap("%1", "Enter")
  expect(r.sent[before]!.at - r.sent[0]!.at).toBe(ESC_SETTLE_MS + 10)
})

test("panes are independent: an Escape on one does not hold another", async () => {
  const r = rig()
  await Promise.all([r.tap("%1", "Escape"), r.tap("%2", "Enter")])
  const other = r.sent.find((s) => s.key === "Enter")!
  expect(other.at).toBe(1_000)
})

test("a failed send still opens the window, and does not wedge the queue", async () => {
  const r = rig()
  const failing = r.gate.send("%1", "Escape", async () => { throw new Error("tmux gone") })
  const next = r.tap("%1", "Enter")
  await expect(failing).rejects.toThrow("tmux gone")
  await next
  expect(r.gate.earliestNextSend("%1")).toBeGreaterThan(0)
  expect(r.sent.map((s) => s.key)).toEqual(["Enter"])
})

test("the raw ESC byte and C-[ count as Escape", () => {
  expect(opensChordWindow("Escape")).toBe(true)
  expect(opensChordWindow("\x1b")).toBe(true)
  expect(opensChordWindow("C-[")).toBe(true)
  expect(opensChordWindow("Enter")).toBe(false)
  expect(opensChordWindow("C-u")).toBe(false)
})

test("the shared gate, on the real clock, spaces two requests by >= ESC_SETTLE_MS", async () => {
  const at: number[] = []
  const send = (key: string) => keyGate.send("%real", key, async () => { at.push(performance.now()) })
  await Promise.all([send("Escape"), send("Enter")])
  // 1ms slack for timer rounding on the real clock.
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(ESC_SETTLE_MS - 1)
})

// ── Codex LOW round 2: the maps must not keep every pane ever seen ─────────
test("cleanup: an Escape's window is forgotten once it has passed", async () => {
  const gate = createKeyGate({ settleMs: 20 })
  await gate.send("%gone", "Escape", async () => {})
  expect(gate.size().windows).toBe(1)
  await new Promise((r) => setTimeout(r, 60))
  // The pane was destroyed right after its Escape: nothing about it remains.
  expect(gate.size()).toEqual({ windows: 0, queues: 0 })
})

test("cleanup: an older window's expiry does not cut a NEWER Escape's window short", async () => {
  const gate = createKeyGate({ settleMs: 40 })
  await gate.send("%1", "Escape", async () => {})
  await new Promise((r) => setTimeout(r, 20))
  await gate.send("%1", "Escape", async () => {})  // waits out the first, opens a new window
  const newer = gate.earliestNextSend("%1")
  await new Promise((r) => setTimeout(r, 10))
  expect(gate.earliestNextSend("%1")).toBe(newer)
  expect(gate.remainingMs("%1")).toBeGreaterThan(0)
})

test("cleanup: forget() drops a retired pane", async () => {
  const gate = createKeyGate({ settleMs: 1_000 })
  await gate.send("%9", "Escape", async () => {})
  gate.forget("%9")
  expect(gate.size()).toEqual({ windows: 0, queues: 0 })
  expect(gate.remainingMs("%9")).toBe(0)
})

// ── Codex HIGH round 3: a stalled sender must never wedge the pane ─────────
const never = <T>() => new Promise<T>(() => {})

test("deadline: a sender that never resolves does not block the next sender past the deadline", async () => {
  const logs: string[] = []
  const gate = createKeyGate({ sendTimeoutMs: 50, log: (l) => logs.push(l) })
  let abortedSignal = false
  const t0 = performance.now()
  const wedged = gate.send("%1", "Down", (signal) => {
    signal.addEventListener("abort", () => { abortedSignal = true })  // runTmux kills tmux here
    return never<void>()
  })
  let nextAt = 0
  const next = gate.send("%1", "Enter", async () => { nextAt = performance.now() })
  await expect(wedged).rejects.toBeInstanceOf(KeyGateTimeout)
  await next
  expect(nextAt - t0).toBeGreaterThanOrEqual(45)
  expect(nextAt - t0).toBeLessThan(500)
  expect(abortedSignal).toBe(true)
  // Logged once, for the send that timed out, not once per waiter.
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain("timed out")
})

test("deadline: a wedged Escape still opens its chord window for the next sender", async () => {
  const gate = createKeyGate({ sendTimeoutMs: 20, log: () => {} })
  const wedged = gate.send("%1", "Escape", () => never<void>())
  await expect(wedged).rejects.toBeInstanceOf(KeyGateTimeout)
  expect(gate.remainingMs("%1")).toBeGreaterThan(0)
})

test("startBy: a queued send past its deadline is rejected and NEVER runs; the queue continues", async () => {
  const gate = createKeyGate({ sendTimeoutMs: 150, log: () => {} })
  const wedged = gate.send("%1", "Down", () => never<void>())
  let lateRan = false
  const t0 = performance.now()
  const late = gate.send("%1", "Enter", async () => { lateRan = true }, { startBy: Date.now() + 30 })
  await expect(late).rejects.toBeInstanceOf(KeyGateTimeout)
  // Rejected at its own deadline, not when the wedged sender timed out.
  expect(performance.now() - t0).toBeLessThan(120)
  let afterRan = false
  const after = gate.send("%1", "Up", async () => { afterRan = true })
  await expect(wedged).rejects.toBeInstanceOf(KeyGateTimeout)
  await after
  expect(afterRan).toBe(true)
  // The cancelled turn did not type late into the pane.
  expect(lateRan).toBe(false)
})

test("startBy: a deadline that an open Escape window would overrun is refused up front", async () => {
  const gate = createKeyGate({ settleMs: 200, log: () => {} })
  await gate.send("%1", "Escape", async () => {})
  let ran = false
  const late = gate.send("%1", "x", async () => { ran = true }, { startBy: Date.now() + 20 })
  await expect(late).rejects.toBeInstanceOf(KeyGateTimeout)
  expect(ran).toBe(false)
})
