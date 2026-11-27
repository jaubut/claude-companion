import { createHash } from "node:crypto"
import { BRAIN_THREAD, brainFiling } from "../lib/brain"
import {
  enqueueSyncOutbox,
  getSyncOutboxItem,
  handoffSeen,
  listPendingSyncOutbox,
  markSyncOutboxDone,
  markSyncOutboxFailed,
  markSyncOutboxRetry,
  openDeliveries,
  proposeSeen,
  proposeSeenById,
  rememberHandoff,
  rememberPropose,
  removeHandoff,
  removeSyncOutbox,
  updateHandoff,
} from "../lib/brain-store"
import { type TraceRow, rowId, upsertRow } from "../lib/brain-trace"
import { DEFAULT_AGENT, fileHandoff, getNote, newDispatchId, resolveAgent } from "../lib/dispatch-tasks"
import { mintHandoffClaim } from "../lib/handoff-claim"
import { companionLog } from "../lib/log"
import { createProposal, getTask, getTurn, stampDispatchId } from "../lib/orchestrator-chat"
import { TursoUnreachable } from "../lib/turso"
import { emitTrace } from "./brain"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { emitTask, fileProposal, writeCtx } from "./orchestrator"
import { approveProposal, filedStatus } from "./proposals"

// Atomic local Brain propose / handoff (< 20 ms) + durable async `tls-sqld` outbox sync.
// Deduplicates by explicit `taskId` and deterministic request hash `(sourceTurnId, requestHash)`
// in local Companion SQLite, mints the handoff claim locally, and syncs `tasks` + `agent_activity`
// to GCP `tls-sqld` asynchronously with durable retry in `brain_sync_outbox`.

export const DEFAULT_LOCAL_SYNC_BUDGET_MS = 12
const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 30_000
const MAX_SYNC_ATTEMPTS = 12

/** `repo`: a valid bare repo name, lowercased by the route; absent = no claim. */
export interface HandoffInput {
  title: string
  prompt: string
  noteId: string
  reasoning: string
  sourceTurnId: string
  repo?: string
  taskId?: string
  /** Max ms to wait for tls-sqld before returning the local SQLite record and finishing sync in the background. */
  syncBudgetMs?: number
}

export interface ProposeSyncInput {
  title: string
  prompt: string
  noteId: string
  agent: string | null
  reasoning: string
  sourceTurnId: string
  taskId?: string
  syncBudgetMs?: number
}

/**
 * The origin is decided here, never by the caller. `jeremie` only for his own turn that the brain is answering right
 * now: an event, a peer's message or a turn already closed reads `unknown`.
 */
export function handoffOrigin(turnId: string): "jeremie" | "unknown" {
  const turn = getTurn(turnId)
  const open = openDeliveries().some((r) => r.turnId === turnId && r.state === "typed")
  return turn?.role === "user" && turn.threadId === BRAIN_THREAD && open ? "jeremie" : "unknown"
}

export function deterministicHandoffId(p: Pick<HandoffInput, "sourceTurnId" | "noteId" | "prompt" | "repo">): string {
  return createHash("sha256")
    .update(`handoff\n${p.sourceTurnId}\n${p.noteId}\n${p.prompt}${p.repo ? `\n${p.repo}` : ""}`)
    .digest("hex")
    .slice(0, 32)
}

export function deterministicProposeHash(p: Pick<ProposeSyncInput, "prompt" | "taskId">): string {
  return createHash("sha256")
    .update(p.taskId ? `task:${p.taskId}` : p.prompt)
    .digest("hex")
    .slice(0, 32)
}

type HandoffSyncOutcome =
  | { kind: "synced"; taskId: string; origin: "jeremie" | "unknown"; claim: string | null; inserted: boolean; noteTitle: string }
  | { kind: "no_such_note" }
  | { kind: "retry"; error: string }

let retryTimer: ReturnType<typeof setTimeout> | null = null
const activeFlushes = new Map<string, Promise<unknown>>()

