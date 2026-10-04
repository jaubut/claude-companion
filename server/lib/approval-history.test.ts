import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DETAIL_MAX_BYTES,
  SUMMARY_MAX,
  getHistoryItem,
  listHistory,
  onApprovalHistory,
  pruneHistory,
  recordOutcome,
  recordPending,
  useApprovalHistoryDb,
  type HistoryItem,
  type PendingEntry,
} from "./approval-history"
import { MASK, parseSecretValues, redactSecrets, setRedactionSources } from "./secret-redact"

// Unit: the approval_history store — upsert, one-way transitions, boot
// reconciliation, redaction, caps, pagination, filters, pruning. Always an
// isolated sqlite file, never the real Companion db.

const dir = mkdtempSync(join(tmpdir(), "appr-hist-"))
let dbPath = ""
let n = 0

const SECRET_ENV = "zz-known-secret-value-1234"
const SECRET_MIRROR = "mirror\"quoted\\value-5678"

beforeAll(() => {
  writeFileSync(join(dir, "secrets.env"), [
    "# header",
    `ZZ_ONE='${SECRET_ENV}'  # host.example.com`,
    "ZZ_SHORT=short",
  ].join("\n"))
  writeFileSync(join(dir, "secrets.mirror"), `export ZZ_TWO=${SECRET_MIRROR}\n`)
  setRedactionSources([join(dir, "secrets.env"), join(dir, "secrets.mirror"), join(dir, "missing")])
})
afterAll(() => setRedactionSources(null))

beforeEach(() => {
  dbPath = join(dir, `h-${++n}.db`)
  useApprovalHistoryDb(dbPath)
})

function entry(id: string, over: Partial<PendingEntry> = {}): PendingEntry {
  return { id, kind: "approval", tool: "Bash", summary: `cmd ${id}`, detail: { input: { command: `cmd ${id}` } }, sessionKey: "k1", sessionId: "s1", cwd: "/tmp/p", ...over }
}

test("insert pending → resolve once; a late second exit never overwrites", () => {
  recordPending(entry("a1"))
  expect(listHistory({}).items.map((i) => [i.id, i.state])).toEqual([["a1", "pending"]])
  expect(recordOutcome("a1", "allowed", "phone", { device: "iPhone" })).toBe(true)
  expect(recordOutcome("a1", "expired", "expiry")).toBe(false)
  const d = getHistoryItem("a1")!
  expect(d.state).toBe("allowed")
  expect(d.decided_via).toBe("phone")
  expect(d.device_claimed).toBe("iPhone")
  expect(d.resolved_at).toBeTruthy()
  expect(d.host).toBeTruthy()
  expect(d.detail).toEqual({ input: { command: "cmd a1" } })
  expect(recordOutcome("nope", "denied", "phone")).toBe(false)
})

test("same id re-asked → one row back to pending, created_at kept", () => {
  recordPending(entry("q1", { kind: "question" }))
  const first = getHistoryItem("q1")!
  recordOutcome("q1", "expired", "expiry")
  recordPending(entry("q1", { kind: "question", summary: "again" }))
  const all = listHistory({ state: "all" }).items
  expect(all.length).toBe(1)
  expect(all[0]!.state).toBe("pending")
  expect(all[0]!.decided_via).toBeNull()
  expect(all[0]!.resolved_at).toBeNull()
  expect(all[0]!.created_at).toBe(first.created_at)
  expect(all[0]!.summary).toBe("again")
})

test("detailPatch merges the chosen answers into the stored detail", () => {
  recordPending(entry("q2", { kind: "question", detail: { questions: [{ question: "Q?" }] } }))
  expect(recordOutcome("q2", "answered", "phone", { detailPatch: { answers: [{ selected: ["Red"] }] } })).toBe(true)
  expect(getHistoryItem("q2")!.detail).toEqual({ questions: [{ question: "Q?" }], answers: [{ selected: ["Red"] }] })
})

test("boot reconciliation: rows left pending by a previous process end expired / server_restart", () => {
  recordPending(entry("live"))
  recordPending(entry("done"))
  recordOutcome("done", "denied", "phone")
  useApprovalHistoryDb(dbPath) // reopen = boot
  expect(getHistoryItem("live")!.state).toBe("expired")
  expect(getHistoryItem("live")!.decided_via).toBe("server_restart")
  expect(getHistoryItem("done")!.state).toBe("denied")
})

test("migration is idempotent on an existing table", () => {
  recordPending(entry("m1"))
  const raw = new Database(dbPath)
  const cols = (raw.query("PRAGMA table_info(approval_history)").all() as Array<{ name: string }>).map((c) => c.name)
  raw.close()
  expect(cols).toEqual(["id", "kind", "state", "tool", "summary", "detail_json", "session_key", "session_id", "cwd", "host", "decided_via", "device_claimed", "created_at", "resolved_at"])
  useApprovalHistoryDb(dbPath)
  useApprovalHistoryDb(dbPath)
  expect(listHistory({}).items.length).toBe(1)
})

