import { test, expect } from "bun:test"
import {
  type ApprovalRequest,
  addApprovalRequest,
  cancelApprovalsFor,
  getPending,
  hasPendingApprovalFor,
  onApprovalExpired,
  onApprovalRequest,
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

test("the expiry exit fires the handler with the request and resolves expired — never allow", async () => {
  const seen: ApprovalRequest[] = []
  const decisions: string[] = []
  const off = onApprovalExpired((r, d) => { seen.push(r); decisions.push(d) })
  const decided = addApprovalRequest(
    {
      agent: "claude", sessionId: "pm-3", tool: "Bash", input: {},
      cwd: "/home/aubut", sessionKey: "claude:tty:/dev/pts/82",
    },
    { expiryMs: 10 },
  )
  const id = pendingFor("pm-3").id
  // Fail closed: an unanswered approval is NOT an allow (it was until
  // 2026-10-01). The route turns "expired" into no decision at all.
  expect(await decided).toBe("expired")
  expect(decisions).toEqual(["expired"])
  expect(seen.length).toBe(1)
  expect(seen[0]?.id).toBe(id)
  expect(seen[0]?.sessionKey).toBe("claude:tty:/dev/pts/82")
  // Expiry is a real exit: nothing is left to resolve, so no second listener.
  expect(getPending().some((r) => r.id === id)).toBe(false)
  expect(resolveApproval(id, "allow")).toBe(false)
  off()
})

test("reason rides the pending record and the request handler; absent stays absent", async () => {
  const seen: ApprovalRequest[] = []
  const off = onApprovalRequest((r) => seen.push(r))
  const withReason = addApprovalRequest({
    agent: "claude", sessionId: "pm-4", tool: "Bash", input: { command: "terraform apply" },
    cwd: "/home/aubut", sessionKey: "claude:tty:/dev/pts/83", reason: "not on the Bash allowlist",
  })
  const without = addApprovalRequest({
    agent: "codex", sessionId: "pm-5", tool: "Bash", input: {},
    cwd: "/home/aubut", sessionKey: "codex:tty:/dev/pts/84",
  })
  expect(pendingFor("pm-4").reason).toBe("not on the Bash allowlist")
  expect(pendingFor("pm-5").reason).toBeUndefined()
  expect(seen.find((r) => r.sessionId === "pm-4")?.reason).toBe("not on the Bash allowlist")
  resolveApproval(pendingFor("pm-4").id, "allow")
  resolveApproval(pendingFor("pm-5").id, "deny")
  await Promise.all([withReason, without])
  off()
})

test("abort of the hook request ends the approval 'elsewhere' (no allow), once", async () => {
  const decisions: string[] = []
  const off = onApprovalExpired((_r, d) => decisions.push(d))
  const ctrl = new AbortController()
  const decided = addApprovalRequest(
    { agent: "claude", sessionId: "pm-ab", tool: "Bash", input: { command: "x" }, cwd: "/h", sessionKey: "k-ab" },
    { signal: ctrl.signal },
  )
  const id = pendingFor("pm-ab").id
  ctrl.abort()
  expect(await decided).toBe("elsewhere")
  expect(decisions).toEqual(["elsewhere"])
  // Late phone decision finds nothing.
  expect(resolveApproval(id, "allow")).toBe(false)
  off()
})

test("an already-aborted signal ends the approval immediately", async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  const decided = addApprovalRequest(
    { agent: "claude", sessionId: "pm-ab2", tool: "Bash", input: {}, cwd: "/h", sessionKey: "k-ab2" },
    { signal: ctrl.signal },
  )
  expect(await decided).toBe("elsewhere")
  expect(getPending().some((r) => r.sessionId === "pm-ab2")).toBe(false)
})

test("cancelApprovalsFor ends only the matching call; a parallel call of the same tool keeps its card", async () => {
  const a = addApprovalRequest({ agent: "claude", sessionId: "pm-c", tool: "Bash", input: { command: "one" }, cwd: "/h", sessionKey: "k-c" })
  const b = addApprovalRequest({ agent: "claude", sessionId: "pm-c", tool: "Bash", input: { command: "two" }, cwd: "/h", sessionKey: "k-c" })
  const c = addApprovalRequest({ agent: "claude", sessionId: "pm-c", tool: "Write", input: { file_path: "/x" }, cwd: "/h", sessionKey: "k-c", toolUseId: "toolu_1" })
  expect(hasPendingApprovalFor("k-c", "")).toBe(true)
  expect(hasPendingApprovalFor("", "pm-c")).toBe(true)
  expect(hasPendingApprovalFor("k-other", "pm-other")).toBe(false)
  expect(cancelApprovalsFor({ sessionId: "pm-c", tool: "Bash", input: { command: "one" } })).toBe(1)
  expect(await a).toBe("elsewhere")
  // tool_use_id wins over input when both sides carry one.
  expect(cancelApprovalsFor({ sessionId: "pm-c", tool: "Write", input: { file_path: "/x" }, toolUseId: "toolu_2" })).toBe(0)
  expect(cancelApprovalsFor({ sessionId: "pm-c", tool: "Write", input: {}, toolUseId: "toolu_1" })).toBe(1)
  expect(await c).toBe("elsewhere")
  // Another session never matches; an empty matcher never matches.
  expect(cancelApprovalsFor({ sessionId: "pm-z", sessionKey: "k-z" })).toBe(0)
  expect(cancelApprovalsFor({})).toBe(0)
  // Session-wide (Stop / SessionEnd) ends the rest.
  expect(cancelApprovalsFor({ sessionKey: "k-c" })).toBe(1)
  expect(await b).toBe("elsewhere")
  expect(hasPendingApprovalFor("k-c", "pm-c")).toBe(false)
})
