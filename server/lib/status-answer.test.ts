import { describe, expect, test } from "bun:test"
import type { BodyResponse } from "./body"
import type { DispatchTask } from "./dispatch-tasks"
import { buildStatusAnswer, scopeTasks } from "./status-answer"

const NOW = 10 * 3_600_000
const task = (id: string, over: Partial<DispatchTask>): DispatchTask => ({
  id: id.padEnd(32, "0"), noteId: "projects/a", title: `task ${id}`, agent: "builder", status: "queued", done: false, blocker: null, owner: null,
  prUrl: null, resultRef: null, projectTitle: "Proj A", projectRef: null, createdAt: NOW - 3_600_000, updatedAt: NOW - 600_000, updatedAtRaw: "", ...over,
})

const body = (dead: number): BodyResponse => ({
  ok: true, generated_at: "2026-10-04T12:00:00Z",
  summary: { ok: 40, warning: 0, failing: 0, dead, crash_loop: 0, dormant: 0, stopped: 0, unknown: 0, total: 40 + dead },
  components: dead ? [{ id: "mac:launchd:x", host: "mac", kind: "launchd", name: "x", criticality: null, state: "dead", last_run_at: null, last_ok_at: null, last_exit: 78, consecutive_failures: 3, detail: "exit 78", depends_on: [], dependents_count: 0 }] : [],
  recent_events: [],
})

const LOCAL = { cap: 3, live: 1, queued: 0 }

describe("buildStatusAnswer", () => {
  test("running / blocked / next up / PR / failed + local workers + Body", () => {
    const tasks = [
      task("r1", { status: "running", updatedAt: NOW - 12 * 60_000 }),
      task("b1", { status: "blocked", blocker: "needs the Stripe key" }),
      task("q2", { createdAt: NOW - 1000 }),
      task("q1", { createdAt: NOW - 9000 }),
      task("p1", { status: "completed", prUrl: "https://github.com/x/y/pull/1" }),
      task("f1", { status: "failed", updatedAt: NOW - 3_600_000 }),
      task("d1", { status: "completed", done: true }),
    ]
    const out = buildStatusAnswer({ tasks, local: LOCAL, body: body(1), scope: "all projects", now: NOW })
    expect(out.split("\n")).toEqual([
      "Queue (all projects): 1 running · 1 blocked · 2 queued · 1 PR open",
      "Running (1):",
      "  [r1000000] builder — task r1 (Proj A) · 12 min",
      "Blocked (1):",
      "  [b1000000] builder — task b1 (Proj A): needs the Stripe key",
      "Next up (2):",
      "  [q1000000] builder — task q1 (Proj A)",
      "  [q2000000] builder — task q2 (Proj A)",
      "PR open (1):",
      "  [p1000000] builder — task p1 (Proj A) https://github.com/x/y/pull/1",
      "Failed (24 h) (1):",
      "  [f1000000] builder — task f1 (Proj A)",
      "Live workers here: 1/3 busy.",
      "Body: 41 components — 1 dead:",
      "  mac:launchd:x dead — exit 78",
    ])
  })

  test("empty queue, unpolled queue, Body down, long lists", () => {
    expect(buildStatusAnswer({ tasks: [], local: { cap: 3, live: 0, queued: 2 }, body: body(0), scope: "Proj A", now: NOW })).toBe(
      "Queue (Proj A): 0 running · 0 blocked · 0 queued · 0 PR open\nNothing open.\nLive workers here: 0/3 busy, 2 waiting for a slot.\nBody: 40 components, nothing dead, crash-looping or failing.",
    )
    const unpolled = buildStatusAnswer({ tasks: null, local: LOCAL, body: null, scope: "all projects", now: NOW })
    expect(unpolled).toContain("not read yet")
    expect(unpolled).toContain("Body: unavailable right now")
    const many = Array.from({ length: 7 }, (_, i) => task(`q${i}`, {}))
    expect(buildStatusAnswer({ tasks: many, local: LOCAL, body: null, scope: "x", now: NOW })).toContain("  …and 3 more")
  })

  test("scopeTasks filters by note", () => {
    const t = [task("a", {}), task("b", { noteId: "projects/b" })]
    expect(scopeTasks(t, "projects/b")!.map((x) => x.noteId)).toEqual(["projects/b"])
    expect(scopeTasks(t, null)).toBe(t)
    expect(scopeTasks(null, "projects/b")).toBeNull()
  })
})
