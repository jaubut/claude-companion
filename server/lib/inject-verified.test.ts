import { test, expect } from "bun:test"
import { COMPACT_TEXT } from "./auto-compact-keep"
import { inputText } from "./command-menu"
import {
  CHUNK_CHARS, CHUNK_GAP_MS, CLEAR_MAX_PRESSES, MENU_SETTLE_MS, TYPE_SETTLE_MS, VERIFIED_TEXT_MAX,
  capKeep, injectVerifiedWith, type VerifiedInjectDeps,
} from "./inject-verified"

const ref = { pane: "%1", socket: "" }
const sig = new AbortController().signal

// Claude Code's input box, wrapped at `width` columns: `❯ ` then indented rows.
function render(box: string, width: number): string {
  const rows: string[] = []
  for (let i = 0; i < box.length || i === 0; i += width) rows.push(box.slice(i, i + width))
  return `${"─".repeat(width + 2)}\n❯ ${rows[0]}\n${rows.slice(1).map((r) => `  ${r}\n`).join("")}${"─".repeat(width + 2)}\n  ? for shortcuts\n`
}

// A pane model: typed text accumulates in the box. `lose` drops that many
// leading chars of an attempt (the Mac failure: the head of the burst vanished).
function fake(opts: { lose?: number; loseFirstOnly?: boolean; width?: number } = {}) {
  const calls: string[] = []
  let box = ""
  let attempts = 0
  let fresh = true
  const d: VerifiedInjectDeps = {
    async type(_r, text) {
      calls.push(`type:${text}`)
      if (fresh) { attempts++; fresh = false }
      const lose = opts.loseFirstOnly && attempts > 1 ? 0 : (opts.lose ?? 0)
      box += box.length === 0 ? text.slice(lose) : text
      return true
    },
    async capture() { return render(box, opts.width ?? 200) },
    async key(_r, key) {
      calls.push(`key:${key}`)
      if (key === "C-u") { box = ""; fresh = true }
      if (key === "Enter") calls.push(`submitted:${box}`)
      return true
    },
    sleep: async (ms) => { calls.push(`sleep:${ms}`) },
    log: (l) => calls.push(`log:${l}`),
  }
  return { d, calls }
}

const longKeep = `/compact keep: ${"Auto-compress canvas images on save; ".repeat(60)}`
const typed = (calls: string[]) => calls.filter((c) => c.startsWith("type:")).map((c) => c.slice(5))
const keys = (calls: string[]) => calls.filter((c) => c.startsWith("key:"))

test("staged typing: /compact alone, menu settle, then ≤200-char chunks with gaps", async () => {
  const { d, calls } = fake()
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  const sent = capKeep(longKeep)
  expect(r).toEqual({ ok: true, text: sent, fellBack: false })
  const steps = calls.filter((c) => c.startsWith("type:") || c.startsWith("sleep:") || c.startsWith("key:"))
  expect(steps[0]).toBe("type:/compact")
  expect(steps[1]).toBe(`sleep:${MENU_SETTLE_MS}`)
  const chunks = typed(calls).slice(1)
  expect(chunks.length).toBe(Math.ceil((VERIFIED_TEXT_MAX - "/compact".length) / CHUNK_CHARS))
  expect(chunks.every((c) => c.length <= CHUNK_CHARS)).toBe(true)
  expect(chunks[0]!.startsWith(" keep: ")).toBe(true)
  expect(`/compact${chunks.join("")}`).toBe(sent)
  // a gap between chunks, the settle before the read-back, then Enter last
  expect(steps.filter((c) => c === `sleep:${CHUNK_GAP_MS}`).length).toBe(chunks.length - 1)
  expect(steps.at(-2)).toBe(`sleep:${TYPE_SETTLE_MS}`)
  expect(steps.at(-1)).toBe("key:Enter")
  expect(calls).toContain(`submitted:${sent}`)
})

