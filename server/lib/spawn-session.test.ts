import { test, expect } from "bun:test"
import { buildInner } from "./spawn-session"

// The inner command tmux runs. Both spawn paths build it here — the Mac one
// wraps it in `tmux new-session -s <sess> '<inner>'` for AppleScript, the Linux
// one hands it to `/bin/sh -c` — so pinning this string pins both.

const CWD = "/Users/jeremieaubut/claude-companion"

test("no env keeps the command byte-identical to the pre-Phase-8 form", () => {
  expect(buildInner(CWD, "claude")).toBe(`cd '${CWD}' && claude`)
  expect(buildInner(CWD, "codex", {})).toBe(`cd '${CWD}' && codex`)
})

test("the export comes FIRST, terminated by ';', before the cd", () => {
  // Load-bearing. `COMPANION_TASK_ID=abc123 cd … && claude` is a command
  // assignment in POSIX sh: it scopes to `cd` alone, so claude — and every hook
  // claude spawns — would never see it, and every worker would fall back to
  // guessing by cwd.
  const inner = buildInner(CWD, "claude", { COMPANION_TASK_ID: "abc123" })
  expect(inner).toBe(`export COMPANION_TASK_ID=abc123; cd '${CWD}' && claude`)
  expect(inner.indexOf("export COMPANION_TASK_ID=abc123;")).toBe(0)
  expect(inner.indexOf("export")).toBeLessThan(inner.indexOf("cd '"))
})

test("the export also precedes the kimi env sourcing", () => {
  expect(buildInner(CWD, "kimi", { COMPANION_TASK_ID: "abc123" }))
    .toBe(`export COMPANION_TASK_ID=abc123; cd '${CWD}' && . "$HOME/.config/kimi/kimi.env" && claude`)
})

test("a path with an apostrophe is still single-quote escaped around the export", () => {
  expect(buildInner("/Users/j/Jeremie's Films", "claude", { COMPANION_TASK_ID: "abc123" }))
    .toBe(`export COMPANION_TASK_ID=abc123; cd '/Users/j/Jeremie'\\''s Films' && claude`)
})

test("a value carrying shell metacharacters throws instead of shipping a command line", () => {
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "x; rm -rf /" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "a b" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "$(id)" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "`id`" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { COMPANION_TASK_ID: "" })).toThrow(/unsafe value/)
  expect(() => buildInner(CWD, "claude", { "BAD KEY": "ok" })).toThrow(/unsafe key/)
})

test("a real dispatch id passes the charset", () => {
  // Task ids are crypto.randomUUID().slice(0, 8) — always 8 hex chars.
  const id = crypto.randomUUID().slice(0, 8)
  expect(buildInner(CWD, "claude", { COMPANION_TASK_ID: id })).toBe(`export COMPANION_TASK_ID=${id}; cd '${CWD}' && claude`)
})
