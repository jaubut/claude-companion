import { companionLog } from "../lib/log"
import { HOST_INFO, broadcast } from "../state"
import {
  appendTurn as orchAppendTurn,
  getThread,
  createProposal,
  getTask,
  setTaskSpawn,
  bindTaskSession,
  setTaskStatus,
  setTaskLogTail,
  countLiveTasks,
  listQueued,
  matchUnboundTaskByCwd,
  findRunningTaskByCwd,
  matchUnboundTaskById,
  findRunningTaskById,
  matchUnboundTaskByTmuxSession,
  findRunningTaskByTmuxSession,
  countUnboundTasksInCwd,
  countRunningTasksInCwd,
  listLiveTasks,
  stampDispatchId,
  markFiled,
  type Turn as OrchTurn,
  type Task as OrchTask,
} from "../lib/orchestrator-chat"
import { getChannel, type Channel as OrchChannel } from "../lib/orchestrator-channels"
import { type BrainDecision, decide as brainDecide } from "../lib/orchestrator-brain"
import { createWorkerTailManager } from "../lib/worker-tail"
import { createQueue, wipCap } from "../lib/orchestrator-queue"
import { capturePane, paneInputReady, paneHasDialog, sessionCmdArgv, tmuxSessionForPane } from "../lib/tmux-pane"
import { createWorkerIdentityResolver } from "../lib/worker-identity"
import { listSessions, type Session } from "../lib/sessions"
import { spawnCompanionSession, type SpawnResult } from "../lib/spawn-session"
import { BODY_CHANNEL, type BodySnapshot } from "../lib/body"
import { bodyDigestFor } from "./body"
import {
  DEFAULT_AGENT, type ProjectRef, type WriteCtx, agentAllowlist, fileTask, getDispatchTask, getNote, isLiveLinked, newDispatchId, resolveAgent, toTaskDto,
} from "../lib/dispatch-tasks"
import { TursoUnreachable } from "../lib/turso"
import { type DispatchWiring, dispatchWiring } from "./dispatch"

// Orchestrator wiring (PRJ-OR1T): the always-on pieces that turn a proposal
// into a running worker and report back — emit helpers, the WIP queue, the
// worker tail, prompt delivery into tmux, dispatch reconcile on session
// registration, and the brain. Module singletons; the queue tick, resumeAll
// and the boot drain run at import time, before the server starts serving.

// Orchestrator single-thread (PRJ-OR1T): push every new thread turn to all
// clients so the one always-open chat stays live on every device.
export function orchEmit(turn: OrchTurn): void {
  broadcast({ type: "orchestrator", turn })
}

// Broadcast a task's current state on every transition (proposed → dispatched →
// running → done/error/rejected) so the phone's Tasks panel tracks live work.
// A live run (P4) is shown as its Turso row: re-send that frame too, so the
// worker's tmux identity (spawn, bind) reaches the phone.
export function emitTask(taskId: string): void {
  const t = getTask(taskId)
  if (!t) return
  broadcast({ type: "orchestrator_task", task: toTaskDto(t) })
  // Not cached yet → the next poll carries it (identity included).
  if (isLiveLinked(t)) dispatchWiring.reemit(t.dispatchTaskId!)
}

// Live mode (P4): wiring/live.ts closes the Turso row when a worker dies
// without a stop hook. Registered there (it imports this module, not the reverse).
let liveWorkerDead: ((task: OrchTask) => void) | null = null
export function onLiveWorkerDead(fn: (task: OrchTask) => void): void {
  liveWorkerDead = fn
}

// Broadcast a new/updated channel so every device's channel rail live-updates
// (PRJ-OR1T Phase 6).
export function emitChannel(channel: OrchChannel): void {
  broadcast({ type: "orchestrator_channel", channel: dispatchWiring.decorate(channel) })
}

// Backpressure (PRJ-OR1T Phase 7): at most WIP_CAP live workers on this host.
// Anything admitted past that — approved proposal, auto-dispatch, or a manual
// /dispatch — parks as queued and drains FIFO when a worker exits (stop hook,
// dead-pane backstop, cancel), on boot, and on a 30s safety tick.
export const WIP_CAP = wipCap()
export const workerQueue = createQueue({
  cap: WIP_CAP,
  countLive: countLiveTasks,
  listQueued,
  markQueued(task) {
    setTaskStatus(task.taskId, "queued")
    emitTask(task.taskId)
    orchEmit(orchAppendTurn(
      "orchestrator",
      `queued [${task.taskId}] — ${countLiveTasks()} of ${WIP_CAP} worker slots busy; starts when one frees`,
      task.taskId,
      task.threadId,
    ))
  },
  dispatch: executeDispatch,
})
const drainTimer = setInterval(() => void workerQueue.drain(), 30_000)
// Don't keep the event loop alive just for the safety tick (sessions.ts:113-123).
if (typeof (drainTimer as unknown as { unref?: () => void }).unref === "function") {
  (drainTimer as unknown as { unref: () => void }).unref()
}

