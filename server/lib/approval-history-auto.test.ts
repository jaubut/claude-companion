import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DETAIL_MAX_BYTES, getHistoryItem, historyCounts, listHistory, recordOutcome, recordPending, useApprovalHistoryDb } from "./approval-history"
import {
  type AutoDecision,
  type AutoFrame,
  FLUSH_ROWS,
  autoHistoryStats,
  autoRetentionDays,
  createAutoFrameThrottle,
  flushAutoHistory,
  onAutoHistoryFlush,
  pruneAutoHistory,
  recordAutoDecision,
  resetAutoHistoryForTests,
} from "./approval-history-auto"
import { MASK, setRedactionSources } from "./secret-redact"

// Unit: auto-decision rows — batching, row shape, redaction/caps, filters,
// stats, retention (auto rows only), error containment, frame throttle.
// Isolated sqlite per test, never ~/.claude-companion/companion.db.

const dir = mkdtempSync(join(tmpdir(), "appr-hist-auto-"))
const SECRET = "zz-auto-secret-value-9876"
let dbPath = ""
let n = 0

beforeAll(() => {
  writeFileSync(join(dir, "secrets.env"), `ZZ_AUTO='${SECRET}'\n`)
  setRedactionSources([join(dir, "secrets.env")])
})
afterAll(() => setRedactionSources(null))
beforeEach(() => {
  resetAutoHistoryForTests()
  dbPath = join(dir, `a-${++n}.db`)
  useApprovalHistoryDb(dbPath)
})

function dec(over: Partial<AutoDecision> = {}): AutoDecision {
  return { agent: "claude", tool: "Bash", input: { command: "ls -la" }, cwd: "/tmp/p", sessionId: "s1", sessionKey: "k1", decision: "allow", via: "super", ...over }
}

test("recordAutoDecision does no I/O; flush writes one row per decision with resolved_at = created_at", () => {
  recordAutoDecision(dec())
  recordAutoDecision(dec({ decision: "deny", via: "auto_judge", reason: "matches the destructive-command denylist", toolUseId: "tu1" }))
  expect(autoHistoryStats()).toMatchObject({ buffered: 2, transactions: 0 })
  expect(listHistory({ state: "everything" }).items).toEqual([])
  expect(flushAutoHistory()).toBe(2)
  const items = listHistory({ state: "everything" }).items
  expect(items.length).toBe(2)
  for (const i of items) {
    expect(i.kind).toBe("approval")
    expect(i.resolved_at).toBe(i.created_at)
    expect(i).toMatchObject({ tool: "Bash", summary: "ls -la", cwd: "/tmp/p", session_id: "s1", session_key: "k1" })
  }
  const denied = items.find((i) => i.state === "auto_denied")!
  expect(denied.decided_via).toBe("auto_judge")
  expect(getHistoryItem(denied.id)!.detail).toEqual({ agent: "claude", input: { command: "ls -la" }, reason: "matches the destructive-command denylist", toolUseId: "tu1" })
  expect(items.find((i) => i.state === "auto_allowed")!.decided_via).toBe("super")
  expect(typeof getHistoryItem(denied.id)!.host).toBe("string")
})

test("100 rapid decisions → a few transactions, all rows written", async () => {
  const t0 = performance.now()
  for (let i = 0; i < 100; i++) recordAutoDecision(dec({ input: { command: `echo ${i}` } }))
  const pushMs = performance.now() - t0
  expect(pushMs).toBeLessThan(50)
  expect(autoHistoryStats().transactions).toBe(0)
  for (let i = 0; i < 100 && autoHistoryStats().buffered > 0; i++) await Bun.sleep(10)
  const s = autoHistoryStats()
  expect(s.rows).toBe(100)
  expect(s.buffered).toBe(0)
  expect(s.transactions).toBeGreaterThanOrEqual(1)
  expect(s.transactions).toBeLessThanOrEqual(Math.ceil(100 / FLUSH_ROWS) + 1)
  expect(listHistory({ state: "auto", limit: 200 }).items.length).toBe(100)
})

test("the timer flushes a small batch on its own (≤ 250 ms)", async () => {
  recordAutoDecision(dec())
  await Bun.sleep(400)
  expect(autoHistoryStats()).toMatchObject({ rows: 1, transactions: 1, buffered: 0 })
})

test("redaction and caps apply to auto rows", () => {
  const big = "x".repeat(DETAIL_MAX_BYTES * 2)
  recordAutoDecision(dec({ input: { command: `curl -H "Authorization: Bearer tok123456" -d ${SECRET}` } }))
  recordAutoDecision(dec({ tool: "Write", input: { file_path: "/tmp/big", content: big } }))
  flushAutoHistory()
  const items = listHistory({ state: "auto" }).items
  const bash = items.find((i) => i.tool === "Bash")!
  expect(bash.summary).not.toContain(SECRET)
  expect(bash.summary).toContain(MASK)
  const detail = JSON.stringify(getHistoryItem(bash.id)!.detail)
  expect(detail).not.toContain(SECRET)
  expect(detail).not.toContain("tok123456")
  const write = items.find((i) => i.tool === "Write")!
  expect(getHistoryItem(write.id)!.detail).toMatchObject({ truncated: true })
})

function seedPhone(id: string, end?: "allowed" | "denied"): void {
  recordPending({ id, kind: "approval", tool: "Bash", summary: `phone ${id}`, detail: {}, sessionKey: "k", sessionId: "s", cwd: "/tmp/p" })
  if (end) recordOutcome(id, end, "phone")
}

