import { companionLog } from "../lib/log"
import { HOST_INFO } from "../state"
import {
  LIVE_STATUSES, type Task, appendTurn, countLiveTasks, createProposal, getTask, getTaskByDispatchId, setLiveTarget,
  setTaskStatus, stampDispatchId,
} from "../lib/orchestrator-chat"
import { getChannel } from "../lib/orchestrator-channels"
import {
  DEFAULT_AGENT, type DispatchTask, type LiveOutcome, type WriteOutcome, claimLive, detectPrUrl, detectResultRef,
  finishLive, getDispatchTask, getNote, isLiveLinked, listLiveOwned, liveOwner, newDispatchId, resolveAgent,
} from "../lib/dispatch-tasks"
import { resolveLiveCwdWhy } from "../lib/live-repo"
import { TursoUnreachable } from "../lib/turso"
import { capturePane, sessionCmdArgv } from "../lib/tmux-pane"
import { WIP_CAP, emitTask, executeDispatch, onLiveWorkerDead, orchEmit, writeCtx } from "./orchestrator"
import { type DispatchWiring, dispatchWiring } from "./dispatch"

// Live mode (orchestrator-one-queue P4): an opt-in run in a watchable tmux
// worker on this host. The Turso row is filed already claimed (running, owner
// companion:<host>) and the existing tmux runner does the work; the local
// sqlite row keeps the tmux identity and links dispatch_task_id. The worker's
// stop hook → finishLive; a phone cancel kills the worker; boot fails rows whose
// worker is gone. The WIP cap applies here only: over it → 429, nothing filed.
// Contract: docs/orchestrator-dispatch-api.md.

/** The tmux worker runner, behind a seam so tests never spawn tmux. */
export interface LiveRunner {
  /** Spawn the worker; on ok the local row is `dispatched` with its tmux session (executeDispatch). */
  spawn(task: Task): Promise<{ ok: boolean; error?: string }>
  kill(task: Task): Promise<void>
  alive(task: Task): Promise<boolean>
}

export const tmuxRunner: LiveRunner = {
  spawn: executeDispatch,
  async kill(task) {
    if (!task.tmuxSession) return
    try {
      // On the server it was spawned on (COMPANION_TMUX_SOCKET), as cancelLocal does.
      await Bun.spawn(sessionCmdArgv(task.tmuxSocket, "kill-session", task.tmuxSession), { stdout: "ignore", stderr: "ignore" }).exited
    } catch { /* already gone */ }
  },
  async alive(task) {
    if (!task.tmuxSession) return false
    return (await capturePane(task.tmuxSession, undefined, { socket: task.tmuxSocket || undefined })) !== null
  },
}

let runner: LiveRunner = tmuxRunner
let capOverride: number | null = null

/** Test seam: swap the runner; returns the previous one. */
export function setLiveRunner(r: LiveRunner): LiveRunner {
  const prev = runner
  runner = r
  return prev
}

/** Test seam: override the WIP cap (null = COMPANION_WIP_CAP / 3). */
export function setLiveCap(cap: number | null): void {
  capOverride = cap
}

export const WORKER_LOST = "companion restarted; worker lost"

// Slots held between the cap check and the spawn recording its row, so two
// concurrent approves cannot both take the last slot.
let reserved = 0
const spawning = new Set<string>()

export function liveSlots(): { cap: number; live: number } {
  return { cap: capOverride ?? WIP_CAP, live: countLiveTasks() + reserved }
}

function reserve(): (() => void) | null {
  const { cap, live } = liveSlots()
  if (live >= cap) return null
  reserved++
  let released = false
  return () => {
    if (!released) { released = true; reserved-- }
  }
}

export type LiveStatus = "running" | "completed" | "failed" | "cancelled" | "queued"

export type LiveStart =
  | { ok: true; taskId: string; dispatchTaskId: string; status: LiveStatus; mode: "live" | "headless"; replay: boolean }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> }

const fail = (status: number, error: string, extra?: Record<string, unknown>): LiveStart => ({ ok: false, status, error, ...(extra ? { extra } : {}) })

