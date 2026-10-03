import {
  emitChannel,
  emitTask,
  fileProposal,
  orchEmit,
  runBrain,
  workerQueue,
  writeCtx,
} from "../wiring/orchestrator"
import {
  appendTurn as orchAppendTurn,
  createQueuedTask,
  getTask,
  getThread,
  listTasks,
  setTaskStatus,
  type Task as OrchTask,
} from "../lib/orchestrator-chat"
import {
  type Channel as OrchChannel, createChannel, getChannel, getChannelByNote, listChannels, setChannelAuto, setChannelNote,
} from "../lib/orchestrator-channels"
import { GENERAL_CHANNEL } from "../lib/orchestrator-db"
import {
  ANSWER_MAX, DEFAULT_AGENT, DISPATCH_ID, type DispatchTask, type WriteOutcome,
  cancelDispatchTask, dispatchToDto, fileTask, getDispatchTask, getNote, getTaskActivity, getTaskResult,
  newDispatchId, requeueTask, resolveAgent, toTaskDto, unblockTask,
} from "../lib/dispatch-tasks"
import { withIdempotency } from "../lib/idempotency"
import { bodySnapshot } from "../wiring/body"
import { TursoUnreachable } from "../lib/turso"
import { type DispatchWiring, dispatchWiring } from "../wiring/dispatch"
import { handleKeyCommand, isKeyCommand } from "../lib/secret-store"
import { BODY_CHANNEL, type BodySnapshot, type BodyVitals, vitalsHeader } from "../lib/body"
import { keyCommandGate } from "../lib/vault-guard"
import { companionLog } from "../lib/log"
import { sessionCmdArgv } from "../lib/tmux-pane"

// Orchestrator routes (PRJ-OR1T): channels, thread, send, dispatch, proposal
// approve/reject, task cancel, auto-dispatch toggle; plus the Turso dispatch
// queue (orchestrator-one-queue): channel ↔ note link, task detail, projects
// (P1); approve files to Turso, cancel / requeue / unblock through the guarded
// writes in lib/dispatch-tasks.ts, #Body vitals header (P2/P3). Contract:
// docs/orchestrator-dispatch-api.md. Returns null for any other path. Turso
// failures → 503 {ok:false, error:"turso_unreachable"}.

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/
const NOTE_ID_MAX = 300

function unreachable(err: unknown): Response {
  const what = err instanceof TursoUnreachable ? err.message : `unexpected error (${(err as Error)?.name ?? typeof err})`
  companionLog(`[orchestrator] ${what}`)
  return Response.json({ ok: false, error: "turso_unreachable" }, { status: 503 })
}

// Resolve a channel id from a request (query param or body field), defaulting to
// General. Returns null only when a non-empty id names a channel that doesn't
// exist — callers reject that as a 404.
function resolveChannel(id: string | null | undefined): OrchChannel | null {
  const wanted = id?.trim() || GENERAL_CHANNEL
  return getChannel(wanted)
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.json() as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch {
    return null
  }
}

const optStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

// POST .../channels {name, cwd?, noteId?}: a noteId links the new channel to
// that project (404 unknown note, 409 note_linked_elsewhere — nothing created).
async function createChannelRoute(req: Request, dispatch: DispatchWiring): Promise<Response> {
  const body = await readJson(req)
  const name = optStr(body?.name)
  if (!name) return Response.json({ ok: false, error: "name required" }, { status: 400 })
  const noteId = optStr(body?.noteId)
  if (body?.noteId !== undefined && body.noteId !== null && (!noteId || noteId.length > NOTE_ID_MAX)) {
    return Response.json({ ok: false, error: "noteId must be a note id" }, { status: 400 })
  }
  let link = null
  if (noteId) {
    if (getChannelByNote(noteId)) return Response.json({ ok: false, error: "note_linked_elsewhere" }, { status: 409 })
    try {
      link = await getNote(dispatch.query, noteId)
    } catch (err) {
      return unreachable(err)
    }
    if (!link) return Response.json({ ok: false, error: "no such note" }, { status: 404 })
  }
  let channel = createChannel(name, optStr(body?.cwd))
  if (link) {
    const res = setChannelNote(channel.id, link)
    if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: 409 })
    channel = res.channel
    dispatch.relink([link.noteId])
  }
  emitChannel(channel)
  return Response.json({ ok: true, channel: dispatch.decorate(channel) })
}

