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
  timestamp: number
  resolve: (decision: "allow" | "deny") => void
}

type EventHandler = (event: ApprovalRequest) => void
// Expiry and resolve both hand back the request: the listener needs its
// sessionKey and id to clear the waiting reason it created.
type ExpiryHandler = (req: ApprovalRequest) => void

const pending = new Map<string, ApprovalRequest>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const handlers = new Set<EventHandler>()
const expiryHandlers = new Set<ExpiryHandler>()
const resolvedHandlers = new Set<EventHandler>()

// Hook's curl times out at 300s and Claude defaults to "allow" when the
// hook returns nothing. We expire the server-side request slightly before
// that so we get a chance to broadcast a clear `expired` signal to phones
// instead of having the approval just silently fall off the queue.
const EXPIRY_MS = 290_000

// `opts.expiryMs` is a test seam for the expiry exit — an env var would
// reintroduce the Bun import-order trap COMPANION_DB_PATH lives with.
export function addApprovalRequest(
  req: Omit<ApprovalRequest, "id" | "timestamp" | "resolve">,
  opts: { expiryMs?: number } = {},
): Promise<"allow" | "deny"> {
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

    // Auto-expire if no decision arrives in time. Resolves the promise as
    // "allow" because that's what Claude would do once the hook itself
    // times out — staying consistent avoids a confusing "I tapped allow
    // late and Claude denied it anyway" race.
    const timer = setTimeout(() => {
      const req = pending.get(id)
      if (!req) return
      // One of the only two exits from `pending` (the other is resolveApproval);
      // both fire a listener, so an approval can never strand its waiting reason.
      pending.delete(id)
      expiryTimers.delete(id)
      for (const handler of expiryHandlers) {
        try { handler(req) } catch { /* ignore */ }
      }
      req.resolve("allow")
    }, opts.expiryMs ?? EXPIRY_MS)
    expiryTimers.set(id, timer)
  })
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
  // One of the only two exits from `pending` (the other is the expiry timer);
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

// Subscribe to "approval expired before user could decide" — used by the
// server to emit a `resolved` frame with decision="expired" so phones can
// flip the row's verdict without confusing it with a real allow/deny.
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