function unreachable(err: unknown): LiveStart {
  const what = err instanceof TursoUnreachable ? err.message : `unexpected error (${(err as Error)?.name ?? typeof err})`
  companionLog(`[live] ${what}`)
  return fail(503, "turso_unreachable")
}

function localToLive(s: Task["status"]): LiveStatus {
  if (s === "done") return "completed"
  if (s === "error") return "failed"
  if (s === "cancelled") return "cancelled"
  return "running"
}

// A replayed approve (iOS outbox, double tap): same ids, never a second worker.
function replayOf(task: Task | null): LiveStart | null {
  if (!task?.dispatchTaskId) return null
  const base = { ok: true as const, taskId: task.taskId, dispatchTaskId: task.dispatchTaskId, replay: true }
  if (task.status === "filed") return { ...base, status: "queued", mode: "headless" }
  if (isLiveLinked(task)) return { ...base, status: localToLive(task.status), mode: "live" }
  if (spawning.has(task.taskId)) return { ...base, status: "running", mode: "live" }
  return null
}

export interface LiveOpts { agent?: string | null; noteId?: string | null; cwd?: string | null }

/** approve {mode:"live"}: claim the Turso row, then run the tmux worker. */
export async function approveLive(taskId: string, opts: LiveOpts = {}, dispatch: DispatchWiring = dispatchWiring): Promise<LiveStart> {
  const task = getTask(taskId)
  if (!task) return fail(404, "no such proposal")
  const replay = replayOf(task)
  if (replay) return replay
  if (task.status !== "proposed") return fail(409, `not proposable (status ${task.status})`)
  const channel = getChannel(task.threadId)
  const noteId = opts.noteId?.trim() || task.noteId || channel?.noteId || null
  if (!noteId) return fail(422, "no_project")
  const agent = resolveAgent(opts.agent || task.agent || DEFAULT_AGENT)
  if (!agent) return fail(400, "unknown_agent")
  const release = reserve()
  if (!release) return fail(429, "live_cap", liveSlots())
  try {
    let note
    try {
      note = await getNote(dispatch.query, noteId)
    } catch (err) {
      return unreachable(err)
    }
    if (!note) return fail(404, "no such note")
    const { cwd, reason } = resolveLiveCwdWhy({ explicit: opts.cwd, noteId, noteTitle: note.title, taskCwd: task.cwd, channelCwd: channel?.cwd })
    if (!cwd) return fail(422, "no_cwd", reason ? { reason } : undefined)
    const id = stampDispatchId(task.taskId, newDispatchId())
    if (!id || !setLiveTarget(task.taskId, { cwd, noteId, agent })) return replayOf(getTask(task.taskId)) ?? fail(409, "not proposable")
    const claimed = await claim(dispatch, task.threadId, {
      id, noteId, agent, title: liveTitle(task), description: `${task.prompt}\n\n— Live run from Companion #${channel?.name ?? task.threadId} (proposal ${task.taskId})`,
    })
    if (!claimed.ok) return claimed.out
    return await startWorker(task.taskId, id, dispatch)
  } finally {
    release()
  }
}

/** POST /dispatch {mode:"live"}: same claim + runner, from a typed prompt. */
export async function dispatchLive(
  input: { prompt: string; channelId: string; noteId?: string | null; agent?: string | null; title?: string | null; cwd?: string | null },
  dispatch: DispatchWiring = dispatchWiring,
): Promise<LiveStart> {
  const channel = getChannel(input.channelId)
  const noteId = input.noteId?.trim() || channel?.noteId || null
  if (!noteId) return fail(422, "no_project")
  const agent = resolveAgent(input.agent || DEFAULT_AGENT)
  if (!agent) return fail(400, "unknown_agent")
  const release = reserve()
  if (!release) return fail(429, "live_cap", liveSlots())
  try {
    let note
    try {
      note = await getNote(dispatch.query, noteId)
    } catch (err) {
      return unreachable(err)
    }
    if (!note) return fail(404, "no such note")
    const { cwd, reason } = resolveLiveCwdWhy({ explicit: input.cwd, noteId, noteTitle: note.title, channelCwd: channel?.cwd })
    if (!cwd) return fail(422, "no_cwd", reason ? { reason } : undefined)
    const id = newDispatchId()
    const title = (input.title?.trim() || input.prompt.split("\n")[0]!).slice(0, 120)
    const claimed = await claim(dispatch, input.channelId, {
      id, noteId, agent, title, description: `${input.prompt}\n\n— Live run from Companion #${channel?.name ?? input.channelId}`,
    })
    if (!claimed.ok) return claimed.out
    // The local worker row: a proposal row (never shown: it is live-linked the
    // moment the spawn records it) so it shares the approve path exactly.
    const local = createProposal(input.prompt, cwd, "manual live dispatch", input.channelId, { noteId, agent, title })
    stampDispatchId(local.taskId, id)
    return await startWorker(local.taskId, id, dispatch)
  } finally {
    release()
  }
}