// POST .../channels/<id>/link {noteId: string|null}. Re-routes that note's
// dispatch tasks (frames re-emitted) and refreshes the rail counts.
async function linkChannel(req: Request, id: string, dispatch: DispatchWiring): Promise<Response> {
  const ch = getChannel(id)
  if (!ch) return Response.json({ ok: false, error: "no such channel" }, { status: 404 })
  if (id === GENERAL_CHANNEL || id === BODY_CHANNEL) {
    return Response.json({ ok: false, error: "system channels cannot be linked" }, { status: 400 })
  }
  let raw: { noteId?: unknown }
  try {
    raw = await req.json() as { noteId?: unknown }
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 })
  }
  const noteId = typeof raw?.noteId === "string" ? raw.noteId.trim() : raw?.noteId === null ? null : undefined
  if (noteId === undefined || noteId === "" || (noteId && noteId.length > NOTE_ID_MAX)) {
    return Response.json({ ok: false, error: "noteId must be a note id or null" }, { status: 400 })
  }
  let link = null
  if (noteId) {
    try {
      link = await getNote(dispatch.query, noteId)
    } catch (err) {
      return unreachable(err)
    }
    if (!link) return Response.json({ ok: false, error: "no such note" }, { status: 404 })
  }
  const res = setChannelNote(id, link)
  if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: res.error === "no_such_channel" ? 404 : 409 })
  dispatch.relink([ch.noteId, link?.noteId].filter((n): n is string => !!n))
  emitChannel(res.channel)
  return Response.json({ ok: true, channel: dispatch.decorate(res.channel) })
}

// GET .../task/<id>: a local (8-char) task from sqlite, else the Turso row with
// its description, result note excerpt and last 20 activity rows.
async function taskDetail(id: string, dispatch: DispatchWiring): Promise<Response> {
  if (!TASK_ID.test(id)) return Response.json({ ok: false, error: "no such task" }, { status: 404 })
  const local = getTask(id)
  if (local) return Response.json({ ok: true, task: toTaskDto(local), description: local.prompt, activity: [] })
  try {
    const found = await getDispatchTask(dispatch.query, await dispatch.columns(), id)
    if (!found) return Response.json({ ok: false, error: "no such task" }, { status: 404 })
    const [result, activity] = await Promise.all([getTaskResult(dispatch.query, found.task), getTaskActivity(dispatch.query, id)])
    return Response.json({
      ok: true, task: dispatchToDto(found.task, dispatch.threadIdFor(found.task)), description: found.description,
      ...(result ? { result } : {}), activity,
    })
  } catch (err) {
    return unreachable(err)
  }
}

// Cancel a local (tmux-era) task, Phase 7 behaviour: kill its worker if any.
async function cancelLocal(task: OrchTask): Promise<Response> {
  if (task.status !== "queued" && task.status !== "dispatched" && task.status !== "running") {
    return Response.json({ ok: false, error: `not cancellable (status ${task.status})` }, { status: 409 })
  }
  if (task.tmuxSession) {
    try {
      // On the server it was spawned on (COMPANION_TMUX_SOCKET) — a bare
      // `tmux kill-session` would miss it, or hit a same-named stranger.
      await Bun.spawn(sessionCmdArgv(task.tmuxSocket, "kill-session", task.tmuxSession), { stdout: "ignore", stderr: "ignore" }).exited
    } catch { /* already gone */ }
  }
  setTaskStatus(task.taskId, "cancelled")
  emitTask(task.taskId)
  orchEmit(orchAppendTurn("orchestrator", `cancelled [${task.taskId}]`, task.taskId, task.threadId))
  vetoAuto(task.threadId)
  void workerQueue.drain()
  return Response.json({ ok: true, taskId: task.taskId, status: "cancelled" })
}

