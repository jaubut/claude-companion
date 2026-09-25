import { test, expect } from "bun:test"
import {
  type QuestionAnswer,
  type QuestionItem,
  type QuestionRequest,
  EXPIRY_MS,
  addQuestionRequest,
  cancelQuestionsFor,
  getPendingQuestions,
  onQuestionExpired,
  questionAnswerMap,
} from "./questions"
import {
  LOCAL_PHONE_WINDOW_MS,
  type QuestionHookInput,
  localTerminalAttached,
  questionFastPath,
  questionWindowMs,
} from "./question-hook"
import { hookDecisionResponse, hookPassthroughResponse } from "./hook-common"

// Fix 2 (audit 2026-09-25): 5/5 phone questions logged "question expired".

const color: QuestionItem = { header: "Color", question: "Which color test?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }
const toppings: QuestionItem = { header: "Toppings", question: "Which toppings?", multiSelect: true, options: [{ label: "Cheese" }, { label: "Olives" }, { label: "Ham" }] }

let seq = 0
function hookInput(over: Partial<QuestionHookInput> = {}): QuestionHookInput {
  seq++
  return {
    agent: "claude",
    eventName: "PermissionRequest",
    tool: "AskUserQuestion",
    input: { questions: [color] },
    sessionId: `qh-${seq}`,
    cwd: `/tmp/qh-${seq}`,
    tty: "/dev/pts/77",
    session: null,
    headerMeta: { tmuxPane: "%77", tty: "/dev/pts/77" },
    ...over,
  }
}

type Ask = typeof addQuestionRequest
function fakeAsk(answers: QuestionAnswer[]) {
  const calls: Array<{ expiryMs?: number }> = []
  const ask: Ask = async (_req, opts = {}) => { calls.push(opts); return answers }
  return { ask, calls }
}

// ---- no instant expiry ------------------------------------------------------

test("a question stays pending for its whole window — no instant expiry", async () => {
  const ended: string[] = []
  const off = onQuestionExpired((r) => ended.push(r.id))
  const answered = addQuestionRequest(
    { agent: "claude", sessionId: "inst-1", cwd: "/x", questions: [color], sessionKey: "k-inst-1" },
    { expiryMs: 120 },
  )
  let settled = false
  void answered.then(() => { settled = true })
  await Bun.sleep(10)
  expect(settled).toBe(false)
  expect(getPendingQuestions().some((q) => q.sessionId === "inst-1")).toBe(true)
  await Bun.sleep(60)
  expect(settled).toBe(false)
  expect(await answered).toEqual([])
  expect(ended.length).toBe(1)
  off()
})

test("the route's phone window is never shorter than 90 s", () => {
  expect(questionWindowMs("PermissionRequest", false)).toBe(EXPIRY_MS)
  expect(questionWindowMs("PermissionRequest", true)).toBe(EXPIRY_MS)
  expect(questionWindowMs("PreToolUse", false)).toBe(EXPIRY_MS)
  expect(questionWindowMs("PreToolUse", true)).toBe(LOCAL_PHONE_WINDOW_MS)
  expect(LOCAL_PHONE_WINDOW_MS).toBe(90_000)
})

// ---- answered: updatedInput, not keystrokes -----------------------------------

test("PermissionRequest answer: correct hookEventName + updatedInput.answers", async () => {
  const { ask } = fakeAsk([{ selected: ["Blue"] }])
  const driven: string[] = []
  const res = await questionFastPath(hookInput(), { ask, afterAnswer: (_t, _q, _a, agent) => driven.push(agent) })
  expect(await res!.json()).toEqual({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions: [color], answers: { "Which color test?": "Blue" } } },
    },
  })
  expect(driven).toEqual(["claude"])
})

test("PreToolUse answer: allow + updatedInput.answers (skips the picker)", async () => {
  const { ask } = fakeAsk([{ selected: ["Red"] }, { selected: ["Cheese", "Ham"], otherText: "extra basil" }])
  const input = { questions: [color, toppings] }
  const res = await questionFastPath(hookInput({ eventName: "PreToolUse", input }), { ask, localAttached: async () => false, afterAnswer: () => {} })
  const body = await res!.json() as { hookSpecificOutput: Record<string, unknown> }
  expect(body.hookSpecificOutput.hookEventName).toBe("PreToolUse")
  expect(body.hookSpecificOutput.permissionDecision).toBe("allow")
  expect(body.hookSpecificOutput.updatedInput).toEqual({
    questions: [color, toppings],
    answers: { "Which color test?": "Red", "Which toppings?": "Cheese, Ham, extra basil" },
  })
})

test("codex keeps the old contract (empty allow) and still drives its picker", async () => {
  const { ask } = fakeAsk([{ selected: ["Red"] }])
  const driven: string[] = []
  const res = await questionFastPath(hookInput({ agent: "codex", eventName: "PreToolUse" }), { ask, localAttached: async () => false, afterAnswer: (_t, _q, _a, agent) => driven.push(agent) })
  expect(await res!.text()).toBe("")
  expect(driven).toEqual(["codex"])
})

test("the sibling hook for an answered question gets the same answers without asking", async () => {
  const first = fakeAsk([{ selected: ["Blue"] }])
  const inp = hookInput({ eventName: "PreToolUse" })
  await questionFastPath(inp, { ask: first.ask, localAttached: async () => false, afterAnswer: () => {} })
  const second = fakeAsk([])
  const res = await questionFastPath({ ...inp, eventName: "PermissionRequest" }, { ask: second.ask, afterAnswer: () => {} })
  expect(second.calls.length).toBe(0)
  const body = await res!.json() as { hookSpecificOutput: { decision: { updatedInput: { answers: unknown } } } }
  expect(body.hookSpecificOutput.decision.updatedInput.answers).toEqual({ "Which color test?": "Blue" })
})

