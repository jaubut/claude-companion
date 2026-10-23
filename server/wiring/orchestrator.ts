import { companionLog } from "../lib/log"
import { HOST_INFO, broadcast } from "../state"
import {
  appendTurn as orchAppendTurn,
  getThread,
  createProposal,
  getTask,
  stampDispatchId,
  markFiled,
  type Turn as OrchTurn,
  type Task as OrchTask,
} from "../lib/orchestrator-chat"
import { getChannel, type Channel as OrchChannel } from "../lib/orchestrator-channels"
import { type BrainDecision, decide as brainDecide } from "../lib/orchestrator-brain"
import { type Catalog, buildCatalog, catalogLines } from "../lib/project-catalog"
import { readRepoMapSource } from "../lib/live-repo"
import { listSessions } from "../lib/sessions"
import { BODY_CHANNEL, type BodySnapshot } from "../lib/body"
import { GENERAL_CHANNEL } from "../lib/orchestrator-db"
import { bodyDigestFor } from "./body"
import { investigationDigestFor } from "./body-investigate"
import {
  DEFAULT_AGENT, type ProjectRef, type RequiresHost, type WriteCtx, agentAllowlist, fileTask, getDispatchTask, getNote, newDispatchId, resolveAgent, toTaskDto,
} from "../lib/dispatch-tasks"
import { TursoUnreachable } from "../lib/turso"
import { type DispatchWiring, dispatchWiring } from "./dispatch"

// Orchestrator wiring (PRJ-OR1T): emit helpers, filing a proposal to the one
// Turso queue (dispatch-run runs it; nothing here spawns a worker), and the brain.

// Orchestrator single-thread (PRJ-OR1T): push every new thread turn to all
// clients so the one always-open chat stays live on every device.
export function orchEmit(turn: OrchTurn): void {
  broadcast({ type: "orchestrator", turn })
}

// Broadcast a task's current state on every transition (proposed → dispatched →
// running → done/error/rejected) so the phone's Tasks panel tracks live work.
export function emitTask(taskId: string): void {
  const t = getTask(taskId)
  if (!t) return
  broadcast({ type: "orchestrator_task", task: toTaskDto(t) })
  for (const fn of taskListeners) fn(t)
}

// Triage (wiring/triage.ts) recomputes when a local task (proposal) changes,
// and adds its count to the #General / #Body brain context. Registered there
// (it imports this module, not the reverse).
const taskListeners = new Set<(task: OrchTask) => void>()
export function onTaskEmitted(fn: (task: OrchTask) => void): () => void {
  taskListeners.add(fn)
  return () => taskListeners.delete(fn)
}
let triageDigest: (() => string | null) | null = null
export function setTriageDigest(fn: (() => string | null) | null): void {
  triageDigest = fn
}

// Broadcast a new/updated channel so every device's channel rail live-updates
// (PRJ-OR1T Phase 6).
export function emitChannel(channel: OrchChannel): void {
  broadcast({ type: "orchestrator_channel", channel: dispatchWiring.decorate(channel) })
}

// ── Orchestrator brain (PRJ-OR1T Phase 2): propose-confirm dispatch ──

// Project directories the brain may dispatch into: cwds of live registered
// sessions, deduped. Keeps proposals grounded in real, currently-open projects.
function candidateCwds(): string[] {
  return [...new Set(listSessions().map((s) => s.cwd).filter(Boolean))]
}

// ── Filing to the one queue (orchestrator-one-queue P2) ──

/** Write context for the guarded Turso writes: host + channel go into the ledger meta. */
export async function writeCtx(dispatch: DispatchWiring, channel: string | null): Promise<WriteCtx> {
  return { exec: dispatch.exec, cols: await dispatch.columns(), host: HOST_INFO.name, channel, log: companionLog }
}

export type FileOutcome =
  /** queued: filed as Jeremie's (origin jeremie) straight to the queue; false = pending, waits for the dashboard stamp. */
  | { ok: true; dispatchTaskId: string; replay: boolean; queued: boolean; task: OrchTask }
  | { ok: false; status: number; error: string }

function proposalTitle(t: OrchTask): string {
  return (t.title?.trim() || t.prompt.split("\n").find((l) => l.trim()) || t.prompt).trim().slice(0, 120)
}

function proposalDescription(t: OrchTask, channelName: string): string {
  const why = t.reasoning?.trim() ? `\nWhy: ${t.reasoning.trim()}` : ""
  return `${t.prompt}\n\n— Filed from Companion #${channelName} (proposal ${t.taskId})${why}`
}

