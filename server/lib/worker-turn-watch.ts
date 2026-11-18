import type { SpawnedWorkerHandle } from "./worker-invocation"
import type { WorkerTurn } from "./worker-task-store"

/** A running turn checks in with the brain every CHECKIN_MS; it is stopped only after IDLE_KILL_MS with no output (or past an explicit timeoutS). */
export const CHECKIN_MS = 3_600_000, IDLE_KILL_MS = 30 * 60_000
const fmtMin = (ms: number): string => { const m = Math.floor(ms / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min` }

interface WatchedTask {
  timeoutTimer: ReturnType<typeof setTimeout> | null; killTimer: ReturnType<typeof setTimeout> | null; handle: Pick<SpawnedWorkerHandle, "kill"> | null
  error: string | null; stderrTail: readonly string[]; worktree: string; step: string | null; turns: readonly WorkerTurn[]
}

export interface TurnWatchOpts {
  now(): number; timeoutS?: number; lastOutputAt(): number
  /** False once the turn settled, was superseded or left `running`: the watch (and a pending SIGKILL) stops. */
  live(): boolean
  checkIn(note: string, tag: string): void
}

/** No hard stop by default: the brain hears from a long turn every hour; only silence (or an explicit timeoutS) stops it. */
export function watchTurn(task: WatchedTask, o: TurnWatchOpts): void {
  const turnStart = o.now()
  const timeoutMs = o.timeoutS ? Math.max(1, o.timeoutS) * 1000 : Infinity
  let nextCheckIn = turnStart + CHECKIN_MS
  const stop = (error: string) => {
    task.error = error.slice(0, 400)
    task.handle?.kill("SIGTERM")
    task.killTimer = setTimeout(() => { if (o.live()) task.handle?.kill("SIGKILL") }, 5_000)
    task.killTimer.unref?.()
  }
  const arm = (t: number) => {
    task.timeoutTimer = setTimeout(watch, Math.max(1_000, Math.min(turnStart + timeoutMs, nextCheckIn, o.lastOutputAt() + IDLE_KILL_MS) - t))
    task.timeoutTimer.unref?.()
  }
  const watch = () => {
    task.timeoutTimer = null
    if (!o.live()) return
    const t = o.now(), idle = t - o.lastOutputAt()
    if (t - turnStart >= timeoutMs) { const last = task.stderrTail.at(-1); return stop(`timed out after ${Math.round(timeoutMs / 1000)}s${last ? `: ${last}` : ""}`) }
    if (idle >= IDLE_KILL_MS) return stop(`stopped: no output for ${fmtMin(idle)}; worktree kept at ${task.worktree}`)
    if (t >= nextCheckIn) {
      if (task.turns.at(-1)?.endedAt === null) o.checkIn(`${fmtMin(t - turnStart)}, step: ${task.step ?? "none"}, last output ${fmtMin(idle)} ago`, `~running@${t}`)
      nextCheckIn = t + CHECKIN_MS
    }
    arm(t)
  }
  arm(turnStart)
}
