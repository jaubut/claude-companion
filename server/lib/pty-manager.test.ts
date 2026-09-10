import { test, expect } from "bun:test"
import {
  type ApprovalRequest,
  addApprovalRequest,
  getPending,
  onApprovalExpired,
  onApprovalResolved,
  resolveApproval,
} from "./pty-manager"

// The approval lifecycle is what clears the session's `approval` waiting reason
// (PRJ-OR1T Phase 11), so both exits from the pending map are covered here:
// a decision and the 290s expiry, the latter through the `expiryMs` seam so no
// test waits on a real timer.

function pendingFor(sessionId: string): ApprovalRequest {
  return getPending().find((r) => r.sessionId === sessionId)!
}

test("sessionKey round-trips into the pending record", async () => {
  const decided = addApprovalRequest({
    agent: "claude", sessionId: "pm-1", tool: "Bash", input: { command: "ls" },
    cwd: "/home/aubut", sessionKey: "claude:tty:/dev/pts/80",
  })
  const req = pendingFor("pm-1")
  expect(req.sessionKey).toBe("claude:tty:/dev/pts/80")
  expect(req.tool).toBe("Bash")
  expect(resolveApproval(req.id, "allow")).toBe(true)
  expect(await decided).toBe("allow")
  expect(getPending().some((r) => r.id === req.id)).toBe(false)
})

test("onApprovalResolved fires once with the request, and not on a duplicate resolve", async () => {
  const seen: ApprovalRequest[] = []
  const off = onApprovalResolved((r) => seen.push(r))
  const decided = addApprovalRequest({
    agent: "claude", sessionId: "pm-2", tool: "Write", input: {},
    cwd: "/home/aubut", sessionKey: "claude:tty:/dev/pts/81",
  })
  const id = pendingFor("pm-2").id

  expect(resolveApproval(id, "deny")).toBe(true)
  expect(await decided).toBe("deny")
  // The phone can send the same decision over both the WS and the REST path.
  expect(resolveApproval(id, "deny")).toBe(false)

  expect(seen.length).toBe(1)
  expect(seen[0]?.id).toBe(id)
  expect(seen[0]?.sessionKey).toBe("claude:tty:/dev/pts/81")
  off()
})

test("the expiry exit fires the handler with the request and resolves allow", async () => {
  const seen: ApprovalRequest[] = []
  const off = onApprovalExpired((r) => seen.push(r))
  const decided = addApprovalRequest(
    {
      agent: "claude", sessionId: "pm-3", tool: "Bash", input: {},
      cwd: "/home/aubut", sessionKey: "claude:tty:/dev/pts/82",
    },
    { expiryMs: 10 },
  )
  const id = pendingFor("pm-3").id
  // Claude defaults to "allow" once its own hook curl times out; we match it.
  expect(await decided).toBe("allow")
  expect(seen.length).toBe(1)
  expect(seen[0]?.id).toBe(id)
  expect(seen[0]?.sessionKey).toBe("claude:tty:/dev/pts/82")
  // Expiry is a real exit: nothing is left to resolve, so no second listener.
  expect(getPending().some((r) => r.id === id)).toBe(false)
  expect(resolveApproval(id, "allow")).toBe(false)
  off()
})