/**
 * Approve → one Turso agent task: `queued` when it is Jeremie's
 * tap (byHand), else `pending` for the dashboard release stamp. The Turso id
 * is stamped on the local row first, so a replayed approve (iOS outbox) reuses
 * it and INSERT OR IGNORE keeps it to one row; only then proposed → filed.
 * A Turso failure leaves the proposal proposed (and retryable): 503.
 */
export async function fileProposal(
  taskId: string, opts: { agent?: string | null; noteId?: string | null; byHand?: boolean; requiresHost?: RequiresHost | null } = {},
  dispatch: DispatchWiring = dispatchWiring,
): Promise<FileOutcome> {
  const task = getTask(taskId)
  if (!task) return { ok: false, status: 404, error: "no such proposal" }
  // A replay reports the queue state the first filing had (same tap, same columns).
  const trusted = async (): Promise<boolean> => !!opts.byHand && !!(await dispatch.columns()).origin
  if (task.status === "filed" && task.dispatchTaskId) return { ok: true, dispatchTaskId: task.dispatchTaskId, replay: true, queued: await trusted(), task }
  if (task.status !== "proposed") return { ok: false, status: 409, error: `not proposable (status ${task.status})` }
  const channel = getChannel(task.threadId)
  const noteId = opts.noteId?.trim() || task.noteId || channel?.noteId || null
  if (!noteId) return { ok: false, status: 422, error: "no_project" }
  const agent = resolveAgent(opts.agent || task.agent || DEFAULT_AGENT)
  if (!agent) return { ok: false, status: 400, error: "unknown_agent" }
  const id = stampDispatchId(task.taskId, newDispatchId())
  if (!id) return fileProposalReplay(task.taskId, await trusted())
  let queued: boolean
  try {
    if (!(await getNote(dispatch.query, noteId))) return { ok: false, status: 404, error: "no such note" }
    queued = (await fileTask(await writeCtx(dispatch, task.threadId), {
      id, noteId, agent, title: proposalTitle(task), description: proposalDescription(task, channel?.name ?? task.threadId),
      // Not Jeremie's tap (#Body, Opus rescope): no trusted origin, so the queue guard holds it for a human stamp.
      ...(opts.byHand ? { origin: "jeremie" as const } : {}),
      requiresHost: opts.requiresHost ?? null,
    })).status === "queued"
  } catch (err) {
    const what = err instanceof TursoUnreachable ? err.message : `unexpected error (${(err as Error)?.name ?? typeof err})`
    companionLog(`[orchestrator] file [${task.taskId}] failed: ${what}`)
    return { ok: false, status: 503, error: "turso_unreachable" }
  }
  if (!markFiled(task.taskId, { noteId, agent })) return fileProposalReplay(task.taskId, queued)
  emitTask(task.taskId)
  const next = queued ? "queued for dispatch-run" : "waits for your approval on the dashboard"
  orchEmit(orchAppendTurn("orchestrator", `filed [${task.taskId}] → ${agent} · ${id.slice(0, 8)} ${next}`, task.taskId, task.threadId))
  await showFiled(id, dispatch)
  return { ok: true, dispatchTaskId: id, replay: false, queued, task: getTask(task.taskId)! }
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
function fileProposalReplay(taskId: string, queued: boolean): FileOutcome {
  const now = getTask(taskId)
  if (now?.status === "filed" && now.dispatchTaskId) return { ok: true, dispatchTaskId: now.dispatchTaskId, replay: true, queued, task: now }
  return { ok: false, status: 409, error: `not proposable (status ${now?.status ?? "gone"})` }
}

// Brain picks are suggestions: a note outside the active projects or an agent
// dispatch-run cannot start is dropped (the channel's note / builder apply).
function validatedTarget(d: Extract<BrainDecision, { kind: "proposal" }>, projects: ProjectRef[]) {
  const note = projects.find((p) => p.noteId === d.noteId) ?? null
  return { noteId: note?.noteId ?? null, agent: resolveAgent(d.agent), title: d.title, projectTitle: note?.title ?? null }
}

/** Stage a brain decision in the channel: a chat reply, or a proposal that waits for a tap. */
export async function applyDecision(decision: BrainDecision, channel: OrchChannel, projects: ProjectRef[]): Promise<void> {
  if (decision.kind === "chat") {
    orchEmit(orchAppendTurn("orchestrator", decision.text, null, channel.id))
    return
  }
  const target = validatedTarget(decision, projects)
  const task = createProposal(decision.prompt, decision.cwd || channel.cwd || "", decision.reasoning, channel.id, target)
  const where = `${target.agent ?? DEFAULT_AGENT} · ${target.projectTitle ?? channel.noteTitle ?? (target.noteId || channel.noteId || "no project yet")}`
  orchEmit(orchAppendTurn(
    "orchestrator",
    `Proposal [${task.taskId}] — ${where}\nWhy: ${decision.reasoning}\nTask: ${decision.prompt}\nApprove to file it.`,
    task.taskId,
    channel.id,
  ))
  emitTask(task.taskId)
}

/** Brain context: Body digest + investigations (#Body / health questions) + this view's dispatch digest + the triage count (#General / #Body). */
export async function brainContext(
  channel: OrchChannel, userText: string, dispatch: DispatchWiring = dispatchWiring, snapshot?: BodySnapshot, forceBody = false,
): Promise<string | null> {
  const body = await bodyDigestFor(channel.id, userText, snapshot, forceBody)
  const investigations = investigationDigestFor(channel.id, userText)
  const scope = channel.id === BODY_CHANNEL ? "all projects" : `#${channel.name}`
  const triage = channel.id === GENERAL_CHANNEL || channel.id === BODY_CHANNEL ? triageDigest?.() ?? null : null
  const parts = [body, investigations, dispatch.digestFor(channel.id, scope), triage].filter((p): p is string => !!p?.trim())
  return parts.length ? parts.join("\n\n") : null
}

/** Front-door hints for one brain run (lib/front-door.ts). */
export interface BrainRunOpts {
  /** Skip the Haiku gate (Jev said task). */
  forceTask?: boolean
  /** Give the brain the Body digest even when the regex health check misses (Jev said body). */
  forceBodyDigest?: boolean
  resolved?: { noteId: string | null; title: string; repo: string | null } | null
  /** Prebuilt projects + catalog (the front door already has them). */
  prebuilt?: BrainCatalog
}

/** What the old path did — the shadow log's label. */
export type BrainOutcome = { kind: "chat" } | { kind: "task"; noteId: string | null } | { kind: "error" }

export interface BrainCatalog { projects: ProjectRef[]; catalog: Catalog }

/** Every project (any status) + the repo map; [] projects when Turso is down. */
export async function brainCatalog(dispatch: DispatchWiring = dispatchWiring): Promise<BrainCatalog> {
  const projects = await dispatch.allProjects().catch(() => [])
  return { projects, catalog: buildCatalog(projects, readRepoMapSource()) }
}

// Run the brain on a user message: answer inline (chat) or stage a proposal.
// Fire-and-forget — never blocks /send. Falls back to a soft note on any model
// failure so the thread never wedges.
export async function runBrain(
  userText: string, channel: OrchChannel, dispatch: DispatchWiring = dispatchWiring, opts: BrainRunOpts = {},
): Promise<BrainOutcome> {
  // History and cwd candidates are scoped to the channel so the brain reasons
  // within one project's thread.
  const cwds = channel.cwd ? [channel.cwd, ...candidateCwds().filter((c) => c !== channel.cwd)] : candidateCwds()
  let decision: BrainDecision | null
  let projects: ProjectRef[] = []
  try {
    const cat = opts.prebuilt ?? await brainCatalog(dispatch)
    projects = cat.projects
    const context = await brainContext(channel, userText, dispatch, undefined, opts.forceBodyDigest)
    decision = await brainDecide(getThread(channel.id), userText, cwds, channel.cwd, context, {
      projects, agents: [...agentAllowlist()].sort(), channelNoteId: channel.noteId, catalog: catalogLines(cat.catalog), resolved: opts.resolved ?? null,
    }, { forceTask: opts.forceTask })
  } catch {
    decision = null
  }
  if (!decision) {
    // decide() returns null only after runClaude exhausts its retries — the model
    // call itself kept failing (overload / auth contention), NOT because the
    // message was unclear.
    orchEmit(orchAppendTurn("orchestrator", "Couldn't reach the model just now — transient error on my side, not your message. Send that again.", null, channel.id))
    return { kind: "error" }
  }
  await applyDecision(decision, channel, projects)
  return decision.kind === "chat" ? { kind: "chat" } : { kind: "task", noteId: validatedTarget(decision, projects).noteId ?? channel.noteId }
}
