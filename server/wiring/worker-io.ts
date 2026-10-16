import { type Herdr, closeHerdrAgentWorkspace, forgetHerdrAgent, realHerdr } from "../lib/herdr"
import { type HerdrDelivery, deliverViaHerdr } from "../lib/herdr-inject"
import { pumpPrompt } from "../lib/herdr-seed"
import { companionLog } from "../lib/log"
import { LIVE_STATUSES, type Task, getTask, markPromptSent } from "../lib/orchestrator-chat"
import { listSessions } from "../lib/sessions"
import { capturePane, paneHasDialog, paneInputReady, sessionCmdArgv } from "../lib/tmux-pane"
import { type WorkerRef, workerLabel, workerRefOf } from "../lib/worker-ref"
import { type Expect, createLiveness } from "./takeover-liveness"

// Worker IO for orchestrator workers (docs/orchestrator-dispatch-api.md): deliver
// the prompt, read the screen, ask alive / gone, kill — per runtime (lib/worker-ref.ts),
// so the callers (orchestrator, live, routes) never branch on tmux. herdr: the
// prompt goes through the shared seed pump (lib/herdr-seed.ts) and liveness comes
// from herdr presence (takeover-liveness.ts), never from a screen read. herdr reuses
// agent names and pane ids, so every herdr check also matches the pane (and
// workspace) recorded at spawn: an agent of that name elsewhere is a stranger. tmux: the
// send-keys path as before. prompt_sent_at is stamped on a confirmed delivery
// either way, so the boot resume never types a prompt twice.

export interface WorkerIODeps {
  herdr: Herdr
  deliver: (pane: string, text: string) => Promise<HerdrDelivery>
  sessions: () => { key: string; taskId: string }[]
  getTask: (taskId: string) => Task | null
  markPromptSent: (taskId: string) => void
  /** A turn in the task's channel (wiring/orchestrator.ts sets it). */
  turn: (text: string, task: Task) => void
  /** The prompt never went in: fail the task (wiring/orchestrator.ts sets it). */
  gaveUp: (task: Task, blocker: string) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
}

const defaults = (): WorkerIODeps => ({
  herdr: realHerdr,
  deliver: (pane, text) => deliverViaHerdr(pane, text),
  sessions: () => listSessions(),
  getTask,
  markPromptSent,
  turn: () => {},
  gaveUp: () => {},
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: companionLog,
})

let deps: WorkerIODeps | null = null
const d = (): WorkerIODeps => (deps ??= defaults())
const live = createLiveness(() => d())
/** One pump per task in this process (prompt_sent_at covers restarts). */
const pumping = new Map<string, Promise<void>>()

/** Wiring + test seam: override some deps (and forget liveness state); returns the previous set. */
export function setWorkerIODeps(patch: Partial<WorkerIODeps>): WorkerIODeps {
  const prev = d()
  deps = { ...prev, ...patch }
  live.reset()
  return prev
}

/** Test seam: every prompt pump finished. */
export async function workerIOIdle(): Promise<void> {
  while (pumping.size) await Promise.all(pumping.values())
}

const stillWanted = (taskId: string): boolean => {
  const t = d().getTask(taskId)
  return !!t && LIVE_STATUSES.includes(t.status) && t.promptSentAt == null
}

type HerdrRef = Extract<WorkerRef, { kind: "herdr" }>
const expectOf = (ref: HerdrRef, taskId: string): Expect => ({ sessionTaskId: taskId, pane: ref.pane, workspaceId: ref.workspace })

/** Type the prompt only while our agent still owns the pane; a stranger there (name / pane reuse) refuses. */
async function deliverOwned(ref: HerdrRef, task: Task): Promise<HerdrDelivery> {
  const a = await live.agentAt(ref.agent, expectOf(ref, task.taskId))
  if (a.kind === "absent") return { ok: false, blocked: false, reason: "agent_gone" }
  if (a.kind === "error") return { ok: false, blocked: false, reason: "herdr_unreadable" }
  return d().deliver(ref.pane, task.prompt)
}

async function pumpHerdr(task: Task, ref: HerdrRef): Promise<void> {
  const id = task.taskId
  const { agent, pane } = ref
  const out = await pumpPrompt({
    gate: () => live.seedGate(agent, pane),
    deliver: () => deliverOwned(ref, task),
    stillWanted: () => stillWanted(id),
    onDialog: (title) => d().turn(`⏸️ [${id}] worker waiting on ${title ? `"${title}"` : "a dialog"} — answer it on the phone; the prompt goes in once it clears`, task),
    now: () => d().now(),
    sleep: (ms) => d().sleep(ms),
  })
  if (out.kind === "dropped") return d().log(`[orchestrator] [${id}] settled before its prompt went in — prompt dropped`)
  if (out.kind === "delivered") {
    d().markPromptSent(id)
    d().log(`\x1b[36morchestrator → herdr\x1b[0m ${agent} "${task.prompt.slice(0, 50)}"`)
    return d().turn(`[${id}] prompt delivered`, task)
  }
  // The workspace stays open for inspection.
  d().turn(`⚠️ [${id}] prompt never delivered (${out.reason}) — the worker is left open; tell it the task yourself`, task)
  const now = d().getTask(id)
  if (now && LIVE_STATUSES.includes(now.status)) d().gaveUp(now, `prompt never delivered: ${out.reason}`)
}

