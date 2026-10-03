import {
  emitChannel,
  emitTask,
  executeDispatch,
  orchEmit,
  runBrain,
  workerQueue,
} from "../wiring/orchestrator"
import {
  appendTurn as orchAppendTurn,
  createQueuedTask,
  getTask,
  getThread,
  listTasks,
  setTaskStatus,
} from "../lib/orchestrator-chat"
import { type Channel as OrchChannel, createChannel, getChannel, listChannels, setChannelAuto, setChannelNote } from "../lib/orchestrator-channels"
import { GENERAL_CHANNEL } from "../lib/orchestrator-db"
import { dispatchToDto, getDispatchTask, getNote, getTaskActivity, getTaskResult, toTaskDto } from "../lib/dispatch-tasks"
import { TursoUnreachable } from "../lib/turso"
import { type DispatchWiring, dispatchWiring } from "../wiring/dispatch"
import { handleKeyCommand, isKeyCommand } from "../lib/secret-store"
import { BODY_CHANNEL } from "../lib/body"
import { keyCommandGate } from "../lib/vault-guard"
import { companionLog } from "../lib/log"
import { sessionCmdArgv } from "../lib/tmux-pane"

// Orchestrator routes (PRJ-OR1T): channels, thread, send, dispatch, proposal
// approve/reject, task cancel, auto-dispatch toggle; plus the Turso dispatch
// read path (orchestrator-one-queue P1): channel ↔ note link, task detail,
// projects. Contract: docs/orchestrator-dispatch-api.md. Returns null for any
// other path. Turso failures → 503 {ok:false, error:"turso_unreachable"}.

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

export function createOrchestratorHandler(dispatch: DispatchWiring = dispatchWiring) {
  return (req: Request, url: URL) => handleRoute(req, url, dispatch)
}

export const handleOrchestratorRoute = createOrchestratorHandler()

async function handleRoute(req: Request, url: URL, dispatch: DispatchWiring): Promise<Response | null> {
  // ── Orchestrator single-thread: chat + worker dispatch (PRJ-OR1T Phase 1) ──
  // One always-open thread per host. /send records a user message; /dispatch
  // spawns a worker bound to this thread (its turn-end reports back tagged by
  // task, via the session-start + stop hooks above); /thread reads it all.
  if (url.pathname === "/api/orchestrator/channels" && req.method === "GET") {
    return Response.json({ channels: listChannels().map(dispatch.decorate) })
  }
  if (url.pathname === "/api/orchestrator/channels" && req.method === "POST") {
    const { name, cwd } = await req.json() as { name?: string; cwd?: string }
    if (!name?.trim()) return Response.json({ ok: false, error: "name required" }, { status: 400 })
    const channel = createChannel(name.trim(), cwd?.trim() || null)
    emitChannel(channel)
    return Response.json({ ok: true, channel })
  }
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
    return Response.json({
      channel: ch.id, channels: listChannels().map(dispatch.decorate), turns: getThread(ch.id),
      tasks: [...listTasks(ch.id).map(toTaskDto), ...dispatch.tasksFor(ch.id)],
      queue: dispatch.queueSummary(),
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
  if (url.pathname === "/api/orchestrator/dispatch" && req.method === "POST") {
    const { prompt, cwd, channel } = await req.json() as { prompt?: string; cwd?: string; channel?: string }
    if (!prompt?.trim()) return Response.json({ ok: false, error: "prompt required" }, { status: 400 })
    const ch = resolveChannel(channel)
    if (!ch) return Response.json({ ok: false, error: "no such channel" }, { status: 404 })
    // Explicit cwd wins; otherwise fall back to the channel's bound project dir.
    const wd = ((cwd ?? "").trim() || ch.cwd || "")
    if (!wd) return Response.json({ ok: false, error: "cwd required" }, { status: 400 })

    // Manual dispatch goes through the same admission as proposals (Phase 7):
    // the task is recorded queued, then either spawned now (executeDispatch
    // records the tmux session + starts the tail) or left for the drain.
    const task = createQueuedTask(prompt.trim(), wd, ch.id)
    orchEmit(orchAppendTurn("orchestrator", `dispatch [${task.taskId}]: ${prompt.trim()}`, task.taskId, ch.id))
    const admission = await workerQueue.admit(task)
    if (admission.status === "queued") return Response.json({ ok: true, taskId: task.taskId, status: "queued" })
    if (!admission.ok) return Response.json({ ok: false, error: admission.error ?? "spawn failed", taskId: task.taskId }, { status: 500 })
    return Response.json({ ok: true, taskId: task.taskId, status: "dispatched" })
  }

  // Cancel queued/dispatched/running work (Phase 7). Kills the tmux worker if
  // one exists. In an auto channel a cancel is the veto — it flips the channel
  // back to propose-confirm so autonomy only stays on while it's earning it.
  if (url.pathname.startsWith("/api/orchestrator/task/") && req.method === "POST") {
    const [taskId, action] = url.pathname.slice("/api/orchestrator/task/".length).split("/")
    if (action !== "cancel" || !taskId) return Response.json({ ok: false, error: "unknown action" }, { status: 400 })
    const task = getTask(taskId)
    if (!task) return Response.json({ ok: false, error: "no such task" }, { status: 404 })
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
    setTaskStatus(taskId, "cancelled")
    emitTask(taskId)
    orchEmit(orchAppendTurn("orchestrator", `cancelled [${taskId}]`, taskId, task.threadId))
    const ch = getChannel(task.threadId)
    if (ch?.autoDispatch) {
      const updated = setChannelAuto(ch.id, false)
      if (updated) {
        emitChannel(updated)
        orchEmit(orchAppendTurn("orchestrator", `auto-dispatch OFF for #${ch.name} — a cancel resets the ramp; flip it back on when ready`, null, ch.id))
      }
    }
    void workerQueue.drain()
    return Response.json({ ok: true, taskId, status: "cancelled" })
  }

  // Approve or reject a brain proposal (Phase 2). POST .../proposal/<id>/approve
  // spawns the worker; .../<id>/reject drops it. Only a 'proposed' task is valid.
  if (url.pathname.startsWith("/api/orchestrator/proposal/") && req.method === "POST") {
    const [taskId, action] = url.pathname.slice("/api/orchestrator/proposal/".length).split("/")
    if (!taskId) return Response.json({ ok: false, error: "no such proposal" }, { status: 404 })
    const task = getTask(taskId)
    if (!task) return Response.json({ ok: false, error: "no such proposal" }, { status: 404 })
    if (task.status !== "proposed") {
      return Response.json({ ok: false, error: `not proposable (status ${task.status})` }, { status: 409 })
    }
    if (action === "reject") {
      setTaskStatus(taskId, "rejected")
      emitTask(taskId)
      orchEmit(orchAppendTurn("orchestrator", `rejected [${taskId}] — not dispatched`, taskId, task.threadId))
      return Response.json({ ok: true, taskId, status: "rejected" })
    }
    if (action === "approve") {
      const admission = await workerQueue.admit(task)
      if (admission.status === "queued") return Response.json({ ok: true, taskId, status: "queued" })
      if (!admission.ok) return Response.json({ ok: false, error: admission.error, taskId }, { status: 500 })
      return Response.json({ ok: true, taskId, status: "dispatched" })
    }
    return Response.json({ ok: false, error: "unknown action" }, { status: 400 })
  }
  return null
}
