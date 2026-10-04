import { BODY_CHANNEL, BODY_CHANNEL_NAME } from "../lib/body"
import { type BodyFixStore, type FixRequest, fixRequestFor, fixRunsElsewhere, localizeCwd, postFix } from "../lib/body-fix"
import { type BodyHost, localBodyHost } from "../lib/body-investigate"
import { type PeerConfig, bodyPeer } from "../lib/body-investigate-engine"
import { companionLog } from "../lib/log"
import { type Task, appendTurn, createProposal, getTask, markFiled, stampDispatchId } from "../lib/orchestrator-chat"
import { ensureChannel } from "../lib/orchestrator-channels"
import { broadcast } from "../state"
import { HOP_HEADER, bodyFixStore } from "./body-investigate"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { type LiveStart, approveLive } from "./live"
import { emitTask, orchEmit } from "./orchestrator"

// Body fixes for MAC components run LIVE ON THE MAC (lib/body-fix.ts).
//   Zettlab: approving a mac card (headless or live) forwards it to the Mac's
//            POST /api/body/fix; on success the card is stamped with the Mac's
//            Turso id and leaves as `filed` (the poller shows the Mac's live row).
//            Mac unreachable → 503 host_unreachable, the card stays proposed.
//   Mac:     /api/body/fix creates (once per fix id) a local #Body proposal row
//            and runs approveLive with the fix's own cwd — never the note's repo.
// Contract: docs/body-api.md.

export interface BodyFixDeps {
  store: BodyFixStore
  localHost: () => BodyHost
  peer: () => PeerConfig | null
  fetchFn: typeof fetch
  now: () => number
}

let deps: BodyFixDeps = {
  store: bodyFixStore,
  localHost: () => localBodyHost(),
  peer: () => bodyPeer(),
  fetchFn: fetch,
  now: Date.now,
}

/** Test seam: override some deps; returns the previous set. */
export function setBodyFixDeps(patch: Partial<BodyFixDeps>): BodyFixDeps {
  const prev = deps
  deps = { ...deps, ...patch }
  return prev
}

function liveJson(out: LiveStart, host: string): Response {
  if (!out.ok) return Response.json({ ok: false, error: out.error, host, ...out.extra }, { status: out.status })
  return Response.json({ ...out, host })
}

/**
 * Approve hook (routes/orchestrator.ts): null = not a Mac body fix, the normal
 * approve path applies. Same response for `mode` headless or live.
 */
export async function approveBodyFix(task: Task, dispatch: DispatchWiring = dispatchWiring): Promise<Response | null> {
  const card = deps.store.card(task.taskId)
  if (!card || card.host !== "mac") return null
  // The card lives on the Mac itself (reported locally): run it live here, in its cwd.
  if (!fixRunsElsewhere(card, deps.localHost())) {
    return liveJson(await approveLive(task.taskId, { cwd: localizeCwd(card.cwd), noteId: card.noteId, agent: card.agent }, dispatch), card.host)
  }
  const base = { taskId: task.taskId, host: card.host }
  if (task.status === "filed" && task.dispatchTaskId) {
    return Response.json({ ok: true, ...base, dispatchTaskId: task.dispatchTaskId, status: "running", mode: "live", replay: true })
  }
  if (task.status !== "proposed") return Response.json({ ok: false, error: `not proposable (status ${task.status})`, ...base }, { status: 409 })
  const peer = deps.peer()
  if (!peer) return Response.json({ ok: false, error: "host_unreachable", reason: "no peer configured (COMPANION_BODY_PEER)", ...base }, { status: 503 })
  const out = await postFix(peer, fixRequestFor(card, task.prompt), HOP_HEADER, deps.fetchFn)
  if (out.kind === "unreachable") {
    companionLog(`[body-fix] ${task.taskId} → mac unreachable (${out.reason})`)
    return Response.json({ ok: false, error: "host_unreachable", reason: out.reason, ...base }, { status: 503 })
  }
  if (out.kind === "refused") {
    // The Mac's own refusal (live cap, no_cwd, turso…) passes through; its 401/403 is ours to explain, not the phone's auth.
    const status = out.status === 401 || out.status === 403 ? 502 : out.status
    const error = typeof out.json?.error === "string" ? out.json.error : out.status === 401 || out.status === 403 ? "host_refused" : "host_error"
    return Response.json({ ok: false, error, ...base }, { status })
  }
  const id = String(out.json.dispatchTaskId)
  const stamped = stampDispatchId(task.taskId, id)
  if (stamped) markFiled(task.taskId, { noteId: card.noteId, agent: card.agent })
  emitTask(task.taskId)
  orchEmit(appendTurn("orchestrator", `approved [${task.taskId}] → running live on the mac as ${id.slice(0, 8)} in ${card.cwd}`, task.taskId, task.threadId))
  void dispatch.poll()
  const now = getTask(task.taskId)
  return Response.json({
    ok: true, ...base, dispatchTaskId: now?.dispatchTaskId ?? id, status: typeof out.json.status === "string" ? out.json.status : "running",
    mode: "live", replay: out.json.replay === true,
  })
}

/** POST /api/body/fix on the owning host: one local proposal row per fix id, run live in the fix's cwd. */
export async function runBodyFix(req: FixRequest, dispatch: DispatchWiring = dispatchWiring, local: BodyHost = deps.localHost()): Promise<Response> {
  // Never forwarded again: a fix for a component this host does not own is refused.
  if (local !== req.host || !req.componentId.startsWith(`${req.host}:`)) {
    return Response.json({ ok: false, error: "not_owner", host: local }, { status: 409 })
  }
  let taskId = deps.store.run(req.fixId)
  if (!taskId) {
    const { channel, created } = ensureChannel(BODY_CHANNEL, BODY_CHANNEL_NAME)
    if (created) broadcast({ type: "orchestrator_channel", channel })
    // create + record with no await in between: a replayed forward finds this row.
    const t = createProposal(req.prompt, localizeCwd(req.cwd), `Body fix approved on Zettlab (card ${req.fixId}, investigation ${req.investigationId || "?"})`, BODY_CHANNEL, {
      noteId: req.noteId, agent: req.agent, title: req.title,
    })
    deps.store.recordRun(req.fixId, t.taskId, deps.now())
    taskId = t.taskId
  }
  return liveJson(await approveLive(taskId, { cwd: localizeCwd(req.cwd), noteId: req.noteId, agent: req.agent }, dispatch), req.host)
}