function liveTitle(t: Task): string {
  return (t.title?.trim() || t.prompt.split("\n").find((l) => l.trim()) || t.prompt).trim().slice(0, 120)
}

type Claim = { ok: true } | { ok: false; out: LiveStart }

// INSERT OR IGNORE under the stamped id; a replay finds the row it filed. The
// row must be running and ours, else something else moved it: no worker.
async function claim(dispatch: DispatchWiring, channel: string, input: Parameters<typeof claimLive>[1]): Promise<Claim> {
  try {
    const ctx = await writeCtx(dispatch, channel)
    await claimLive(ctx, input)
    const row = await getDispatchTask(dispatch.query, ctx.cols, input.id)
    if (row?.task.status === "running" && row.task.owner === liveOwner(ctx.host)) return { ok: true }
    return { ok: false, out: fail(409, "conflict", { dispatchStatus: row?.task.status ?? null, owner: row?.task.owner ?? null }) }
  } catch (err) {
    return { ok: false, out: unreachable(err) }
  }
}

// The local proposed → dispatched flip (inside the runner) is the spawn gate:
// only the caller that still sees `proposed` here spawns.
async function startWorker(taskId: string, dispatchTaskId: string, dispatch: DispatchWiring): Promise<LiveStart> {
  const task = getTask(taskId)
  if (!task || task.status !== "proposed" || spawning.has(taskId)) return replayOf(task) ?? fail(409, "not proposable")
  spawning.add(taskId)
  let r: { ok: boolean; error?: string }
  try {
    r = await runner.spawn(task)
  } catch (err) {
    r = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    spawning.delete(taskId)
  }
  if (!r.ok) {
    if (getTask(taskId)?.status !== "error") setTaskStatus(taskId, "error")
    emitTask(taskId)
    await closeLive(dispatchTaskId, { status: "failed", blocker: `spawn failed: ${r.error ?? "unknown"}`.slice(0, 300) }, dispatch, task.threadId)
    return fail(500, r.error ?? "spawn failed", { taskId, dispatchTaskId })
  }
  orchEmit(appendTurn("orchestrator", `live [${taskId}] → ${task.agent ?? DEFAULT_AGENT} · running as ${dispatchTaskId.slice(0, 8)} in ${task.cwd}`, taskId, task.threadId))
  await showRow(dispatchTaskId, dispatch)
  return { ok: true, taskId, dispatchTaskId, status: "running", mode: "live", replay: false }
}

async function showRow(id: string, dispatch: DispatchWiring): Promise<DispatchTask | null> {
  try {
    const row = await getDispatchTask(dispatch.query, await dispatch.columns(), id)
    if (row) {
      dispatch.applyLocal(row.task)
      return row.task
    }
  } catch { /* the poll picks it up */ }
  void dispatch.poll()
  return null
}

