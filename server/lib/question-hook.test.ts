import { afterAll, test, expect } from "bun:test"
import { forgetSession } from "./activity"
import {
  type QuestionAnswer,
  type QuestionItem,
  type QuestionRequest,
  EXPIRY_MS,
  PARK_MS,
  addQuestionRequest,
  cancelQuestionsFor,
  getPendingQuestions,
  onQuestionExpired,
  onQuestionRequest,
  questionAnswerMap,
  resolveQuestion,
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

// questionFastPath raises an AskUserQuestion pill (recordToolStart) for every
// hookInput, which keeps activity's 1.5 s poll running into later files
// (bun shares modules across files). Drop them when this file ends.
afterAll(() => forgetSession({ tty: "/dev/pts/77" }))

type Ask = typeof addQuestionRequest
function fakeAsk(answers: QuestionAnswer[]) {
  const calls: Array<{ expiryMs?: number; id?: string; parkMs?: number }> = []
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

test("after a PreToolUse fell through, the PermissionRequest sibling RE-ASKS the phone (same id, full window)", async () => {
  const first = fakeAsk([])
  const inp = hookInput({ eventName: "PreToolUse" })
  await questionFastPath(inp, { ask: first.ask, localAttached: async () => true, claim: () => undefined })
  expect(first.calls[0]?.parkMs).toBe(PARK_MS)
  const second = fakeAsk([{ selected: ["Red"] }])
  const res = await questionFastPath({ ...inp, eventName: "PermissionRequest" }, { ask: second.ask, claim: () => null, afterAnswer: () => {} })
  expect(second.calls.length).toBe(1)
  expect(second.calls[0]?.id).toBe(first.calls[0]?.id)
  expect(second.calls[0]?.expiryMs).toBe(EXPIRY_MS)
  // The final window never parks.
  expect(second.calls[0]?.parkMs).toBeUndefined()
  const body = await res!.json() as { hookSpecificOutput: { decision: { behavior: string; updatedInput: { answers: unknown } } } }
  expect(body.hookSpecificOutput.decision.behavior).toBe("allow")
  expect(body.hookSpecificOutput.decision.updatedInput.answers).toEqual({ "Which color test?": "Red" })
})

test("both windows lapse → passthrough; a further sibling does not ask again; never deny", async () => {
  const inp = hookInput({ eventName: "PreToolUse" })
  await questionFastPath(inp, { ask: fakeAsk([]).ask, localAttached: async () => false, claim: () => undefined })
  const second = fakeAsk([])
  const res = await questionFastPath({ ...inp, eventName: "PermissionRequest" }, { ask: second.ask, claim: () => null })
  expect(second.calls.length).toBe(1)
  expect(await res!.json()).toEqual({})
  const third = fakeAsk([{ selected: ["Red"] }])
  const again = await questionFastPath({ ...inp, eventName: "PermissionRequest" }, { ask: third.ask })
  expect(third.calls.length).toBe(0)
  expect(await again!.json()).toEqual({})
})

// ---- real queue: the card survives the gap between the two windows ----------

// The real queue with the windows shrunk: PreToolUse 20 ms, park 300 ms.
const quickAsk: Ask = (req, opts = {}) => addQuestionRequest(req, { ...opts, expiryMs: 20, ...(opts.parkMs ? { parkMs: 300 } : {}) })

test("phone answers BETWEEN windows: not lost — the PermissionRequest sibling answers with it, no second ask", async () => {
  const asked: string[] = []
  const off = onQuestionRequest((r) => asked.push(r.id))
  const inp = hookInput({ eventName: "PreToolUse" })
  const pre = await questionFastPath(inp, { ask: quickAsk, localAttached: async () => true, afterAnswer: () => {} })
  expect(await pre!.json()).toEqual({})
  // Still on the phone (parked), same id.
  const q = getPendingQuestions().find((r) => r.sessionId === inp.sessionId)!
  expect(q.id).toBe(asked[0]!)
  expect(resolveQuestion(q.id, [{ selected: ["Blue"] }])).toBe(true)
  const ask = fakeAsk([])
  const res = await questionFastPath({ ...inp, eventName: "PermissionRequest" }, { ask: ask.ask, afterAnswer: () => {} })
  expect(ask.calls.length).toBe(0)
  const body = await res!.json() as { hookSpecificOutput: { hookEventName: string; decision: { updatedInput: { answers: unknown } } } }
  expect(body.hookSpecificOutput.hookEventName).toBe("PermissionRequest")
  expect(body.hookSpecificOutput.decision.updatedInput.answers).toEqual({ "Which color test?": "Blue" })
  expect(asked.length).toBe(1)
  off()
})

test("re-ask: the question frame goes out again with the SAME id and the phone can answer in the second window", async () => {
  const asked: string[] = []
  const ended: string[] = []
  const offA = onQuestionRequest((r) => asked.push(r.id))
  const offE = onQuestionExpired((r) => ended.push(r.id))
  const inp = hookInput({ eventName: "PreToolUse" })
  await questionFastPath(inp, { ask: quickAsk, localAttached: async () => true, afterAnswer: () => {} })
  const perm = questionFastPath({ ...inp, eventName: "PermissionRequest" }, { afterAnswer: () => {} })
  for (let i = 0; i < 100 && asked.length < 2; i++) await Bun.sleep(2)
  expect(asked.length).toBe(2)
  expect(asked[1]).toBe(asked[0])
  // No `expired` between the windows: the card never left the phone.
  expect(ended).toEqual([])
  expect(resolveQuestion(asked[0]!, [{ selected: ["Red"] }])).toBe(true)
  const body = await (await perm)!.json() as { hookSpecificOutput: { decision: { updatedInput: { answers: unknown } } } }
  expect(body.hookSpecificOutput.decision.updatedInput.answers).toEqual({ "Which color test?": "Red" })
  offA(); offE()
})

test("parked with no sibling: the card expires after the park; an answer that came in meanwhile goes to the picker fallback", async () => {
  const ended: string[] = []
  const offE = onQuestionExpired((r) => ended.push(r.id))
  const driven: QuestionAnswer[][] = []
  const inp = hookInput({ eventName: "PreToolUse" })
  await questionFastPath(inp, { ask: quickAsk, localAttached: async () => true, afterAnswer: (_t, _q, a) => driven.push(a) })
  const q = getPendingQuestions().find((r) => r.sessionId === inp.sessionId)!
  expect(resolveQuestion(q.id, [{ selected: ["Red"] }])).toBe(true)
  await Bun.sleep(350)
  expect(driven).toEqual([[{ selected: ["Red"] }]])
  // Answered → not "expired" on top.
  expect(ended).toEqual([])

  const inp2 = hookInput({ eventName: "PreToolUse" })
  await questionFastPath(inp2, { ask: quickAsk, localAttached: async () => true, afterAnswer: (_t, _q, a) => driven.push(a) })
  const q2 = getPendingQuestions().find((r) => r.sessionId === inp2.sessionId)!
  await Bun.sleep(350)
  expect(ended).toEqual([q2.id])
  expect(getPendingQuestions().some((r) => r.id === q2.id)).toBe(false)
  offE()
})

test("answered at the terminal while parked: the held phone answer is dropped, never typed", async () => {
  const driven: QuestionAnswer[][] = []
  const inp = hookInput({ eventName: "PreToolUse" })
  await questionFastPath(inp, { ask: quickAsk, localAttached: async () => true, afterAnswer: (_t, _q, a) => driven.push(a) })
  const q = getPendingQuestions().find((r) => r.sessionId === inp.sessionId)!
  expect(resolveQuestion(q.id, [{ selected: ["Red"] }])).toBe(true)
  cancelQuestionsFor({ sessionId: inp.sessionId }, "answered")
  await Bun.sleep(350)
  expect(driven).toEqual([])
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
  expect(await localTerminalAttached({ tty: "/dev/pts/4" }, "linux", yes, async () => ({ pane: "%9", socket: "" }))).toBe(true)
  // The tmux server travels with the pane: from the target, or from the tty map.
  const seen: Array<[string, string | undefined]> = []
  const spy = async (pane: string, socket?: string) => { seen.push([pane, socket]); return true }
  await localTerminalAttached({ tmuxPane: "%3", tmuxSocket: "/tmp/tmux-1/w" }, "linux", spy)
  await localTerminalAttached({ tty: "/dev/pts/5" }, "linux", spy, async () => ({ pane: "%7", socket: "/tmp/tmux-1/x" }))
  await localTerminalAttached({ tmuxPane: "%4" }, "linux", spy)
  expect(seen).toEqual([["%3", "/tmp/tmux-1/w"], ["%7", "/tmp/tmux-1/x"], ["%4", undefined]])
  expect(await localTerminalAttached({ tty: "/dev/pts/4" }, "linux", yes, async () => null)).toBe(false)
  expect(await localTerminalAttached({}, "darwin", yes)).toBe(false)
})
