// Approval queue — holds pending tool approvals from Claude Code hooks

export interface ApprovalRequest {
  id: string
  sessionId: string
  tool: string
  input: Record<string, unknown>
  cwd: string
  timestamp: number
  resolve: (decision: "allow" | "deny") => void
}

type EventHandler = (event: ApprovalRequest) => void

const pending = new Map<string, ApprovalRequest>()
const handlers = new Set<EventHandler>()

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
  })
}

export function resolveApproval(id: string, decision: "allow" | "deny"): boolean {
  const req = pending.get(id)
  if (!req) return false
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
