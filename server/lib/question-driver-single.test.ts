import { test, expect } from "bun:test"
import { answeredCount, driveQuestionPicker, pickerShowsQuestions, type PickerIO } from "./question-driver"
import type { QuestionItem } from "./questions"

// The single-question picker as captured live on CC 2.1.282 (2026-09-25):
// no tab bar, no review screen, a digit submits at once. The old driver
// waited for a review and logged "review screen never appeared" for an
// answer that had gone through.
const color: QuestionItem = { header: "Color", question: "Which color test?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }

const PICKER = [
  "⏺ User answered Claude's questions:",       // an EARLIER question, still on screen
  "  ⎿  · Which fruit test? → Banana",
  "❯ Ask me which color",
  "────────",
  " ☐ Color",
  "Which color test?",
  "❯ 1. Red",
  "  2. Blue",
  "  3. Type something.",
  "────────",
  "  4. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n")

function singlePicker() {
  let picked: number | null = null
  const keys: string[] = []
  const io: PickerIO = {
    capture: async () => picked === null
      ? PICKER
      : PICKER.split("\n").slice(0, 4).join("\n") + `\n⏺ User answered Claude's questions:\n  ⎿  · Which color test? → ${color.options[picked - 1]!.label}\n❯ `,
    key: async (k) => { keys.push(k); return true },
    digit: async (n) => { keys.push(String(n)); picked = n; return true },
    text: async (t) => { keys.push(`text:${t}`); return true },
    sleep: async () => {},
  }
  return { io, keys }
}

test("single question: the pick submits; no Tab/Enter hunting for a review screen", async () => {
  const { io, keys } = singlePicker()
  const r = await driveQuestionPicker(io, [color], [{ selected: ["Blue"] }])
  expect(r).toEqual({ ok: true, reason: "submitted on pick" })
  expect(keys).toEqual(["2"])
})

test("an earlier question's 'User answered' on screen is not mistaken for this one", () => {
  expect(answeredCount(PICKER)).toBe(1)
})

test("pickerShowsQuestions: only while the picker for these questions is up", () => {
  expect(pickerShowsQuestions(PICKER, [color])).toBe(true)
  const other: QuestionItem = { ...color, question: "Which size test?" }
  expect(pickerShowsQuestions(PICKER, [other])).toBe(false)
  expect(pickerShowsQuestions("❯ \n  ⏸ manual mode on", [color])).toBe(false)
})
