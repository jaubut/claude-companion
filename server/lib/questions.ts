// Question queue — holds pending AskUserQuestion calls from Claude Code.
//
// Distinct from the approval queue (pty-manager.ts) on purpose: an approval
// is a binary deny/allow gate, while a question is a structured pick-an-option
// interaction. Mixing them on the wire conflated UX (the phone showed
// deny/allow for AskUserQuestion, which is meaningless — there's no "deny"
// for a question, only an answer).

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionItem {
  id?: string
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

export interface QuestionRequest {
  id: string
  agent?: "claude" | "codex" | "kimi"
  sessionId: string
  cwd: string
  questions: QuestionItem[]
  // The Session this question blocks, issued by the route that already holds
  // the record (PRJ-OR1T Phase 11). Never reaches the wire.
  sessionKey: string
  timestamp: number
  resolve: (answers: QuestionAnswer[]) => void
}

// One answer per question. selected[] holds the chosen option labels (single-
// item array for non-multiSelect questions). otherText is set when the user
// chose "Other" with custom text.
export interface QuestionAnswer {
  selected: string[]
  otherText?: string
}

type EventHandler = (event: QuestionRequest) => void
// Expiry and resolve both hand back the request: the listener needs its
// sessionKey and id to clear the waiting reason it created. `decision` is the
// `resolved` frame's value: "expired" for the phone window running out (or
// the question going away with no answer), "answered" when it was answered
// at the terminal instead (see cancelQuestionsFor).
export type QuestionEndDecision = "expired" | "answered"
// `via` names the exit ("expiry", or the caller's reason for
// cancelQuestionsFor) — the approval history records it.
type ExpiryHandler = (req: QuestionRequest, decision: QuestionEndDecision, via: string) => void
// Who answered, when the transport knows (X-Companion-Device / WS client).
export interface AnsweredBy { device?: string }
type ResolvedHandler = (req: QuestionRequest, answers: QuestionAnswer[], by: AnsweredBy) => void

const pending = new Map<string, QuestionRequest>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const handlers = new Set<EventHandler>()
const expiryHandlers = new Set<ExpiryHandler>()
const resolvedHandlers = new Set<ResolvedHandler>()

// Same 290s budget as approvals — Claude's hook curl times out at 300s and
// we want to broadcast a clean `expired` signal before that fires. The hook
// route may pick a shorter window (lib/question-hook.ts questionWindowMs).
export const EXPIRY_MS = 290_000

// How long a question whose PreToolUse window lapsed stays answerable on the
// phone while Claude Code puts up its picker and fires the PermissionRequest
// sibling (~0.3 s later in practice). If no sibling claims it in this time it
// ends "expired" as before.
export const PARK_MS = 15_000

// Phone answers that arrived while a question was parked (between the
// PreToolUse and PermissionRequest windows), waiting for the sibling to claim
// them. Keyed by question id.
const parkedAnswers = new Map<string, { answers: QuestionAnswer[]; sessionId: string; sessionKey: string }>()
const parkTimers = new Map<string, ReturnType<typeof setTimeout>>()

export interface QuestionAskOptions {
  // Test seam for the expiry exit — a param, not an env var (pty-manager).
  expiryMs?: number
  // Reuse this id (the PermissionRequest re-ask keeps the PreToolUse id, so
  // the phone upserts the same card).
  id?: string
  // When the window lapses, resolve [] for the caller but keep the question
  // pending (still answerable on the phone) for this long — see PARK_MS.
  parkMs?: number
  // A phone answer that landed while parked and nobody claimed it.
  onUnclaimedAnswer?: (answers: QuestionAnswer[]) => void
}

export function addQuestionRequest(
  req: Omit<QuestionRequest, "id" | "timestamp" | "resolve">,
  opts: QuestionAskOptions = {},
): Promise<QuestionAnswer[]> {
  return new Promise((resolve) => {
    const id = opts.id ?? crypto.randomUUID()
    // A reused id still pending from an earlier ask ends quietly first.
    discardParked(id)
    const request: QuestionRequest = {
      ...req,
      id,
      timestamp: Date.now(),
      resolve,
    }
    pending.set(id, request)

    for (const handler of handlers) {
      try { handler(request) } catch { /* ignore */ }
    }

    // On expiry we resolve with empty answers — the caller decides how to
    // surface that (the hook route: no decision, so the terminal picker takes
    // it). We don't pretend they answered.
    const onLapse = opts.parkMs ? () => park(id, opts.parkMs!, opts.onUnclaimedAnswer) : () => endUnanswered(id, "expired", "expiry")
    const timer = setTimeout(onLapse, opts.expiryMs ?? EXPIRY_MS)
    expiryTimers.set(id, timer)
  })
}

// The window lapsed but a sibling hook is expected to pick the question up:
// the caller gets [] now, the question stays pending (phone card up, replayed
// on reconnect, answerable), and a phone answer is held for the sibling.
function park(id: string, parkMs: number, onUnclaimed?: (answers: QuestionAnswer[]) => void): void {
  const r = pending.get(id)
  if (!r) return
  expiryTimers.delete(id)
  const hand = r.resolve
  r.resolve = (answers) => {
    if (answers.length) parkedAnswers.set(id, { answers, sessionId: r.sessionId, sessionKey: r.sessionKey })
  }
  hand([])
  const t = setTimeout(() => {
    parkTimers.delete(id)
    const held = parkedAnswers.get(id)
    parkedAnswers.delete(id)
    if (held) { try { onUnclaimed?.(held.answers) } catch { /* ignore */ } }
    endUnanswered(id, "expired", "expiry")
  }, parkMs)
  ;(t as unknown as { unref?: () => void }).unref?.()
  parkTimers.set(id, t)
}

function discardParked(id: string): void {
  const t = parkTimers.get(id)
  if (t) clearTimeout(t)
  parkTimers.delete(id)
  parkedAnswers.delete(id)
}

// The sibling hook claims a parked question. Returns the phone's answer when
// it already came in between windows, `null` when the question is still
// waiting (still pending, parked — the caller re-asks it with the same id),
// or `undefined` when it is gone (expired / ended).
export function claimParkedQuestion(id: string): QuestionAnswer[] | null | undefined {
  const held = parkedAnswers.get(id)
  if (held) {
    discardParked(id)
    return held.answers
  }
  if (!parkTimers.has(id)) return undefined
  discardParked(id)
  // Leave it in `pending`: addQuestionRequest with the same id replaces the
  // record, re-broadcasts the `question` frame and re-pushes.
  return null
}

// The no-answer exit from `pending` (the other is resolveQuestion); both fire
// a listener, so a question can never strand its waiting reason.
function endUnanswered(id: string, decision: QuestionEndDecision, via: string): boolean {
  const r = pending.get(id)
  if (!r) return false
  pending.delete(id)
  discardParked(id)
  const timer = expiryTimers.get(id)
  if (timer) clearTimeout(timer)
  expiryTimers.delete(id)
  for (const handler of expiryHandlers) {
    try { handler(r, decision, via) } catch { /* ignore */ }
  }
  r.resolve([])
  return true
}

// The question went away without the phone: answered in the terminal picker
// (PostToolUse for the question tool), or the turn / session moved on (Stop,
// UserPromptSubmit, SessionEnd). Claude Code shows its picker WHILE a
// PermissionRequest hook is still waiting and drops the hook when the user
// answers locally, so without this the phone card sat there until the 290 s
// expiry and the log read "question expired" for a question that had been
// answered (audit 2026-09-25). Matches on session id or session key; returns
// how many were ended.
export function cancelQuestionsFor(who: { sessionId?: string; sessionKey?: string }, decision: QuestionEndDecision, via = "cancelled"): number {
  let n = 0
  for (const r of [...pending.values()]) {
    const bySession = !!who.sessionId && r.sessionId === who.sessionId
    const byKey = !!who.sessionKey && r.sessionKey === who.sessionKey
    if ((bySession || byKey) && endUnanswered(r.id, decision, via)) n++
  }
  // A phone answer held for a sibling that will now never come (the picker
  // was answered at the terminal / the turn moved on): drop it, never type it.
  for (const [id, h] of [...parkedAnswers]) {
    if ((who.sessionId && h.sessionId === who.sessionId) || (who.sessionKey && h.sessionKey === who.sessionKey)) discardParked(id)
  }
  return n
}

export function resolveQuestion(id: string, answers: QuestionAnswer[], by: AnsweredBy = {}): boolean {
  const req = pending.get(id)
  if (!req) return false
  // A parked question keeps its park timer: the held answer waits there for
  // the sibling hook (claimParkedQuestion) or the unclaimed fallback.
  const timer = expiryTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    expiryTimers.delete(id)
  }
  // Fired inside the `pending.get` guard, so an answer arriving over both the
  // WS and REST paths notifies exactly once.
  for (const handler of resolvedHandlers) {
    try { handler(req, answers, by) } catch { /* ignore */ }
  }
  req.resolve(answers)
  // One of the only two exits from `pending` (the other is the expiry timer);
  // both fire a listener.
  pending.delete(id)
  return true
}

