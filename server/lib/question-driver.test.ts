import { test, expect } from "bun:test"
import { driveQuestionPicker, pickerRegion, type PickerIO } from "./question-driver"
import type { QuestionItem, QuestionAnswer } from "./questions"

// A fake of the real picker, transcribed from live captures on 2026-09-05:
// digit picks a row (single-select auto-advances, multi toggles), Tab moves to
// the next tab, Enter on the review tab submits. Renders text the driver reads.
class FakePicker implements PickerIO {
  tab = 0                       // index into questions; questions.length = review
  checked = new Map<number, Set<number>>()
  typed = new Map<number, string>()
  submitted = false
  mounted = false
  keys: string[] = []
  mountDelayPolls: number
  polls = 0
  prompt = "Use the AskUserQuestion tool right now, to ask me exactly two questions. Question 1: Pick one color."

  constructor(readonly questions: QuestionItem[], mountDelayPolls = 3) {
    this.mountDelayPolls = mountDelayPolls
  }

  capture = async (): Promise<string | null> => {
    this.polls++
    if (this.polls >= this.mountDelayPolls) this.mounted = true
    const lines = [`❯ ${this.prompt}`, "────────"]
    if (!this.mounted) return lines.join("\n")
    if (this.submitted) {
      lines.push("● User answered Claude's questions:")
      return lines.join("\n")
    }
    const tabs = this.questions.map((q, i) => `${i < this.tab ? "☒" : "☐"} ${q.header}`).join("  ")
    lines.push(`←  ${tabs}  ✔ Submit  →`)
    if (this.tab >= this.questions.length) {
      lines.push("Review your answers", "Ready to submit your answers?", "❯ 1. Submit answers", "  2. Cancel")
    } else {
      const q = this.questions[this.tab]!
      lines.push(q.question)
      q.options.forEach((o, i) => lines.push(q.multiSelect ? `  ${i + 1}. [${this.checked.get(this.tab)?.has(i) ? "✔" : " "}] ${o.label}` : `  ${i + 1}. ${o.label}`))
      lines.push(`  ${q.options.length + 1}. Type something`, "Enter to select · Tab/Arrow keys to navigate · Esc to cancel")
    }
    return lines.join("\n")
  }

  async key(name: "Tab" | "Enter"): Promise<boolean> {
    this.keys.push(name)
    if (!this.mounted) return true
    if (name === "Tab") { this.tab = Math.min(this.tab + 1, this.questions.length); return true }
    // Enter
    if (this.tab >= this.questions.length) { this.submitted = true; return true }
    // Enter while typing custom text confirms it and advances like a pick.
    if (this.typed.has(this.tab)) { this.tab++; return true }
    return true
  }

  async digit(n: number): Promise<boolean> {
    this.keys.push(String(n))
    if (!this.mounted || this.tab >= this.questions.length) return true
    const q = this.questions[this.tab]!
    if (n === q.options.length + 1) { this.typed.set(this.tab, ""); return true }
    if (q.multiSelect) {
      const set = this.checked.get(this.tab) ?? new Set<number>()
      set.has(n - 1) ? set.delete(n - 1) : set.add(n - 1)
      this.checked.set(this.tab, set)
      return true
    }
    this.checked.set(this.tab, new Set([n - 1]))
    this.tab++ // single-select auto-advance
    return true
  }

  async text(s: string): Promise<boolean> {
    this.keys.push(`text:${s}`)
    if (this.typed.has(this.tab)) this.typed.set(this.tab, s)
    return true
  }

  sleep = async (_ms: number): Promise<void> => {}

  answersOf(i: number): string[] {
    const q = this.questions[i]!
    const picked = [...(this.checked.get(i) ?? [])].sort().map((k) => q.options[k]!.label)
    const t = this.typed.get(i)
    return t ? [...picked, t] : picked
  }
}

