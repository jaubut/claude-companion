// The AskUserQuestion / request_user_input hook path, shared by the
// PreToolUse and PermissionRequest routes (moved out of routes/hooks.ts).
//
// How Claude Code (2.1.282, verified live 2026-09-25) treats a question:
//   - PreToolUse runs BEFORE the picker. Its allow is not enough on its own:
//     the tool keeps a user-interaction floor and the picker opens anyway —
//     unless the allow carries `updatedInput.answers`, which answers it with
//     no picker. No decision = normal flow = the terminal picker.
//   - PermissionRequest runs WHILE the picker is on screen. The user can
//     answer at the terminal, and Claude Code then drops the hook. An allow
//     with `updatedInput.answers` closes the picker with those answers; an
//     allow without them is ignored for this tool; the body's hookEventName
//     must say "PermissionRequest" or the whole reply is ignored.
//
// So: the phone's answer goes back as updatedInput (no keystrokes), no
// answer falls through to the terminal picker (never deny), and a question
// answered at the terminal clears the phone card (cancelQuestionsFor, called
// from routes/hooks.ts).

import type { SpawnAgent } from "./spawn-session"
import { companionLog } from "./log"
import {
  type QuestionAnswer,
  type QuestionItem,
  EXPIRY_MS,
  addQuestionRequest,
  answeredToolInput,
  answeredWith,
  didQuestionFallThrough,
  isQuestionTool,
  markQuestionAnswered,
  markQuestionFellThrough,
  parseQuestionInput,
  questionDedupeKey,
} from "./questions"
import { type InjectTarget, resolveTmuxPaneFromTty, withPickerIO } from "./keyboard-inject"
import { driveQuestionPicker, pickerShowsQuestions } from "./question-driver"
import { tmuxPaneAttached } from "./tmux-pane"
import { recordToolStart } from "./activity"
import { summarize } from "./tool-format"
import { hookDecisionResponse, hookPassthroughResponse } from "./hook-common"
import type { Session } from "./sessions"

