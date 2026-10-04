// Orphaned AskUserQuestion → a real question card again (Approvals tab).
//
// When both hook windows lapse — or the server restarts and forgets them —
// the phone card is dropped but Claude Code's picker stays on screen. The
// dialog watcher spots that picker (QUESTION_ORPHAN_MS with no card) and asks
// here first: the structured questions are read back from the session's
// transcript (the AskUserQuestion tool_use that has no tool_result yet), put
// back in the question queue with a long window, and a phone answer drives
// the picker — only while it still visibly shows those questions. Anything
// that fails falls back to the plain dialog-card mirror.
//
// Ends like any question: answered on the phone, or cancelQuestionsFor from
// the hooks (PostToolUse / Stop / UserPromptSubmit / SessionEnd) when it was
// answered at the terminal, or the watcher seeing the picker gone.

import { closeSync, openSync, readSync, statSync } from "node:fs"
import { companionLog } from "./log"
import { type QuestionAnswer, type QuestionItem, addQuestionRequest, cancelQuestionsFor, isQuestionTool, parseQuestionInput } from "./questions"
import { driveQuestionPicker, pickerShowsQuestions } from "./question-driver"
import { type InjectTarget, withPickerIO } from "./keyboard-inject"
import { transcriptPath } from "./session-titles"
import type { Session } from "./sessions"

const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"; const green = "\x1b[32m"; const red = "\x1b[31m"

// The picker is already on screen and blocks nobody but the phone, so the
// window is long; the hooks or the watcher end it sooner when it goes away.
export const ORPHAN_WINDOW_MS = 24 * 60 * 60 * 1000

export interface OpenQuestionCall {
  toolUseId: string
  questions: QuestionItem[]
}

interface Block { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string }

// The last question tool call in the transcript tail with no tool_result.
// Bounded tail read, like modelFromTranscript: a truncated first line just
// fails JSON.parse and is skipped.
export function openQuestionFromTranscript(path: string, tailBytes = 262_144): OpenQuestionCall | null {
  let text: string
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - tailBytes)
    const len = size - start
    if (len <= 0) return null
    const fd = openSync(path, "r")
    const buf = Buffer.alloc(len)
    try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
    text = buf.toString("utf8")
  } catch {
    return null
  }
  const answered = new Set<string>()
  let open: OpenQuestionCall | null = null
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let entry: { message?: { content?: unknown } }
    try { entry = JSON.parse(line) } catch { continue }
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Block[]) {
      if (b?.type === "tool_result" && b.tool_use_id) answered.add(b.tool_use_id)
      if (b?.type === "tool_use" && b.id && b.name && isQuestionTool(b.name)) {
        const questions = parseQuestionInput(b.input)
        if (questions) open = { toolUseId: b.id, questions }
      }
    }
  }
  return open && !answered.has(open.toolUseId) ? open : null
}

export interface OrphanDeps {
  readOpen?: (s: Session) => OpenQuestionCall | null
  ask?: typeof addQuestionRequest
  drive?: (target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[]) => void
}

// key → the tool call a card was re-raised for (one card per call).
const raised = new Map<string, string>()

function defaultReadOpen(s: Session): OpenQuestionCall | null {
  if (!s.cwd || !s.sessionId) return null
  return openQuestionFromTranscript(transcriptPath(s.cwd, s.sessionId))
}

function defaultDrive(target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[]): void {
  void withPickerIO(target, async (io, via) => {
    const pane = io.capture ? await io.capture() : null
    if (pane === null || !pickerShowsQuestions(pane, questions)) {
      companionLog(`${yellow}late answer not delivered${reset} → ${via} — picker no longer on screen`)
      return false
    }
    const r = await driveQuestionPicker(io, questions, answers)
    companionLog(r.ok ? `${green}picker driven${reset} → ${via} ${dim}(orphan card)${reset}` : `${red}picker drive failed${reset} → ${via} — ${r.reason}`)
    return r.ok
  }).catch(() => { /* logged above */ })
}

// True when a structured card is up for this picker (raised now, or earlier
// for the same tool call); false → caller mirrors the plain dialog instead.
export function raiseOrphanQuestion(s: Session, pane: string, deps: OrphanDeps = {}): boolean {
  if (s.agent !== "claude") return false
  const open = (deps.readOpen ?? defaultReadOpen)(s)
  if (!open || !pickerShowsQuestions(pane, open.questions)) return false
  if (raised.get(s.key) === open.toolUseId) return true
  raised.set(s.key, open.toolUseId)
  companionLog(`${yellow}→ phone${reset} orphaned question re-raised ${dim}${open.questions[0]?.question.slice(0, 80) ?? ""} · ${s.key}${reset}`)
  const target: InjectTarget = {
    tmuxPane: s.tmuxPane, tmuxSocket: s.tmuxSocket ?? "", tty: s.tty,
    termProgram: s.termProgram, iTermSessionId: s.iTermSessionId,
  }
  void (deps.ask ?? addQuestionRequest)(
    { agent: "claude", sessionId: s.sessionId, cwd: s.cwd, questions: open.questions, sessionKey: s.key },
    { expiryMs: ORPHAN_WINDOW_MS },
  ).then((answers) => {
    if (answers.length > 0) (deps.drive ?? defaultDrive)(target, open.questions, answers)
  })
  return true
}

// The picker is gone (answered at the terminal, Esc, turn moved on): end the
// re-raised card if the hooks have not already.
export function orphanPickerClosed(key: string): void {
  if (!raised.has(key)) return
  raised.delete(key)
  cancelQuestionsFor({ sessionKey: key }, "answered", "picker closed")
}

export function _resetOrphansForTest(): void {
  raised.clear()
}
