import { test, expect, afterEach } from "bun:test"
import { ESC_SETTLE_MS } from "./command-list"
import { keyGate } from "./key-gate"
import { deliverViaTmux } from "./keyboard-inject"

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