export function getPendingQuestions(): QuestionRequest[] {
  return Array.from(pending.values()).sort((a, b) => a.timestamp - b.timestamp)
}

export function onQuestionRequest(handler: EventHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function onQuestionExpired(handler: ExpiryHandler): () => void {
  expiryHandlers.add(handler)
  return () => expiryHandlers.delete(handler)
}

// Subscribe to "the user answered" — the counterpart exit to onQuestionExpired.
// wiring/events.ts uses it to clear the session's `question` waiting reason.
export function onQuestionResolved(handler: ResolvedHandler): () => void {
  resolvedHandlers.add(handler)
  return () => resolvedHandlers.delete(handler)
}

export function isQuestionTool(tool: string): boolean {
  const normalized = tool
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  return normalized === "askuserquestion"
    || normalized === "requestuserinput"
    || normalized === "askuser"
    || normalized.endsWith("requestuserinput")
    || normalized.endsWith("askuserquestion")
}

function parseOptions(raw: unknown): QuestionOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const options: QuestionOption[] = []
  for (const o of raw) {
    if (typeof o === "string") {
      if (!o) return null
      options.push({ label: o })
      continue
    }
    if (!o || typeof o !== "object") return null
    const oobj = o as Record<string, unknown>
    const label = typeof oobj.label === "string" ? oobj.label : ""
    if (!label) return null
    const description = typeof oobj.description === "string" ? oobj.description : undefined
    options.push({ label, description })
  }
  return options
}

