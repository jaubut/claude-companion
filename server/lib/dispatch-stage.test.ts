import { describe, expect, test } from "bun:test"
import { type Mirror, createDispatchWiring } from "./dispatch-poller"
import { shepherdOf, stageFields, taskStage } from "./dispatch-stage"
import { type DispatchTask, fromRow, phaseOf, seenKey } from "./dispatch-tasks"
import type { QueryFn, Row } from "./turso"

// Pipeline stage derivation (brain-tab-queue-graph F1): pure rules, then the
// poller end to end against a fake Turso carrying tasks + shepherd ledger rows.

const PR = "https://github.com/jaubut/dash/pull/42"
const row = (over: Row = {}): Row => ({
  id: "a".repeat(32), note_id: "projects/dash", text: "t", assignee: "agent:builder", done: 0,
  created_at: "2026-10-16 10:00:00", updated_at: "2026-10-16 11:00:00",
  dispatch_status: "queued", dispatch_blocker: null, dispatch_owner: null, dispatch_run_id: null, ...over,
})
const t = (over: Row = {}): DispatchTask => fromRow(row(over))
let seq = 0
const act = (action: string, meta: Record<string, unknown> = {}, ts = "2026-10-16 12:00:00", target = "a".repeat(32)): Row =>
  ({ id: ++seq, target_id: target, action, meta: JSON.stringify(meta), ts })
// Newest first, like the query.
const ledger = (...rows: Row[]): Row[] => rows.reverse()

describe("taskStage", () => {
  test("queued → queue; blocked / failed / cancelled pass through", () => {
    expect(taskStage(t())).toBe("queue")
    expect(taskStage(t({ dispatch_status: "blocked" }))).toBe("blocked")
    expect(taskStage(t({ dispatch_status: "failed" }))).toBe("failed")
    expect(taskStage(t({ dispatch_status: "cancelled", done: 1 }))).toBe("cancelled")
    expect(taskStage(t({ dispatch_status: "weird" }))).toBeNull()
  })

  test("headless run: claimed → dispatch until the runner reports start (run id), then builder", () => {
    const claimed = t({ dispatch_status: "running", dispatch_owner: "zettlab" })
    expect(taskStage(claimed)).toBe("dispatch")
    expect(taskStage(t({ dispatch_status: "running", dispatch_owner: "zettlab", dispatch_run_id: "run_abc" }))).toBe("builder")
  })

  test("live run is its own runner: builder at once", () => {
    expect(taskStage(t({ dispatch_status: "running", dispatch_owner: "companion:mac" }))).toBe("builder")
  })

  test("PR open → shepherd; PR merged (done) → merged; completed without a PR → merged", () => {
    expect(taskStage(t({ dispatch_status: "completed", dispatch_pr_url: PR }))).toBe("shepherd")
    expect(taskStage(t({ dispatch_status: "completed", dispatch_pr_url: PR, done: 1 }))).toBe("merged")
    expect(taskStage(t({ dispatch_status: "completed" }))).toBe("merged")
  })
})

describe("stageFields", () => {
  test("merged PR: prNumber + mergedAt from the outcome:merged row", () => {
    const f = stageFields(t({ dispatch_status: "completed", dispatch_pr_url: PR, done: 1 }), [act("outcome:merged", {}, "2026-10-16 13:30:00")])
    expect(f).toEqual({ stage: "merged", prNumber: 42, mergedAt: Date.parse("2026-10-16T13:30:00Z") })
  })

  test("merged PR without a ledger row (manual merge): mergedAt falls back to updated_at", () => {
    expect(stageFields(t({ dispatch_status: "completed", dispatch_pr_url: PR, done: 1 })).mergedAt).toBe(Date.parse("2026-10-16T11:00:00Z"))
  })

  test("completed without a PR: merged, no prNumber, no mergedAt, no shepherd", () => {
    expect(stageFields(t({ dispatch_status: "completed" }))).toEqual({ stage: "merged" })
  })

  test("only stage=shepherd carries shepherd", () => {
    expect(stageFields(t({ dispatch_status: "completed", dispatch_pr_url: PR })).shepherd).toEqual({ ci: "pending", review: "pending", parked: false })
    expect(stageFields(t({ dispatch_status: "running", dispatch_run_id: "r" })).shepherd).toBeUndefined()
  })
})

describe("shepherdOf", () => {
  test("no ledger yet: pending / pending, not parked", () => {
    expect(shepherdOf([])).toEqual({ ci: "pending", review: "pending", parked: false })
  })

  test("parked sensitive PR: reason without the cascade brief", () => {
    const s = shepherdOf(ledger(
      act("pr:local-gates", { tests: "pass", build: "pass" }),
      act("pr:review", { verdict: "APPROVE" }),
      act("pr:needs-human", { reason: "touches src/lib/auth — needs your review · Opus: cookie flag dropped" }),
    ))
    expect(s).toEqual({ ci: "passing", review: "approved", parked: true, parkedReason: "touches src/lib/auth — needs your review" })
  })

  test("an unpark or Jeremie's approval after the park lifts it", () => {
    expect(shepherdOf(ledger(act("pr:needs-human", { reason: "x" }), act("pr:unpark"))).parked).toBe(false)
    const approved = shepherdOf(ledger(act("pr:needs-human", { reason: "x" }), act("pr:approved-merge")))
    expect(approved).toMatchObject({ parked: false, review: "approved" })
    expect(approved.parkedReason).toBeUndefined()
  })

  test("ci: newest local gates win; a fail anywhere is failing; nothing run is none", () => {
    expect(shepherdOf(ledger(act("pr:local-gates", { tests: "pass", build: "pass" }), act("pr:local-gates", { tests: "fail", build: "pass" }))).ci).toBe("failing")
    expect(shepherdOf(ledger(act("pr:local-gates", { tests: "none", build: "none" }))).ci).toBe("none")
    expect(shepherdOf(ledger(act("pr:local-gates", { tests: "none", build: "pass" }))).ci).toBe("passing")
  })

  test("review: CHANGES → changes; UNVERIFIED → none; newest wins", () => {
    expect(shepherdOf(ledger(act("pr:review", { verdict: "APPROVE" }), act("pr:review", { verdict: "CHANGES" }))).review).toBe("changes")
    expect(shepherdOf(ledger(act("pr:review", { verdict: "UNVERIFIED" }))).review).toBe("none")
  })
})

