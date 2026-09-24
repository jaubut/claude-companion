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

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

const ID = { key: "claude:tty:/dev/pts/7", sessionId: "9a6be474", tty: "/dev/pts/7" }
const DIV = "─".repeat(40)
const box = (input: string, footer = "  ⏸ manual mode on · ? for shortcuts") => `${DIV}\n${input}\n${DIV}\n${footer}\n`

// Text still typed in the box: the Enter was lost.
const STUCK = box("❯ hello there")
// Empty box with Claude Code's dim predicted reply (capture-pane -e).
const GHOST = box("❯ \x1b[2mdone, service is running\x1b[0m")
const PICKER = "  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n"
const BUSY_QUEUED = "✻ Working… (12s · esc to interrupt)\n❯ hello there\n" + box("❯ ", "  esc to interrupt")
const BUSY_NOT_QUEUED = "✻ Working… (12s · esc to interrupt)\n" + box("❯ ", "  esc to interrupt")

function harness(panes: string | Array<string | null>) {
  const c = fakeClock()
  const watch = watchSubmit(ID)
  const presses: number[] = []
  const seq = Array.isArray(panes) ? panes : [panes]
  let captures = 0
  const deps = {
    watch,
    text: "hello there",
    clock: c.clock,
    pressEnter: async () => { presses.push(1); return true },
    capture: async () => seq[Math.min(captures++, seq.length - 1)] ?? null,
  }
  return { c, watch, presses, deps, captures: () => captures }
}

test("confirm: the hook inside the first window confirms without a retry", async () => {
  const h = harness(STUCK)
  const result = confirmSubmit(h.deps)
  await h.c.advance(1_200)
  noteUserPromptSubmit({ key: ID.key })
  expect(await result).toEqual({ ok: true, confirmed: true, retried: false })
  expect(h.presses).toEqual([])
  expect(h.c.pending()).toBe(0)
  h.watch.close()
})

test("confirm: a hook that lands before the wait starts still counts", async () => {
  const h = harness(STUCK)
  noteUserPromptSubmit({ sessionId: ID.sessionId })
  expect(await confirmSubmit(h.deps)).toEqual({ ok: true, confirmed: true, retried: false })
  h.watch.close()
})

test("retry-then-confirm: our text still in the box → one more Enter → hook confirms", async () => {
  const h = harness(STUCK)
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

test("retry that still gets no hook → not_submitted, exactly one retry", async () => {
  const h = harness(STUCK)
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS)
  await h.c.advance(SUBMIT_WINDOW_MS)
  const r = await result
  expect(r.ok).toBe(false)
  expect(h.presses.length).toBe(1)
  h.watch.close()
})

test("a picker on screen: NO Enter is pressed (it would answer the prompt)", async () => {
  const h = harness(PICKER)
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect(await result).toEqual({ ok: false, error: "not_submitted", excerpt: "  Do you want to proceed?\n  ❯ 1. Yes\n    2. No" })
  expect(h.presses).toEqual([])
  h.watch.close()
})

test("empty box with a dim predicted reply: text went elsewhere, no Enter, not_submitted", async () => {
  const h = harness(GHOST)
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS)
  const r = await result
  expect(r.ok).toBe(false)
  expect(h.presses).toEqual([])
  if (!r.ok) expect(r.excerpt).not.toContain("\x1b")
  h.watch.close()
})

test("hook landing during the capture: no spurious Enter", async () => {
  const h = harness(STUCK)
  h.deps.capture = async () => { noteUserPromptSubmit({ key: ID.key }); return STUCK }
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect(await result).toEqual({ ok: true, confirmed: true, retried: false })
  expect(h.presses).toEqual([])
  h.watch.close()
})

test("busy Claude with our text in its queue: queued, no stray Enter", async () => {
  const h = harness(BUSY_QUEUED)
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect(await result).toEqual({ ok: true, confirmed: false, queued: true })
  expect(h.presses).toEqual([])
  h.watch.close()
})

test("busy Claude but our text nowhere: a loss, not 'queued'", async () => {
  const h = harness(BUSY_NOT_QUEUED)
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect((await result).ok).toBe(false)
  expect(h.presses).toEqual([])
  h.watch.close()
})

test("capture failure: not_submitted with no excerpt, no Enter", async () => {
  const h = harness([null])
  const result = confirmSubmit(h.deps)
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect(await result).toEqual({ ok: false, error: "not_submitted", excerpt: "" })
  expect(h.presses).toEqual([])
  h.watch.close()
})

test("a hook from another session does not confirm", async () => {
  const h = harness(STUCK)
  const result = confirmSubmit(h.deps)
  noteUserPromptSubmit({ key: "claude:tty:/dev/pts/9", sessionId: "other", tty: "/dev/pts/9" })
  noteUserPromptSubmit({})
  await h.c.advance(SUBMIT_WINDOW_MS)
  await h.c.advance(SUBMIT_WINDOW_MS)
  expect((await result).ok).toBe(false)
  h.watch.close()
})

test("watches are released on close", () => {
  const before = activeWatchCount()
  const w = watchSubmit(ID)
  expect(activeWatchCount()).toBe(before + 1)
  w.close()
  expect(activeWatchCount()).toBe(before)
})

test("paneExcerpt keeps the last non-blank lines, capped, unstyled", () => {
  expect(paneExcerpt(null)).toBe("")
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
  expect(paneExcerpt(many).split("\n")).toEqual(Array.from({ length: 8 }, (_, i) => `line ${i + 12}`))
  expect(paneExcerpt("x".repeat(2_000)).length).toBe(600)
  expect(paneExcerpt("\x1b[2mdim\x1b[0m")).toBe("dim")
})