// Defensive parser for the AskUserQuestion `tool_input` shape. Returns null
// when the shape doesn't match — caller falls back to the generic approval
// flow rather than broadcasting a malformed question frame.
export function parseQuestionInput(input: unknown): QuestionItem[] | null {
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  const raw = Array.isArray(obj.questions) ? obj.questions : [obj]
  if (raw.length === 0) return null

  const out: QuestionItem[] = []
  for (const q of raw) {
    if (!q || typeof q !== "object") return null
    const qobj = q as Record<string, unknown>
    const id = typeof qobj.id === "string" ? qobj.id : undefined
    const question = typeof qobj.question === "string" ? qobj.question : ""
    const header = typeof qobj.header === "string" ? qobj.header : ""
    const multiSelect = qobj.multiSelect === true
    const options = parseOptions(qobj.options ?? qobj.choices)
    if (!options) return null
    if (!question) return null
    out.push({ id, question, header, multiSelect, options })
  }
  return out
}

// ---- hook dedupe ------------------------------------------------------------
//
// Claude Code can fire BOTH PreToolUse and PermissionRequest for one
// AskUserQuestion call (the Linux host wires both hooks with matcher "*"). Without
// this, the phone gets two cards and two drivers type into one picker (seen
// live 2026-09-05: "answered ← phone" + "key-seq delivered" twice per
// question, picker left half-filled, never submitted). The first hook to see
// a question asks the phone and drives the picker; any later hook carrying
// the same session + questions inside the window just allows.

