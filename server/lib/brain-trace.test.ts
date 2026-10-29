import { beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DispatchTask } from "./dispatch-tasks"

// brain-v2 trace rows (lib/brain-trace.ts) + the contracts/brain fixtures.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-trace-")), "test.db")

let trace: typeof import("./brain-trace")
let sqlite: typeof import("./orchestrator-db")["db"]

beforeAll(async () => {
  trace = await import("./brain-trace")
  sqlite = (await import("./orchestrator-db")).db
})
beforeEach(() => sqlite.exec("DELETE FROM brain_trace"))

test("seq is monotonic across rows and every write; an unchanged write bumps nothing", () => {
  const a = trace.upsertRow({ id: "turn:t1", turnId: "t1", kind: "turn", status: "pending", title: "hi" })!
  const b = trace.upsertRow({ id: "turn:t2", turnId: "t2", kind: "turn", status: "pending", title: "yo" })!
  const a2 = trace.upsertRow({ id: "turn:t1", kind: "turn", status: "running", title: "hi" })!
  expect([a.seq, b.seq, a2.seq]).toEqual([a.seq, a.seq + 1, a.seq + 2])
  expect(trace.upsertRow({ id: "turn:t1", kind: "turn", status: "running", title: "hi" })).toBeNull()
  expect(trace.rowsSince(b.seq).map((r) => r.id)).toEqual(["turn:t1"])
  expect(a2.startedAt).toBe(a.startedAt)
  expect(a2.turnId).toBe("t1")
})

test("parent chain turn → repo → agent → pr", () => {
  const turn = trace.rowId.turn("t9")
  const repo = trace.rowId.repo("t9", "PRJ-WCLS")
  trace.upsertRow({ id: turn, turnId: "t9", kind: "turn", status: "running", title: "ship it" })
  trace.upsertRow({ id: repo, parentId: turn, turnId: "t9", kind: "repo", status: "running", title: "TLS Dashboard" })
  trace.upsertRow({ id: trace.rowId.agent("abcd1234"), parentId: repo, turnId: "t9", kind: "agent", status: "pending", title: "builder — fix" })
  const t: DispatchTask = {
    id: "f".repeat(32), noteId: "projects/dash", title: "fix", agent: "builder", status: "completed", done: false, blocker: null, owner: "zettlab",
    prUrl: "https://github.com/x/y/pull/1", resultRef: null, projectTitle: null, projectRef: null, createdAt: 0, updatedAt: 0, updatedAtRaw: "",
  }
  const rows = trace.traceForDispatch(t, "abcd1234")
  expect(rows.map((r) => [r.id, r.status])).toEqual([["agent:abcd1234", "done"], ["pr:abcd1234", "done"]])
  const pr = trace.getRow("pr:abcd1234")!
  const agent = trace.getRow(pr.parentId!)!
  expect(agent.parentId).toBe(repo)
  expect(trace.getRow(agent.parentId!)!.parentId).toBe(turn)
  expect(pr.ref).toEqual({ taskId: t.id, prUrl: t.prUrl! })
  // A task the brain never proposed stays off the trace.
  expect(trace.traceForDispatch(t, "nope0000")).toEqual([])
})

test("terminal rows never reopen; a retry is a new id", () => {
  trace.upsertRow({ id: "agent:z", kind: "agent", status: "running", title: "x" })
  const done = trace.upsertRow({ id: "agent:z", kind: "agent", status: "error", title: "x" })!
  expect(done.endedAt).not.toBeNull()
  expect(trace.upsertRow({ id: "agent:z", kind: "agent", status: "running", title: "x" })).toBeNull()
  expect(trace.upsertRow({ id: "agent:z", kind: "agent", status: "done", title: "x" })).toBeNull()
  expect(trace.getRow("agent:z")!.status).toBe("error")
})

test("approvals: pending under needs-you, then done (allow) / error (deny)", () => {
  const [p] = trace.traceForApproval({ kind: "approval", id: "a1", title: "Bash: ls", parentId: null })
  expect(p).toMatchObject({ id: "appr:a1", parentId: trace.NEEDS_YOU, status: "pending", ref: { approvalId: "a1" } })
  expect(trace.traceForApproval({ kind: "approval", id: "a1", title: "Bash", parentId: null, ended: "deny" })[0]!.status).toBe("error")
  const [q] = trace.traceForApproval({ kind: "question", id: "q1", title: "Which?", parentId: "agent:x" })
  expect(q!.parentId).toBe("agent:x")
  expect(trace.traceForApproval({ kind: "question", id: "q1", title: "Which?", parentId: null, ended: "answered" })[0]!.status).toBe("done")
})

test("contracts/brain fixtures parse and every trace row has the contract's keys", () => {
  const dir = join(import.meta.dir, "..", "..", "contracts", "brain")
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  expect(files.length).toBeGreaterThanOrEqual(7)
  const keys = ["id", "parentId", "turnId", "kind", "status", "title", "detail", "ref", "startedAt", "endedAt", "seq"].sort()
  for (const f of files) {
    const frame = JSON.parse(readFileSync(join(dir, f), "utf8")) as { type: string; rows?: Record<string, unknown>[] }
    expect(typeof frame.type).toBe("string")
    for (const r of frame.rows ?? []) expect(Object.keys(r).sort()).toEqual(keys)
  }
  // A row written by upsertRow carries exactly those keys too.
  const row = trace.upsertRow({ id: "turn:k", kind: "turn", status: "pending", title: "k" })!
  expect(Object.keys(row).sort()).toEqual(keys)
})
