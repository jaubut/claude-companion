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
//
// The picker's last screen ("Review your answers … ❯ 1. Submit answers /
// 2. Cancel") has no key-hint footer, so parseDialog never sees it and the
// dialog mirror can't help: a session left there sat invisible on the phone
// (2026-10-03). It gets its own card — "Submit your answers?" with the chosen
// answers — and the pick presses Submit or Cancel in the terminal.

import { closeSync, openSync, readSync, statSync } from "node:fs"
import { companionLog } from "./log"
import type { Herdr } from "./herdr"
import { type QuestionAnswer, type QuestionItem, addQuestionRequest, cancelQuestionsFor, isQuestionTool, parseQuestionInput } from "./questions"
import { REVIEW_RE, answeredCount, driveQuestionPicker, pickerRegion, pickerShowsQuestions } from "./question-driver"
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

// The picker's review screen, cursor on its Submit / Cancel rows.
export function isQuestionReview(pane: string): boolean {
  const region = pickerRegion(pane)
  return REVIEW_RE.test(region) && /^\s*(?:❯\s*)?1\.\s*Submit answers/m.test(region) && /^\s*(?:❯\s*)?2\.\s*Cancel/m.test(region)
}

export const REVIEW_SUBMIT = "Submit answers"
export const REVIEW_CANCEL = "Cancel"

// "● question / → answer" pairs between "Review your answers" and the prompt.
export function reviewSummary(pane: string): string {
  const region = pickerRegion(pane).split("\n")
  const start = region.findIndex((l) => /Review your answers/.test(l))
  const end = region.findIndex((l) => REVIEW_RE.test(l))
  if (start < 0 || end <= start) return ""
  const out: string[] = []
  for (const raw of region.slice(start + 1, end)) {
    const l = raw.replace(/^[\s│]+/, "").trimEnd()
    if (l.startsWith("●")) out.push(l.slice(1).trim())
    else if (l.startsWith("→") && out.length) out[out.length - 1] += ` → ${l.slice(1).trim()}`
    else if (l && out.length) out[out.length - 1] += ` ${l}`
  }
  return out.join("\n")
}

function reviewQuestion(open: OpenQuestionCall, pane: string): QuestionItem {
  const summary = reviewSummary(pane)
  return {
    question: open.questions.length === 1 ? `Submit: ${open.questions[0]!.question}` : "Submit your answers?",
    header: "Submit",
    multiSelect: false,
    options: [
      { label: REVIEW_SUBMIT, ...(summary ? { description: summary } : {}) },
      { label: REVIEW_CANCEL, description: "Decline the question; Claude carries on without the answers" },
    ],
  }
}

// The question text of the open call is on the review screen (so it is THIS
// question's review, not another's).
function reviewShows(pane: string, open: OpenQuestionCall): boolean {
  const region = pickerRegion(pane)
  return open.questions.some((q) => region.includes(q.question.trim().slice(0, 24)))
}

function defaultDriveReview(target: InjectTarget, choice: string, herdr?: Herdr): void {
  void withPickerIO(target, async (io, via) => {
    const pane = io.capture ? await io.capture() : null
    if (pane === null || !isQuestionReview(pane)) {
      companionLog(`${yellow}late answer not delivered${reset} → ${via} — review screen no longer on screen`)
      return false
    }
    const before = answeredCount(pane)
    if (choice === REVIEW_CANCEL) {
      await io.digit(2)
      await io.sleep(250)
      const now = io.capture ? await io.capture() : null
      if (now !== null && isQuestionReview(now) && /^\s*❯\s*2\./m.test(pickerRegion(now))) await io.key("Enter")
    } else {
      // The cursor starts on Submit; Enter there is what the driver does too.
      if (!/^\s*❯\s*1\./m.test(pickerRegion(pane))) await io.digit(1)
      await io.sleep(120)
      await io.key("Enter")
    }
    await io.sleep(600)
    const after = io.capture ? await io.capture() : null
    const ok = after !== null && (!isQuestionReview(after) || answeredCount(after) > before)
    companionLog(ok ? `${green}review ${choice === REVIEW_CANCEL ? "cancelled" : "submitted"}${reset} → ${via} ${dim}(orphan card)${reset}` : `${red}review press not confirmed${reset} → ${via}`)
    return ok
  }, { herdr }).catch(() => { /* logged above */ })
}

export interface OrphanDeps {
  readOpen?: (s: Session) => OpenQuestionCall | null
  ask?: typeof addQuestionRequest
  drive?: (target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[]) => void
  driveReview?: (target: InjectTarget, choice: string) => void
  // The herdr the default drivers' picker IO talks to (tests pass a fake).
  herdr?: Herdr
}

// key → the tool call a card was re-raised for (one card per call).
const raised = new Map<string, string>()

function defaultReadOpen(s: Session): OpenQuestionCall | null {
  if (!s.cwd || !s.sessionId) return null
  return openQuestionFromTranscript(transcriptPath(s.cwd, s.sessionId))
}

function defaultDrive(target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[], herdr?: Herdr): void {
  void withPickerIO(target, async (io, via) => {
    const pane = io.capture ? await io.capture() : null
    if (pane === null || !pickerShowsQuestions(pane, questions)) {
      companionLog(`${yellow}late answer not delivered${reset} → ${via} — picker no longer on screen`)
      return false
    }
    const r = await driveQuestionPicker(io, questions, answers)
    companionLog(r.ok ? `${green}picker driven${reset} → ${via} ${dim}(orphan card)${reset}` : `${red}picker drive failed${reset} → ${via} — ${r.reason}`)
    return r.ok
  }, { herdr }).catch(() => { /* logged above */ })
}

// True when a structured card is up for this picker (raised now, or earlier
// for the same tool call); false → caller mirrors the plain dialog instead.
export function raiseOrphanQuestion(s: Session, pane: string, deps: OrphanDeps = {}): boolean {
  if (s.agent !== "claude") return false
  const open = (deps.readOpen ?? defaultReadOpen)(s)
  if (!open) return false
  const review = isQuestionReview(pane) && reviewShows(pane, open)
  if (!review && !pickerShowsQuestions(pane, open.questions)) return false
  const tag = review ? `${open.toolUseId}:review` : open.toolUseId
  if (raised.get(s.key) === tag) return true
  raised.set(s.key, tag)
  const questions = review ? [reviewQuestion(open, pane)] : open.questions
  companionLog(`${yellow}→ phone${reset} orphaned question re-raised${review ? " (review screen)" : ""} ${dim}${questions[0]?.question.slice(0, 80) ?? ""} · ${s.key}${reset}`)
  // herdrPane too: the watcher re-raises herdr pickers, and withPickerIO
  // drives a herdr pane only when the target names it.
  const target: InjectTarget = {
    tmuxPane: s.tmuxPane, tmuxSocket: s.tmuxSocket ?? "", tty: s.tty,
    termProgram: s.termProgram, iTermSessionId: s.iTermSessionId, herdrPane: s.herdrPane ?? "",
  }
  void (deps.ask ?? addQuestionRequest)(
    { agent: "claude", sessionId: s.sessionId, cwd: s.cwd, questions, sessionKey: s.key },
    { expiryMs: ORPHAN_WINDOW_MS },
  ).then((answers) => {
    if (answers.length === 0) return
    const choice = answers[0]?.selected[0] ?? REVIEW_SUBMIT
    if (review) deps.driveReview ? deps.driveReview(target, choice) : defaultDriveReview(target, choice, deps.herdr)
    else if (deps.drive) deps.drive(target, open.questions, answers)
    else defaultDrive(target, open.questions, answers, deps.herdr)
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
