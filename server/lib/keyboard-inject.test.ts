import { test, expect, afterEach, spyOn } from "bun:test"
import { ESC_SETTLE_MS } from "./command-list"
import { keyGate } from "./key-gate"
import { deliverViaTmux, injectText } from "./keyboard-inject"
import { deliverViaHerdr } from "./herdr-inject"
import type { Herdr } from "./herdr"

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

test("guard: tmux identity changes between literal text and Enter", async () => {
  const sent: string[] = []
  let current = true
  const result = await deliverViaTmux("%991", "private prompt", async (args) => {
    sent.push(args.at(-1)!)
    current = false
    return { ok: true, reason: "" }
  }, Date.now() + 2000, "", () => current)
  expect(sent).toEqual(["private prompt"])
  expect(result).toMatchObject({ ok: false, reason: "target_changed" })
})

for (const changeAt of ["queued", "read", "text"] as const) test(`guard: herdr identity changes at ${changeAt}`, async () => {
  let current = changeAt !== "queued"
  const sent: string[] = []
  const h: Herdr = {
    gate: async () => null, read: async () => null,
    call: async (args) => {
      if (args[1] === "get" && changeAt === "read") current = false
      if (args[1] === "send-text" || args[1] === "send-keys") sent.push(args[1])
      if (args[1] === "send-text" && changeAt === "text") current = false
      return {}
    },
  }
  const result = await deliverViaHerdr("w991:p1", "/clear", { herdr: h, canDeliver: () => current })
  expect(sent).toEqual(changeAt === "text" ? ["send-text"] : [])
  expect(result).toMatchObject({ ok: false, reason: "target_changed" })
})

for (const waitAt of ["get", "send-text", "prompt"] as const) test(`abort: guarded herdr ${waitAt} cannot write after its gate expires`, async () => {
  const sent: string[] = []
  let signalSeen: AbortSignal | undefined
  const gateSend = keyGate.send
  const gate = spyOn(keyGate, "send").mockImplementation((pane, key, fn, opts) => gateSend(pane, key, fn, { ...opts, timeoutMs: 20 }))
  const h: Herdr = { gate: async () => null, read: async () => null, call: async (args, _timeout, signal) => {
    if (args[1] === waitAt) {
      signalSeen = signal
      await Bun.sleep(60)
      if (waitAt === "prompt" && signal?.aborted) throw new Error("aborted")
    }
    if (["prompt", "send-text", "send-keys"].includes(args[1]!)) sent.push(args[1]!)
    return {}
  } }
  try {
    expect((await deliverViaHerdr("w993:p1", waitAt === "prompt" ? "hello" : "/clear", { herdr: h, canDeliver: () => true })).ok).toBe(false)
    await Bun.sleep(80)
    expect(signalSeen?.aborted).toBe(true)
    expect(sent).toEqual(waitAt === "send-text" ? ["send-text"] : [])
  } finally { gate.mockRestore() }
})

async function macScripts(run: (script: string) => { result?: string; exited?: Promise<number>; kill?: () => void }, check: () => Promise<void>) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  const spawn = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
    expect(args[0]).toBe("osascript")
    const proc = run(args[2]!)
    return { stdout: new Response(proc.result ?? "MATCH").body!, stderr: new Response("").body!,
      exited: proc.exited ?? Promise.resolve(0), exitCode: 0, kill: proc.kill ?? (() => {}) }
  }) as typeof Bun.spawn)
  try { await check() } finally { spawn.mockRestore(); Object.defineProperty(process, "platform", platform) }
}

for (const termProgram of ["Apple_Terminal", "unknown"]) test(`guard: ${termProgram} rechecks between AppleScript text and Enter`, async () => {
  let current = true
  const writes: string[] = []
  await macScripts((script) => {
    if (script.includes("do script")) { writes.push("text"); current = false }
    if (script.includes("keystroke return")) writes.push("Enter")
    return { result: script.includes("do script") ? "MATCH" : "Terminal" }
  }, async () => {
    expect(await injectText("guarded text", { tty: "/dev/ttys993", termProgram }, { canDeliver: () => current })).toBe(false)
    expect(writes).toEqual(["text"])
  })
})

