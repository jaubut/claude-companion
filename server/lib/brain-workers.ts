import { BRAIN_AGENT, BRAIN_THREAD } from "./brain"

// brain-workers policy (STATE.md § Change Plan — brain-workers): which herdr
// workspaces the brain owns, and which of them may close. Pure; the herdr side
// effects live in wiring/brain-workers.ts.
//
// Ownership is a property of the workspace (Kubernetes ownerReferences), never
// a controller's memory: the env stamped on its shell at creation.
//   brain  = label `brain` + COMPANION_TASK_ID=brain
//   worker = label `dispatch-<id8>` + DISPATCH_TASK_ID=<id> whose sqlite
//            proposal row sits in the brain thread
// Anything unknown (env unreadable, Turso not polled, task unseen) keeps.

export type ReapMode = "observe" | "on" | "off"
export type Verdict = "close" | "keep"
export type WsKind = "brain" | "worker"

/** Terminal for this long (past Turso updated_at) before a worker may close. */
export const WORKER_GRACE_MS = 2 * 60_000
/** Worker sweep interval: grace + one poll (20 s) + one sweep stays under ~3 min. */
export const WORKER_SWEEP_MS = 30_000
/** Consecutive sweeps a worker must read settled before it closes. */
export const SETTLED_SWEEPS = 2
export const TERMINAL_PHASES: ReadonlySet<string> = new Set(["pr", "completed", "done", "failed", "cancelled"])
export const WORKER_PREFIX = "dispatch-"

/** COMPANION_BRAIN_REAP: `on` acts, `off` does nothing, anything else observes (Phase 0 default). */
export function reapMode(v: string | undefined): ReapMode {
  const m = (v ?? "").trim().toLowerCase()
  return m === "on" || m === "off" ? m : "observe"
}

/** Same name dispatch-runner.ts herdrAgentName gives the task's workspace. */
export function workerLabel(taskId: string): string {
  return `${WORKER_PREFIX}${taskId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "task"}`
}

export function envValue(env: readonly string[] | null, key: string): string | null {
  if (!env) return null
  const hit = env.find((e) => e.startsWith(`${key}=`))
  return hit === undefined ? "" : hit.slice(key.length + 1)
}

/** What one survey read about a workspace. `atShell` null = process-info unreadable; `env` null = unreadable. */
export interface SweepView {
  workspaceId: string
  label: string
  paneCount: number
  pane: string
  agentStatus: string
  atShell: boolean | null
  env: string[] | null
}

export interface Decision { verdict: Verdict; reason: string; owned: boolean }

const keep = (reason: string, owned = true): Decision => ({ verdict: "keep", reason, owned })

/** herdr says the agent is finished, or it is gone and the shell is back in front. */
export function settledNow(v: SweepView): boolean {
  if (v.agentStatus === "done" || v.agentStatus === "idle") return true
  return (v.agentStatus === "" || v.agentStatus === "unknown") && v.atShell === true
}

/** Live brain: its herdr agent's workspace / pane and any brain-tagged session pane. null = unknown (agentOf errored). */
export interface BrainLive { workspaceIds: string[]; panes: string[] }

export function classifyBrainWs(v: SweepView, live: BrainLive | null): Decision {
  if (v.label !== BRAIN_AGENT) return keep("not a brain workspace", false)
  const env = envValue(v.env, "COMPANION_TASK_ID")
  if (env === null) return keep("env unreadable")
  if (env !== BRAIN_AGENT) return keep("not started by the brain supervisor", false)
  if (!live) return keep("brain state unknown")
  if (live.workspaceIds.includes(v.workspaceId) || (v.pane && live.panes.includes(v.pane))) return keep("self")
  if (v.paneCount !== 1) return keep("split")
  if (v.atShell !== true) return keep(v.atShell === null ? "pane unreadable" : "busy")
  return { verdict: "close", reason: "brain leftover", owned: true }
}

/** What the worker's task looks like right now. `snapshotOk` false = Turso never polled. */
export interface WorkerFacts {
  /** The sqlite proposal of this Turso task, or null (not a Companion proposal). */
  proposal: { proposalId: string; threadId: string } | null
  snapshotOk: boolean
  /** Live Turso phase + updated_at; null = task not found. */
  task: { phase: string; updatedAt: number } | null
  settledSweeps: number
  now: number
  /** The brain asked (POST /hooks/brain/sessions close): no time grace, a settled read now is enough. */
  manual?: boolean
}

export function workerTaskId(v: SweepView): string | null {
  const id = envValue(v.env, "DISPATCH_TASK_ID")
  return id ? id : null
}

export function classifyWorker(v: SweepView, f: WorkerFacts): Decision {
  if (!v.label.startsWith(WORKER_PREFIX)) return keep("not a worker workspace", false)
  if (v.env === null) return keep("env unreadable", false)
  const taskId = workerTaskId(v)
  if (!taskId || workerLabel(taskId) !== v.label) return keep("not a dispatch worker", false)
  if (!f.proposal || f.proposal.threadId !== BRAIN_THREAD) return keep("not a brain task", false)
  if (!f.snapshotOk) return keep("dispatch state unknown")
  if (!f.task) return keep("task unknown")
  if (!TERMINAL_PHASES.has(f.task.phase)) return keep(`running (${f.task.phase})`)
  if (!f.manual && f.now - f.task.updatedAt < WORKER_GRACE_MS) return keep(`${f.task.phase}, in grace`)
  if (v.paneCount !== 1) return keep("split")
  const settled = f.manual ? settledNow(v) : f.settledSweeps >= SETTLED_SWEEPS
  if (!settled) return keep("settling")
  return { verdict: "close", reason: `finished (${f.task.phase})`, owned: true }
}
