import { test, expect } from "bun:test"
import {
  type QuestionItem,
  type QuestionRequest,
  addQuestionRequest,
  getPendingQuestions,
  markQuestionAnswered,
  onQuestionExpired,
  onQuestionResolved,
  questionDedupeKey,
  resolveQuestion,
  wasQuestionAnswered,
} from "./questions"

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

// ---- lifecycle (PRJ-OR1T Phase 11) ------------------------------------------
//
// The question lifecycle clears the session's `question` waiting reason, so
// both exits from the pending map are covered: an answer and the 290s expiry,
// the latter through the `expiryMs` seam so no test waits on a real timer.

function pendingFor(sessionId: string): QuestionRequest {
  return getPendingQuestions().find((r) => r.sessionId === sessionId)!
}

test("sessionKey round-trips into the pending question", async () => {
  const answered = addQuestionRequest({
    agent: "claude", sessionId: "q-1", cwd: "/home/aubut", questions: qs,
    sessionKey: "claude:tty:/dev/pts/90",
  })
  const req = pendingFor("q-1")
  expect(req.sessionKey).toBe("claude:tty:/dev/pts/90")
  expect(resolveQuestion(req.id, [{ selected: ["Red"] }])).toBe(true)
  expect(await answered).toEqual([{ selected: ["Red"] }])
})

test("onQuestionResolved fires once with the request, and not on a duplicate answer", async () => {
  const seen: QuestionRequest[] = []
  const off = onQuestionResolved((r) => seen.push(r))
  const answered = addQuestionRequest({
    agent: "claude", sessionId: "q-2", cwd: "/home/aubut", questions: qs,
    sessionKey: "claude:tty:/dev/pts/91",
  })
  const id = pendingFor("q-2").id

  expect(resolveQuestion(id, [{ selected: ["Green"] }])).toBe(true)
  await answered
  expect(resolveQuestion(id, [{ selected: ["Green"] }])).toBe(false)

  expect(seen.length).toBe(1)
  expect(seen[0]?.id).toBe(id)
  expect(seen[0]?.sessionKey).toBe("claude:tty:/dev/pts/91")
  off()
})

test("the expiry exit fires the handler with the request and resolves empty", async () => {
  const seen: QuestionRequest[] = []
  const off = onQuestionExpired((r) => seen.push(r))
  const answered = addQuestionRequest(
    {
      agent: "claude", sessionId: "q-3", cwd: "/home/aubut", questions: qs,
      sessionKey: "claude:tty:/dev/pts/92",
    },
    { expiryMs: 10 },
  )
  const id = pendingFor("q-3").id
  // No answer is never faked as one — the caller denies the tool instead.
  expect(await answered).toEqual([])
  expect(seen.length).toBe(1)
  expect(seen[0]?.id).toBe(id)
  expect(seen[0]?.sessionKey).toBe("claude:tty:/dev/pts/92")
  expect(getPendingQuestions().some((r) => r.id === id)).toBe(false)
  expect(resolveQuestion(id, [{ selected: ["Red"] }])).toBe(false)
  off()
})
