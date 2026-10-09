import { test, expect, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REVIEW_CANCEL, REVIEW_SUBMIT, _resetOrphansForTest, isQuestionReview, openQuestionFromTranscript, orphanPickerClosed, raiseOrphanQuestion, reviewSummary } from "./orphan-question"
import { getPendingQuestions, type QuestionAnswer } from "./questions"
import type { Session } from "./sessions"
import { type InjectTarget, withPickerIO } from "./keyboard-inject"
import { type Herdr, herdrScreen } from "./herdr"
import { herdrPickerIO } from "./herdr-inject"

const INPUT = { questions: [{ question: "Activate the slim CLAUDE.md?", header: "CLAUDE.md", multiSelect: false,
  options: [{ label: "Activate", description: "swap it in" }, { label: "Not yet", description: "keep current" }] }] }

const PANE = `
←  ☐ CLAUDE.md  ✔ Submit  →
Activate the slim CLAUDE.md?
❯ 1. Activate
     swap it in
  2. Not yet
     keep current
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`

function line(content: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content } })
}

function transcript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-orphan-"))
  const p = join(dir, "t.jsonl")
  writeFileSync(p, lines.join("\n") + "\n")
  return p
}

function session(over: Partial<Session> = {}): Session {
  return {
    key: "claude:tty:/dev/ttys008", agent: "claude", label: "", title: "", sidConfirmed: true,
    cwd: "/Users/x", sessionId: "sid-orphan", termProgram: "tmux", tty: "/dev/ttys008", iTermSessionId: "",
    tmuxPane: "%87", taskId: "", waitingSince: 0, waitingKind: "", waitingRef: "", waitingReasons: [],
    pid: "1", firstSeenAt: 0, lastSeenAt: 0, model: "", agentStatus: "", waitingFor: "", ...over,
  }
}

beforeEach(() => {
  _resetOrphansForTest()
  for (const q of getPendingQuestions()) orphanPickerClosed(q.sessionKey)
})

test("transcript: the last question call with no tool_result is open", () => {
  const p = transcript([
    line([{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: INPUT }]),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } }),
    line([{ type: "text", text: "ok" }, { type: "tool_use", id: "tu2", name: "AskUserQuestion", input: INPUT }]),
  ])
  const open = openQuestionFromTranscript(p)
  expect(open?.toolUseId).toBe("tu2")
  expect(open?.questions[0]?.options.map((o) => o.label)).toEqual(["Activate", "Not yet"])
})

test("transcript: an answered question is not open; a missing file is null", () => {
  const p = transcript([
    line([{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: INPUT }]),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } }),
  ])
  expect(openQuestionFromTranscript(p)).toBeNull()
  expect(openQuestionFromTranscript("/nonexistent/x.jsonl")).toBeNull()
})

test("raise: one structured card per tool call, answer drives the picker", async () => {
  const p = transcript([line([{ type: "tool_use", id: "tu9", name: "AskUserQuestion", input: INPUT }])])
  const driven: QuestionAnswer[][] = []
  let resolveAsk: (a: QuestionAnswer[]) => void = () => {}
  let asks = 0
  const deps = {
    readOpen: () => openQuestionFromTranscript(p),
    ask: (() => { asks++; return new Promise<QuestionAnswer[]>((r) => { resolveAsk = r }) }) as never,
    drive: (_t: unknown, _q: unknown, a: QuestionAnswer[]) => { driven.push(a) },
  }
  expect(raiseOrphanQuestion(session(), PANE, deps)).toBe(true)
  expect(raiseOrphanQuestion(session(), PANE, deps)).toBe(true)
  expect(asks).toBe(1)
  resolveAsk([{ selected: ["Not yet"] }])
  await Promise.resolve(); await Promise.resolve()
  expect(driven).toEqual([[{ selected: ["Not yet"] }]])
})

test("raise: refused when the picker on screen is not that call's question, or for codex", () => {
  const p = transcript([line([{ type: "tool_use", id: "tu3", name: "AskUserQuestion", input: INPUT }])])
  const deps = { readOpen: () => openQuestionFromTranscript(p), ask: (() => new Promise(() => {})) as never }
  const other = PANE.replace("Activate the slim CLAUDE.md?", "Something else entirely?").replace(/Activate|Not yet/g, "zz")
  expect(raiseOrphanQuestion(session(), other, deps)).toBe(false)
  expect(raiseOrphanQuestion(session({ agent: "codex" }), PANE, deps)).toBe(false)
  expect(raiseOrphanQuestion(session(), PANE, { ...deps, readOpen: () => null })).toBe(false)
})