function scheduleOutboxRetry(dispatch: DispatchWiring, delayMs = RETRY_BASE_MS): void {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushBrainSyncOutbox(dispatch)
  }, delayMs)
  retryTimer.unref?.()
}

async function syncHandoffToTurso(
  outboxId: string,
  payload: {
    taskId: string
    sourceTurnId: string
    noteId: string
    title: string
    prompt: string
    reasoning: string
    repo: string | null
    origin: "jeremie" | "unknown"
    claim: string | null
  },
  dispatch: DispatchWiring,
): Promise<HandoffSyncOutcome> {
  try {
    const note = await getNote(dispatch.query, payload.noteId)
    if (!note) {
      markSyncOutboxFailed(outboxId, "no_such_note")
      return { kind: "no_such_note" }
    }
    const description = `${payload.prompt}\n\n— Handed off from Companion #Brain${payload.reasoning ? `\nWhy: ${payload.reasoning}` : ""}`
    const ctx = await writeCtx(dispatch, BRAIN_THREAD)
    const minted = payload.origin === "jeremie" && payload.repo && ctx.cols.origin
      ? (payload.claim ?? mintHandoffClaim(payload.taskId, payload.repo, payload.sourceTurnId))
      : null
    const { inserted } = await fileHandoff(ctx, {
      id: payload.taskId,
      noteId: note.noteId,
      title: payload.title,
      description,
      origin: payload.origin,
      ...(minted && payload.repo ? { claim: { repo: payload.repo, turnId: payload.sourceTurnId, kid: minted.split(".")[1]! } } : {}),
    })
    const filed: "jeremie" | "unknown" = !ctx.cols.origin
      ? "unknown"
      : inserted
      ? payload.origin
      : (String((await dispatch.query("SELECT origin FROM tasks WHERE id = ?", [payload.taskId]))[0]?.origin ?? "unknown") === "jeremie" ? "jeremie" : "unknown")
    const claim = filed === "jeremie" && payload.repo ? (minted ?? mintHandoffClaim(payload.taskId, payload.repo, payload.sourceTurnId)) : null
    updateHandoff(payload.taskId, { origin: filed, claim, synced: true, noteId: note.noteId })
    markSyncOutboxDone(outboxId)
    return {
      kind: "synced",
      taskId: payload.taskId,
      origin: filed,
      claim,
      inserted,
      noteTitle: note.title ?? note.ref ?? note.noteId,
    }
  } catch (err) {
    const msg = err instanceof TursoUnreachable ? err.message : ((err as Error)?.message ?? "turso_unreachable")
    const item = getSyncOutboxItem(outboxId)
    const attempts = (item?.attempts ?? 0) + 1
    if (attempts >= MAX_SYNC_ATTEMPTS) {
      markSyncOutboxFailed(outboxId, msg)
    } else {
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6))
      markSyncOutboxRetry(outboxId, msg, delay)
    }
    return { kind: "retry", error: msg }
  }
}

async function syncProposeToTurso(
  outboxId: string,
  proposalId: string,
  dispatch: DispatchWiring,
): Promise<{ ok: true; dispatchTaskId: string; status: string; replay: boolean } | { ok: false; status: number; error: string }> {
  const task = getTask(proposalId)
  if (!task) {
    markSyncOutboxFailed(outboxId, "no_such_proposal")
    return { ok: false, status: 404, error: "no such proposal" }
  }
  if (task.status === "filed" && task.dispatchTaskId) {
    markSyncOutboxDone(outboxId)
    return { ok: true, dispatchTaskId: task.dispatchTaskId, status: "queued", replay: true }
  }
  const out = await fileProposal(task.taskId, { byHand: true }, dispatch)
  if (out.ok) {
    markSyncOutboxDone(outboxId)
    const st = filedStatus(out.dispatchTaskId, out.queued)
    return { ok: true, dispatchTaskId: out.dispatchTaskId, status: st.status, replay: out.replay }
  }
  if (out.status === 404 || out.status === 400 || out.status === 422 || out.status === 409) {
    markSyncOutboxFailed(outboxId, out.error)
    return { ok: false, status: out.status, error: out.error }
  }
  const item = getSyncOutboxItem(outboxId)
  const attempts = (item?.attempts ?? 0) + 1
  if (attempts >= MAX_SYNC_ATTEMPTS) {
    markSyncOutboxFailed(outboxId, out.error)
  } else {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6))
    markSyncOutboxRetry(outboxId, out.error, delay)
  }
  return { ok: false, status: out.status, error: out.error }
}