// In an auto channel a cancel is the veto: back to propose-confirm.
function vetoAuto(channelId: string): void {
  const ch = getChannel(channelId)
  if (!ch?.autoDispatch) return
  const updated = setChannelAuto(ch.id, false)
  if (!updated) return
  emitChannel(updated)
  orchEmit(orchAppendTurn("orchestrator", `auto-dispatch OFF for #${ch.name} — a cancel resets the ramp; flip it back on when ready`, null, ch.id))
}

type TaskAction = "cancel" | "requeue" | "unblock"

function actionTurn(action: TaskAction, t: DispatchTask, answer: string): string {
  const who = `[${t.id.slice(0, 8)}] ${t.agent ?? "agent"} — ${t.title}`
  if (action === "cancel") return `cancelled ${who}`
  if (action === "requeue") return `requeued ${who}`
  return `unblocked ${who}\nAnswer: ${answer.slice(0, 500)}`
}

// POST .../task/<32-hex>/{cancel|requeue|unblock}: one guarded Turso write.
// 409 when the row is not in an allowed state or another writer moved it
// first (state unchanged); a running task names its owner instead.
async function dispatchAction(req: Request, id: string, action: TaskAction, dispatch: DispatchWiring): Promise<Response> {
  let answer = ""
  if (action === "unblock") {
    const raw = (await readJson(req))?.answer
    answer = typeof raw === "string" ? raw.trim() : ""
    if (!answer || answer.length > ANSWER_MAX) {
      return Response.json({ ok: false, error: `answer must be 1..${ANSWER_MAX} chars` }, { status: 400 })
    }
  }
  const cached = dispatch.cached(id)
  let out: WriteOutcome
  try {
    const ctx = await writeCtx(dispatch, cached ? dispatch.threadIdFor(cached) : null)
    out = action === "cancel" ? await cancelDispatchTask(ctx, id)
      : action === "requeue" ? await requeueTask(ctx, id)
      : await unblockTask(ctx, id, answer)
  } catch (err) {
    return unreachable(err)
  }
  if (!out.ok && out.error === "no_such_task") return Response.json({ ok: false, error: "no such task" }, { status: 404 })
  if (!out.ok) {
    const task = dispatchToDto(out.task, dispatch.threadIdFor(out.task))
    const error = out.error === "running" ? `running_on_${out.task.owner ?? "unknown"}` : "conflict"
    return Response.json({ ok: false, error, dispatchStatus: task.dispatchStatus, owner: out.task.owner, task }, { status: 409 })
  }
  dispatch.applyLocal(out.task)
  const channelId = dispatch.threadIdFor(out.task)
  orchEmit(orchAppendTurn("orchestrator", actionTurn(action, out.task, answer), out.task.id, channelId))
  if (action === "cancel") vetoAuto(channelId)
  const task = dispatchToDto(out.task, channelId)
  return Response.json(action === "cancel" ? { ok: true, taskId: id, status: "cancelled", task } : { ok: true, task })
}

async function taskActionRoute(req: Request, path: string, dispatch: DispatchWiring): Promise<Response> {
  const [taskId, action] = path.split("/")
  if (action !== "cancel" && action !== "requeue" && action !== "unblock") {
    return Response.json({ ok: false, error: "unknown action" }, { status: 400 })
  }
  if (!taskId || !TASK_ID.test(taskId)) return Response.json({ ok: false, error: "no such task" }, { status: 404 })
  const local = getTask(taskId)
  if (local) {
    if (action === "cancel") return cancelLocal(local)
    return Response.json({ ok: false, error: `${action} needs a dispatch task` }, { status: 409 })
  }
  if (!DISPATCH_ID.test(taskId)) return Response.json({ ok: false, error: "no such task" }, { status: 404 })
  return withIdempotency(req, `task-${action}:${taskId}`, () => dispatchAction(req, taskId, action, dispatch))
}

