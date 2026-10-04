import type { QuestionItem, QuestionAnswer } from "./questions"

// Drives Claude Code's AskUserQuestion picker from the phone's answers.
//
// Grammar of the picker (Claude Code 2.1.x, mapped live on 2026-09-05):
//   ← ☐ Color  ☐ Toppings  ✔ Submit →        tab bar, one tab per question
//   ❯ 1. Red / 2. Green / 3. Blue / 4. Type something.   single-select rows
//     1. [ ] Cheese … 4. [ ] Type something / Submit     multi-select rows
//   digit N  → picks row N. Single-select auto-advances to the next question;
//              multi-select toggles in place.
//   Tab      → next tab; from the last question, the Submit tab:
//              "Review your answers … ❯ 1. Submit answers / 2. Cancel"
//   Enter    → on the Submit tab, submits. Transcript then shows
//              "User answered Claude's questions".
//
// A SINGLE question has no tab bar and no review screen (re-mapped live on
// CC 2.1.282, 2026-09-25): "☐ Color / Which color? / ❯ 1. Red …", and a digit
// submits at once. The driver used to wait for a review that never came and
// logged "review screen never appeared" for an answer that had gone through;
// it now also accepts a new "User answered Claude's questions" as done.
//
// For Claude Code the driver is only a fallback: the hook hands the answers
// over as `updatedInput.answers` and no picker opens (lib/question-hook.ts).
//
// Pane-driven, not timer-driven: every step waits for the screen to show the
// state it expects (picker mounted, next question, review) so it works whether
// the picker takes 200ms or 5s to mount and never types into the wrong screen.
// Without a readable pane (macOS non-tmux terminals) it falls back to a blind
// sequence with fixed gaps.

export interface PickerIO {
  // Current pane text, or null when it can't be read (blind mode / pane gone).
  capture: (() => Promise<string | null>) | null
  key(name: "Tab" | "Enter"): Promise<boolean>
  digit(n: number): Promise<boolean>
  text(s: string): Promise<boolean>
  sleep(ms: number): Promise<void>
}

export interface DriveResult {
  ok: boolean
  reason: string
}

export const PICKER_READY_RE = /Enter to select/
export const REVIEW_RE = /Ready to submit your answers\?|Submit answers/
export const ANSWERED_RE = /User answered Claude's questions/
const TAB_BAR_RE = /Submit\s+→/

const MOUNT_TIMEOUT_MS = 20_000
const STEP_TIMEOUT_MS = 6_000
const CONFIRM_TIMEOUT_MS = 8_000
const POLL_MS = 150

const ANSWERED_ALL_RE = /User answered Claude's questions/g

// How many "User answered" lines the pane shows: an earlier question's
// confirmation can still be on screen, so "done" means one MORE than at mount.
export function answeredCount(pane: string): number {
  return pane.match(ANSWERED_ALL_RE)?.length ?? 0
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// The picker sits below its tab bar. Matching only there keeps the user's
// prompt echo (which repeats the question text) from satisfying a wait early.
export function pickerRegion(pane: string): string {
  const lines = pane.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TAB_BAR_RE.test(lines[i]!)) return lines.slice(i).join("\n")
  }
  return ""
}

// A short prefix of the question text — the picker prints it on its own line
// right under the tab bar, so the first ~24 chars never wrap.
function questionMarker(q: QuestionItem): RegExp {
  return new RegExp(escapeRe(q.question.trim().slice(0, 24)))
}

// Is the picker for these questions on screen right now? Used after a hook
// answered via updatedInput: if the picker is still up a few seconds later,
// Claude Code did not take the answers and the driver has to type them.
export function pickerShowsQuestions(pane: string, questions: QuestionItem[]): boolean {
  if (!PICKER_READY_RE.test(pane)) return false
  const tail = pane.split("\n").slice(-40).join("\n")
  return questions.some((q) => questionMarker(q).test(tail))
}

