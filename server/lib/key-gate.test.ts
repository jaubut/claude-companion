import { test, expect, afterEach } from "bun:test"
import { ESC_SETTLE_MS } from "./command-list"
import { createKeyGate, keyGate, opensChordWindow } from "./key-gate"

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
