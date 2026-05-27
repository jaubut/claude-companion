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
  agent?: "claude" | "codex"
  sessionId: string
  cwd: string
  questions: QuestionItem[]
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
type ExpiryHandler = (id: string) => void

const pending = new Map<string, QuestionRequest>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const handlers = new Set<EventHandler>()
const expiryHandlers = new Set<ExpiryHandler>()

// Same 290s budget as approvals — Claude's hook curl times out at 300s and
// we want to broadcast a clean `expired` signal before that fires.
const EXPIRY_MS = 290_000

export function addQuestionRequest(req: Omit<QuestionRequest, "id" | "timestamp" | "resolve">): Promise<QuestionAnswer[]> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
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
    // surface that to Claude (typically: deny the tool with reason "user did
    // not answer in time"). We don't pretend they answered.
    const timer = setTimeout(() => {
      const r = pending.get(id)
      if (!r) return
      pending.delete(id)
      expiryTimers.delete(id)
      for (const handler of expiryHandlers) {
        try { handler(id) } catch { /* ignore */ }
      }
      r.resolve([])
    }, EXPIRY_MS)
    expiryTimers.set(id, timer)
  })
}

export function resolveQuestion(id: string, answers: QuestionAnswer[]): boolean {
  const req = pending.get(id)
  if (!req) return false
  const timer = expiryTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    expiryTimers.delete(id)
  }
  req.resolve(answers)
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
