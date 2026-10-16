import type { Task } from "./orchestrator-chat"

// Worker tmux-tail streaming (PRJ-OR1T Phase 6, hybrid output model): while a
// dispatched task runs, poll its tmux pane and stream the last lines to clients
// as transient WS frames — the live terminal card in the thread. Nothing is
// persisted per tick; when the task leaves the running states, the final pane
// snapshot is written once to the task row (log_tail) as the collapsed card.
//
// The pane IS the durable thing (detached tmux survives server restarts), the
// tail is just a viewer — resumeAll() reattaches pollers on boot.
//
// A herdr worker (task.herdrPane) is read with `pane read`, and the screen is
// only for display: it is dead only when herdrGone() says so (asked when a read
// fails and every HERDR_GONE_EVERY ticks). A failed read is never a pane miss.

const POLL_MS = 1500
const TAIL_LINES = 20
// A vanished pane usually means the worker exited before the stop hook closed
// the task; tolerate a few misses so a tmux hiccup doesn't finalize early.
const MAX_PANE_MISSES = 3
const HERDR_GONE_EVERY = 4

const LIVE_STATUSES = new Set(["dispatched", "running"])

export interface WorkerTailDeps {
  // `socket`: the task's recorded tmux server (undefined = default).
  capturePane(sessionName: string, socket?: string): Promise<string | null>
  getTask(taskId: string): Task | null
  setTaskLogTail(taskId: string, tail: string): void
  // Called when the pane vanished while the task was still live — the worker
  // died without a stop hook (killed tmux, crashed). Mark it so it doesn't sit
  // in 'running' forever.
  setTaskDead(taskId: string): void
  // herdr workers (wiring/worker-io.ts): the pane's screen (null = unreadable)
  // and whether herdr still runs the worker. Absent = herdr tasks are not tailed.
  readHerdr?(pane: string): Promise<string | null>
  herdrGone?(task: Task): Promise<boolean>
  onLines(task: Task, lines: string[]): void
  onFinished(taskId: string): void
  // Poll interval override (tests). Production uses POLL_MS.
  pollMs?: number
}

export interface WorkerTailManager {
  watch(taskId: string): void
  resumeAll(tasks: Task[]): void
  watching(taskId: string): boolean
}

interface Watch {
  timer: ReturnType<typeof setInterval>
  lastTail: string
  paneMisses: number
  ticks: number
  ticking: boolean
}

function tailOf(pane: string): string[] {
  const lines = pane.replace(/\s+$/, "").split("\n")
  return lines.slice(-TAIL_LINES)
}

export function createWorkerTailManager(deps: WorkerTailDeps): WorkerTailManager {
  const watches = new Map<string, Watch>()
  const pollMs = deps.pollMs ?? POLL_MS

  function finalize(taskId: string, paneDied = false): void {
    const w = watches.get(taskId)
    if (!w) return
    clearInterval(w.timer)
    watches.delete(taskId)
    if (w.lastTail) deps.setTaskLogTail(taskId, w.lastTail)
    if (paneDied) {
      const task = deps.getTask(taskId)
      if (task && LIVE_STATUSES.has(task.status)) deps.setTaskDead(taskId)
    }
    deps.onFinished(taskId)
  }

  async function tick(taskId: string): Promise<void> {
    const w = watches.get(taskId)
    if (!w || w.ticking) return
    w.ticking = true
    try {
      const task = deps.getTask(taskId)
      if (!task || !LIVE_STATUSES.has(task.status)) {
        finalize(taskId)
        return
      }
      if (task.herdrPane) return await tickHerdr(w, task, task.herdrPane)
      if (!task.tmuxSession) return // proposal approved but spawn not recorded yet
      const pane = await deps.capturePane(task.tmuxSession, task.tmuxSocket || undefined)
      if (pane === null) {
        w.paneMisses++
        if (w.paneMisses >= MAX_PANE_MISSES) finalize(taskId, true)
        return
      }
      w.paneMisses = 0
      show(w, task, pane)
    } finally {
      const still = watches.get(taskId)
      if (still) still.ticking = false
    }
  }

  function show(w: Watch, task: Task, pane: string): void {
    const tail = tailOf(pane).join("\n")
    if (tail !== w.lastTail) {
      w.lastTail = tail
      deps.onLines(task, tail.split("\n"))
    }
  }

  async function tickHerdr(w: Watch, task: Task, pane: string): Promise<void> {
    if (!deps.readHerdr) return
    w.ticks++
    const screen = await deps.readHerdr(pane)
    if ((screen === null || w.ticks % HERDR_GONE_EVERY === 0) && await deps.herdrGone?.(task)) return finalize(task.taskId, true)
    if (screen !== null) show(w, task, screen)
  }

  function watch(taskId: string): void {
    if (watches.has(taskId)) return
    const w: Watch = {
      timer: setInterval(() => void tick(taskId), pollMs),
      lastTail: "",
      paneMisses: 0,
      ticks: 0,
      ticking: false,
    }
    watches.set(taskId, w)
    void tick(taskId)
  }

  return {
    watch,
    watching: (taskId) => watches.has(taskId),
    resumeAll(tasks: Task[]): void {
      for (const t of tasks) {
        if (LIVE_STATUSES.has(t.status) && (t.tmuxSession || t.herdrPane)) watch(t.taskId)
      }
    },
  }
}