test("raise (real queue): card is pending under the session key; picker closed ends it", () => {
  const p = transcript([line([{ type: "tool_use", id: "tu4", name: "AskUserQuestion", input: INPUT }])])
  expect(raiseOrphanQuestion(session(), PANE, { readOpen: () => openQuestionFromTranscript(p) })).toBe(true)
  const q = getPendingQuestions().find((x) => x.sessionKey === "claude:tty:/dev/ttys008")
  expect(q?.questions[0]?.question).toBe("Activate the slim CLAUDE.md?")
  orphanPickerClosed("claude:tty:/dev/ttys008")
  expect(getPendingQuestions().some((x) => x.sessionKey === "claude:tty:/dev/ttys008")).toBe(false)
})

const REVIEW_PANE = `
←  ☒ CLAUDE.md  ☒ Cleanup  ✔ Submit  →

Review your answers

 │ ● Activate the slim CLAUDE.md?
   → Activate (Recommended)
 ● Also fix these?
   → Retire invoice-generator, Fix Zettlab's 5 broken skills

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`

test("review screen: detected, summarised, raised as a Submit/Cancel card that presses the pick", async () => {
  expect(isQuestionReview(REVIEW_PANE)).toBe(true)
  expect(isQuestionReview(PANE)).toBe(false)
  expect(reviewSummary(REVIEW_PANE)).toBe("Activate the slim CLAUDE.md? → Activate (Recommended)\nAlso fix these? → Retire invoice-generator, Fix Zettlab's 5 broken skills")
  const p = transcript([line([{ type: "tool_use", id: "tu7", name: "AskUserQuestion", input: INPUT }])])
  const asked: unknown[] = []
  const pressed: string[] = []
  let resolveAsk: (a: QuestionAnswer[]) => void = () => {}
  const deps = {
    readOpen: () => openQuestionFromTranscript(p),
    ask: ((req: { questions: unknown[] }) => { asked.push(req.questions); return new Promise<QuestionAnswer[]>((r) => { resolveAsk = r }) }) as never,
    drive: () => { throw new Error("picker driver must not run on the review screen") },
    driveReview: (_t: unknown, choice: string) => { pressed.push(choice) },
  }
  expect(raiseOrphanQuestion(session(), REVIEW_PANE, deps)).toBe(true)
  expect(raiseOrphanQuestion(session(), REVIEW_PANE, deps)).toBe(true)
  expect(asked).toHaveLength(1)
  const q = (asked[0] as { question: string; options: { label: string; description?: string }[] }[])[0]!
  expect(q.question).toBe("Submit: Activate the slim CLAUDE.md?")
  expect(q.options.map((o) => o.label)).toEqual([REVIEW_SUBMIT, REVIEW_CANCEL])
  expect(q.options[0]!.description).toContain("→ Activate (Recommended)")
  resolveAsk([{ selected: [REVIEW_SUBMIT] }])
  await Promise.resolve(); await Promise.resolve()
  expect(pressed).toEqual([REVIEW_SUBMIT])
})

test("review screen of another question is not claimed", () => {
  const p = transcript([line([{ type: "tool_use", id: "tu8", name: "AskUserQuestion", input: { questions: [{ question: "Completely different question?", header: "X", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }] } }])])
  expect(raiseOrphanQuestion(session(), REVIEW_PANE, { readOpen: () => openQuestionFromTranscript(p), ask: (() => new Promise(() => {})) as never })).toBe(false)
})