// POST .../proposal/<id>/{approve|reject}. Approve files the proposal to Turso
// (P2; replay on `filed` → 200 with the same dispatchTaskId). {mode:"live"} keeps
// the pre-P4 tmux worker path (no Turso row yet).
async function proposalRoute(req: Request, path: string, dispatch: DispatchWiring): Promise<Response> {
  const [taskId, action] = path.split("/")
  const task = taskId ? getTask(taskId) : null
  if (!task) return Response.json({ ok: false, error: "no such proposal" }, { status: 404 })
  if (action === "reject") {
    if (task.status !== "proposed") return Response.json({ ok: false, error: `not proposable (status ${task.status})` }, { status: 409 })
    setTaskStatus(task.taskId, "rejected")
    emitTask(task.taskId)
    orchEmit(orchAppendTurn("orchestrator", `rejected [${task.taskId}] — not dispatched`, task.taskId, task.threadId))
    // An approve that died after the Turso insert but before markFiled left a
    // queued row behind: withdraw it (best effort, guarded queued → cancelled).
    if (task.dispatchTaskId) {
      void writeCtx(dispatch, task.threadId).then((ctx) => cancelDispatchTask(ctx, task.dispatchTaskId!)).catch(() => {})
    }
    return Response.json({ ok: true, taskId: task.taskId, status: "rejected" })
  }
  if (action !== "approve") return Response.json({ ok: false, error: "unknown action" }, { status: 400 })
  return withIdempotency(req, `approve:${task.taskId}`, async () => {
    const body = (await readJson(req)) ?? {}
    if (body.mode === "live") return approveLive(task)
    const out = await fileProposal(task.taskId, { agent: optStr(body.agent), noteId: optStr(body.noteId) }, dispatch)
    if (!out.ok) return Response.json({ ok: false, error: out.error, taskId: task.taskId }, { status: out.status })
    return Response.json({ ok: true, taskId: task.taskId, status: "queued", dispatchTaskId: out.dispatchTaskId, replay: out.replay })
  })
}

async function approveLive(task: OrchTask): Promise<Response> {
  if (task.status !== "proposed") return Response.json({ ok: false, error: `not proposable (status ${task.status})` }, { status: 409 })
  if (!task.cwd) return Response.json({ ok: false, error: "cwd required for a live run" }, { status: 400 })
  const admission = await workerQueue.admit(task)
  if (admission.status === "queued") return Response.json({ ok: true, taskId: task.taskId, status: "queued" })
  if (!admission.ok) return Response.json({ ok: false, error: admission.error, taskId: task.taskId }, { status: 500 })
  return Response.json({ ok: true, taskId: task.taskId, status: "dispatched" })
}

// POST .../dispatch {prompt, channel?, noteId?, agent?, title?, mode?, cwd?}:
// files a Turso agent task straight away; mode "live" keeps the tmux worker.
async function dispatchRoute(req: Request, dispatch: DispatchWiring): Promise<Response> {
  const body = (await readJson(req)) ?? {}
  const prompt = optStr(body.prompt)
  if (!prompt) return Response.json({ ok: false, error: "prompt required" }, { status: 400 })
  const ch = resolveChannel(optStr(body.channel))
  if (!ch) return Response.json({ ok: false, error: "no such channel" }, { status: 404 })
  if (body.mode === "live") return dispatchLive(prompt, optStr(body.cwd) || ch.cwd || "", ch.id)
  const noteId = optStr(body.noteId) || ch.noteId
  if (!noteId) return Response.json({ ok: false, error: "no_project" }, { status: 422 })
  const agent = resolveAgent(optStr(body.agent) ?? DEFAULT_AGENT)
  if (!agent) return Response.json({ ok: false, error: "unknown_agent" }, { status: 400 })
  const id = newDispatchId()
  const title = optStr(body.title) ?? prompt.split("\n")[0]!
  try {
    if (!(await getNote(dispatch.query, noteId))) return Response.json({ ok: false, error: "no such note" }, { status: 404 })
    await fileTask(await writeCtx(dispatch, ch.id), { id, noteId, agent, title, description: `${prompt}\n\n— Filed from Companion #${ch.name}` })
  } catch (err) {
    return unreachable(err)
  }
  orchEmit(orchAppendTurn("orchestrator", `filed ${id.slice(0, 8)} → ${agent}: ${title}`, id, ch.id))
  void dispatch.poll()
  return Response.json({ ok: true, taskId: id, dispatchTaskId: id, status: "queued" })
}

