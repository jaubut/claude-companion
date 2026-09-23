import { test, expect, afterEach } from "bun:test"
import { ESC_SETTLE_MS } from "./command-list"
import { keyGate } from "./key-gate"
import { deliverViaTmux, injectText } from "./keyboard-inject"

// The user-facing bug behind PR #38: a phone prompt "do both" arrived at
// Claude Code as "o both". An Escape followed within ~100ms by a byte is read
// as opt+<byte> and the byte is swallowed. The inject's own send-keys has to
// wait out any Escape window open on the pane — whoever sent the Escape.

afterEach(() => keyGate.reset())

function recorder() {
  const sent: Array<{ args: readonly string[]; at: number }> = []
  const sendKeys = async (args: readonly string[]) => {
    sent.push({ args, at: performance.now() })
    return { ok: true, reason: "" }
  }
  return { sent, sendKeys }
}

test("inject: text sent during an open Escape window is delayed past the window", async () => {
  // A phone's /api/dialog/key Escape, a moment before the inject.
  let escAt = 0
  await keyGate.send("%7", "Escape", async () => { escAt = performance.now() })
  const r = recorder()
  const res = await deliverViaTmux("%7", "do both", r.sendKeys)
  expect(res.ok).toBe(true)
  expect(r.sent.map((s) => s.args.at(-1))).toEqual(["do both", "Enter"])
  // 1ms slack for timer rounding on the real clock.
  expect(r.sent[0]!.at - escAt).toBeGreaterThanOrEqual(ESC_SETTLE_MS - 1)
})

test("inject: the text and its Enter are one turn — no other key lands between them", async () => {
  const order: string[] = []
  const r = {
    sendKeys: async (args: readonly string[]) => {
      order.push(String(args.at(-1)))
      await new Promise((res) => setTimeout(res, 5))   // tmux takes a moment
      return { ok: true, reason: "" }
    },
  }
  const delivery = deliverViaTmux("%7", "ping", r.sendKeys)
  const escape = keyGate.send("%7", "Escape", async () => { order.push("Escape") })
  await Promise.all([delivery, escape])
  expect(order).toEqual(["ping", "Enter", "Escape"])
})

test("inject: an invalid pane id is refused before touching the gate", async () => {
  const r = recorder()
  const res = await deliverViaTmux("main:0", "x", r.sendKeys)
  expect(res.ok).toBe(false)
  expect(r.sent).toEqual([])
  expect(keyGate.size()).toEqual({ windows: 0, queues: 0 })
})

// ── Codex HIGH round 3: a wedged pane cannot hold an inject, or the others ──
test("inject: waiting on a wedged pane returns an error within its budget and leaves other panes injectable", async () => {
  // Something on %1 hangs inside its turn (a tmux that never returns).
  const wedge = keyGate.send("%1", "Down", () => new Promise<void>(() => {}), { timeoutMs: 1_500 })
  wedge.catch(() => {})
  const r = recorder()
  const t0 = performance.now()
  const stuck = injectText("to the wedged pane", { tmuxPane: "%1" }, { deadline: Date.now() + 100, sendKeys: r.sendKeys })
  // Fired while %1 is still wedged: must not queue behind it.
  const other = injectText("do both", { tmuxPane: "%2" }, { deadline: Date.now() + 100, sendKeys: r.sendKeys })
  expect(await other).toBe(true)
  const otherDone = performance.now() - t0
  expect(await stuck).toBe(false)
  const stuckDone = performance.now() - t0
  expect(otherDone).toBeLessThan(80)             // not held by %1, nor by the global lock
  expect(stuckDone).toBeGreaterThanOrEqual(95)   // it did wait its budget…
  expect(stuckDone).toBeLessThan(400)            // …and no longer
  // Only %2 was typed into; the cancelled %1 delivery never runs late.
  await expect(wedge).rejects.toThrow()
  await new Promise((res) => setTimeout(res, 20))
  expect(r.sent.map((s) => s.args[2])).toEqual(["%2", "%2"])
})
