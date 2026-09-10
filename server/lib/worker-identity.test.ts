import { test, expect, describe } from "bun:test"
import { createWorkerIdentityResolver, BIND_DEGRADE_AFTER_MS, type WorkerIdentityDeps } from "./worker-identity"
import type { Task, TaskStatus } from "./orchestrator-chat"

// Pure module, fake seams: no sqlite, no tmux, no wiring import (which would run
// the orchestrator's import-time setInterval + resumeAll + boot drain).

function task(taskId: string, over: Partial<Task> = {}): Task {
  return {
    taskId, threadId: "general", prompt: "do it", cwd: "/w",
    sessionKey: null, tmuxSession: `cc-${taskId}`, reasoning: null, logTail: null,
    status: "dispatched" as TaskStatus, createdAt: 0, updatedAt: 0, ...over,
  }
}

interface Harness {
  deps: WorkerIdentityDeps
  logs: string[]
  paneLookups: string[]
  clock: { now: number }
}

// tasks are indexed the way the SQL matchers filter: unbound+dispatched for a
// bind, running for a close.
function harness(opts: { unbound?: Task[]; running?: Task[] } = {}): Harness {
  const unbound = opts.unbound ?? []
  const running = opts.running ?? []
  const all = [...unbound, ...running]
  const logs: string[] = []
  const paneLookups: string[] = []
  const clock = { now: 1_000_000 }
  const deps: WorkerIdentityDeps = {
    matchUnboundTaskById: (id) => unbound.find((t) => t.taskId === id) ?? null,
    findRunningTaskById: (id) => running.find((t) => t.taskId === id) ?? null,
    getTask: (id) => all.find((t) => t.taskId === id) ?? null,
    matchUnboundTaskByTmuxSession: (s) => unbound.find((t) => t.tmuxSession === s) ?? null,
    findRunningTaskByTmuxSession: (s) => running.find((t) => t.tmuxSession === s) ?? null,
    countUnboundTasksInCwd: (cwd) => unbound.filter((t) => t.cwd === cwd).length,
    countRunningTasksInCwd: (cwd) => running.filter((t) => t.cwd === cwd).length,
    matchUnboundTaskByCwd: (cwd) => unbound.filter((t) => t.cwd === cwd)[0] ?? null,
    findRunningTaskByCwd: (cwd) => running.filter((t) => t.cwd === cwd)[0] ?? null,
    async tmuxSessionForPane(pane) {
      paneLookups.push(pane)
      return pane === "%1" ? "cc-a" : pane === "%2" ? "cc-b" : null
    },
    now: () => clock.now,
    log: (m) => { logs.push(m) },
  }
  return { deps, logs, paneLookups, clock }
}

describe("tier 1 — the task id issued at dispatch", () => {
  test("binds and closes the exact task, ignoring every sibling in the cwd", async () => {
    const h = harness({ unbound: [task("a"), task("b")], running: [task("r1", { status: "running" }), task("r2", { status: "running" })] })
    const r = createWorkerIdentityResolver(h.deps)
    expect((await r.resolve("bind", { taskId: "b", cwd: "/w" }))?.taskId).toBe("b")
    expect((await r.resolve("close", { taskId: "r2", cwd: "/w" }))?.taskId).toBe("r2")
    // identity settled it — tmux was never asked, even though the cwd is ambiguous
    expect(h.paneLookups).toEqual([])
  })

  test("an already-resolved task id resolves to null, it does not fall through", async () => {
    // The load-bearing case: reconcileDispatch re-runs on every session mutation,
    // so a worker already bound to 'a' keeps arriving with taskId 'a'. Falling
    // through would hand it sibling 'b' and fire b's prompt into a's pane.
    const bound = task("a", { status: "running", sessionKey: "k" })
    const h = harness({ unbound: [task("b")], running: [bound] })
    const r = createWorkerIdentityResolver(h.deps)
    expect(await r.resolve("bind", { taskId: "a", cwd: "/w" })).toBeNull()
    // and a finished task never re-closes
    const h2 = harness({ unbound: [], running: [] })
    h2.deps.getTask = () => task("done-1", { status: "done" })
    const r2 = createWorkerIdentityResolver(h2.deps)
    expect(await r2.resolve("close", { taskId: "done-1", cwd: "/w" })).toBeNull()
  })

  test("an unknown task id carries no identity and falls through to the cwd tier", async () => {
    // A restored db or an env inherited from another host: refusing forever
    // would wedge the dispatch, and there is exactly one candidate here anyway.
    const h = harness({ unbound: [task("a")] })
    const r = createWorkerIdentityResolver(h.deps)
    expect((await r.resolve("bind", { taskId: "from-another-host", cwd: "/w" }))?.taskId).toBe("a")
  })
})