async function dispatchLive(prompt: string, wd: string, channelId: string): Promise<Response> {
  if (!wd) return Response.json({ ok: false, error: "cwd required" }, { status: 400 })
  // Same admission as proposals (Phase 7): recorded queued, then spawned now or drained later.
  const task = createQueuedTask(prompt, wd, channelId)
  orchEmit(orchAppendTurn("orchestrator", `dispatch [${task.taskId}]: ${prompt}`, task.taskId, channelId))
  const admission = await workerQueue.admit(task)
  if (admission.status === "queued") return Response.json({ ok: true, taskId: task.taskId, status: "queued" })
  if (!admission.ok) return Response.json({ ok: false, error: admission.error ?? "spawn failed", taskId: task.taskId }, { status: 500 })
  return Response.json({ ok: true, taskId: task.taskId, status: "dispatched" })
}

// #Body thread header (P3): vitals counts + blocked tasks. Never holds the
// thread up for long — a slow or failed Body read gives null.
async function bodyVitals(body: BodySnapshot, dispatch: DispatchWiring, timeoutMs: number): Promise<BodyVitals | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), timeoutMs) })
  try {
    const snap = await Promise.race([body.get().catch(() => null), timeout])
    return snap ? vitalsHeader(snap, dispatch.queueSummary().dispatch.blocked) : null
  } finally {
    clearTimeout(timer)
  }
}

export interface OrchestratorRouteOpts { body?: BodySnapshot; vitalsTimeoutMs?: number }

export function createOrchestratorHandler(dispatch: DispatchWiring = dispatchWiring, opts: OrchestratorRouteOpts = {}) {
  return (req: Request, url: URL) => handleRoute(req, url, dispatch, opts)
}

export const handleOrchestratorRoute = createOrchestratorHandler()

