import type { Task } from "./orchestrator-chat"

// Backpressure (PRJ-OR1T Phase 7). The orchestrator must never fan out
// unboundedly: WIP_CAP live workers per host, everything admitted past that
// parks as 'queued' and drains FIFO as workers exit. Pure policy over injected
// seams — the server wires the sqlite counters and the real spawn; tests wire
// the same sqlite (COMPANION_DB_PATH) and a fake spawn.

export const DEFAULT_WIP_CAP = 3

export interface QueueDeps {
  cap: number
  countLive(): number
  listQueued(): Task[]
  markQueued(task: Task): void
  // Spawn the worker for a task. Resolves ok:false if the spawn failed (the
  // task is then the callee's to mark error) — either way the slot it would
  // have taken is re-counted on the next drain pass.
  dispatch(task: Task): Promise<{ ok: boolean; error?: string }>
}

export type Admission =
  | { status: "queued" }
  | { status: "dispatched"; ok: boolean; error?: string }

export interface Queue {
  // Run the task now if a slot is free, else park it. Never throws.
  admit(task: Task): Promise<Admission>
  // Start queued tasks, oldest first, until the cap is reached or the queue
  // is empty. Re-entrancy safe: a drain triggered while one is in flight is
  // coalesced into a single follow-up pass.
  drain(): Promise<number>
  cap: number
}

export function createQueue(deps: QueueDeps): Queue {
  let draining = false
  let rerun = false

  async function drain(): Promise<number> {
    if (draining) {
      rerun = true
      return 0
    }
    draining = true
    let started = 0
    try {
      do {
        rerun = false
        for (const task of deps.listQueued()) {
          if (deps.countLive() >= deps.cap) break
          const r = await deps.dispatch(task)
          if (r.ok) started++
        }
      } while (rerun)
    } finally {
      draining = false
    }
    return started
  }

  async function admit(task: Task): Promise<Admission> {
    // A queue that already has members keeps FIFO: newcomers park behind them
    // even if a slot happens to be free (the drain pass will fill it in order).
    // The task itself may already sit in the queue (manual /dispatch creates it
    // queued), so it doesn't count as "someone ahead".
    const ahead = deps.listQueued().some((t) => t.taskId !== task.taskId)
    if (deps.countLive() >= deps.cap || ahead) {
      deps.markQueued(task)
      void drain()
      return { status: "queued" }
    }
    const r = await deps.dispatch(task)
    return { status: "dispatched", ok: r.ok, error: r.error }
  }

  return { admit, drain, cap: deps.cap }
}
