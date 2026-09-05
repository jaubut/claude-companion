import { test, expect } from "bun:test"
import { questionDedupeKey, markQuestionAnswered, wasQuestionAnswered, type QuestionItem } from "./questions"

const qs: QuestionItem[] = [
  { header: "Color", question: "Pick one color", multiSelect: false, options: [{ label: "Red" }, { label: "Green" }] },
]

test("a question answered via one hook is recognised by the other within the window", () => {
  const key = questionDedupeKey("sess-1", "/x", qs)
  expect(wasQuestionAnswered(key)).toBe(false)
  markQuestionAnswered(key, 1_000)
  expect(wasQuestionAnswered(key, 1_500)).toBe(true)
  expect(wasQuestionAnswered(key, 1_000 + 180_000 + 1)).toBe(false) // expired
  expect(wasQuestionAnswered(key, 2_000)).toBe(false) // expiry deletes the entry
})

test("the key separates sessions and question sets; falls back to cwd without a session id", () => {
  const other: QuestionItem[] = [{ ...qs[0]!, question: "Pick two colors" }]
  expect(questionDedupeKey("s", "/x", qs)).not.toBe(questionDedupeKey("t", "/x", qs))
  expect(questionDedupeKey("s", "/x", qs)).not.toBe(questionDedupeKey("s", "/x", other))
  expect(questionDedupeKey("", "/x", qs)).toBe(questionDedupeKey("", "/x", qs))
  expect(questionDedupeKey("", "/x", qs)).not.toBe(questionDedupeKey("", "/y", qs))
})