/** Deliver a worker's prompt: herdr → the seed pump (in the background, one per task); tmux → send-keys once input-ready. */
export function deliverWorkerPrompt(task: Task): void {
  const ref = workerRefOf(task)
  if (ref.kind === "tmux") {
    void sendToTmux(ref.session, task.prompt, ref.socket || undefined).then((ok) => { if (ok) d().markPromptSent(task.taskId) })
    return
  }
  if (ref.kind !== "herdr" || pumping.has(task.taskId)) return
  const p = pumpHerdr(task, ref)
    .catch((err) => d().log(`[orchestrator] [${task.taskId}] prompt pump failed (${(err as Error)?.message ?? err})`))
    .finally(() => pumping.delete(task.taskId))
  pumping.set(task.taskId, p)
}

/** Boot: restart the pump for herdr rows still waiting on their prompt (listPendingHerdrPrompts); tmux rows are never re-typed. */
export function resumeWorkerPrompts(tasks: Task[]): void {
  for (const t of tasks) {
    if (workerRefOf(t).kind !== "herdr") continue
    d().log(`[orchestrator] [${t.taskId}] prompt pump resumed (${workerLabel(workerRefOf(t))})`)
    deliverWorkerPrompt(t)
  }
}

/** A herdr worker's screen (the live tail); null when unreadable. */
export function readHerdrPane(pane: string): Promise<string | null> {
  return d().herdr.read(pane)
}

/** Gone = herdr no longer runs it: no registered session with its task id and no claude in front of its pane, past the start grace (from spawn time). */
export function herdrGone(task: Task): Promise<boolean> {
  const ref = workerRefOf(task)
  if (ref.kind !== "herdr") return Promise.resolve(false)
  return live.missing(ref.agent, task.spawnedAt ?? task.updatedAt, expectOf(ref, task.taskId))
}

/** Still running (live boot reconcile): herdr presence, or a capturable tmux pane. */
export async function workerAlive(task: Task): Promise<boolean> {
  const ref = workerRefOf(task)
  if (ref.kind === "herdr") return live.alive(ref.agent, expectOf(ref, task.taskId))
  if (ref.kind === "tmux") return (await capturePane(ref.session, undefined, { socket: ref.socket || undefined })) !== null
  return false
}

/** Cancel: close a herdr worker's own workspace (label = agent name, still in its pane), or kill the tmux session on its server. Already gone = no-op. */
export async function killWorker(task: Task): Promise<void> {
  const ref = workerRefOf(task)
  if (ref.kind === "herdr") {
    if (!ref.agent) return
    const ws = await closeHerdrAgentWorkspace(ref.agent, ref.pane, d().herdr, ref.workspace)
    if (ws) {
      forgetHerdrAgent(ref.pane)
      d().log(`[orchestrator] [${task.taskId}] herdr workspace ${ws} closed`)
    }
    return
  }
  if (ref.kind !== "tmux") return
  try {
    // On the server it was spawned on (COMPANION_TMUX_SOCKET) — a bare
    // `tmux kill-session` would miss it, or hit a same-named stranger.
    await Bun.spawn(sessionCmdArgv(ref.socket, "kill-session", ref.session), { stdout: "ignore", stderr: "ignore" }).exited
  } catch { /* already gone */ }
}

// Deliver a dispatched prompt straight to the worker's tmux session by name.
// We spawned it (cc-<name>), so send-keys -t <session> hits its active pane no
// matter how the session surfaced in the registry. This is the reliable path: a
// tmux-wrapped worker discovered via ps has no tmuxPane recorded and its client
// tty has no Terminal tab, so AppleScript/tty inject fails ("no tab for tty").
// tmux send-keys does not care — it just needs the TUI to be input-ready first.
// `socket` is the server the worker was spawned on (task.tmuxSocket). True once sent.
async function sendToTmux(sessionName: string, text: string, socket?: string): Promise<boolean> {
  const keys = (...rest: string[]) =>
    Bun.spawn(sessionCmdArgv(socket, "send-keys", sessionName, ...rest), { stdout: "ignore", stderr: "ignore" }).exited
  let ready = false
  for (let i = 0; i < 30; i++) {
    const pane = await capturePane(sessionName, undefined, { socket })
    if (pane === null) return false // worker session gone
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
    return false
  }
  try {
    await keys("-l", text)
    await new Promise((r) => setTimeout(r, 300))
    await keys("Enter")
    const reset = "\x1b[0m"; const cyan = "\x1b[36m"
    companionLog(`${cyan}orchestrator → tmux${reset} ${sessionName} "${text.slice(0, 50)}"`)
    return true
  } catch {
    return false // worker session gone
  }
}