describe("poller: stage fields on the wire and counts", () => {
  const NOW = Date.parse("2026-10-16T18:00:00Z")
  const ids = { merged: "1".repeat(32), shep: "2".repeat(32), dispatch: "3".repeat(32), failed: "4".repeat(32), noPr: "5".repeat(32) }
  const tasks: Row[] = [
    row({ id: ids.merged, dispatch_status: "completed", dispatch_pr_url: PR, done: 1 }),
    row({ id: ids.shep, dispatch_status: "completed", dispatch_pr_url: "https://github.com/jaubut/dash/pull/43" }),
    row({ id: ids.dispatch, dispatch_status: "running", dispatch_owner: "zettlab" }),
    row({ id: ids.failed, dispatch_status: "failed", dispatch_blocker: "boom" }),
    row({ id: ids.noPr, dispatch_status: "completed", done: 1 }),
  ]
  const activity: Row[] = ledger(
    act("outcome:merged", {}, "2026-10-16 17:00:00", ids.merged),
    act("pr:needs-human", { reason: "touches migrations" }, "2026-10-16 17:00:00", ids.shep),
  )
  const sqls: { sql: string; args: unknown[] }[] = []
  const query: QueryFn = async (sql, args) => {
    sqls.push({ sql, args })
    if (sql.includes("pragma_table_info")) return [{ name: "dispatch_pr_url" }, { name: "dispatch_result_ref" }]
    if (sql.includes("FROM tasks t")) return tasks
    if (sql.includes("FROM agent_activity")) return activity.filter((r) => args.includes(String(r.target_id)))
    return []
  }
  const store = new Map<string, { phase: string; updatedAt: string; key: string }>()
  const mirror: Mirror = {
    seenKey, lastSeen: (id) => store.get(id) ?? null,
    markSeen: (d) => { store.set(d.id, { phase: phaseOf(d), updatedAt: d.updatedAtRaw, key: seenKey(d) }) },
    seenCount: () => store.size, pruneSeen: () => 0,
  }

  test("GET-path DTOs carry stage / shepherd / mergedAt / prNumber; counts gain failed + mergedToday", async () => {
    const w = createDispatchWiring({
      query, broadcast: () => {}, appendTurn: () => ({ id: "0", threadId: "general", role: "orchestrator", text: "", taskId: null, createdAt: 0 }),
      push: () => {}, pushEnabled: () => false, linkedNotes: () => new Map(), getChannel: () => null,
      localQueue: () => ({ cap: 3, live: 0, queued: 0 }), mirror, generalChannel: "general", now: () => NOW, log: () => {},
    })
    expect(await w.poll()).toBe(true)
    const byId = new Map(w.tasksFor("general").map((d) => [d.taskId, d]))
    expect(byId.get(ids.merged)).toMatchObject({ stage: "merged", prNumber: 42, mergedAt: Date.parse("2026-10-16T17:00:00Z") })
    expect(byId.get(ids.shep)).toMatchObject({ stage: "shepherd", prNumber: 43, shepherd: { ci: "pending", review: "pending", parked: true, parkedReason: "touches migrations" } })
    expect(byId.get(ids.dispatch)).toMatchObject({ stage: "dispatch", dispatchStatus: "running" })
    expect(byId.get(ids.failed)?.stage).toBe("failed")
    expect(byId.get(ids.noPr)?.stage).toBe("merged")
    expect(byId.get(ids.noPr)?.mergedAt).toBeUndefined()
    expect(w.queueSummary().dispatch).toEqual({ queued: 0, running: 1, blocked: 0, pr: 1, failed: 1, mergedToday: 1 })
    // Only PR tasks are looked up in the ledger, by parameter.
    const ledgerSql = sqls.find((q) => q.sql.includes("FROM agent_activity"))!
    expect(ledgerSql.args).toContain(ids.merged)
    expect(ledgerSql.args).not.toContain(ids.dispatch)
  })

  test("a failed ledger read never fails the poll", async () => {
    const broken: QueryFn = async (sql, args) => {
      if (sql.includes("FROM agent_activity")) throw new Error("down")
      return query(sql, args)
    }
    const logs: string[] = []
    const w = createDispatchWiring({
      query: broken, broadcast: () => {}, appendTurn: () => ({ id: "0", threadId: "general", role: "orchestrator", text: "", taskId: null, createdAt: 0 }),
      push: () => {}, pushEnabled: () => false, linkedNotes: () => new Map(), getChannel: () => null,
      localQueue: () => ({ cap: 3, live: 0, queued: 0 }), mirror, generalChannel: "general", now: () => NOW, log: (m) => logs.push(m),
    })
    expect(await w.poll()).toBe(true)
    expect(w.tasksFor("general").find((d) => d.taskId === ids.shep)?.shepherd).toEqual({ ci: "pending", review: "pending", parked: false })
    expect(logs.some((l) => l.includes("ledger read failed"))).toBe(true)
  })
})
