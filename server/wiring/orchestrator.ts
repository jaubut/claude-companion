import { broadcast } from "../state"
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
  listTasks,
  getChannel,
  type Turn as OrchTurn,
  type Task as OrchTask,
  type Channel as OrchChannel,
} from "../lib/orchestrator-chat"
import { decide as brainDecide } from "../lib/orchestrator-brain"
import { createWorkerTailManager } from "../lib/worker-tail"
import { createQueue, DEFAULT_WIP_CAP } from "../lib/orchestrator-queue"
import { capturePane, paneInputReady, paneHasDialog } from "../lib/tmux-pane"
import { listSessions, type Session } from "../lib/sessions"
import { spawnCompanionSession, type SpawnResult } from "../lib/spawn-session"

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
export function emitTask(taskId: string): void {
  const t = getTask(taskId)
  if (t) broadcast({ type: "orchestrator_task", task: t })
}

// Broadcast a new/updated channel so every device's channel rail live-updates
// (PRJ-OR1T Phase 6).
export function emitChannel(channel: OrchChannel): void {
  broadcast({ type: "orchestrator_channel", channel })
}

// Backpressure (PRJ-OR1T Phase 7): at most WIP_CAP live workers on this host.
// Anything admitted past that — approved proposal, auto-dispatch, or a manual
// /dispatch — parks as queued and drains FIFO when a worker exits (stop hook,
// dead-pane backstop, cancel), on boot, and on a 30s safety tick.
export const WIP_CAP = Number(process.env.COMPANION_WIP_CAP) || DEFAULT_WIP_CAP
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
setInterval(() => void workerQueue.drain(), 30_000)

// Live worker tail (Phase 6, hybrid output model): stream the dispatched
// worker's tmux pane into its channel as transient frames; the final snapshot
// persists on the task row when it finishes. Workers outlive server restarts in
// detached tmux, so resumeAll reattaches viewers on boot. A pane that vanishes
// while the task is still live means the worker died without a stop hook — the
// task is marked error instead of sitting in 'running' forever.
export const workerTail = createWorkerTailManager({
  capturePane,
  getTask,
  setTaskLogTail,
  setTaskDead(taskId) {
    setTaskStatus(taskId, "error")
    void workerQueue.drain() // the dead worker's slot is free
  },
  onLines(task, lines) {
    broadcast({ type: "orchestrator_worker_output", taskId: task.taskId, channel: task.threadId, lines, ts: Date.now() })
  },
  onFinished(taskId) {
    emitTask(taskId) // now carries logTail — clients collapse the live card
  },
})
workerTail.resumeAll(listTasks())
void workerQueue.drain() // queued work left over from before a restart

// Deliver a dispatched prompt straight to the worker's tmux session by name.
// We spawned it (cc-<name>), so send-keys -t <session> hits its active pane no
// matter how the session surfaced in the registry. This is the reliable path: a
// tmux-wrapped worker discovered via ps has no tmuxPane recorded and its client
// tty has no Terminal tab, so AppleScript/tty inject fails ("no tab for tty").
// tmux send-keys does not care — it just needs the TUI to be input-ready first.
async function sendToTmux(sessionName: string, text: string): Promise<void> {
  let ready = false
  for (let i = 0; i < 30; i++) {
    const pane = await capturePane(sessionName)
    if (pane === null) return // worker session gone
    if (paneHasDialog(pane)) {
      // Dismiss the onboarding dialog (Escape = reject MCP enable / decline
      // trust), then keep polling for the real input box.
      await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "Escape"], { stdout: "ignore", stderr: "ignore" }).exited
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    if (paneInputReady(pane)) { ready = true; break }
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!ready) {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"
    process.stderr.write(`${dim}[companion]${reset} ${red}orchestrator → tmux timeout${reset} ${sessionName} never became input-ready\n`)
    return
  }
  try {
    await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "-l", text], { stdout: "ignore", stderr: "ignore" }).exited
    await new Promise((r) => setTimeout(r, 300))
    await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "Enter"], { stdout: "ignore", stderr: "ignore" }).exited
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
    process.stderr.write(`${dim}[companion]${reset} ${cyan}orchestrator → tmux${reset} ${sessionName} "${text.slice(0, 50)}"\n`)
  } catch { /* worker session gone */ }
}