export async function driveQuestionPicker(
  io: PickerIO,
  questions: QuestionItem[],
  answers: QuestionAnswer[],
): Promise<DriveResult> {
  if (!io.capture) return driveBlind(io, questions, answers)
  const capture = io.capture
  let baseline = 0

  async function waitUntil(test: (pane: string) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const pane = await capture()
      if (pane === null) return false
      if (test(pane)) return true
      await io.sleep(POLL_MS)
    }
    return false
  }
  const waitFor = (re: RegExp, timeoutMs: number, region: boolean) =>
    waitUntil((pane) => re.test(region ? pickerRegion(pane) : pane), timeoutMs)
  const submitted = (pane: string) => answeredCount(pane) > baseline
  const reviewOrDone = (pane: string) => REVIEW_RE.test(pickerRegion(pane)) || submitted(pane)

  let mountPane = ""
  if (!(await waitUntil((pane) => { mountPane = pane; return PICKER_READY_RE.test(pane) }, MOUNT_TIMEOUT_MS))) {
    return { ok: false, reason: "picker never mounted" }
  }
  baseline = answeredCount(mountPane)

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!
    const a = answers[i] ?? { selected: [] }
    // The first question is on screen the moment the picker mounts; later
    // ones appear after the previous auto-advance / Tab.
    if (i > 0 && !(await waitFor(questionMarker(q), STEP_TIMEOUT_MS, true))) {
      return { ok: false, reason: `question ${i + 1} never appeared` }
    }
    await io.sleep(120)
    const r = await answerOne(io, q, a)
    if (!r.ok) return r
  }

  // A lone single-select question submits on the pick (no review screen).
  // Otherwise single-select on the last question auto-advances to the review
  // screen and Tab gets us there. Bounded retries in case a Tab lands mid-paint.
  let onReview = await waitUntil(reviewOrDone, 1_500)
  for (let attempt = 0; !onReview && attempt <= questions.length; attempt++) {
    await io.key("Tab")
    onReview = await waitUntil(reviewOrDone, STEP_TIMEOUT_MS)
  }
  const now = await capture()
  if (now !== null && submitted(now)) return { ok: true, reason: "submitted on pick" }
  if (!onReview) return { ok: false, reason: "review screen never appeared" }

  await io.sleep(120)
  await io.key("Enter")
  if (!(await waitUntil(submitted, CONFIRM_TIMEOUT_MS))) {
    return { ok: false, reason: "submitted but no confirmation" }
  }
  return { ok: true, reason: "" }
}

// One question's rows. Row N = option N (1-based); row options.length+1 =
// "Type something" (free text). Multi-select toggles stay on the question and
// the caller Tabs onward; single-select auto-advances.
async function answerOne(io: PickerIO, q: QuestionItem, a: QuestionAnswer): Promise<DriveResult> {
  const customRow = q.options.length + 1
  const custom = (a.otherText ?? "").trim()

  if (q.multiSelect) {
    for (let oi = 0; oi < q.options.length; oi++) {
      if (!a.selected.includes(q.options[oi]!.label)) continue
      if (!(await io.digit(oi + 1))) return { ok: false, reason: `toggle ${oi + 1} failed` }
      await io.sleep(120)
    }
    if (custom) {
      if (!(await typeCustom(io, customRow, custom))) return { ok: false, reason: "custom text failed" }
    }
    if (!(await io.key("Tab"))) return { ok: false, reason: "Tab failed" }
    return { ok: true, reason: "" }
  }

  const picked = a.selected[0] ?? ""
  const idx = q.options.findIndex((o) => o.label === picked)
  if (idx >= 0) {
    if (!(await io.digit(idx + 1))) return { ok: false, reason: `pick ${idx + 1} failed` }
    return { ok: true, reason: "" }
  }
  // Not one of the options → free text (the phone's "Other", or a label we
  // can't match). An empty answer still needs something typed or the picker
  // won't advance; the picked label is the best text we have.
  const freeText = custom || picked
  if (!freeText) return { ok: false, reason: "empty answer for single-select" }
  if (!(await typeCustom(io, customRow, freeText))) return { ok: false, reason: "custom text failed" }
  return { ok: true, reason: "" }
}

async function typeCustom(io: PickerIO, row: number, text: string): Promise<boolean> {
  if (!(await io.digit(row))) return false
  await io.sleep(200)
  if (!(await io.text(text))) return false
  await io.sleep(120)
  return io.key("Enter")
}

// No pane to read: fixed gaps sized for a Mac terminal that has just returned
// from the hook. Same key grammar, no verification possible.
async function driveBlind(io: PickerIO, questions: QuestionItem[], answers: QuestionAnswer[]): Promise<DriveResult> {
  await io.sleep(900)
  for (let i = 0; i < questions.length; i++) {
    if (i > 0) await io.sleep(400)
    const r = await answerOne(io, questions[i]!, answers[i] ?? { selected: [] })
    if (!r.ok) return r
  }
  const last = questions[questions.length - 1]
  if (last?.multiSelect === false) {
    // auto-advanced to review already
  } else if (!last) {
    return { ok: false, reason: "no questions" }
  }
  await io.sleep(400)
  await io.key("Enter")
  return { ok: true, reason: "blind (unverified)" }
}