async function handleRoute(req: Request, url: URL, dispatch: DispatchWiring, opts: OrchestratorRouteOpts): Promise<Response | null> {
  // ── Orchestrator single-thread: chat + worker dispatch (PRJ-OR1T Phase 1) ──
  // One always-open thread per host. /send records a user message; /dispatch
  // spawns a worker bound to this thread (its turn-end reports back tagged by
  // task, via the session-start + stop hooks above); /thread reads it all.
  if (url.pathname === "/api/orchestrator/channels" && req.method === "GET") {
    return Response.json({ channels: listChannels().map(dispatch.decorate) })
  }
  if (url.pathname === "/api/orchestrator/channels" && req.method === "POST") return createChannelRoute(req, dispatch)
  // Trust ramp toggle (Phase 7). POST .../channels/<id>/auto { enabled }.
  // The server reports eligibility (trust.eligible); only the user flips it.
  if (url.pathname.startsWith("/api/orchestrator/channels/") && req.method === "POST") {
    const [id, action] = url.pathname.slice("/api/orchestrator/channels/".length).split("/")
    if (action === "link" && id) return linkChannel(req, id, dispatch)
    if (action !== "auto" || !id) return Response.json({ ok: false, error: "unknown action" }, { status: 400 })
    const { enabled } = await req.json() as { enabled?: unknown }
    if (typeof enabled !== "boolean") return Response.json({ ok: false, error: "enabled must be boolean" }, { status: 400 })
    if (id === BODY_CHANNEL && enabled) return Response.json({ ok: false, error: "auto-dispatch is disabled for #Body" }, { status: 400 })
    const ch = setChannelAuto(id, enabled)
    if (!ch) return Response.json({ ok: false, error: "no such channel" }, { status: 404 })
    emitChannel(ch)
    orchEmit(orchAppendTurn(
      "orchestrator",
      enabled
        ? `auto-dispatch ON for #${ch.name} — proposals run without a tap; cancel any task to switch it back off`
        : `auto-dispatch OFF for #${ch.name} — back to propose-confirm`,
      null,
      ch.id,
    ))
    return Response.json({ ok: true, channel: ch })
  }
  if (url.pathname === "/api/orchestrator/thread" && req.method === "GET") {
    const ch = resolveChannel(url.searchParams.get("channel"))
    if (!ch) return Response.json({ ok: false, error: "no such channel" }, { status: 404 })
    // Returns the channel roster too, so the client fills the rail and the
    // active thread in one round-trip.
    // tasks = this channel's local rows + its Turso dispatch tasks (from the
    // poller's last read; never blocks on Turso). queue gains `dispatch`.
    // #Body adds `vitals` (P3): the header line + counts, null when unavailable.
    const vitals = ch.id === BODY_CHANNEL ? { vitals: await bodyVitals(opts.body ?? bodySnapshot, dispatch, opts.vitalsTimeoutMs ?? 1500) } : {}
    return Response.json({
      channel: ch.id, channels: listChannels().map(dispatch.decorate), turns: getThread(ch.id),
      tasks: [...listTasks(ch.id).map(toTaskDto), ...dispatch.tasksFor(ch.id)],
      queue: dispatch.queueSummary(), ...vitals,
    })
  }
  if (url.pathname === "/api/orchestrator/projects" && req.method === "GET") {
    try {
      return Response.json({ projects: await dispatch.projects(url.searchParams.get("fresh") === "1") })
    } catch (err) {
      return unreachable(err)
    }
  }
  if (url.pathname.startsWith("/api/orchestrator/task/") && req.method === "GET") {
    const id = url.pathname.slice("/api/orchestrator/task/".length)
    return taskDetail(id, dispatch)
  }
  if (url.pathname === "/api/orchestrator/send" && req.method === "POST") {
    const { text, channel } = await req.json() as { text?: string; channel?: string }
    if (!text?.trim()) return Response.json({ ok: false, error: "empty" }, { status: 400 })
    const ch = resolveChannel(channel)
    if (!ch) return Response.json({ ok: false, error: "no such channel" }, { status: 404 })
    // `/key NAME value` goes to secrets.env: the thread (and the brain) only
    // ever see the orchestrator's name-only confirmation.
    // Same gate as /api/inject: only from where the vault itself would accept
    // it, and a refused /key never reaches the thread (the value would land
    // in it and in the brain's prompt).
    let keyed: Awaited<ReturnType<typeof handleKeyCommand>> = null
    if (isKeyCommand(text)) {
      const gate = keyCommandGate(req)
      if (!gate.allowed) {
        const { status, ...refusal } = gate.refusal ?? { status: 403, error: "forbidden_network", message: "/key refusé. Rien enregistré." }
        companionLog(`/key refused (orchestrator) — ${refusal.error} peer=${gate.origin.peer}`)
        return Response.json({ ok: false, ...refusal }, { status })
      }
      keyed = await handleKeyCommand(text, gate.origin)
    }
    if (keyed) {
      const turn = orchAppendTurn("orchestrator", keyed.message, null, ch.id)
      orchEmit(turn)
      return Response.json({ ...keyed, turn }, { status: keyed.status })
    }
    const turn = orchAppendTurn("user", text.trim(), null, ch.id)
    orchEmit(turn)
    // Brain decides chat-vs-dispatch async; the user message is already
    // recorded, so /send returns instantly and the reply/proposal streams in.
    void runBrain(text.trim(), ch)
    return Response.json({ ok: true, turn })
  }
  if (url.pathname === "/api/orchestrator/dispatch" && req.method === "POST") return dispatchRoute(req, dispatch)
  if (url.pathname.startsWith("/api/orchestrator/task/") && req.method === "POST") {
    return taskActionRoute(req, url.pathname.slice("/api/orchestrator/task/".length), dispatch)
  }
  if (url.pathname.startsWith("/api/orchestrator/proposal/") && req.method === "POST") {
    return proposalRoute(req, url.pathname.slice("/api/orchestrator/proposal/".length), dispatch)
  }
  return null
}