test("filters: all = phone only, resolved = phone non-pending, auto, auto_allowed, everything", () => {
  seedPhone("p-pend")
  seedPhone("p-allow", "allowed")
  recordAutoDecision(dec())
  recordAutoDecision(dec({ decision: "deny", via: "auto_judge" }))
  flushAutoHistory()
  const ids = (state?: string) => listHistory({ state }).items.map((i) => i.state).sort()
  expect(ids()).toEqual(["allowed", "pending"])
  expect(ids("all")).toEqual(["allowed", "pending"])
  expect(ids("resolved")).toEqual(["allowed"])
  expect(ids("auto")).toEqual(["auto_allowed", "auto_denied"])
  expect(ids("auto_allowed")).toEqual(["auto_allowed"])
  expect(ids("auto_denied")).toEqual(["auto_denied"])
  expect(ids("everything")).toEqual(["allowed", "auto_allowed", "auto_denied", "pending"])
})

test("cursor pagination over auto rows", () => {
  for (let i = 0; i < 7; i++) recordAutoDecision(dec({ input: { command: `echo ${i}` } }))
  flushAutoHistory()
  const p1 = listHistory({ state: "auto", limit: 3 })
  const p2 = listHistory({ state: "auto", limit: 3, before: p1.next! })
  const p3 = listHistory({ state: "auto", limit: 3, before: p2.next! })
  const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id)
  expect(new Set(all).size).toBe(7)
  expect(p3.next).toBeNull()
})

test("historyCounts: every state present, since honoured", () => {
  seedPhone("c-pend")
  seedPhone("c-deny", "denied")
  recordAutoDecision(dec())
  recordAutoDecision(dec())
  recordAutoDecision(dec({ decision: "deny", via: "auto_judge" }))
  flushAutoHistory()
  expect(historyCounts()).toEqual({ pending: 1, allowed: 0, denied: 1, expired: 0, elsewhere: 0, answered: 0, auto_allowed: 2, auto_denied: 1 })
  const future = new Date(Date.now() + 60_000).toISOString()
  expect(Object.values(historyCounts(future)).every((v) => v === 0)).toBe(true)
})

test("retention prunes only auto rows older than N days (env configurable)", () => {
  const db = new Database(dbPath)
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
  const mid = new Date(Date.now() - 10 * 86_400_000).toISOString()
  const ins = db.query("INSERT INTO approval_history (id, kind, state, created_at, resolved_at) VALUES (?, 'approval', ?, ?, ?)")
  ins.run("old-auto", "auto_allowed", old, old)
  ins.run("old-auto-d", "auto_denied", old, old)
  ins.run("mid-auto", "auto_allowed", mid, mid)
  ins.run("old-phone", "allowed", old, old)
  db.close()
  expect(autoRetentionDays()).toBe(30)
  expect(pruneAutoHistory()).toBe(2)
  const left = listHistory({ state: "everything" }).items.map((i) => i.id).sort()
  expect(left).toEqual(["mid-auto", "old-phone"])
  process.env.COMPANION_HISTORY_AUTO_DAYS = "7"
  try {
    expect(autoRetentionDays()).toBe(7)
    expect(pruneAutoHistory()).toBe(1)
  } finally {
    delete process.env.COMPANION_HISTORY_AUTO_DAYS
  }
  expect(listHistory({ state: "everything" }).items.map((i) => i.id)).toEqual(["old-phone"])
})

test("a write error drops the batch, is logged once per minute, never throws", () => {
  const db = new Database(dbPath)
  db.exec("DROP TABLE approval_history")
  db.close()
  const lines: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((s: string | Uint8Array) => { lines.push(String(s)); return true }) as typeof process.stderr.write
  try {
    recordAutoDecision(dec())
    expect(() => flushAutoHistory()).not.toThrow()
    recordAutoDecision(dec())
    expect(() => flushAutoHistory()).not.toThrow()
  } finally {
    process.stderr.write = orig
  }
  expect(autoHistoryStats()).toMatchObject({ dropped: 2, rows: 0 })
  expect(lines.filter((l) => l.includes("approval history (auto)")).length).toBe(1)
})

test("flush listeners get the row count and the oldest created_at", () => {
  const seen: Array<[number, string]> = []
  const off = onAutoHistoryFlush((c, at) => seen.push([c, at]))
  try {
    recordAutoDecision(dec())
    recordAutoDecision(dec())
    flushAutoHistory()
  } finally { off() }
  expect(seen.length).toBe(1)
  expect(seen[0]![0]).toBe(2)
  expect(seen[0]![1]).toBe(listHistory({ state: "auto" }).items.at(-1)!.created_at)
})

test("frame throttle: leading frame, then at most one per window with the accumulated count", async () => {
  const frames: AutoFrame[] = []
  const push = createAutoFrameThrottle((f) => frames.push(f), 80)
  push(3, "2026-10-02T00:00:01.000Z")
  expect(frames).toEqual([{ type: "approval_history_auto", count: 3, since: "2026-10-02T00:00:01.000Z" }])
  push(2, "2026-10-02T00:00:02.000Z")
  push(4, "2026-10-02T00:00:03.000Z")
  expect(frames.length).toBe(1)
  await Bun.sleep(120)
  expect(frames.length).toBe(2)
  expect(frames[1]).toEqual({ type: "approval_history_auto", count: 6, since: "2026-10-02T00:00:02.000Z" })
  await Bun.sleep(120)
  expect(frames.length).toBe(2)
  push(0, "x")
  expect(frames.length).toBe(2)
})