const color: QuestionItem = { header: "Color", question: "Pick one color", multiSelect: false, options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }] }
const toppings: QuestionItem = { header: "Toppings", question: "Pick toppings", multiSelect: true, options: [{ label: "Cheese" }, { label: "Olives" }, { label: "Ham" }] }

test("single then multi: digits, Tab to review, Enter submits — the live-mapped grammar", async () => {
  const p = new FakePicker([color, toppings])
  const r = await driveQuestionPicker(p, [color, toppings], [{ selected: ["Green"] }, { selected: ["Cheese", "Ham"] }])
  expect(r).toEqual({ ok: true, reason: "" })
  expect(p.answersOf(0)).toEqual(["Green"])
  expect(p.answersOf(1)).toEqual(["Cheese", "Ham"])
  expect(p.submitted).toBe(true)
  expect(p.keys).toEqual(["2", "1", "3", "Tab", "Enter"])
})

test("waits for the picker to mount instead of typing into the prompt", async () => {
  const p = new FakePicker([color], 8)
  const r = await driveQuestionPicker(p, [color], [{ selected: ["Blue"] }])
  expect(r.ok).toBe(true)
  expect(p.answersOf(0)).toEqual(["Blue"])
  expect(p.polls).toBeGreaterThanOrEqual(8)
})

test("single-select as the last question auto-advances: no Tab before Enter", async () => {
  const p = new FakePicker([toppings, color])
  const r = await driveQuestionPicker(p, [toppings, color], [{ selected: ["Olives"] }, { selected: ["Red"] }])
  expect(r.ok).toBe(true)
  expect(p.keys).toEqual(["2", "Tab", "1", "Enter"])
  expect(p.answersOf(0)).toEqual(["Olives"])
  expect(p.answersOf(1)).toEqual(["Red"])
})

test("Other on a single-select goes through the Type-something row", async () => {
  const p = new FakePicker([color])
  const r = await driveQuestionPicker(p, [color], [{ selected: ["Other"], otherText: "Teal" }])
  expect(r.ok).toBe(true)
  expect(p.keys).toEqual(["4", "text:Teal", "Enter", "Enter"])
  expect(p.answersOf(0)).toEqual(["Teal"])
})

test("fails loudly when the picker never mounts (no blind typing)", async () => {
  const p = new FakePicker([color], 10_000)
  const io: PickerIO = { ...p, capture: async () => "❯ still the prompt", key: p.key.bind(p), digit: p.digit.bind(p), text: p.text.bind(p), sleep: async () => {} }
  // Shrink the wait by making capture return quickly forever; the driver's
  // mount timeout is wall-clock, so bound it with a fake clock via Date.now.
  const realNow = Date.now
  let t = realNow()
  Date.now = () => (t += 2_000)
  try {
    const r = await driveQuestionPicker(io, [color], [{ selected: ["Red"] }])
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("picker never mounted")
    expect(p.keys).toEqual([])
  } finally {
    Date.now = realNow
  }
})

test("blind mode (no pane) still emits the grammar with gaps", async () => {
  const p = new FakePicker([color, toppings], 0)
  p.mounted = true
  const io: PickerIO = { capture: null, key: p.key.bind(p), digit: p.digit.bind(p), text: p.text.bind(p), sleep: async () => {} }
  const r = await driveQuestionPicker(io, [color, toppings], [{ selected: ["Red"] }, { selected: ["Ham"] }])
  expect(r.ok).toBe(true)
  expect(p.keys).toEqual(["1", "3", "Tab", "Enter"])
  expect(p.submitted).toBe(true)
})

test("pickerRegion ignores the prompt echo above the tab bar", () => {
  const pane = "❯ ask me: Pick one color\n────\n←  ☐ Color  ✔ Submit  →\nPick one color\n❯ 1. Red"
  expect(pickerRegion(pane)).toBe("←  ☐ Color  ✔ Submit  →\nPick one color\n❯ 1. Red")
  expect(pickerRegion("no picker here")).toBe("")
})