/** Drain pending `brain_sync_outbox` items against `tls-sqld`. Returns count of newly synced items. */
export async function flushBrainSyncOutbox(dispatch: DispatchWiring = dispatchWiring, now = Date.now()): Promise<number> {
  const pending = listPendingSyncOutbox(now)
  let synced = 0
  let needsRetry = false
  for (const item of pending) {
    if (activeFlushes.has(item.id)) continue
    if (item.kind === "handoff") {
      const p = item.payload as Parameters<typeof syncHandoffToTurso>[1]
      const job = syncHandoffToTurso(item.id, p, dispatch)
      activeFlushes.set(item.id, job)
      const res = await job.finally(() => activeFlushes.delete(item.id))
      if (res.kind === "synced") synced++
      else if (res.kind === "retry") needsRetry = true
    } else if (item.kind === "propose") {
      const proposalId = String(item.payload.proposalId ?? item.taskId)
      const job = syncProposeToTurso(item.id, proposalId, dispatch)
      activeFlushes.set(item.id, job)
      const res = await job.finally(() => activeFlushes.delete(item.id))
      if (res.ok) synced++
      else if (res.status >= 500) needsRetry = true
    }
  }
  if (needsRetry) scheduleOutboxRetry(dispatch)
  return synced
}

export async function addBrainHandoff(
  p: HandoffInput,
  dispatch: DispatchWiring = dispatchWiring,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const requestHash = deterministicHandoffId(p)
  const id = typeof p.taskId === "string" && p.taskId.trim() ? p.taskId.trim() : requestHash
  const outboxId = `handoff:${id}`

  // Fast local idempotency check by taskId or (sourceTurnId, requestHash) (< 1 ms, 0 remote queries).
  const seen = handoffSeen(id, p.sourceTurnId, requestHash)
  if (seen) {
    if (!seen.synced) {
      // If a prior call queued background sync or failed transiently, nudge the outbox flush.
      const pending = activeFlushes.get(outboxId)
      const budgetMs = p.syncBudgetMs ?? DEFAULT_LOCAL_SYNC_BUDGET_MS
      if (pending && budgetMs > 0) {
        await Promise.race([pending, Bun.sleep(budgetMs)])
      } else {
        void flushBrainSyncOutbox(dispatch)
      }
      const refreshed = handoffSeen(seen.taskId) ?? seen
      return {
        status: 200,
        body: {
          ok: true,
          taskId: refreshed.taskId,
          origin: refreshed.origin,
          replay: true,
          ...(refreshed.claim ? { claim: refreshed.claim } : {}),
        },
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        taskId: seen.taskId,
        origin: seen.origin,
        replay: true,
        ...(seen.claim ? { claim: seen.claim } : {}),
      },
    }
  }

  const origin = handoffOrigin(p.sourceTurnId)
  const optimisticClaim = origin === "jeremie" && p.repo ? mintHandoffClaim(id, p.repo, p.sourceTurnId) : null
  const now = Date.now()
  const payload = {
    taskId: id,
    sourceTurnId: p.sourceTurnId,
    noteId: p.noteId,
    title: p.title,
    prompt: p.prompt,
    reasoning: p.reasoning,
    repo: p.repo ?? null,
    origin,
    claim: optimisticClaim,
  }

  rememberHandoff({
    taskId: id,
    sourceTurnId: p.sourceTurnId,
    requestHash,
    noteId: p.noteId,
    title: p.title,
    prompt: p.prompt,
    reasoning: p.reasoning,
    repo: p.repo ?? null,
    origin,
    claim: optimisticClaim,
    synced: false,
    at: now,
  })
  enqueueSyncOutbox({ id: outboxId, kind: "handoff", taskId: id, payload }, now)

  const syncJob = syncHandoffToTurso(outboxId, payload, dispatch)
  activeFlushes.set(outboxId, syncJob)
  void syncJob.finally(() => activeFlushes.delete(outboxId))

  const budgetMs = p.syncBudgetMs ?? DEFAULT_LOCAL_SYNC_BUDGET_MS
  const raced = budgetMs <= 0
    ? ({ kind: "timeout" } as const)
    : await Promise.race([
        syncJob,
        Bun.sleep(budgetMs).then(() => ({ kind: "timeout" } as const)),
      ])

  if (raced.kind === "no_such_note") {
    removeHandoff(id)
    removeSyncOutbox(outboxId)
    return { status: 404, body: { ok: false, error: "no such note" } }
  }

  if (raced.kind === "synced") {
    const row = upsertRow({
      id: `handoff:${id}`,
      parentId: rowId.turn(p.sourceTurnId),
      turnId: p.sourceTurnId,
      kind: "agent",
      status: "done",
      title: `Handed off: ${p.title}`,
      detail: raced.noteTitle,
      ref: { taskId: id },
    })
    if (row) emitTrace([row])
    return {
      status: 200,
      body: {
        ok: true,
        taskId: id,
        origin: raced.origin,
        replay: !raced.inserted,
        ...(raced.claim ? { claim: raced.claim } : {}),
      },
    }
  }

  if (raced.kind === "retry") {
    companionLog(`[brain] handoff ${id.slice(0, 8)} queued in local outbox for background tls-sqld retry (${raced.error})`)
    scheduleOutboxRetry(dispatch)
  }

  // Fast local return (< 20 ms): background outbox sync continues asynchronously.
  const row = upsertRow({
    id: `handoff:${id}`,
    parentId: rowId.turn(p.sourceTurnId),
    turnId: p.sourceTurnId,
    kind: "agent",
    status: "done",
    title: `Handed off: ${p.title}`,
    detail: p.noteId,
    ref: { taskId: id },
  })
  if (row) emitTrace([row])
  return {
    status: 200,
    body: {
      ok: true,
      taskId: id,
      origin,
      replay: false,
      ...(optimisticClaim ? { claim: optimisticClaim } : {}),
      sync: "pending",
    },
  }
}