test("no paste anywhere in the delivery path: the deps have no paste, only type/key", async () => {
  const { d, calls } = fake()
  expect(Object.keys(d).sort()).toEqual(["capture", "key", "log", "sleep", "type"])
  await injectVerifiedWith(ref, longKeep, d, sig)
  expect(calls.filter((c) => /paste/i.test(c.split(":")[0]!))).toEqual([])
  const src = await Bun.file(new URL("./inject-verified.ts", import.meta.url)).text()
  expect(src).not.toMatch(/paste-buffer|load-buffer/)
})

test("a long keep wraps across rows and still reads back; Enter pressed", async () => {
  const { d, calls } = fake({ width: 60 })
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(r).toEqual({ ok: true, text: capKeep(longKeep), fellBack: false })
  expect(keys(calls)).toEqual(["key:Enter"])
})

test("inputText joins a wrapped input box (styled or plain) and stops at the divider", () => {
  const text = capKeep(longKeep)
  const pane = render(text, 60)
  expect(pane.split("\n").length).toBeGreaterThan(14)
  expect(inputText(pane)!.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""))
  const styled = pane.replace("❯ ", "❯ \x1b[0m").replace("? for shortcuts", "\x1b[2m? for shortcuts\x1b[0m")
  expect(inputText(styled)!.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""))
  expect(inputText(render("", 60))).toBe("")
})

test("a keep under the cap is delivered unmodified", async () => {
  const { d } = fake()
  const text = `/compact keep: ${"x".repeat(700)}`
  const r = await injectVerifiedWith(ref, text, d, sig)
  expect(r).toEqual({ ok: true, text, fellBack: false })
})

test("newlines in the keep are flattened: a typed newline would submit early", async () => {
  const { d, calls } = fake()
  await injectVerifiedWith(ref, "/compact keep: a\nb\r\nc", d, sig)
  expect(typed(calls).join("")).toBe("/compact keep: a b c")
})

test("a mangled read-back never gets an Enter; Ctrl-U then the generic command typed the same way", async () => {
  const { d, calls } = fake({ lose: 15, loseFirstOnly: true })
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(r).toEqual({ ok: true, text: COMPACT_TEXT, fellBack: true })
  expect(keys(calls)).toEqual(["key:C-u", "key:Enter"])
  const afterClear = calls.slice(calls.indexOf("key:C-u") + 1)
  expect(typed(afterClear)[0]).toBe("/compact")
  expect(afterClear[afterClear.findIndex((c) => c === "type:/compact") + 1]).toBe(`sleep:${MENU_SETTLE_MS}`)
  expect(calls).toContain(`submitted:${COMPACT_TEXT}`)
})

test("mismatch → Ctrl-U → generic retry mismatches too → nothing submitted", async () => {
  const { d, calls } = fake({ lose: 15 })
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toBe("input_mismatch")
  expect(keys(calls)).toEqual(["key:C-u", "key:C-u"])
  expect(calls.some((c) => c.startsWith("submitted:"))).toBe(false)
  expect(typed(calls).filter((t) => t === "/compact").length).toBe(2)
})

test("plain /compact that mangles aborts without a second retry", async () => {
  const { d, calls } = fake({ lose: 5 })
  const r = await injectVerifiedWith(ref, COMPACT_TEXT, d, sig)
  expect(r.ok).toBe(false)
  expect(typed(calls).filter((t) => t === "/compact").length).toBe(1)
  expect(calls).not.toContain("key:Enter")
})

test("unreadable pane: cleared, no Enter", async () => {
  const { d, calls } = fake()
  d.capture = async () => null
  const r = await injectVerifiedWith(ref, COMPACT_TEXT, d, sig)
  expect(r.ok).toBe(false)
  expect(calls).not.toContain("key:Enter")
})

test("failed typing never presses Enter; the half-typed line is cleared", async () => {
  const { d, calls } = fake()
  d.type = async () => false
  const r = await injectVerifiedWith(ref, COMPACT_TEXT, d, sig)
  expect(r).toEqual({ ok: false, error: "type_failed" })
  expect(calls).not.toContain("key:Enter")
  expect(calls).toContain("key:C-u")
})

