import { test, expect } from "bun:test"
import { createWorkerTailManager, type WorkerTailDeps } from "./worker-tail"
import type { Task } from "./orchestrator-chat"

// Pure dependency-injected manager: real timers on a 10ms poll, fake pane +
// task store. No sqlite, no tmux — the seams are what the server wires.

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now()
  return {
    taskId: "t1", threadId: "general", prompt: "p", cwd: "/x", sessionKey: null,
    tmuxSession: "cc-x", reasoning: null, logTail: null, status: "running",
    createdAt: now, updatedAt: now, ...over,
  }
}

interface Harness {
  deps: WorkerTailDeps
  tasks: Map<string, Task>
  pane: string | null
  lines: string[][]
  tails: string[]
  dead: string[]
  finished: string[]
}

function harness(initial: Task[]): Harness {
  const h: Harness = { deps: null as unknown as WorkerTailDeps, tasks: new Map(), pane: "", lines: [], tails: [], dead: [], finished: [] }
  for (const t of initial) h.tasks.set(t.taskId, t)
  h.deps = {
    pollMs: 10,
    capturePane: async () => h.pane,
    getTask: (id) => h.tasks.get(id) ?? null,
    setTaskLogTail: (id, tail) => { h.tails.push(tail); const t = h.tasks.get(id); if (t) t.logTail = tail },
    setTaskDead: (id) => { h.dead.push(id); const t = h.tasks.get(id); if (t) t.status = "error" },
    onLines: (_t, lines) => h.lines.push(lines),
    onFinished: (id) => h.finished.push(id),
  }
  return h
}

const settle = () => Bun.sleep(60)

test("streams the pane tail once per change, not per tick", async () => {
  const h = harness([makeTask()])
  h.pane = "line1\nline2\n"
  const m = createWorkerTailManager(h.deps)
  m.watch("t1")
  await settle()
  expect(h.lines).toEqual([["line1", "line2"]]) // repeated identical ticks don't re-emit
  h.pane = "line1\nline2\nline3\n"
  await settle()
  expect(h.lines).toHaveLength(2)
  expect(h.lines[1]).toEqual(["line1", "line2", "line3"])
  expect(m.watching("t1")).toBe(true)
})

test("keeps only the last 20 lines", async () => {
  const h = harness([makeTask()])
  h.pane = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n")
  createWorkerTailManager(h.deps).watch("t1")
  await settle()
  expect(h.lines[0]).toHaveLength(20)
  expect(h.lines[0]?.[0]).toBe("l10")
  expect(h.lines[0]?.[19]).toBe("l29")
})

test("finalizes when the task leaves the live states: persists last tail, fires onFinished, stops", async () => {
  const h = harness([makeTask()])
  h.pane = "working\n"
  const m = createWorkerTailManager(h.deps)
  m.watch("t1")
  await settle()
  h.tasks.get("t1")!.status = "done"
  await settle()
  expect(h.tails).toEqual(["working"])
  expect(h.finished).toEqual(["t1"])
  expect(h.dead).toEqual([])
  expect(m.watching("t1")).toBe(false)
})

test("marks a live task dead after the pane vanishes for 3 consecutive polls", async () => {
  const h = harness([makeTask()])
  h.pane = "alive\n"
  const m = createWorkerTailManager(h.deps)
  m.watch("t1")
  await settle()
  h.pane = null
  await settle()
  expect(h.dead).toEqual(["t1"])
  expect(h.tasks.get("t1")!.status).toBe("error")
  expect(h.tails).toEqual(["alive"])
  expect(h.finished).toEqual(["t1"])
  expect(m.watching("t1")).toBe(false)
})

test("tolerates a transient pane miss (fewer than 3)", async () => {
  const h = harness([makeTask()])
  h.pane = "alive\n"
  const m = createWorkerTailManager(h.deps)
  m.watch("t1")
  await settle()
  h.pane = null
  await Bun.sleep(15) // ~1 miss
  h.pane = "alive\nmore\n"
  await settle()
  expect(h.dead).toEqual([])
  expect(m.watching("t1")).toBe(true)
  expect(h.lines.at(-1)).toEqual(["alive", "more"])
})

test("waits without capturing while a task has no tmux session yet", async () => {
  const h = harness([makeTask({ status: "dispatched", tmuxSession: null })])
  h.pane = "should not be read"
  const m = createWorkerTailManager(h.deps)
  m.watch("t1")
  await settle()
  expect(h.lines).toEqual([])
  expect(m.watching("t1")).toBe(true)
})

test("resumeAll only reattaches live tasks that have a tmux session", () => {
  const h = harness([
    makeTask({ taskId: "live", status: "running" }),
    makeTask({ taskId: "disp", status: "dispatched" }),
    makeTask({ taskId: "done", status: "done" }),
    makeTask({ taskId: "nopane", status: "running", tmuxSession: null }),
    makeTask({ taskId: "prop", status: "proposed", tmuxSession: null }),
  ])
  const m = createWorkerTailManager(h.deps)
  m.resumeAll([...h.tasks.values()])
  expect(m.watching("live")).toBe(true)
  expect(m.watching("disp")).toBe(true)
  expect(m.watching("done")).toBe(false)
  expect(m.watching("nopane")).toBe(false)
  expect(m.watching("prop")).toBe(false)
})
