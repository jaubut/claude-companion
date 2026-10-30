import { describe, expect, test } from "bun:test"
import { fromRow } from "./dispatch-tasks"
import { NEEDS_HUMAN } from "./triage-sources"
import { type PipelineState, pipelineItem, pipelineState } from "./pipeline"
import type { Row } from "./turso"

// One-stream slice D: every tasks-row fixture through the one state mapper.

const NOW = Date.parse("2026-10-26T12:00:00Z")
const PR = "https://github.com/jaubut/dash/pull/7"

function task(over: Row) {
  return fromRow({
    id: "a".repeat(32), note_id: "projects/dash", text: "Fix rounding", assignee: "agent:builder", done: 0,
    dispatch_status: "queued", created_at: "2026-10-25 10:00:00", updated_at: "2026-10-26 09:00:00", ...over,
  })
}

const act = (id: number, action: string, meta: Record<string, unknown> = {}): Row =>
  ({ id, target_id: "a".repeat(32), action, meta: JSON.stringify(meta), ts: "2026-10-26 08:00:00" })

const fixtures: [string, Row, Row[], PipelineState][] = [
  ["pending", { dispatch_status: "pending" }, [], "pending_approval"],
  ["queued", { dispatch_status: "queued" }, [], "queued"],
  ["running (claimed, run not started)", { dispatch_status: "running", dispatch_owner: "zettlab" }, [], "running"],
  ["running (builder)", { dispatch_status: "running", dispatch_owner: "zettlab", dispatch_run_id: "r1" }, [], "running"],
  ["completed + open PR", { dispatch_status: "completed", dispatch_pr_url: PR }, [], "pr_open"],
  ["completed + PR, done=1, outcome:merged", { dispatch_status: "completed", dispatch_pr_url: PR, done: 1 }, [act(2, "outcome:merged")], "merged"],
  ["completed + PR, done=1, no ledger (manual merge)", { dispatch_status: "completed", dispatch_pr_url: PR, done: 1 }, [], "merged"],
  ["completed + PR, done=1, parked, not merged", { dispatch_status: "completed", dispatch_pr_url: PR, done: 1 }, [act(1, NEEDS_HUMAN, { url: PR })], "pr_open"],
  ["completed without a PR", { dispatch_status: "completed", done: 1 }, [], "merged"],
  ["blocked", { dispatch_status: "blocked", dispatch_blocker: "needs key" }, [], "blocked"],
  ["failed", { dispatch_status: "failed" }, [], "failed"],
  ["cancelled", { dispatch_status: "cancelled", done: 1 }, [], "cancelled"],
]

describe("pipelineItem state", () => {
  for (const [name, row, ledger, want] of fixtures) {
    test(`${name} → ${want}`, () => {
      expect(pipelineItem(task(row), ledger, NOW)?.state).toBe(want)
    })
  }

  test("an unknown or missing dispatch_status → no item", () => {
    expect(pipelineItem(task({ dispatch_status: "weird" }), [], NOW)).toBeNull()
    expect(pipelineState({ status: null }, null)).toBeNull()
  })
})

describe("pipelineItem fields", () => {
  test("pending_approval carries the dashboard approveUrl; no other state does", () => {
    const item = pipelineItem(task({ dispatch_status: "pending" }), [], NOW)!
    expect(item).toMatchObject({
      id: "a".repeat(32), title: "Fix rounding", agent: "builder", noteId: "projects/dash", prUrl: null, shepherd: null,
      updatedAt: Date.parse("2026-10-26T09:00:00Z"),
    })
    expect(item.approveUrl).toEndWith(`/tasks?task=${"a".repeat(32)}`)
    for (const [, row, ledger, want] of fixtures) {
      if (want !== "pending_approval") expect("approveUrl" in pipelineItem(task(row), ledger, NOW)!).toBe(false)
    }
  })

  test("pr_open carries the shepherd verdict from the pr:* ledger; merged does not", () => {
    const open = pipelineItem(task({ dispatch_status: "completed", dispatch_pr_url: PR }), [
      act(3, "pr:review", { url: PR, verdict: "CHANGES" }),
      act(2, "pr:local-gates", { url: PR, tests: "fail", build: "pass" }),
    ], NOW)!
    expect(open).toMatchObject({ state: "pr_open", prUrl: PR, shepherd: { ci: "failing", review: "changes", parked: false } })
    const parked = pipelineItem(task({ dispatch_status: "completed", dispatch_pr_url: PR }), [act(1, NEEDS_HUMAN, { url: PR, reason: "conflict" })], NOW)!
    expect(parked.shepherd).toMatchObject({ parked: true })
    const merged = pipelineItem(task({ dispatch_status: "completed", dispatch_pr_url: PR, done: 1 }), [act(2, "outcome:merged")], NOW)!
    expect(merged.shepherd).toBeNull()
  })
})
