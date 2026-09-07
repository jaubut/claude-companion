import {
  WIP_CAP,
  emitChannel,
  emitTask,
  executeDispatch,
  orchEmit,
  runBrain,
  workerQueue,
} from "../wiring/orchestrator"
import {
  type Channel as OrchChannel,
  GENERAL_CHANNEL,
  appendTurn as orchAppendTurn,
  countLiveTasks,
  createChannel,
  createQueuedTask,
  getChannel,
  getTask,
  getThread,
  listChannels,
  listQueued,
  listTasks,
  setChannelAuto,
  setTaskStatus,
} from "../lib/orchestrator-chat"

// Orchestrator routes (PRJ-OR1T): channels, thread, send, dispatch, proposal
// approve/reject, task cancel, auto-dispatch toggle. Same paths, methods and
// responses as before the split. Returns null for any other path.

// Resolve a channel id from a request (query param or body field), defaulting to
// General. Returns null only when a non-empty id names a channel that doesn't
// exist — callers reject that as a 404.
function resolveChannel(id: string | null | undefined): OrchChannel | null {
  const wanted = id?.trim() || GENERAL_CHANNEL
  return getChannel(wanted)
}

export async function handleOrchestratorRoute(req: Request, url: URL): Promise<Response | null> {
  // ── Orchestrator single-thread: chat + worker dispatch (PRJ-OR1T Phase 1) ──
  // One always-open thread per host. /send records a user message; /dispatch
  // spawns a worker bound to this thread (its turn-end reports back tagged by
  // task, via the session-start + stop hooks above); /thread reads it all.
  if (url.pathname === "/api/orchestrator/channels" && req.method === "GET") {
    return Response.json({ channels: listChannels() })
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
    if (action !== "auto" || !id) return Response.json({ ok: false, error: "unknown action" }, { status: 400 })
    const { enabled } = await req.json() as { enabled?: unknown }
    if (typeof enabled !== "boolean") return Response.json({ ok: false, error: "enabled must be boolean" }, { status: 400 })
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
    return Response.json({
      channel: ch.id, channels: listChannels(), turns: getThread(ch.id), tasks: listTasks(ch.id),
      queue: { cap: WIP_CAP, live: countLiveTasks(), queued: listQueued().length },
    })
  }
  if (url.pathname === "/api/orchestrator/send" && req.method === "POST") {
    const { text, channel } = await req.json() as { text?: string; channel?: string }
    if (!text?.trim()) return Response.json({ ok: false, error: "empty" }, { status: 400 })
    const ch = resolveChannel(channel)
    if (!ch) return Response.json({ ok: false, error: "no such channel" }, { status: 404 })
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
        await Bun.spawn(["tmux", "kill-session", "-t", task.tmuxSession], { stdout: "ignore", stderr: "ignore" }).exited
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