test("herdr session: the re-raised card's answer is driven into the herdr pane", async () => {
  const p = transcript([line([{ type: "tool_use", id: "tuH", name: "AskUserQuestion", input: INPUT }])])
  let resolveAsk: (a: QuestionAnswer[]) => void = () => {}
  const routes: Array<string | null> = []
  const deps = {
    readOpen: () => openQuestionFromTranscript(p),
    ask: (() => new Promise<QuestionAnswer[]>((r) => { resolveAsk = r })) as never,
    // The real driver's IO choice (withPickerIO), without touching a pane.
    drive: (t: InjectTarget) => { void withPickerIO(t, async (_io, via) => via).then((via) => routes.push(via)) },
  }
  const herdr = session({ key: "claude:tty:/dev/pts/9", tmuxPane: "", termProgram: "", tty: "", herdrPane: "w6:p1" })
  expect(raiseOrphanQuestion(herdr, PANE, deps)).toBe(true)
  resolveAsk([{ selected: ["Activate"] }])
  await new Promise((r) => setTimeout(r, 20))
  expect(routes).toEqual(["herdr|w6:p1"])
})

// ── herdr: the REAL review driver on a styled `pane read` (PR #157) ─────────

// What realHerdr.read hands back for a screen: herdr's ANSI read after
// herdrScreen (CRLF + trailing blanks gone), every row behind an SGR run.
function herdrStyled(plain: string): string {
  return herdrScreen(plain.split("\n").map((l) => (l ? `\x1b[0m\x1b[38;2;153;153;153m${l}\x1b[0m   ` : "")).join("\r\n"))
}

const PROMPT_PANE = "\n────\n❯ \n────\n"

// A herdr pane showing `screens()` and recording every herdr command.
function herdrPane(screens: (sent: string[][]) => string) {
  const sent: string[][] = []
  const h: Herdr = {
    async gate() { return null },
    async read() { return herdrStyled(screens(sent)) },
    async call(args) { sent.push(args); return {} },
  }
  return { h, sent }
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

const HERDR_SESSION = { key: "claude:tty:/dev/pts/9", tmuxPane: "", termProgram: "", tty: "", herdrPane: "w6:p1" }

test("herdr orphan review → Submit: the real driver presses Enter in the herdr pane", async () => {
  const p = transcript([line([{ type: "tool_use", id: "tuR1", name: "AskUserQuestion", input: INPUT }])])
  let resolveAsk: (a: QuestionAnswer[]) => void = () => {}
  const pane = herdrPane((sent) => (sent.length === 0 ? REVIEW_PANE : PROMPT_PANE))
  const deps = {
    readOpen: () => openQuestionFromTranscript(p),
    ask: (() => new Promise<QuestionAnswer[]>((r) => { resolveAsk = r })) as never,
    herdr: pane.h,
  }
  // The watcher hands raiseOrphanQuestion the unstyled screen.
  expect(raiseOrphanQuestion(session(HERDR_SESSION), REVIEW_PANE, deps)).toBe(true)
  resolveAsk([{ selected: [REVIEW_SUBMIT] }])
  await until(() => pane.sent.length > 0)
  expect(pane.sent).toEqual([["pane", "send-keys", "w6:p1", "enter"]])
})

test("herdr orphan review → Cancel: the real driver picks 2 then Enter in the herdr pane", async () => {
  const p = transcript([line([{ type: "tool_use", id: "tuR2", name: "AskUserQuestion", input: INPUT }])])
  let resolveAsk: (a: QuestionAnswer[]) => void = () => {}
  const onTwo = REVIEW_PANE.replace("❯ 1. Submit answers", "  1. Submit answers").replace("  2. Cancel", "❯ 2. Cancel")
  const pane = herdrPane((sent) => (sent.length === 0 ? REVIEW_PANE : sent.length === 1 ? onTwo : PROMPT_PANE))
  const deps = {
    readOpen: () => openQuestionFromTranscript(p),
    ask: (() => new Promise<QuestionAnswer[]>((r) => { resolveAsk = r })) as never,
    herdr: pane.h,
  }
  expect(raiseOrphanQuestion(session(HERDR_SESSION), REVIEW_PANE, deps)).toBe(true)
  resolveAsk([{ selected: [REVIEW_CANCEL] }])
  await until(() => pane.sent.length > 1)
  expect(pane.sent).toEqual([["pane", "send-text", "w6:p1", "2"], ["pane", "send-keys", "w6:p1", "enter"]])
})

test("herdr picker IO reads the plain shape tmux's `capture-pane -p` gives", async () => {
  const pane = herdrPane(() => REVIEW_PANE)
  const text = await herdrPickerIO("w6:p1", pane.h).capture!()
  expect(text).toBe(herdrScreen(REVIEW_PANE))
  expect(isQuestionReview(text!)).toBe(true)
})