// Claude Code's real Ctrl-U: it deletes ONE wrapped row (the last), not the
// whole input. `lose` mangles every attempt's head so the read-back mismatches.
function rowWise(opts: { width: number; lose: number; stuck?: boolean }) {
  const calls: string[] = []
  let box = ""
  const d: VerifiedInjectDeps = {
    async type(_r, text) {
      calls.push(`type:${text}`)
      box += box.length === 0 ? text.slice(opts.lose) : text
      return true
    },
    async capture() { return render(box, opts.width) },
    async key(_r, key) {
      calls.push(`key:${key}`)
      if (key === "C-u" && !opts.stuck) {
        const rows = Math.ceil(box.length / opts.width)
        box = box.slice(0, Math.max(0, rows - 1) * opts.width)
      }
      if (key === "Enter") calls.push(`submitted:${box}`)
      return true
    },
    sleep: async () => {},
    log: (l) => calls.push(`log:${l}`),
  }
  return { d, calls, box: () => box }
}

test("a wrapped input that needs N Ctrl-U is cleared until the read-back is empty", async () => {
  const width = 20
  const { d, calls, box } = rowWise({ width, lose: 5 })
  const n = Math.ceil((COMPACT_TEXT.length - 5) / width)
  expect(n).toBeGreaterThan(1)
  const r = await injectVerifiedWith(ref, COMPACT_TEXT, d, sig)
  expect(r.ok).toBe(false)
  expect(calls.filter((c) => c === "key:C-u").length).toBe(n)
  if (!r.ok) {
    expect(r.error).toBe("input_mismatch")
    expect(r.residue).toBeUndefined()
  }
  expect(box()).toBe("")
  expect(inputText(await d.capture(ref, sig) as string)).toBe("")
  expect(calls).not.toContain("key:Enter")
})

test("long keep at 60 cols: several Ctrl-U per attempt, box empty after both attempts", async () => {
  const { d, calls, box } = rowWise({ width: 60, lose: 15 })
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toBe("input_mismatch")
  // The first (long) attempt wraps to many rows: more than one press to clear it.
  const firstRetry = calls.findIndex((c, i) => i > 0 && c === "type:/compact" && calls.slice(0, i).includes("key:C-u"))
  const pressesFirst = calls.slice(0, firstRetry).filter((c) => c === "key:C-u").length
  expect(pressesFirst).toBeGreaterThan(5)
  expect(box()).toBe("")
  expect(inputText(await d.capture(ref, sig) as string)).toBe("")
})

test("a residue that will not clear: capped presses, logged, reported, no retry typed on top", async () => {
  const { d, calls } = rowWise({ width: 60, lose: 15, stuck: true })
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.error).toBe("input_mismatch")
    expect(r.residue).toBe(true)
  }
  expect(calls.filter((c) => c === "key:C-u").length).toBe(CLEAR_MAX_PRESSES)
  expect(calls.some((c) => c.startsWith("log:") && c.includes("residue left"))).toBe(true)
  expect(typed(calls).filter((t) => t === "/compact").length).toBe(1)
  expect(calls).not.toContain("key:Enter")
})

test("pane 11 cols wide → pane_too_narrow, zero keystrokes sent", async () => {
  const { d, calls } = fake()
  d.width = async () => 11
  const r = await injectVerifiedWith(ref, longKeep, d, sig)
  expect(r).toEqual({ ok: false, error: "pane_too_narrow", width: 11 })
  expect(typed(calls)).toEqual([])
  expect(keys(calls)).toEqual([])
  expect(calls.some((c) => c.startsWith("log:") && c.includes("11 cols"))).toBe(true)
})

test("a wide pane, or an unknown width, types as before", async () => {
  for (const w of [160, null]) {
    const { d } = fake()
    d.width = async () => w
    const r = await injectVerifiedWith(ref, longKeep, d, sig)
    expect(r.ok).toBe(true)
  }
})