const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"; const cyan = "\x1b[36m"
const green = "\x1b[32m"; const red = "\x1b[31m"

// Phone window when someone is at the terminal and the picker can't open
// until the hook returns (PreToolUse): long enough to reach for the phone
// after the push, short enough that a person at the keyboard gets the local
// picker in 1.5 min instead of 5. Everywhere else the full 290 s: with
// PermissionRequest the picker is already live in the terminal, so the
// window blocks nobody; with no one attached the phone is the only way in.
export const LOCAL_PHONE_WINDOW_MS = 90_000

export function questionWindowMs(eventName: "PreToolUse" | "PermissionRequest", localAttached: boolean): number {
  return eventName === "PreToolUse" && localAttached ? LOCAL_PHONE_WINDOW_MS : EXPIRY_MS
}

const PANE_RE = /^%\d+$/

// Is a person's terminal showing this session? A tmux pane: its session has
// an attached client. A Mac tty with no tmux pane: that tab IS the local
// terminal. Unknown counts as not attached (keep the full phone window).
export async function localTerminalAttached(
  target: InjectTarget,
  platform: string = process.platform,
  attached: (pane: string) => Promise<boolean | null> = tmuxPaneAttached,
  paneForTty: (tty: string) => Promise<string | null> = resolveTmuxPaneFromTty,
): Promise<boolean> {
  let pane = target.tmuxPane?.trim() ?? ""
  if (!PANE_RE.test(pane)) pane = ""
  if (!pane && target.tty && platform === "linux") pane = (await paneForTty(target.tty)) ?? ""
  if (pane) return (await attached(pane)) === true
  return !!target.tty && platform === "darwin"
}

// Drive the terminal picker with the phone's answers (Codex, and the Claude
// fallback below). Fire-and-forget; logged either way.
function driveAnswer(target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[]): void {
  void withPickerIO(target, async (io, via) => {
    const r = await driveQuestionPicker(io, questions, answers)
    if (r.ok) {
      companionLog(`${green}picker driven${reset} → ${cyan}${via}${reset} ${dim}(${questions.length} question${questions.length === 1 ? "" : "s"}${r.reason ? `, ${r.reason}` : ""})${reset}`)
    } else {
      companionLog(`${red}picker drive failed${reset} → ${via} — ${r.reason}`)
    }
    return r.ok
  }).then((res) => {
    if (res === null) companionLog(`${red}picker drive refused${reset} — no tmux pane or tty target`)
  }).catch(() => { /* logged above */ })
}

export const HOOK_ANSWER_CHECK_MS = 3_000

// Defensive path for the updatedInput answer. If a future Claude Code stops
// honouring `answers`, its picker stays up; a few seconds later we look, and
// only if the picker for THESE questions is visibly still there do we type
// the answers. Never blind: with no readable pane (Mac tab outside tmux) we
// only log, since typing digits into a closed picker would land in the
// prompt box.
function verifyHookAnswer(target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[]): void {
  const t = setTimeout(() => {
    void withPickerIO(target, async (io, via) => {
      const pane = io.capture ? await io.capture() : null
      if (pane === null) {
        companionLog(`${dim}question answered via hook → ${via} (pane unreadable, not verified)${reset}`)
        return true
      }
      if (!pickerShowsQuestions(pane, questions)) {
        companionLog(`${dim}question answered via hook → ${via} (no picker)${reset}`)
        return true
      }
      companionLog(`${yellow}hook answer not honoured${reset} → ${via} — picker still open, driving it`)
      const r = await driveQuestionPicker(io, questions, answers)
      companionLog(r.ok ? `${green}picker driven${reset} → ${via}` : `${red}picker drive failed${reset} → ${via} — ${r.reason}`)
      return r.ok
    }).catch(() => { /* best effort */ })
  }, HOOK_ANSWER_CHECK_MS)
  ;(t as unknown as { unref?: () => void }).unref?.()
}

function answeredResponse(
  agent: SpawnAgent,
  eventName: "PreToolUse" | "PermissionRequest",
  input: Record<string, unknown>,
  questions: QuestionItem[],
  answers: QuestionAnswer[],
): Response {
  const updated = agent === "codex" ? undefined : answeredToolInput(input, questions, answers)
  return hookDecisionResponse(agent, eventName, "allow", "Answered via Claude Companion", updated)
}

function questionInjectTarget(session: Session | null, headerMeta: Partial<Session>): InjectTarget {
  return {
    tmuxPane: session?.tmuxPane || headerMeta.tmuxPane || "",
    tty: session?.tty || headerMeta.tty || "",
    termProgram: session?.termProgram || headerMeta.termProgram || "",
    iTermSessionId: session?.iTermSessionId || headerMeta.iTermSessionId || "",
  }
}

export interface QuestionHookInput {
  agent: SpawnAgent
  eventName: "PreToolUse" | "PermissionRequest"
  tool: string
  input: Record<string, unknown>
  sessionId: string
  cwd: string
  tty: string
  session: Session | null
  headerMeta: Partial<Session>
}

// Test seams: the phone round-trip and the terminal probe.
export interface QuestionHookDeps {
  ask?: typeof addQuestionRequest
  localAttached?: (target: InjectTarget) => Promise<boolean>
  afterAnswer?: (target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[], agent: SpawnAgent) => void
}

function defaultAfterAnswer(target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[], agent: SpawnAgent): void {
  // Codex has no answers-in-input: its picker still needs typing.
  if (agent === "codex") driveAnswer(target, questions, answers)
  else verifyHookAnswer(target, questions, answers)
}

// Returns a Response when the question was handled (answered, or handed to
// the terminal picker), null to fall through to the generic approval card
// (parse failed / no live terminal target) so the Mac flow still works.
// Claude Code can fire BOTH PreToolUse and PermissionRequest for one call:
// the sibling reuses the first hook's outcome instead of asking again.
export async function questionFastPath(p: QuestionHookInput, deps: QuestionHookDeps = {}): Promise<Response | null> {
  if (!isQuestionTool(p.tool)) return null
  const questions = parseQuestionInput(p.input)
  const target = questionInjectTarget(p.session, p.headerMeta)
  if (!questions || !(target.tmuxPane || target.tty)) {
    companionLog(`${yellow}question fallback${reset} — ${questions ? "no live terminal target" : "could not parse questions"}`)
    return null
  }
  const dedupeKey = questionDedupeKey(p.sessionId, p.cwd, questions)
  const prior = answeredWith(dedupeKey)
  if (prior) {
    companionLog(`${dim}question already answered — allow (${p.eventName})${reset}`)
    return answeredResponse(p.agent, p.eventName, p.input, questions, prior)
  }
  if (didQuestionFallThrough(dedupeKey)) {
    companionLog(`${dim}question already went unanswered on the phone — terminal picker (${p.eventName})${reset}`)
    return hookPassthroughResponse(p.agent)
  }

  const attached = p.eventName === "PreToolUse" && (await (deps.localAttached ?? localTerminalAttached)(target))
  const windowMs = questionWindowMs(p.eventName, attached)
  companionLog(`${yellow}→ phone${reset} ${cyan}question${reset} ${dim}${questions[0]?.question.slice(0, 80) ?? ""} (${p.eventName}, ${Math.round(windowMs / 1000)}s)${reset}`)
  recordToolStart({ tool: p.tool, input: p.input, summary: summarize(p.tool, p.input), verdict: "pending", cwd: p.cwd, sessionId: p.sessionId, tty: p.tty, sessionKey: p.session?.key ?? "" })
  const answers = await (deps.ask ?? addQuestionRequest)(
    { agent: p.agent, sessionId: p.sessionId, cwd: p.cwd, questions, sessionKey: p.session?.key ?? "" },
    { expiryMs: windowMs },
  )

  if (answers.length === 0) {
    // No phone answer (window ran out, or it was answered / dropped at the
    // terminal). Never deny: that made Claude carry on without an answer.
    // No decision lets Claude Code show — or keep showing — its own picker.
    markQuestionFellThrough(dedupeKey)
    companionLog(`${yellow}question unanswered on phone${reset} — terminal picker takes it (${p.eventName})`)
    return hookPassthroughResponse(p.agent)
  }

  companionLog(`${green}answered${reset} ← phone (${answers.length} answer${answers.length === 1 ? "" : "s"})`)
  markQuestionAnswered(dedupeKey, Date.now(), answers)
  ;(deps.afterAnswer ?? defaultAfterAnswer)(target, questions, answers, p.agent)
  return answeredResponse(p.agent, p.eventName, p.input, questions, answers)
}