describe("tier 2 — tmux pane, gated on ambiguity", () => {
  test("two workers in one cwd each resolve to their own task via their pane", async () => {
    const h = harness({ unbound: [task("a"), task("b")] })
    const r = createWorkerIdentityResolver(h.deps)
    expect((await r.resolve("bind", { tmuxPane: "%1", cwd: "/w" }))?.taskId).toBe("a")
    expect((await r.resolve("bind", { tmuxPane: "%2", cwd: "/w" }))?.taskId).toBe("b")
    expect(h.paneLookups).toEqual(["%1", "%2"])
  })

  test("closes the right one of two running tasks in a shared cwd", async () => {
    const h = harness({ running: [task("a", { status: "running" }), task("b", { status: "running" })] })
    const r = createWorkerIdentityResolver(h.deps)
    expect((await r.resolve("close", { tmuxPane: "%2", cwd: "/w" }))?.taskId).toBe("b")
  })

  test("tmux is not consulted when the cwd holds a single candidate", async () => {
    // The gate that keeps a title resolve or a 60s prune tick from shelling out
    // once per session.
    const h = harness({ unbound: [task("a")] })
    const r = createWorkerIdentityResolver(h.deps)
    expect((await r.resolve("bind", { tmuxPane: "%1", cwd: "/w" }))?.taskId).toBe("a")
    expect(h.paneLookups).toEqual([])
  })

  test("a pane tmux can't resolve refuses rather than guessing", async () => {
    const h = harness({ running: [task("a", { status: "running" }), task("b", { status: "running" })] })
    const r = createWorkerIdentityResolver(h.deps)
    expect(await r.resolve("close", { tmuxPane: "%99", cwd: "/w" })).toBeNull()
    expect(h.paneLookups).toEqual(["%99"])
    expect(h.logs.some((l) => l.includes("ambiguous close in /w: 2 candidates"))).toBe(true)
  })
})

describe("tier 3 — one candidate in the cwd, today's behaviour", () => {
  test("binds and closes with no identity at all", async () => {
    const h = harness({ unbound: [task("a")], running: [task("r", { status: "running" })] })
    const r = createWorkerIdentityResolver(h.deps)
    expect((await r.resolve("bind", { cwd: "/w" }))?.taskId).toBe("a")
    expect((await r.resolve("close", { cwd: "/w" }))?.taskId).toBe("r")
    expect(h.logs).toEqual([])
  })

  test("no candidates resolves to null silently — the common non-worker session", async () => {
    const h = harness()
    const r = createWorkerIdentityResolver(h.deps)
    expect(await r.resolve("bind", { cwd: "/somewhere-else" })).toBeNull()
    expect(await r.resolve("close", { cwd: "/somewhere-else" })).toBeNull()
    expect(await r.resolve("close", { taskId: "", tmuxPane: "", cwd: "" })).toBeNull()
    expect(h.logs).toEqual([])
    expect(h.paneLookups).toEqual([])
  })
})

describe("tier 4 — refusal and the bind-only degrade", () => {
  test("an ambiguous bind with no identity refuses, then degrades to cwd FIFO after 90s", async () => {
    const oldest = task("a", { updatedAt: 1_000 })
    const h = harness({ unbound: [oldest, task("b", { updatedAt: 2_000 })] })
    const r = createWorkerIdentityResolver(h.deps)

    h.clock.now = oldest.updatedAt + BIND_DEGRADE_AFTER_MS // exactly at the window
    expect(await r.resolve("bind", { cwd: "/w" })).toBeNull()
    expect(h.logs.some((l) => l.includes("ambiguous bind in /w: 2 candidates, no identity"))).toBe(true)

    h.clock.now = oldest.updatedAt + BIND_DEGRADE_AFTER_MS + 1 // past it
    expect((await r.resolve("bind", { cwd: "/w" }))?.taskId).toBe("a")
    expect(h.logs.some((l) => l.includes("bind degraded to cwd FIFO"))).toBe(true)
  })

  test("a close never degrades, no matter how long the tasks have been running", async () => {
    // A wrong close posts the reply under a sibling's task and frees its WIP
    // slot. Holding the slot is the accepted cost.
    const h = harness({ running: [task("a", { status: "running", updatedAt: 0 }), task("b", { status: "running", updatedAt: 0 })] })
    const r = createWorkerIdentityResolver(h.deps)
    h.clock.now = 10 * BIND_DEGRADE_AFTER_MS
    expect(await r.resolve("close", { cwd: "/w" })).toBeNull()
    expect(h.logs.some((l) => l.includes("degraded"))).toBe(false)
  })
})

test("resolve is side-effect free — repeated calls return the same task and change nothing", async () => {
  const h = harness({ unbound: [task("a")], running: [task("r", { status: "running" })] })
  const r = createWorkerIdentityResolver(h.deps)
  for (let i = 0; i < 5; i++) {
    expect((await r.resolve("bind", { taskId: "a", cwd: "/w" }))?.taskId).toBe("a")
    expect((await r.resolve("close", { taskId: "r", cwd: "/w" }))?.taskId).toBe("r")
  }
  expect(h.logs).toEqual([])
})
