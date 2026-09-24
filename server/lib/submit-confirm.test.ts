import { test, expect } from "bun:test"
import { type SubmitClock, SUBMIT_WINDOW_MS, activeWatchCount, confirmSubmit, noteUserPromptSubmit, paneExcerpt, watchSubmit } from "./submit-confirm"

// A manual clock: timers fire only when the test advances time.
function fakeClock() {
  let now = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let seq = 0
  const clock: SubmitClock = {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout(h) { timers.delete(h as number) },
  }
  async function advance(ms: number) {
    now += ms
    for (const [id, t] of [...timers]) {
      if (t.at <= now) { timers.delete(id); t.fn() }
    }
    await flush()
  }
  return { clock, advance, pending: () => timers.size }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

const ID = { key: "claude:tty:/dev/pts/7", sessionId: "9a6be474", tty: "/dev/pts/7" }

function harness(pane = "❯ hello\n") {
  const c = fakeClock()
  const watch = watchSubmit(ID)
  const presses: number[] = []
  let captures = 0
  const deps = {
    watch,
    clock: c.clock,
    pressEnter: async () => { presses.push(1); return true },
    capture: async () => { captures++; return pane },
  }
  return { c, watch, presses, deps, captures: () => captures }
}

test("confirm: the hook inside the first window confirms without a retry", async () => {
  const h = harness()
  const result = confirmSubmit(h.deps)
  await h.c.advance(1_200)
  noteUserPromptSubmit({ key: ID.key })
  expect(await result).toEqual({ ok: true, confirmed: true, retried: false })
  expect(h.presses).toEqual([])
  expect(h.c.pending()).toBe(0)
  h.watch.close()
})

test("confirm: a hook that lands before the wait starts still counts", async () => {
  const h = harness()
  noteUserPromptSubmit({ sessionId: ID.sessionId })
  expect(await confirmSubmit(h.deps)).toEqual({ ok: true, confirmed: true, retried: false })
  h.watch.close()
})

test("retry-then-confirm: no hook in 3 s → one more Enter → hook confirms", async () => {
  const h = harness()
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS - 1)
  expect(h.presses).toEqual([])
  await h.c.advance(1)
  expect(h.presses).toEqual([1])
  await h.c.advance(500)
  noteUserPromptSubmit({ tty: ID.tty })
  expect(await result).toEqual({ ok: true, confirmed: true, retried: true })
  h.watch.close()
})

test("not_submitted: no hook after Enter + retry → error with a pane excerpt", async () => {
  const h = harness("header\n\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n\n")
  let settled = false
  const result = confirmSubmit(h.deps).then((r) => { settled = true; return r })
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect(h.presses).toEqual([1])
  await h.c.advance(SUBMIT_WINDOW_MS - 1)
  expect(settled).toBe(false)
  await h.c.advance(1)
  expect(await result).toEqual({
    ok: false,
    error: "not_submitted",
    excerpt: "header\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No",
  })
  expect(h.presses.length).toBe(1)   // exactly one retry
  h.watch.close()
})

test("a hook from another session does not confirm", async () => {
  const h = harness()
  const result = confirmSubmit(h.deps)
  noteUserPromptSubmit({ key: "claude:tty:/dev/pts/9", sessionId: "other", tty: "/dev/pts/9" })
  noteUserPromptSubmit({})
  await h.c.advance(SUBMIT_WINDOW_MS)   // first window, then the retry's
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect((await result).ok).toBe(false)
  h.watch.close()
})

test("busy Claude: no hook is a queued prompt, not a loss — and no stray Enter", async () => {
  const h = harness("✻ Working… (12s · esc to interrupt)\n❯ \n")
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect(await result).toEqual({ ok: true, confirmed: false, queued: true })
  expect(h.presses).toEqual([])
  h.watch.close()
})

test("watches are released on close", () => {
  const before = activeWatchCount()
  const w = watchSubmit(ID)
  expect(activeWatchCount()).toBe(before + 1)
  w.close()
  expect(activeWatchCount()).toBe(before)
})

test("paneExcerpt keeps the last non-blank lines, capped", () => {
  expect(paneExcerpt(null)).toBe("")
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
  expect(paneExcerpt(many).split("\n")).toEqual(Array.from({ length: 8 }, (_, i) => `line ${i + 12}`))
  expect(paneExcerpt("x".repeat(2_000)).length).toBe(600)
})