test("redaction: known vault values (env + mirror, JSON-escaped too) and token shapes", () => {
  expect(parseSecretValues(`A='${SECRET_ENV}' # x\nexport B="12345678"\n# C=commentedout123\nD=short`)).toEqual([SECRET_ENV, "12345678"])
  const cmd = `curl -H "Authorization: Bearer abc.def-ghi" -d ${SECRET_ENV} sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV ghp_ABCDEFGHIJKLMNOPQRSTUVWX pss_service:v2:abc:def short`
  const out = redactSecrets(cmd)
  expect(out).not.toContain(SECRET_ENV)
  expect(out).not.toContain("abc.def-ghi")
  expect(out).not.toContain("sk-ant-api03")
  expect(out).not.toContain("ghp_ABC")
  expect(out).not.toContain("pss_service")
  expect(out).toContain(`Bearer ${MASK}`)
  expect(out).toContain("short")

  recordPending(entry("r1", { summary: cmd, detail: { input: { command: cmd, note: SECRET_MIRROR } } }))
  const d = getHistoryItem("r1")!
  const stored = JSON.stringify(d)
  expect(stored).not.toContain(SECRET_ENV)
  expect(stored).not.toContain("mirror")
  expect(stored).not.toContain("sk-ant")
  expect(d.summary).toContain(MASK)
  // the stored detail is still valid JSON after masking an escaped value
  expect((d.detail as { input: { note: string } }).input.note).toBe(MASK)
})

test("summary ≤ 500 chars, detail ≤ 8 KB (truncated preview)", () => {
  recordPending(entry("big", { summary: "x".repeat(2000), detail: { input: { content: "y".repeat(50_000) } } }))
  const d = getHistoryItem("big")!
  expect(d.summary.length).toBe(SUMMARY_MAX)
  const raw = new Database(dbPath)
  const row = raw.query("SELECT detail_json FROM approval_history WHERE id='big'").get() as { detail_json: string }
  raw.close()
  expect(Buffer.byteLength(row.detail_json)).toBeLessThanOrEqual(DETAIL_MAX_BYTES)
  expect((d.detail as { truncated: boolean }).truncated).toBe(true)
})

test("pagination: newest first, `next` cursor walks every row once, limit clamped to 200", async () => {
  for (let i = 0; i < 7; i++) recordPending(entry(`p${i}`))
  const seen: string[] = []
  let before: string | undefined
  for (let page = 0; page < 10; page++) {
    const r = listHistory({ limit: 3, before })
    seen.push(...r.items.map((i) => i.id))
    if (!r.next) break
    before = r.next
  }
  expect(seen.length).toBe(7)
  expect(new Set(seen).size).toBe(7)
  const times = listHistory({ limit: 500 }).items.map((i) => i.created_at)
  expect([...times].sort().reverse()).toEqual(times)
  expect(listHistory({ limit: 0 }).items.length).toBe(1)
  // a bare created_at cursor works too
  const top = listHistory({ limit: 1 }).items[0]!
  expect(listHistory({ before: top.created_at }).items.every((i) => i.created_at < top.created_at)).toBe(true)
})

test("filters: state / resolved / all, kind, q (LIKE-escaped)", () => {
  recordPending(entry("f1", { summary: "git push origin" }))
  recordPending(entry("f2", { kind: "question", tool: "AskUserQuestion", summary: "Which 100% color?" }))
  recordPending(entry("f3", { summary: "rm thing" }))
  recordOutcome("f1", "allowed", "phone")
  recordOutcome("f2", "answered", "phone")
  const ids = (q: Parameters<typeof listHistory>[0]) => listHistory(q).items.map((i) => i.id).sort()
  expect(ids({ state: "pending" })).toEqual(["f3"])
  expect(ids({ state: "resolved" })).toEqual(["f1", "f2"])
  expect(ids({ state: "all" })).toEqual(["f1", "f2", "f3"])
  expect(ids({ state: "allowed" })).toEqual(["f1"])
  expect(ids({ kind: "question" })).toEqual(["f2"])
  expect(ids({ q: "push" })).toEqual(["f1"])
  expect(ids({ q: "100%" })).toEqual(["f2"])
  expect(ids({ q: "%" })).toEqual(["f2"])
})

test("listener fires on insert and on every transition", () => {
  const got: HistoryItem[] = []
  const off = onApprovalHistory((i) => got.push(i))
  recordPending(entry("l1"))
  recordOutcome("l1", "elsewhere", "post_tool_use")
  recordOutcome("l1", "allowed", "phone") // no-op, no frame
  off()
  expect(got.map((i) => [i.id, i.state, i.decided_via])).toEqual([["l1", "pending", null], ["l1", "elsewhere", "post_tool_use"]])
  expect(Object.keys(got[0]!).sort()).toEqual(["created_at", "cwd", "decided_via", "id", "kind", "resolved_at", "session_id", "session_key", "state", "summary", "tool"])
})

test("pruneHistory deletes resolved rows before the cutoff, never pending ones", () => {
  recordPending(entry("old-done"))
  recordOutcome("old-done", "denied", "phone")
  recordPending(entry("old-live"))
  expect(pruneHistory(new Date(Date.now() + 60_000).toISOString())).toBe(1)
  expect(listHistory({}).items.map((i) => i.id)).toEqual(["old-live"])
  expect(pruneHistory("2000-01-01T00:00:00.000Z")).toBe(0)
})