// ---- unanswered: fall through to the terminal picker, never deny --------------

test("no phone answer → no decision ({}), never a deny", async () => {
  const { ask } = fakeAsk([])
  for (const eventName of ["PreToolUse", "PermissionRequest"] as const) {
    const res = await questionFastPath(hookInput({ eventName }), { ask, localAttached: async () => false })
    const body = await res!.json() as Record<string, unknown>
    expect(body).toEqual({})
    expect(JSON.stringify(body)).not.toContain("deny")
  }
})

test("after a PreToolUse fell through, the PermissionRequest sibling does not re-ask the phone", async () => {
  const first = fakeAsk([])
  const inp = hookInput({ eventName: "PreToolUse" })
  await questionFastPath(inp, { ask: first.ask, localAttached: async () => false })
  const second = fakeAsk([{ selected: ["Red"] }])
  const res = await questionFastPath({ ...inp, eventName: "PermissionRequest" }, { ask: second.ask })
  expect(second.calls.length).toBe(0)
  expect(await res!.json()).toEqual({})
})

test("someone at the terminal on the PreToolUse path gets the 90 s window", async () => {
  const a = fakeAsk([])
  await questionFastPath(hookInput({ eventName: "PreToolUse" }), { ask: a.ask, localAttached: async () => true })
  expect(a.calls[0]?.expiryMs).toBe(90_000)
  const b = fakeAsk([])
  await questionFastPath(hookInput({ eventName: "PermissionRequest" }), { ask: b.ask, localAttached: async () => true })
  expect(b.calls[0]?.expiryMs).toBe(EXPIRY_MS)
})

test("answered at the terminal: the phone card is resolved 'answered' and the hook passes through", async () => {
  const ended: Array<[QuestionRequest, string]> = []
  const off = onQuestionExpired((r, d) => ended.push([r, d]))
  const inp = hookInput({ sessionId: "term-1" })
  const pending = questionFastPath(inp, { afterAnswer: () => {} })
  await Bun.sleep(5)
  expect(getPendingQuestions().some((q) => q.sessionId === "term-1")).toBe(true)
  expect(cancelQuestionsFor({ sessionId: "term-1" }, "answered")).toBe(1)
  expect(await (await pending)!.json()).toEqual({})
  expect(ended.map(([r, d]) => [r.sessionId, d])).toEqual([["term-1", "answered"]])
  expect(cancelQuestionsFor({ sessionId: "term-1" }, "answered")).toBe(0)
  off()
})

test("cancelQuestionsFor never touches another session's question", async () => {
  const a = addQuestionRequest({ agent: "claude", sessionId: "iso-a", cwd: "/a", questions: [color], sessionKey: "ka" }, { expiryMs: 50 })
  expect(cancelQuestionsFor({ sessionId: "iso-b", sessionKey: "kb" }, "expired")).toBe(0)
  expect(cancelQuestionsFor({}, "expired")).toBe(0)
  expect(getPendingQuestions().some((q) => q.sessionId === "iso-a")).toBe(true)
  expect(await a).toEqual([])
})

// ---- helpers ---------------------------------------------------------------

test("questionAnswerMap: labels, multi comma-joined, free text for Other", () => {
  expect(questionAnswerMap([color, toppings], [{ selected: ["Blue"] }, { selected: ["Olives", "Ham"] }]))
    .toEqual({ "Which color test?": "Blue", "Which toppings?": "Olives, Ham" })
  expect(questionAnswerMap([color], [{ selected: ["Other"], otherText: "Teal" }])).toEqual({ "Which color test?": "Teal" })
  expect(questionAnswerMap([color], [{ selected: ["Magenta"] }])).toEqual({ "Which color test?": "Magenta" })
  expect(questionAnswerMap([color], [{ selected: [] }])).toEqual({})
})

test("hookDecisionResponse: deny never carries updatedInput; passthrough is empty", async () => {
  const deny = await hookDecisionResponse("claude", "PreToolUse", "deny", "no", { answers: {} }).json() as { hookSpecificOutput: Record<string, unknown> }
  expect(deny.hookSpecificOutput.updatedInput).toBeUndefined()
  const plain = await hookDecisionResponse("claude", "PermissionRequest", "allow", "ok").json()
  expect(plain).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })
  expect(await hookPassthroughResponse("claude").json()).toEqual({})
  expect(await hookPassthroughResponse("codex").text()).toBe("")
})

test("localTerminalAttached: tmux attach count, Mac tab, Linux tty → pane, unknown = no", async () => {
  const yes = async () => true
  const no = async () => false
  const unknown = async () => null
  expect(await localTerminalAttached({ tmuxPane: "%3" }, "linux", yes)).toBe(true)
  expect(await localTerminalAttached({ tmuxPane: "%3" }, "linux", no)).toBe(false)
  expect(await localTerminalAttached({ tmuxPane: "%3" }, "darwin", unknown)).toBe(false)
  expect(await localTerminalAttached({ tty: "/dev/ttys004" }, "darwin", no)).toBe(true)
  expect(await localTerminalAttached({ tty: "/dev/pts/4" }, "linux", yes, async () => "%9")).toBe(true)
  expect(await localTerminalAttached({ tty: "/dev/pts/4" }, "linux", yes, async () => null)).toBe(false)
  expect(await localTerminalAttached({}, "darwin", yes)).toBe(false)
})
