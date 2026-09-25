import { test, expect } from "bun:test"
import {
  type ConfirmDeps,
  type SubmitClock,
  confirmSubmit,
  deliveryFailedHint,
  echoPromptOnInject,
  isHooklessInput,
  noteSessionBoundary,
  noteUserPromptSubmit,
  watchSubmit,
} from "./submit-confirm"

// Slash commands and bash-mode (fix 1, audit 2026-09-25): `/exit` delivered,
// the session ended, and the server still said "not submitted".

function fakeClock() {
  const timers = new Map<number, { at: number; fn: () => void }>()
  let now = 0
  let seq = 0
  const clock: SubmitClock = {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout(h) { timers.delete(h as number) },
  }
  async function advance(ms: number) {
    now += ms
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn() }
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return { clock, advance }
}

const DIV = "─".repeat(40)
const EMPTY_BOX = `${DIV}\n❯ \n${DIV}\n  ⏸ manual mode on · ? for shortcuts\n`
const ID = { key: "claude:tty:/dev/pts/7", sessionId: "9a6be474", tty: "/dev/pts/7", pane: "%89" }

function deps(text: string, over: Partial<ConfirmDeps> = {}) {
  const c = fakeClock()
  const presses: number[] = []
  const watch = watchSubmit(ID, { boundary: isHooklessInput(text) })
  const d: ConfirmDeps = {
    watch,
    text,
    clock: c.clock,
    hookless: isHooklessInput(text),
    pressEnter: async () => { presses.push(1); return true },
    capture: async () => EMPTY_BOX,
    busy: async () => false,
    ...over,
  }
  return { c, d, watch, presses }
}

test("isHooklessInput: slash commands and bash-mode, after trim", () => {
  expect(isHooklessInput("/exit")).toBe(true)
  expect(isHooklessInput("  /clear ")).toBe(true)
  expect(isHooklessInput("!ls -la")).toBe(true)
  expect(isHooklessInput("hello /exit")).toBe(false)
  expect(isHooklessInput("fix the bug")).toBe(false)
})

test("/exit with no hook and no boundary: ok (command), never not_submitted", async () => {
  const { c, d, watch } = deps("/exit")
  const p = confirmSubmit(d)
  await c.advance(3_000)
  await c.advance(3_000)
  expect(await p).toEqual({ ok: true, confirmed: false, command: true })
  watch.close()
})

test("!cmd bash-mode with no hook: ok (command)", async () => {
  const { c, d, watch } = deps("!git status")
  const p = confirmSubmit(d)
  await c.advance(3_000)
  await c.advance(3_000)
  const r = await p
  expect(r.ok).toBe(true)
  expect("command" in r && r.command).toBe(true)
  watch.close()
})

test("a SessionEnd for the same pane confirms /exit", async () => {
  const { c, d, watch } = deps("/exit")
  const p = confirmSubmit(d)
  await c.advance(500)
  noteSessionBoundary({ sessionId: "other", pane: "%89" })
  expect(await p).toEqual({ ok: true, confirmed: true, retried: false })
  watch.close()
})

test("a SessionStart(clear) matched by tty confirms /clear (the session id changes)", async () => {
  const { c, d, watch } = deps("/clear")
  const p = confirmSubmit(d)
  await c.advance(200)
  noteSessionBoundary({ sessionId: "brand-new-after-clear", tty: "/dev/pts/7" })
  expect(await p).toEqual({ ok: true, confirmed: true, retried: false })
  watch.close()
})

test("a session boundary never confirms a typed prompt; a boundary elsewhere never confirms a command", async () => {
  const typed = deps("hello there")
  const p1 = confirmSubmit(typed.d)
  noteSessionBoundary({ pane: "%89", tty: "/dev/pts/7" })
  await typed.c.advance(3_000)
  await typed.c.advance(3_000)
  const r1 = await p1
  expect(r1.ok).toBe(false)
  typed.watch.close()

  const cmd = deps("/exit")
  const p2 = confirmSubmit(cmd.d)
  noteSessionBoundary({ pane: "%12", tty: "/dev/pts/3", sessionId: "zzz" })
  await cmd.c.advance(3_000)
  await cmd.c.advance(3_000)
  expect(await p2).toEqual({ ok: true, confirmed: false, command: true })
  cmd.watch.close()
})

test("a slash command that expands to a prompt still confirms by its hook", async () => {
  const { c, d, watch } = deps("/build my-app")
  const p = confirmSubmit(d)
  await c.advance(100)
  noteUserPromptSubmit({ sessionId: "9a6be474" })
  expect(await p).toEqual({ ok: true, confirmed: true, retried: false })
  watch.close()
})

test("a command result is not echoed into the feed (no Thinking pill for /exit)", () => {
  expect(echoPromptOnInject({ ok: true, confirmed: false, command: true })).toBe(false)
  expect(echoPromptOnInject({ ok: true, confirmed: false })).toBe(true)
})

// Fix 4: the Mac-only hint on Linux.
test("deliveryFailedHint names tmux on Linux, Accessibility only on macOS", () => {
  const linux = deliveryFailedHint("linux")
  expect(linux).not.toMatch(/osascript|Accessibility/)
  expect(linux).toMatch(/not running inside tmux/)
  expect(linux).toMatch(/cc-tmux/)
  expect(deliveryFailedHint("darwin")).toMatch(/Accessibility/)
})