const RECENT_ANSWER_TTL_MS = 180_000
const recentlyAnswered = new Map<string, { at: number; answers: QuestionAnswer[] }>()
// Questions whose phone window ended with no answer, with the hook phase that
// lapsed and the question id. A PreToolUse lapse is re-asked by the
// PermissionRequest sibling (same id); a PermissionRequest lapse is final.
const recentlyFellThrough = new Map<string, { at: number; phase: "PreToolUse" | "PermissionRequest"; id: string }>()

export function questionDedupeKey(sessionId: string, cwd: string, questions: QuestionItem[]): string {
  const who = sessionId || cwd || "?"
  const what = questions.map((q) => `${q.header}|${q.question}|${q.multiSelect ? 1 : 0}|${q.options.map((o) => o.label).join(",")}`).join("||")
  return `${who}::${what}`
}

export function markQuestionAnswered(key: string, now = Date.now(), answers: QuestionAnswer[] = []): void {
  recentlyAnswered.set(key, { at: now, answers })
  for (const [k, v] of recentlyAnswered) {
    if (now - v.at > RECENT_ANSWER_TTL_MS) recentlyAnswered.delete(k)
  }
}

export function wasQuestionAnswered(key: string, now = Date.now()): boolean {
  return answeredWith(key, now) !== null
}

// The phone's answers for a recently answered question, so the sibling hook
// can hand Claude Code the same updatedInput. Null when unknown / aged out.
export function answeredWith(key: string, now = Date.now()): QuestionAnswer[] | null {
  const v = recentlyAnswered.get(key)
  if (v === undefined) return null
  if (now - v.at > RECENT_ANSWER_TTL_MS) {
    recentlyAnswered.delete(key)
    return null
  }
  return v.answers
}

export function markQuestionFellThrough(
  key: string,
  now = Date.now(),
  phase: "PreToolUse" | "PermissionRequest" = "PermissionRequest",
  id = "",
): void {
  recentlyFellThrough.set(key, { at: now, phase, id })
  for (const [k, v] of recentlyFellThrough) {
    if (now - v.at > RECENT_ANSWER_TTL_MS) recentlyFellThrough.delete(k)
  }
}

export function fellThrough(key: string, now = Date.now()): { phase: "PreToolUse" | "PermissionRequest"; id: string } | null {
  const v = recentlyFellThrough.get(key)
  if (v === undefined) return null
  if (now - v.at > RECENT_ANSWER_TTL_MS) {
    recentlyFellThrough.delete(key)
    return null
  }
  return { phase: v.phase, id: v.id }
}

export function didQuestionFallThrough(key: string, now = Date.now()): boolean {
  return fellThrough(key, now) !== null
}

// Claude Code's AskUserQuestion takes `answers` in its input: question text ->
// answer string, multi-select comma-joined ("User answers collected by the
// permission component", CC 2.1.282 schema). A PreToolUse allow or a
// PermissionRequest allow carrying it as updatedInput answers the question
// with no picker at all — verified live on 2.1.282 for both hooks, single,
// multi and free text. Option labels the phone picked are kept; anything
// else (the phone's "Other") contributes its free text.
export function questionAnswerMap(questions: QuestionItem[], answers: QuestionAnswer[]): Record<string, string> {
  const out: Record<string, string> = {}
  questions.forEach((q, i) => {
    const a = answers[i] ?? { selected: [] }
    const labels = new Set(q.options.map((o) => o.label))
    const picked = a.selected.filter((s) => labels.has(s))
    const custom = (a.otherText ?? "").trim()
    const parts = q.multiSelect ? [...picked] : picked.slice(0, 1)
    if (custom && (q.multiSelect || parts.length === 0)) parts.push(custom)
    // Nothing matched and no free text: the raw pick is the best we have.
    if (parts.length === 0 && a.selected[0]) parts.push(a.selected[0])
    if (parts.length > 0) out[q.question] = parts.join(", ")
  })
  return out
}

// The tool input Claude Code should run with: the call's own input, unchanged
// (its card-answer admitter refuses a changed shown field), plus `answers`.
export function answeredToolInput(
  input: Record<string, unknown>,
  questions: QuestionItem[],
  answers: QuestionAnswer[],
): Record<string, unknown> {
  return { ...input, answers: questionAnswerMap(questions, answers) }
}