/** Guarded running → outcome; null when Turso is unreachable (logged). */
async function closeLive(id: string, outcome: LiveOutcome, dispatch: DispatchWiring, channel: string | null): Promise<WriteOutcome | null> {
  try {
    const out = await finishLive(await writeCtx(dispatch, channel), id, outcome)
    // Through the poller, so a completed / pr transition gets its turn (and push) like any run.
    if (out.ok) void dispatch.poll()
    return out
  } catch (err) {
    companionLog(`[live] finish ${id.slice(0, 8)} → ${outcome.status} failed (${(err as Error)?.message ?? "error"})`)
    return null
  }
}

/** Stop hook: the worker's turn ended → completed (pr when its output names a PR). */
export function finishLiveFromStop(task: Task, lastMessage: string, dispatch: DispatchWiring = dispatchWiring): Promise<WriteOutcome | null> {
  if (!task.dispatchTaskId) return Promise.resolve(null)
  return closeLive(task.dispatchTaskId, {
    status: "completed", prUrl: detectPrUrl(lastMessage), resultRef: detectResultRef(lastMessage),
  }, dispatch, task.threadId)
}

export type LiveCancel =
  | { ok: true; task: DispatchTask; local: Task | null }
  | { ok: false; status: number; error: string; task?: DispatchTask }

/** Phone cancel of a live row owned by this host: Turso first (guarded), then the local row and its worker. */
export async function cancelLive(dispatchTaskId: string, dispatch: DispatchWiring = dispatchWiring): Promise<LiveCancel> {
  const local = getTaskByDispatchId(dispatchTaskId)
  const out = await closeLive(dispatchTaskId, { status: "cancelled" }, dispatch, local?.threadId ?? null)
  if (!out) return { ok: false, status: 503, error: "turso_unreachable" }
  if (!out.ok) return out.error === "no_such_task" ? { ok: false, status: 404, error: "no such task" } : { ok: false, status: 409, error: "conflict", task: out.task }
  if (local) {
    // Cancelled before the kill, so the tail sees a closed task, not a dead worker.
    if (LIVE_STATUSES.includes(local.status) || local.status === "proposed") setTaskStatus(local.taskId, "cancelled")
    await runner.kill(local)
    emitTask(local.taskId)
  }
  dispatch.applyLocal(out.task)
  return { ok: true, task: out.task, local: getTask(local?.taskId ?? "") }
}

/**
 * Boot: running live rows owned by this host whose tmux worker is gone are
 * closed, so nothing sits `running` forever — failed ("companion restarted;
 * worker lost"), or completed / cancelled when the local row already says so
 * (its Turso write was lost). Other hosts' rows are never touched.
 */
export async function reconcileLiveOnBoot(dispatch: DispatchWiring = dispatchWiring, host: string = HOST_INFO.name): Promise<number> {
  let ids: string[]
  try {
    ids = await listLiveOwned(dispatch.query, host)
  } catch (err) {
    companionLog(`[live] boot reconcile skipped (${(err as Error)?.message ?? "error"})`)
    return 0
  }
  let closed = 0
  for (const id of ids) {
    const local = getTaskByDispatchId(id)
    if (local && LIVE_STATUSES.includes(local.status) && await runner.alive(local)) continue
    const outcome: LiveOutcome = local?.status === "done" ? { status: "completed" }
      : local?.status === "cancelled" ? { status: "cancelled" }
      : { status: "failed", blocker: WORKER_LOST }
    if (local && (LIVE_STATUSES.includes(local.status) || local.status === "proposed")) {
      setTaskStatus(local.taskId, "error")
      emitTask(local.taskId)
    }
    const out = await closeLive(id, outcome, dispatch, local?.threadId ?? null)
    if (!out?.ok) continue
    closed++
    if (outcome.status === "failed") {
      orchEmit(appendTurn("orchestrator", `live [${local?.taskId ?? id.slice(0, 8)}] failed — ${WORKER_LOST}`, local?.taskId ?? id, local?.threadId ?? dispatch.threadIdFor(out.task)))
    }
  }
  return closed
}

// A worker that died without a stop hook (worker tail saw its pane vanish).
onLiveWorkerDead((t) => {
  if (t.dispatchTaskId) void closeLive(t.dispatchTaskId, { status: "failed", blocker: "worker exited without a stop hook" }, dispatchWiring, t.threadId)
})
