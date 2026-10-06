import { test, expect } from "bun:test"
import { COMPACT_TEXT } from "./auto-compact-keep"
import { capKeep, injectVerifiedWith, VERIFIED_TEXT_MAX, type VerifiedInjectDeps } from "./inject-verified"

const ref = { pane: "%1", socket: "" }
const sig = new AbortController().signal

// A pane model: the input box holds what was pasted, minus `lose` leading chars
// (the Mac failure: the head of the burst vanished).
function fake(opts: { lose?: number; loseFirstOnly?: boolean } = {}) {
  const calls: string[] = []
  let box = ""
  let pastes = 0
  const d: VerifiedInjectDeps = {
    async paste(_r, text) {
      pastes++
      calls.push(`paste:${text.length}`)
      const lose = opts.loseFirstOnly && pastes > 1 ? 0 : (opts.lose ?? 0)
      box = text.slice(lose)
      return true
    },
    async capture() { return `────\n❯ ${box}\n────\n` },
    async key(_r, key) {
      calls.push(`key:${key}`)
      if (key === "C-u") box = ""
      return true
    },
    sleep: async () => {},
    log: (l) => calls.push(`log:${l}`),
  }
  return { d, calls }
}

const longKeep = `/compact keep: ${"Auto-compress canvas images on save; ".repeat(60)}`

test("a long keep is capped, pasted as one block and submitted intact", async () => {
  const { d, calls } = fake()
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(longKeep.length).toBeGreaterThan(1500)
  expect(r).toEqual({ ok: true, text: capKeep(longKeep), fellBack: false })
  expect(calls.filter((c) => c.startsWith("paste"))).toEqual([`paste:${VERIFIED_TEXT_MAX}`])
  expect(calls.filter((c) => c.startsWith("key"))).toEqual(["key:Enter"])
})

test("a keep under the cap is delivered unmodified", async () => {
  const { d } = fake()
  const text = `/compact keep: ${"x".repeat(700)}`
  const r = await injectVerifiedWith(ref, text, d, sig)
  expect(r).toEqual({ ok: true, text, fellBack: false })
})

test("a mangled read-back never gets an Enter; falls back to plain /compact", async () => {
  const { d, calls } = fake({ lose: 15, loseFirstOnly: true })
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(r).toEqual({ ok: true, text: COMPACT_TEXT, fellBack: true })
  const keys = calls.filter((c) => c.startsWith("key"))
  // clear after the bad paste, Enter only after the good one
  expect(keys).toEqual(["key:C-u", "key:Enter"])
})

test("mangled both times: abort, line cleared, no Enter", async () => {
  const { d, calls } = fake({ lose: 15 })
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toBe("input_mismatch")
  expect(calls).not.toContain("key:Enter")
  expect(calls.filter((c) => c === "key:C-u").length).toBe(2)
})

test("plain /compact that mangles aborts without a second retry", async () => {
  const { d, calls } = fake({ lose: 5 })
  const r = await injectVerifiedWith(ref, COMPACT_TEXT, d, sig)
  expect(r.ok).toBe(false)
  expect(calls.filter((c) => c.startsWith("paste")).length).toBe(1)
  expect(calls).not.toContain("key:Enter")
})

test("unreadable pane: cleared, no Enter", async () => {
  const { d, calls } = fake()
  d.capture = async () => null
  const r = await injectVerifiedWith(ref, COMPACT_TEXT, d, sig)
  expect(r.ok).toBe(false)
  expect(calls).not.toContain("key:Enter")
})

test("failed paste never presses Enter", async () => {
  const { d, calls } = fake()
  d.paste = async () => false
  const r = await injectVerifiedWith(ref, COMPACT_TEXT, d, sig)
  expect(r).toEqual({ ok: false, error: "paste_failed" })
  expect(calls).not.toContain("key:Enter")
})