test("guard: an iTerm miss cannot fall back to Terminal after invalidation", async () => {
  let current = true
  const scripts: string[] = []
  await macScripts((script) => { scripts.push(script); current = false; return { result: "MISS" } }, async () => {
    expect(await injectText("guarded text", { tty: "/dev/ttys993", termProgram: "iTerm" }, { canDeliver: () => current })).toBe(false)
    expect(scripts).toHaveLength(1)
  })
})

test("guard: AppleScript revalidates after the global focus lock wait", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<number>()
  let current = true
  const scripts: string[] = []
  await macScripts((script) => {
    scripts.push(script)
    if (scripts.length === 1) { entered.resolve(); return { exited: release.promise } }
    return {}
  }, async () => {
    const target = { tty: "/dev/ttys993", termProgram: "iTerm" }
    const first = injectText("earlier", target)
    await entered.promise
    const next = injectText("never type this", target, { canDeliver: () => current })
    current = false
    release.resolve(0)
    expect(await first).toBe(true)
    expect(await next).toBe(false)
    expect(scripts).toHaveLength(1)
  })
})

test("abort: guarded AppleScript kills the process and cannot send a late Enter or fallback", async () => {
  const gateSend = keyGate.send
  const gate = spyOn(keyGate, "send").mockImplementation((pane, key, fn, opts) => gateSend(pane, key, fn, { ...opts, timeoutMs: 20 }))
  let killed = 0
  const scripts: string[] = []
  try {
    await macScripts((script) => {
      scripts.push(script)
      const exit = Promise.withResolvers<number>()
      const timer = setTimeout(() => exit.resolve(0), 70)
      return { exited: exit.promise, kill: () => { killed++; clearTimeout(timer); setTimeout(() => exit.resolve(1), 10) } }
    }, async () => {
      expect(await injectText("guarded text", { tty: "/dev/ttys993", termProgram: "Apple_Terminal" }, { canDeliver: () => true })).toBe(false)
      await Bun.sleep(80)
      expect(killed).toBe(1)
      expect(scripts).toHaveLength(1)
    })
  } finally { gate.mockRestore() }
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

// ── tmux socket (P0, sessions batch 3) ──────────────────────────────────────
// A session on `tmux -L cc` must be typed into on THAT server: a bare
// `tmux send-keys -t %3` hits the default server's %3 — another claude.

test("inject: a target on a non-default socket sends `-S <socket>` with every send-keys", async () => {
  const r = recorder()
  const ok = await injectText("hi", { tmuxPane: "%3", tmuxSocket: "/tmp/tmux-501/cc" }, { sendKeys: r.sendKeys })
  expect(ok).toBe(true)
  expect(r.sent.map((s) => s.args)).toEqual([
    ["-S", "/tmp/tmux-501/cc", "send-keys", "-t", "%3", "-l", "hi"],
    ["-S", "/tmp/tmux-501/cc", "send-keys", "-t", "%3", "Enter"],
  ])
})

test("inject: no socket keeps the bare default-server argv", async () => {
  const r = recorder()
  await injectText("hi", { tmuxPane: "%3" }, { sendKeys: r.sendKeys })
  expect(r.sent[0]!.args).toEqual(["send-keys", "-t", "%3", "-l", "hi"])
})

test("inject: the key gate keys a pane by (socket, pane) — an Escape on default %3 does not delay cc %3", async () => {
  let escAt = 0
  await keyGate.send("%3", "Escape", async () => { escAt = performance.now() })
  const r = recorder()
  const res = await deliverViaTmux("%3", "x", r.sendKeys, Date.now() + 2_000, "/tmp/tmux-501/cc")
  expect(res.ok).toBe(true)
  expect(r.sent[0]!.at - escAt).toBeLessThan(ESC_SETTLE_MS - 1)
  // …while the same id on the same socket does wait the window out.
  await keyGate.send("/tmp/tmux-501/cc|%3", "Escape", async () => { escAt = performance.now() })
  const r2 = recorder()
  await deliverViaTmux("%3", "y", r2.sendKeys, Date.now() + 2_000, "/tmp/tmux-501/cc")
  expect(r2.sent[0]!.at - escAt).toBeGreaterThanOrEqual(ESC_SETTLE_MS - 1)
})
