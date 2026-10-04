import { test, expect, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _resetOrphansForTest, openQuestionFromTranscript, orphanPickerClosed, raiseOrphanQuestion } from "./orphan-question"
import { getPendingQuestions, type QuestionAnswer } from "./questions"
import type { Session } from "./sessions"

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