export async function proposeBrainTask(
  p: ProposeSyncInput,
  deps: {
    dispatch: DispatchWiring
    trace: (rows: Array<TraceRow | null>) => void
    log: (msg: string) => void
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const agent = resolveAgent(p.agent ?? DEFAULT_AGENT)
  if (!agent) return { status: 400, body: { ok: false, error: "unknown_agent" } }

  // Dedupe locally first (< 1 ms, 0 remote queries).
  const hash = deterministicProposeHash(p)
  const seen = (p.taskId ? proposeSeenById(p.taskId) : null) ?? proposeSeen(p.sourceTurnId, hash)
  if (seen) return { status: 200, body: { ok: true, proposalId: seen, taskId: seen, replay: true } }

  const budgetMs = p.syncBudgetMs ?? DEFAULT_LOCAL_SYNC_BUDGET_MS
  const noteProbe = getNote(deps.dispatch.query, p.noteId)
    .then((n) => ({ kind: "ok" as const, note: n }))
    .catch((err) => ({ kind: "err" as const, error: (err as Error)?.message ?? "turso_unreachable" }))

  const noteRace = budgetMs <= 0
    ? ({ kind: "timeout" } as const)
    : await Promise.race([
        noteProbe,
        Bun.sleep(budgetMs).then(() => ({ kind: "timeout" } as const)),
      ])

  if (noteRace.kind === "ok" && !noteRace.note) {
    return { status: 404, body: { ok: false, error: "no such note" } }
  }

  // Re-check dedupe after the bounded note probe so concurrent identical calls never double-create.
  const seenAfter = (p.taskId ? proposeSeenById(p.taskId) : null) ?? proposeSeen(p.sourceTurnId, hash)
  if (seenAfter) return { status: 200, body: { ok: true, proposalId: seenAfter, taskId: seenAfter, replay: true } }

  const note = noteRace.kind === "ok" && noteRace.note
    ? noteRace.note
    : { noteId: p.noteId, title: p.noteId, ref: null }

  const task = createProposal(p.prompt, "", p.reasoning, BRAIN_THREAD, { noteId: note.noteId, agent, title: p.title })
  brainFiling.add(task.taskId)
  rememberPropose(p.sourceTurnId, hash, task.taskId)
  const dispatchTaskId = stampDispatchId(task.taskId, newDispatchId()) ?? newDispatchId()
  const outboxId = `propose:${task.taskId}`
  enqueueSyncOutbox({
    id: outboxId,
    kind: "propose",
    taskId: task.taskId,
    payload: {
      proposalId: task.taskId,
      dispatchTaskId,
      sourceTurnId: p.sourceTurnId,
      noteId: note.noteId,
      agent,
      title: p.title,
      prompt: p.prompt,
      reasoning: p.reasoning,
    },
  })

  const project = note.ref ?? note.title ?? note.noteId
  const repoId = rowId.repo(p.sourceTurnId, project)
  deps.trace([
    upsertRow({ id: repoId, parentId: rowId.turn(p.sourceTurnId), turnId: p.sourceTurnId, kind: "repo", status: "running", title: note.title ?? project, detail: project }),
    upsertRow({ id: rowId.agent(task.taskId), parentId: repoId, turnId: p.sourceTurnId, kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: "waits for your tap" }),
  ])
  emitTask(task.taskId)

  const fileJob = (async () => {
    try {
      const res = await approveProposal(task, {}, deps.dispatch)
      const body = await res.json() as Record<string, unknown>
      if (res.ok) {
        markSyncOutboxDone(outboxId)
      } else {
        markSyncOutboxRetry(outboxId, String(body.error ?? "turso_unreachable"), RETRY_BASE_MS)
        scheduleOutboxRetry(deps.dispatch)
      }
      return { ok: res.ok, status: res.status, body }
    } finally {
      brainFiling.delete(task.taskId)
    }
  })()
  activeFlushes.set(outboxId, fileJob)
  void fileJob.finally(() => activeFlushes.delete(outboxId))

  const raced = budgetMs <= 0
    ? ({ kind: "timeout" } as const)
    : await Promise.race([
        fileJob.then((r) => ({ kind: "settled" as const, ...r })),
        Bun.sleep(budgetMs).then(() => ({ kind: "timeout" as const })),
      ])

  if (raced.kind === "settled") {
    if (raced.ok) {
      deps.trace([upsertRow({ id: rowId.agent(task.taskId), kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: raced.body.status === "queued" ? "dispatched" : "waits for the dashboard stamp", ref: { taskId: String(raced.body.dispatchTaskId ?? "") } })])
      return { status: 200, body: { ...raced.body, proposalId: task.taskId } }
    }
    deps.log(`[brain] auto-file failed (${String(raced.body.error)}): left as a proposal (queued in sync outbox)`)
    deps.trace([upsertRow({ id: rowId.agent(task.taskId), kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: "couldn't dispatch — tap to file it" })])
    return { status: 200, body: { ok: true, proposalId: task.taskId, status: "proposed", error: raced.body.error ?? null } }
  }

  // Remote tls-sqld took > budgetMs: return locally in < 20 ms while fileJob + sync outbox finishes in background.
  deps.trace([upsertRow({ id: rowId.agent(task.taskId), kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: "dispatched", ref: { taskId: dispatchTaskId } })])
  return {
    status: 200,
    body: {
      ok: true,
      taskId: task.taskId,
      proposalId: task.taskId,
      dispatchTaskId,
      status: "queued",
      replay: false,
      sync: "pending",
    },
  }
}