// Orchestrator (PRJ-OR1T): when a worker session appears for a dispatched task's
// cwd, bind it and fire the queued prompt into its tmux session. Driven off
// onSessions so it catches the worker no matter how it registered — session-start
// hook, ps discovery, or rehydrate (the session-start hook alone is unreliable; a
// spawned worker often surfaces via ps-scan first). Idempotent: matchUnbound…
// only returns still-dispatched, unbound tasks, so a bound task is never re-fired.
export function reconcileDispatch(sessions: Session[]): void {
  for (const s of sessions) {
    if (!s.cwd) continue
    const pending = matchUnboundTaskByCwd(s.cwd)
    if (!pending) continue
    bindTaskSession(pending.taskId, s.key || s.cwd)
    emitTask(pending.taskId)
    orchEmit(orchAppendTurn("orchestrator", `[${pending.taskId}] worker live — sending prompt`, pending.taskId, pending.threadId))
    const { tmuxSession, prompt } = pending
    // sendToTmux self-paces: it polls the pane until the TUI is input-ready
    // before send-keys, so binding the instant ps-discovery sees the worker is
    // fine — the prompt won't land until Claude can actually receive it.
    if (tmuxSession) void sendToTmux(tmuxSession, prompt)
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
    result = await spawnCompanionSession({ cwd: task.cwd, agent: "claude" })
  } catch (err) {
    setTaskStatus(task.taskId, "error")
    emitTask(task.taskId)
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${dim}[companion]${reset} ${red}dispatch crashed${reset} [${task.taskId}] — ${message}\n`)
    return { ok: false, error: message }
  }
  if (!result.ok) {
    setTaskStatus(task.taskId, "error")
    emitTask(task.taskId)
    process.stderr.write(`${dim}[companion]${reset} ${red}dispatch failed${reset} [${task.taskId}] — ${result.error}\n`)
    return { ok: false, error: result.error }
  }
  setTaskSpawn(task.taskId, result.sessionName ?? null)
  emitTask(task.taskId)
  workerTail.watch(task.taskId)
  process.stderr.write(`${dim}[companion]${reset} ${cyan}orchestrator dispatch${reset} [${task.taskId}] → ${task.cwd} ${dim}(tmux ${result.sessionName ?? "?"})${reset}\n`)
  const verb = task.status === "queued" ? "starting" : "approved"
  orchEmit(orchAppendTurn("orchestrator", `${verb} [${task.taskId}] — worker dispatched`, task.taskId, task.threadId))
  return { ok: true }
}

// Run the brain on a user message: answer inline (chat) or stage a dispatch
// proposal for one-tap approval. Fire-and-forget — never blocks /send. Falls back
// to a soft note on any model failure so the thread never wedges.
export async function runBrain(userText: string, channel: OrchChannel): Promise<void> {
  // History and cwd candidates are scoped to the channel so the brain reasons
  // within one project's thread. A channel bound to a cwd puts it first so the
  // brain leans toward that project when composing a dispatch.
  const cwds = channel.cwd ? [channel.cwd, ...candidateCwds().filter((c) => c !== channel.cwd)] : candidateCwds()
  let decision
  try {
    decision = await brainDecide(getThread(channel.id), userText, cwds, channel.cwd)
  } catch {
    decision = null
  }
  if (!decision) {
    // decide() returns null only after runClaude exhausts its retries — the model
    // call itself kept failing (overload / auth contention), NOT because the
    // message was unclear. Genuine ambiguity comes back as a chat clarifying
    // question, not null. So don't tell the user to rephrase a message that was fine.
    orchEmit(orchAppendTurn("orchestrator", "Couldn't reach the model just now — transient error on my side, not your message. Send that again.", null, channel.id))
    return
  }
  if (decision.kind === "chat") {
    orchEmit(orchAppendTurn("orchestrator", decision.text, null, channel.id))
    return
  }
  const task = createProposal(decision.prompt, decision.cwd, decision.reasoning, channel.id)
  // Trust ramp (Phase 7): re-read the channel — the toggle may have flipped
  // during the brain call. Auto mode skips the tap but never the reasoning:
  // every auto-dispatch shows why + what in the thread, so a bad route is
  // caught at step 2, not step 20. Cancel is the veto.
  if (getChannel(channel.id)?.autoDispatch) {
    orchEmit(orchAppendTurn(
      "orchestrator",
      `Auto-dispatch [${task.taskId}] — worker in ${decision.cwd}\nWhy: ${decision.reasoning}\nTask: ${decision.prompt}`,
      task.taskId,
      channel.id,
    ))
    emitTask(task.taskId)
    void workerQueue.admit(task)
    return
  }
  orchEmit(orchAppendTurn(
    "orchestrator",
    `Proposal [${task.taskId}] — dispatch a worker in ${decision.cwd}\nWhy: ${decision.reasoning}\nTask: ${decision.prompt}\nApprove to run.`,
    task.taskId,
    channel.id,
  ))
  emitTask(task.taskId)
}
