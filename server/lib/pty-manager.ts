// Approval queue — holds pending tool approvals from Claude Code hooks

export interface ApprovalRequest {
  id: string
  agent?: "claude" | "codex"
  sessionId: string
  tool: string
  input: Record<string, unknown>
  cwd: string
  timestamp: number
  resolve: (decision: "allow" | "deny") => void
}

type EventHandler = (event: ApprovalRequest) => void
type ExpiryHandler = (id: string) => void

const pending = new Map<string, ApprovalRequest>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const handlers = new Set<EventHandler>()
const expiryHandlers = new Set<ExpiryHandler>()

// Hook's curl times out at 300s and Claude defaults to "allow" when the
// hook returns nothing. We expire the server-side request slightly before
// that so we get a chance to broadcast a clear `expired` signal to phones
// instead of having the approval just silently fall off the queue.
const EXPIRY_MS = 290_000

export function addApprovalRequest(req: Omit<ApprovalRequest, "id" | "timestamp" | "resolve">): Promise<"allow" | "deny"> {
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
      pending.delete(id)
      expiryTimers.delete(id)
      for (const handler of expiryHandlers) {
        try { handler(id) } catch { /* ignore */ }
      }
      req.resolve("allow")
    }, EXPIRY_MS)
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
  req.resolve(decision)
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