// Live worker tail (Phase 6, hybrid output model): stream the dispatched
// worker's tmux pane into its channel as transient frames; the final snapshot
// persists on the task row when it finishes. Workers outlive server restarts in
// detached tmux, so resumeAll reattaches viewers on boot. A pane that vanishes
// while the task is still live means the worker died without a stop hook — the
// task is marked error instead of sitting in 'running' forever.
export const workerTail = createWorkerTailManager({
  capturePane: (sessionName, socket) => capturePane(sessionName, undefined, { socket }),
  getTask,
  setTaskLogTail,
  setTaskDead(taskId) {
    setTaskStatus(taskId, "error")
    const t = getTask(taskId)
    if (t?.dispatchTaskId) liveWorkerDead?.(t)
    void workerQueue.drain() // the dead worker's slot is free
  },
  onLines(task, lines) {
    broadcast({ type: "orchestrator_worker_output", taskId: task.taskId, channel: task.threadId, lines, ts: Date.now() })
  },
  onFinished(taskId) {
    emitTask(taskId) // now carries logTail — clients collapse the live card
  },
})
workerTail.resumeAll(listLiveTasks())
void workerQueue.drain() // queued work left over from before a restart

// Deliver a dispatched prompt straight to the worker's tmux session by name.
// We spawned it (cc-<name>), so send-keys -t <session> hits its active pane no
// matter how the session surfaced in the registry. This is the reliable path: a
// tmux-wrapped worker discovered via ps has no tmuxPane recorded and its client
// tty has no Terminal tab, so AppleScript/tty inject fails ("no tab for tty").
// tmux send-keys does not care — it just needs the TUI to be input-ready first.
// `socket` is the server the worker was spawned on (task.tmuxSocket).
async function sendToTmux(sessionName: string, text: string, socket?: string): Promise<void> {
  const keys = (...rest: string[]) =>
    Bun.spawn(sessionCmdArgv(socket, "send-keys", sessionName, ...rest), { stdout: "ignore", stderr: "ignore" }).exited
  let ready = false
  for (let i = 0; i < 30; i++) {
    const pane = await capturePane(sessionName, undefined, { socket })
    if (pane === null) return // worker session gone
    if (paneHasDialog(pane)) {
      // Dismiss the onboarding dialog (Escape = reject MCP enable / decline
      // trust), then keep polling for the real input box.
      await keys("Escape")
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    if (paneInputReady(pane)) { ready = true; break }
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!ready) {
    const reset = "\x1b[0m"; const red = "\x1b[31m"
    companionLog(`${red}orchestrator → tmux timeout${reset} ${sessionName} never became input-ready`)
    return
  }
  try {
    await keys("-l", text)
    await new Promise((r) => setTimeout(r, 300))
    await keys("Enter")
    const reset = "\x1b[0m"; const cyan = "\x1b[36m"
    companionLog(`${cyan}orchestrator → tmux${reset} ${sessionName} "${text.slice(0, 50)}"`)
  } catch { /* worker session gone */ }
}

// Worker → task correlation (PRJ-OR1T Phase 8). The policy itself is a pure
// module; this is the one wired instance, sharing the real sqlite matchers and
// tmux lookup. Both consumers go through it: reconcileDispatch below ("bind")
// and the stop hook in routes/hooks.ts ("close").
const workerIdentity = createWorkerIdentityResolver({
  matchUnboundTaskById,
  findRunningTaskById,
  getTask,
  matchUnboundTaskByTmuxSession,
  findRunningTaskByTmuxSession,
  countUnboundTasksInCwd,
  countRunningTasksInCwd,
  matchUnboundTaskByCwd,
  findRunningTaskByCwd,
  tmuxSessionForPane,
  now: Date.now,
  log(msg) {
    const reset = "\x1b[0m"; const yellow = "\x1b[33m"
    companionLog(`${yellow}orchestrator identity${reset} ${msg}`)
  },
})

export const resolveWorkerTask = workerIdentity.resolve

// Orchestrator (PRJ-OR1T): when a worker session appears for a dispatched task's
// cwd, bind it and fire the queued prompt into its tmux session. Driven off
// onSessions so it catches the worker no matter how it registered — session-start
// hook, ps discovery, or rehydrate (the session-start hook alone is unreliable; a
// spawned worker often surfaces via ps-scan first). Idempotent: the resolver
// only returns still-dispatched, unbound tasks, so a bound task is never
// re-fired — and with N workers in one cwd each session binds the task it was
// actually dispatched as, never a sibling's.
// Resolution is async now (tier 2 may ask tmux), so passes are chained instead
// of run concurrently: onSessions fires from ~10 call sites and two overlapping
// passes could both resolve the same pending task before either bound it, and
// fire its prompt twice. The exported signature stays fire-and-forget so the
// onSessions listener is unchanged.
let reconcileChain: Promise<void> = Promise.resolve()

export function reconcileDispatch(sessions: Session[]): void {
  reconcileChain = reconcileChain
    .then(() => reconcileOnce(sessions))
    .catch((err) => {
      // Never wedge the chain — but never hide the failure either: a throw here
      // leaves a task in 'dispatched' with no prompt delivered.
      companionLog(`\x1b[31mreconcileDispatch failed\x1b[0m ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    })
}

async function reconcileOnce(sessions: Session[]): Promise<void> {
  for (const s of sessions) {
    if (!s.cwd) continue
    const pending = await resolveWorkerTask("bind", { taskId: s.taskId, tmuxPane: s.tmuxPane, tmuxSocket: s.tmuxSocket, cwd: s.cwd })
    if (!pending) continue
    bindTaskSession(pending.taskId, s.key || s.cwd)
    emitTask(pending.taskId)
    orchEmit(orchAppendTurn("orchestrator", `[${pending.taskId}] worker live — sending prompt`, pending.taskId, pending.threadId))
    const { tmuxSession, tmuxSocket, prompt } = pending
    // sendToTmux self-paces: it polls the pane until the TUI is input-ready
    // before send-keys, so binding the instant ps-discovery sees the worker is
    // fine — the prompt won't land until Claude can actually receive it.
    if (tmuxSession) void sendToTmux(tmuxSession, prompt, tmuxSocket || undefined)
  }
}

// ── Orchestrator brain (PRJ-OR1T Phase 2): propose-confirm dispatch ──

// Project directories the brain may dispatch into: cwds of live registered
// sessions, deduped. Keeps proposals grounded in real, currently-open projects.
function candidateCwds(): string[] {
  return [...new Set(listSessions().map((s) => s.cwd).filter(Boolean))]
}

// Spawn a worker for an approved proposal and record its tmux session so
// reconcileDispatch delivers the prompt. The task stays 'proposed' (which
// reconcile ignores) until setTaskSpawn flips it to 'dispatched' AFTER the tmux
// session exists — so a worker is never bound before we know where to send.
export async function executeDispatch(task: OrchTask): Promise<{ ok: boolean; error?: string }> {
  const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
  let result: SpawnResult
  try {
    // The worker carries its task id in its environment, so every hook it fires
    // can name the task it belongs to instead of the server guessing from cwd.
    result = await spawnCompanionSession({
      cwd: task.cwd,
      agent: "claude",
      env: { COMPANION_TASK_ID: task.taskId },
    })
  } catch (err) {
    setTaskStatus(task.taskId, "error")
    emitTask(task.taskId)
    const message = err instanceof Error ? err.message : String(err)
    companionLog(`${red}dispatch crashed${reset} [${task.taskId}] — ${message}`)
    return { ok: false, error: message }
  }
  if (!result.ok) {
    setTaskStatus(task.taskId, "error")
    emitTask(task.taskId)
    companionLog(`${red}dispatch failed${reset} [${task.taskId}] — ${result.error}`)
    return { ok: false, error: result.error }
  }
  setTaskSpawn(task.taskId, result.sessionName ?? null, result.tmuxSocket || null)
  emitTask(task.taskId)
  workerTail.watch(task.taskId)
  companionLog(`${cyan}orchestrator dispatch${reset} [${task.taskId}] → ${task.cwd} ${dim}(tmux ${result.sessionName ?? "?"})${reset}`)
  const verb = task.status === "queued" ? "starting" : "approved"
  orchEmit(orchAppendTurn("orchestrator", `${verb} [${task.taskId}] — worker dispatched`, task.taskId, task.threadId))
  return { ok: true }
}

// ── Filing to the one queue (orchestrator-one-queue P2) ──

/** Write context for the guarded Turso writes: host + channel go into the ledger meta. */
export async function writeCtx(dispatch: DispatchWiring, channel: string | null): Promise<WriteCtx> {
  return { exec: dispatch.exec, cols: await dispatch.columns(), host: HOST_INFO.name, channel, log: companionLog }
}

export type FileOutcome =
  | { ok: true; dispatchTaskId: string; replay: boolean; task: OrchTask }
  | { ok: false; status: number; error: string }

function proposalTitle(t: OrchTask): string {
  return (t.title?.trim() || t.prompt.split("\n").find((l) => l.trim()) || t.prompt).trim().slice(0, 120)
}

function proposalDescription(t: OrchTask, channelName: string): string {
  const why = t.reasoning?.trim() ? `\nWhy: ${t.reasoning.trim()}` : ""
  return `${t.prompt}\n\n— Filed from Companion #${channelName} (proposal ${t.taskId})${why}`
}

/**
 * Approve / auto-dispatch → one Turso agent task (status queued). The Turso id
 * is stamped on the local row first, so a replayed approve (iOS outbox) reuses
 * it and INSERT OR IGNORE keeps it to one row; only then proposed → filed.
 * A Turso failure leaves the proposal proposed (and retryable): 503.
 */
export async function fileProposal(
  taskId: string, opts: { agent?: string | null; noteId?: string | null } = {}, dispatch: DispatchWiring = dispatchWiring,
): Promise<FileOutcome> {
  const task = getTask(taskId)
  if (!task) return { ok: false, status: 404, error: "no such proposal" }
  if (task.status === "filed" && task.dispatchTaskId) return { ok: true, dispatchTaskId: task.dispatchTaskId, replay: true, task }
  if (task.status !== "proposed") return { ok: false, status: 409, error: `not proposable (status ${task.status})` }
  const channel = getChannel(task.threadId)
  const noteId = opts.noteId?.trim() || task.noteId || channel?.noteId || null
  if (!noteId) return { ok: false, status: 422, error: "no_project" }
  const agent = resolveAgent(opts.agent || task.agent || DEFAULT_AGENT)
  if (!agent) return { ok: false, status: 400, error: "unknown_agent" }
  const id = stampDispatchId(task.taskId, newDispatchId())
  if (!id) return fileProposalReplay(task.taskId)
  try {
    if (!(await getNote(dispatch.query, noteId))) return { ok: false, status: 404, error: "no such note" }
    await fileTask(await writeCtx(dispatch, task.threadId), {
      id, noteId, agent, title: proposalTitle(task), description: proposalDescription(task, channel?.name ?? task.threadId),
    })
  } catch (err) {
    const what = err instanceof TursoUnreachable ? err.message : `unexpected error (${(err as Error)?.name ?? typeof err})`
    companionLog(`[orchestrator] file [${task.taskId}] failed: ${what}`)
    return { ok: false, status: 503, error: "turso_unreachable" }
  }
  if (!markFiled(task.taskId, { noteId, agent })) return fileProposalReplay(task.taskId)
  emitTask(task.taskId)
  orchEmit(orchAppendTurn("orchestrator", `filed [${task.taskId}] → ${agent} · queued as ${id.slice(0, 8)}`, task.taskId, task.threadId))
  await showFiled(id, dispatch)
  return { ok: true, dispatchTaskId: id, replay: false, task: getTask(task.taskId)! }
}

// The Turso row exists: push its frame now (the next poll would, ≤ 20 s later).
async function showFiled(id: string, dispatch: DispatchWiring): Promise<void> {
  try {
    const row = await getDispatchTask(dispatch.query, await dispatch.columns(), id)
    if (row) return dispatch.applyLocal(row.task)
  } catch { /* the poll picks it up */ }
  void dispatch.poll()
}

// A concurrent approve won the race: answer with its id (same Turso row).
function fileProposalReplay(taskId: string): FileOutcome {
  const now = getTask(taskId)
  if (now?.status === "filed" && now.dispatchTaskId) return { ok: true, dispatchTaskId: now.dispatchTaskId, replay: true, task: now }
  return { ok: false, status: 409, error: `not proposable (status ${now?.status ?? "gone"})` }
}

// Brain picks are suggestions: a note outside the active projects or an agent
// dispatch-run cannot start is dropped (the channel's note / builder apply).
function validatedTarget(d: Extract<BrainDecision, { kind: "proposal" }>, projects: ProjectRef[]) {
  const note = projects.find((p) => p.noteId === d.noteId) ?? null
  return { noteId: note?.noteId ?? null, agent: resolveAgent(d.agent), title: d.title, projectTitle: note?.title ?? null }
}

/**
 * Stage a brain decision in the channel: a chat reply, or a proposal that waits
 * for a tap — or, in an auto channel, files straight to Turso (never in #Body).
 */
export async function applyDecision(
  decision: BrainDecision, channel: OrchChannel, projects: ProjectRef[], dispatch: DispatchWiring = dispatchWiring,
): Promise<void> {
  if (decision.kind === "chat") {
    orchEmit(orchAppendTurn("orchestrator", decision.text, null, channel.id))
    return
  }
  const target = validatedTarget(decision, projects)
  const task = createProposal(decision.prompt, decision.cwd || channel.cwd || "", decision.reasoning, channel.id, target)
  const where = `${target.agent ?? DEFAULT_AGENT} · ${target.projectTitle ?? channel.noteTitle ?? (target.noteId || channel.noteId || "no project yet")}`
  // Trust ramp (Phase 7): re-read the channel — the toggle may have flipped
  // during the brain call. Auto mode skips the tap but never the reasoning:
  // every auto-dispatch shows why + what in the thread. Cancel is the veto.
  // #Body never auto-dispatches: an alert must not start work without a tap.
  if (channel.id !== BODY_CHANNEL && getChannel(channel.id)?.autoDispatch) {
    orchEmit(orchAppendTurn("orchestrator", `Auto-dispatch [${task.taskId}] — ${where}\nWhy: ${decision.reasoning}\nTask: ${decision.prompt}`, task.taskId, channel.id))
    emitTask(task.taskId)
    const filed = await fileProposal(task.taskId, {}, dispatch)
    if (!filed.ok) {
      orchEmit(orchAppendTurn("orchestrator", `auto-dispatch [${task.taskId}] not filed (${filed.error}) — it stays a proposal; approve it by hand`, task.taskId, channel.id))
    }
    return
  }
  orchEmit(orchAppendTurn(
    "orchestrator",
    `Proposal [${task.taskId}] — ${where}\nWhy: ${decision.reasoning}\nTask: ${decision.prompt}\nApprove to file it.`,
    task.taskId,
    channel.id,
  ))
  emitTask(task.taskId)
}

/** Brain context: Body digest (#Body / health questions) + this view's dispatch digest. */
export async function brainContext(
  channel: OrchChannel, userText: string, dispatch: DispatchWiring = dispatchWiring, snapshot?: BodySnapshot,
): Promise<string | null> {
  const body = await bodyDigestFor(channel.id, userText, snapshot)
  const scope = channel.id === BODY_CHANNEL ? "all projects" : `#${channel.name}`
  const parts = [body, dispatch.digestFor(channel.id, scope)].filter((p): p is string => !!p?.trim())
  return parts.length ? parts.join("\n\n") : null
}

// Run the brain on a user message: answer inline (chat) or stage a proposal.
// Fire-and-forget — never blocks /send. Falls back to a soft note on any model
// failure so the thread never wedges.
export async function runBrain(userText: string, channel: OrchChannel, dispatch: DispatchWiring = dispatchWiring): Promise<void> {
  // History and cwd candidates are scoped to the channel so the brain reasons
  // within one project's thread.
  const cwds = channel.cwd ? [channel.cwd, ...candidateCwds().filter((c) => c !== channel.cwd)] : candidateCwds()
  let decision: BrainDecision | null
  let projects: ProjectRef[] = []
  try {
    projects = await dispatch.projects().catch(() => [])
    const context = await brainContext(channel, userText, dispatch)
    decision = await brainDecide(getThread(channel.id), userText, cwds, channel.cwd, context, {
      projects, agents: [...agentAllowlist()].sort(), channelNoteId: channel.noteId,
    })
  } catch {
    decision = null
  }
  if (!decision) {
    // decide() returns null only after runClaude exhausts its retries — the model
    // call itself kept failing (overload / auth contention), NOT because the
    // message was unclear.
    orchEmit(orchAppendTurn("orchestrator", "Couldn't reach the model just now — transient error on my side, not your message. Send that again.", null, channel.id))
    return
  }
  await applyDecision(decision, channel, projects, dispatch)
}
