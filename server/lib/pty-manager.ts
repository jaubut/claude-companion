// Approval queue — holds pending tool approvals from Claude Code hooks

export interface ApprovalRequest {
  id: string
  agent?: "claude" | "codex" | "kimi"
  sessionId: string
  tool: string
  input: Record<string, unknown>
  cwd: string
  // The Session this approval blocks, issued by the route that already holds
  // the record (PRJ-OR1T Phase 11). Never reaches the wire: wiring/events.ts
  // builds the `approval` frame as a literal, never `...req`.
  sessionKey: string
  // Why the auto-judge escalated this to the phone (e.g. "not on the Bash
  // allowlist"). Optional: absent for paths that never ran the judge.
  reason?: string
  // Claude Code's id for this tool call, when the hook payload carried one.
  // Lets PostToolUse end exactly this approval, not a parallel sibling call.
  toolUseId?: string
  timestamp: number
  resolve: (outcome: ApprovalOutcome) => void
}

// What the hook route gets back. Only "allow" may ever let the tool run on the
// companion's say-so; "expired" (nobody decided in time) and "elsewhere" (the
// hook went away / the call was answered at the terminal) both mean the route
// returns NO decision, so Claude Code falls back to its own terminal prompt.
export type ApprovalOutcome = "allow" | "deny" | "expired" | "elsewhere"
// The no-decision exits, as sent on the `resolved` frame.
export type ApprovalEndDecision = "expired" | "elsewhere"

type EventHandler = (event: ApprovalRequest) => void
// Expiry and resolve both hand back the request: the listener needs its
// sessionKey and id to clear the waiting reason it created.
type ExpiryHandler = (req: ApprovalRequest, decision: ApprovalEndDecision) => void

const pending = new Map<string, ApprovalRequest>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const handlers = new Set<EventHandler>()
const expiryHandlers = new Set<ExpiryHandler>()
const resolvedHandlers = new Set<EventHandler>()

// The hook's curl gives up at 295 s and Claude Code kills the hook at 300 s.
// We expire the server-side request before either, so the route can answer
// with an explicit no-decision (`{}` → Claude Code's own terminal prompt) and
// the phones get a clear `expired` instead of the card silently going stale.
// Must stay below the hook scripts' curl --max-time (295).
export const EXPIRY_MS = 290_000

// Route-level test seam: the hook routes pass no expiryMs, so a route test
// that needs the expiry exit shortens the default here. Production never
// calls it.
let defaultExpiryMs = EXPIRY_MS
export function setDefaultApprovalExpiryMs(ms: number | null): void {
  defaultExpiryMs = ms ?? EXPIRY_MS
}

// `opts.expiryMs` is a test seam for the expiry exit — an env var would
// reintroduce the Bun import-order trap COMPANION_DB_PATH lives with.
// `opts.signal` is the hook request's abort signal: the hook process went away
// (Claude Code killed it, the user answered at the terminal, Esc), so the
// approval ends as "elsewhere".
export function addApprovalRequest(
  req: Omit<ApprovalRequest, "id" | "timestamp" | "resolve">,
  opts: { expiryMs?: number; signal?: AbortSignal } = {},
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    const request: ApprovalRequest = {
      ...req,
      id,
      timestamp: Date.now(),
      resolve,
    }
    pending.set(id, request)

    // Notify phone clients
    for (const handler of handlers) {
      try { handler(request) } catch { /* ignore */ }
    }

    // Auto-expire if no decision arrives in time. FAIL CLOSED: "expired" is
    // never an allow — the route returns no decision and Claude Code shows its
    // own prompt. (It resolved "allow" until 2026-10-01: an unanswered phone
    // approved anything after 290 s.)
    const timer = setTimeout(() => endUndecided(id, "expired"), opts.expiryMs ?? defaultExpiryMs)
    expiryTimers.set(id, timer)

    const signal = opts.signal
    if (signal) {
      const onAbort = (): void => { endUndecided(id, "elsewhere") }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

// The no-decision exit from `pending` (the other is resolveApproval); both fire
// a listener, so an approval can never strand its waiting reason.
function endUndecided(id: string, decision: ApprovalEndDecision): boolean {
  const req = pending.get(id)
  if (!req) return false
  pending.delete(id)
  const timer = expiryTimers.get(id)
  if (timer) clearTimeout(timer)
  expiryTimers.delete(id)
  for (const handler of expiryHandlers) {
    try { handler(req, decision) } catch { /* ignore */ }
  }
  req.resolve(decision)
  return true
}

export interface ApprovalMatch {
  sessionId?: string
  sessionKey?: string
  // When set, only approvals for this tool call: the tool_use_id when both
  // sides have one, else tool name + identical input.
  tool?: string
  input?: Record<string, unknown>
  toolUseId?: string
}

function sameCall(r: ApprovalRequest, who: ApprovalMatch): boolean {
  if (who.tool === undefined) return true
  if (r.tool !== who.tool) return false
  if (r.toolUseId && who.toolUseId) return r.toolUseId === who.toolUseId
  if (who.input === undefined) return true
  return JSON.stringify(r.input) === JSON.stringify(who.input)
}

// The approval went away without the phone: its hook was dropped, the call
// ran (PostToolUse — answered at the terminal), or the turn / session ended.
// Never an allow, never learned. Matches on session id or session key (and the
// call, when given); returns how many were ended.
export function cancelApprovalsFor(who: ApprovalMatch, decision: ApprovalEndDecision = "elsewhere"): number {
  let n = 0
  for (const r of [...pending.values()]) {
    const bySession = !!who.sessionId && r.sessionId === who.sessionId
    const byKey = !!who.sessionKey && r.sessionKey === who.sessionKey
    if ((bySession || byKey) && sameCall(r, who) && endUndecided(r.id, decision)) n++
  }
  return n
}

export function hasPendingApprovalFor(sessionKey: string, sessionId: string): boolean {
  for (const r of pending.values()) {
    if (sessionKey && r.sessionKey === sessionKey) return true
    if (sessionId && r.sessionId === sessionId) return true
  }
  return false
}

export function resolveApproval(id: string, decision: "allow" | "deny"): boolean {
  const req = pending.get(id)
  if (!req) return false
  const timer = expiryTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    expiryTimers.delete(id)
  }
  // Fired inside the `pending.get` guard, so a decision arriving over both the
  // WS and REST paths notifies exactly once.
  for (const handler of resolvedHandlers) {
    try { handler(req) } catch { /* ignore */ }
  }
  req.resolve(decision)
  // One of the only two exits from `pending` (the other is endUndecided);
  // both fire a listener.
  pending.delete(id)
  return true
}

export function getPending(): ApprovalRequest[] {
  return Array.from(pending.values()).sort((a, b) => a.timestamp - b.timestamp)
}

export function onApprovalRequest(handler: EventHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

// Subscribe to "approval ended with no decision" — expired, or answered /
// dropped elsewhere. Used by the server to emit a `resolved` frame with
// decision="expired"|"elsewhere" so phones can flip the row's verdict without
// confusing it with a real allow/deny.
export function onApprovalExpired(handler: ExpiryHandler): () => void {
  expiryHandlers.add(handler)
  return () => expiryHandlers.delete(handler)
}

// Subscribe to "the user decided" — the counterpart exit to onApprovalExpired.
// wiring/events.ts uses it to clear the session's `approval` waiting reason;
// the `resolved` frame is already broadcast by ws.ts and routes/api.ts.
export function onApprovalResolved(handler: EventHandler): () => void {
  resolvedHandlers.add(handler)
  return () => resolvedHandlers.delete(handler)
}
