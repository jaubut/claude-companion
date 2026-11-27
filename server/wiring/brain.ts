import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { companionLog } from "../lib/log"
import { HOST_INFO, broadcast } from "../state"
import {
  BRAIN_AGENT, BRAIN_THREAD, brainFiling, type BrainActivity, type BrainState, type DeliveryTurn,
  BUSY_MAX_MS, MEMORY_TAG, QUIET_REPLY, TURN_END_GRACE_MS, bootSeed, brainText, compactText, deliveryText, fitQueued, flushPrompt, idleCompactDue, middayRolloverDue, rolloverDue, rolloverPrompt, superviseStep, TICK_MS,
} from "../lib/brain"
import { classifyBrainEvent } from "../lib/brain-event-triage"
import { type ActiveBrainTurnState, type BrainTurnTrigger, canPreemptBrainTurn, isMutatingBrainToolCall } from "../lib/brain-preempt"
import { type BrainStreamFrame, BrainTurnAccumulator, buildBrainClearFrame, buildBrainDeltaFrame, buildBrainDoneFrame } from "../lib/brain-stream"
import { type OpsTriageDecision, type OpsTriageEvent, triageOpsEvents } from "../lib/ops-triage"
import { clearTyped, dismissDeliveries, enqueueDelivery, getKv, markDelivered, markMaybe, requeueDeliveries, requeueTyped, openDeliveries, setKv, takeDeliveries } from "../lib/brain-store"
import { type TraceRow, rowId, upsertRow } from "../lib/brain-trace"
import { createBrainActivity } from "./brain-activity"
import { type Turn, appendTurn, getTask, getTurn, onTurnAppended, setTurnCard } from "../lib/orchestrator-chat"
import { ensureChannel } from "../lib/orchestrator-channels"
import { type Session, getSessionByKey, listSessions, recordSession } from "../lib/sessions"
import type { SpawnResult } from "../lib/spawn-session"
import { pushToAll } from "../lib/push"
import { type ApnsPayload, apnsConfigured } from "../lib/apns"
import { gauge } from "./gauge"
import { emitChannel, orchEmit } from "./orchestrator"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { proposeBrainTask } from "./brain-handoff"
import { BRAIN_DIR, type BrainDeltaEvent, HEADLESS_BRAIN_PANE, createHeadlessBrainRunner, getBrainModel } from "./brain-headless"

export { BRAIN_DIR, HEADLESS_BRAIN_PANE, getBrainModel }

// brain-v2 (RES-QDHU) runtime: supervises the one `brain` agent, relays Jeremie's brain-thread
// turns into it, records its replies and keeps the trace (sqlite is the store, not the transcript).

export interface BrainStatus { state: BrainState; sessionKey: string | null; since: number; restarts: number; host: string; activity: BrainActivity | null }
export interface ProposeInput {
  title: string; prompt: string; noteId: string; agent: string | null; reasoning: string; sourceTurnId: string; taskId?: string; syncBudgetMs?: number
}

export interface BrainDeps {
  now(): number
  alive(): Promise<boolean>
  agentPane(): Promise<string>
  spawn(resume: string | null): Promise<SpawnResult>
  stopAgent(): Promise<void>
  sessions(): Session[]
  sessionByKey(key: string): Session | null
  tagBrain(key: string): boolean
  deliver(text: string, key: string): Promise<Response>
  agentStatus(key: string): Promise<string>
  lastReply(s: Session): Promise<string>
  interrupt(key: string): Promise<void>
  broadcast(frame: Record<string, unknown>): void
  push(payload: ApnsPayload): void
  paused: { read(): boolean; write(on: boolean): void }
  contextPct(key: string): number | null
  compact(key: string, text: string): Promise<boolean>
  dispatch: DispatchWiring
  host: string
  log(msg: string): void
  eventCoalesceMs?: number
  middayRollover?: boolean
  triageEvents?: (events: OpsTriageEvent[]) => Promise<OpsTriageDecision>
}

export function emitTrace(rows: TraceRow[]): void {
  if (rows.length) broadcast({ type: "brain_trace", op: "row", rows })
}

/** The resolver leaves a proposal alone once it is handed off: the brain is filing it, or it is no longer `proposed`. */
export const proposalHandedOff = (taskId: string): boolean => brainFiling.has(taskId) || getTask(taskId)?.status !== "proposed"

export function createBrainWiring(deps: BrainDeps) {
  let state: BrainState = "starting"
  let since = deps.now()
  let restarts: number[] = []
  let spawnedAt = 0, busySince = 0, lastHookAt = 0, lastActivity = deps.now(), compactedAt = 0, turnsSinceReset = 0
  let pane = "", lastReplyText = ""
  let sessionKey: string | null = null, sessionId: string | null = null
  let busy = false, pendingSeed = false, compacting = false
  let control: "flush" | "rollover" | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null
  const coalesceMs = deps.eventCoalesceMs ?? 0
  let selfWrite = 0, ticking = false, triaging = false, triageGen = 0, turnGen = 0
  let activeTurn: ActiveBrainTurnState | null = null
  let activeDraft: { draftTurnId: string; acc: BrainTurnAccumulator } | null = null

  const clearCoalesce = (): void => { if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null } }
  const trace = (rows: Array<TraceRow | null>, out = rows.filter((r): r is TraceRow => !!r)): void => {
    if (out.length) deps.broadcast({ type: "brain_trace", op: "row", rows: out })
  }
  const activity = createBrainActivity({ now: deps.now, changed: () => deps.broadcast({ type: "brain", ...status() }), trace })
  const status = (): BrainStatus => ({ state, sessionKey, since, restarts: restarts.length, host: deps.host, activity: activity.get() })

  function setState(next: BrainState): void {
    if (next === state) return
    const was = state; state = next; since = deps.now()
    deps.log(`[brain] ${was} → ${next}`)
    deps.broadcast({ type: "brain", ...status() })
    if (next === "down") {
      deps.push({ title: "Brain is down", body: `${restarts.length} restarts in 5 min — Settings ▸ Brain to restart.`, category: "body_alert", collapseId: "brain-down", userInfo: { kind: "brain" } })
    }
  }

  const syncActivity = (): void => activity.sync({ busy, compacting, flushing: control === "flush" })
  const setBusy = (on: boolean): void => { busy = on; busySince = on ? deps.now() : 0; syncActivity() }
  const forgetSession = (): void => { sessionKey = sessionId = null; activeTurn = null; activeDraft = null; setBusy(false) }

  function target(): Session | null {
    if (!sessionKey || !sessionId) return null
    const s = deps.sessionByKey(sessionKey)
    return s && s.taskId === BRAIN_AGENT && s.sessionId === sessionId ? s : null
  }

  function adopt(s: Session): boolean {
    if (s.taskId !== BRAIN_AGENT || !s.sessionId || !pane || !s.herdrPane || s.herdrPane !== pane) return false
    if (s.key === sessionKey && s.sessionId === sessionId) return true
    if (target()) return false
    sessionKey = s.key; sessionId = s.sessionId; setBusy(false); compacting = false
    setKv("session_id", s.sessionId)
    deps.log(`[brain] adopted ${s.key} sid=${s.sessionId.slice(0, 8)} pane=${pane}`)
    return true
  }

  const turnsOf = (ids: string[]): DeliveryTurn[] =>
    ids.map((id) => getTurn(id)).filter((t): t is Turn => !!t).map((t) => ({ id: t.id, text: t.text, createdAt: t.createdAt, card: t.card ?? null, role: t.role }))
  const userIds = (ids: string[]): string[] => ids.filter((id) => getTurn(id)?.role === "user")

  function say(text: string, taskId: string | null = null, draftTurnId: string | null = null): Turn {
    selfWrite++
    try {
      const turn = appendTurn("orchestrator", text, taskId, BRAIN_THREAD, undefined, draftTurnId ?? undefined)
      orchEmit(turn, draftTurnId ? { draftTurnId } : undefined)
      return turn
    } finally {
      selfWrite--
    }
  }

  function noteSideEffect(reason: string): boolean {
    if (activeTurn?.preempted) return false
    if (activeTurn) { activeTurn.sideEffectFired = true; activeTurn.sideEffectReason ??= reason }
    return true
  }

  function requeueActiveEvents(seedIds: string[]): string[] {
    const typedIds = requeueTyped(deps.now())
    const evIds = [...new Set([...seedIds, ...typedIds])].filter((id) => getTurn(id)?.role !== "user")
    if (evIds.length > 0) requeueDeliveries(evIds, deps.now())
    return evIds
  }

  function wake(turn: Turn): void {
    if (turn.threadId !== BRAIN_THREAD || turn.role !== "orchestrator" || selfWrite > 0) return
    const disposition = classifyBrainEvent(turn)
    if (disposition === "silent") return
    try {
      enqueueDelivery(turn.id, turn.createdAt)
      if (disposition === "batch" && coalesceMs > 0) {
        if (!coalesceTimer) {
          coalesceTimer = setTimeout(() => { coalesceTimer = null; void flush() }, coalesceMs)
          coalesceTimer.unref?.()
        }
        return
      }
      clearCoalesce()
      void flush()
    } catch (err) {
      deps.log(`[brain] wake failed: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  async function type(text: string): Promise<"ok" | "maybe" | "refused"> {
    const s = target()
    if (!s) return "refused"
    let res: Response
    try { res = await deps.deliver(text, s.key) } catch { return "refused" }
    const body = await res.json().catch(() => ({})) as { ok?: unknown; error?: unknown }
    if (res.ok && body.ok === true) return "ok"
    if (body.error === "not_submitted") return "maybe"
    deps.log(`[brain] delivery refused: ${typeof body.error === "string" ? body.error : res.status}`)
    return "refused"
  }

  async function memoryRef(): Promise<string | null> {
    const known = getKv("memory_ref")
    if (known) return known
    try {
      const rows = await deps.dispatch.query("SELECT ref_code FROM notes WHERE folder = 'resources' AND tags LIKE ? ORDER BY updated_at DESC LIMIT 1", [`%"${MEMORY_TAG}"%`])
      const ref = rows[0]?.ref_code
      if (typeof ref === "string" && ref) { setKv("memory_ref", ref); return ref }
    } catch { /* Notes DB unreachable: the brain looks it up itself */ }
    return null
  }

  function fitPrioritized(queued: string[], found: DeliveryTurn[]): { turns: DeliveryTurn[]; ids: string[] } {
    const fitted = fitQueued(queued, found)
    if (!found.some((t) => t.role === "user") || fitted.turns.some((t) => t.role === "user")) return fitted
    return fitQueued(queued, [...found.filter((t) => t.role === "user"), ...found.filter((t) => t.role !== "user")])
  }

  /** Deliver what is queued (with the boot seed first after a spawn). One typed prompt per brain turn. */
  async function flush(): Promise<void> {
    // A lost post-compact SessionStart must not hold delivery forever.
    if (compacting && deps.now() - compactedAt > BUSY_MAX_MS) compacting = false
    if (deps.paused.read() || busy || compacting || state !== "up" || !target()) return
    const seed = pendingSeed
    let queued = seed ? openDeliveries().map((r) => r.turnId) : takeDeliveries()
    if (!seed && queued.length === 0) return
    let found = turnsOf(queued)
    const hasUserTurn = found.some((t) => t.role === "user")
    if (triaging) {
      if (!hasUserTurn) return
      // A real user turn arrived while pure-event triage was running: preempt triage so Jeremie never waits behind it.
      triageGen++; triaging = false
    }
    let { turns, ids } = seed ? fitQueued(queued, found) : fitPrioritized(queued, found)
    if (!seed && !hasUserTurn && deps.triageEvents && turns.length > 0 && turns.every((t) => t.role === "orchestrator" && classifyBrainEvent({ threadId: BRAIN_THREAD, role: "orchestrator", text: t.text, card: t.card ?? null }) === "batch")) {
      const myGen = ++triageGen; triaging = true
      let ignored = false
      try {
        const d = await deps.triageEvents(turns.map((t) => ({ id: t.id, text: brainText(t), cardKind: t.card?.kind ?? null })))
        if (myGen !== triageGen) return
        if (d.provider !== "none") deps.log(`[brain] ops-triage (${d.mode}) ${d.verdict}→${d.action} [${d.provider}/${d.model} ${d.latencyMs}ms]: ${d.reason}${d.error ? ` (${d.error})` : ""}`)
        if (d.action === "ignore") { dismissDeliveries(ids); ignored = true }
      } catch (err) {
        if (myGen !== triageGen) return
        deps.log(`[brain] ops-triage failed (escalating): ${(err as Error)?.message ?? String(err)}`)
      } finally {
        if (myGen === triageGen) triaging = false
      }
      if (ignored) { if (takeDeliveries().length > 0) void flush(); return }
      queued = takeDeliveries()
      if (queued.length === 0) return
      found = turnsOf(queued)
      ;({ turns, ids } = fitPrioritized(queued, found))
    }
    const text = seed ? bootSeed({ memoryRef: await memoryRef(), open: turns }) : deliveryText(turns)
    if (busy || !target()) return
    const trigger: BrainTurnTrigger = seed ? "boot" : turns.some((t) => t.role === "user") ? "user" : "event"
    const turnState: ActiveBrainTurnState = {
      gen: ++turnGen, trigger, turnIds: [...ids], draftTurnId: randomUUID(),
      sideEffectFired: false, sideEffectReason: null, preempted: false, startedAt: deps.now(),
    }
    activeTurn = turnState; activeDraft = null; setBusy(true)
    const out = await type(text)
    if (turnState.preempted) {
      const evToRequeue = ids.filter((id) => getTurn(id)?.role !== "user")
      if (evToRequeue.length > 0) requeueDeliveries(evToRequeue, deps.now())
      return
    }
    if (out === "refused") { if (activeTurn === turnState) activeTurn = null; setBusy(false); return }
    if (seed) { pendingSeed = false; requeueDeliveries(queued.filter((id) => !ids.includes(id))) }
    lastActivity = deps.now()
    if (out === "maybe") {
      if (activeTurn === turnState) activeTurn = null
      markMaybe(ids); setBusy(false)
      say("⚠︎ Typed into the brain but not confirmed as submitted — not retyped. Check the brain pane, or resend.")
      return
    }
    markDelivered(ids)
    activity.turn(seed ? null : userIds(ids).at(-1) ?? null)
    trace(userIds(ids).map((id) => upsertRow({ id: rowId.turn(id), turnId: id, kind: "turn", status: "running", title: getTurn(id)?.text ?? id, detail: "with the brain" })))
  }

  /** Spawn now unless paused (re-read: callers may have awaited). fresh = a new conversation (rollover, resume from down), else resume. */
  async function spawnNow(fresh = false): Promise<void> {
    if (deps.paused.read()) { setState("paused"); return }
    forgetSession(); pane = ""
    if (fresh) { setKv("session_id", ""); turnsSinceReset = 0 }
    const r = await deps.spawn(getKv("session_id") || null)
    spawnedAt = deps.now()
    if (!r.ok) {
      deps.log(`[brain] spawn failed: ${r.error ?? "unknown"}`)
      if (r.error?.startsWith("name_taken")) await deps.stopAgent()
      return
    }
    pane = r.herdrPane ?? ""; pendingSeed = true
    deps.log(`[brain] spawned (pane ${pane || "?"})`)
  }

  /** A brain turn ended (its Stop hook, or the transcript when that hook was lost). */
  async function finishTurn(reply: string, explicitDraftTurnId?: string): Promise<void> {
    const finishedTurn = activeTurn; activeTurn = null
    const finishedDraft = activeDraft; activeDraft = null
    const draftTurnId = explicitDraftTurnId || finishedDraft?.draftTurnId || finishedTurn?.draftTurnId || null
    const hadStream = !!finishedDraft?.acc.hasStreamed() || !!explicitDraftTurnId
    const blockIdx = finishedDraft?.acc.currentBlockIndex() ?? 0
    setBusy(false); lastActivity = deps.now()
    const rawText = reply.trim()
    const text = finishedDraft?.acc.hasStreamed() ? finishedDraft.acc.finalReply(rawText) : rawText
    const was = control; control = null
    const isQuiet = text.toLowerCase() === QUIET_REPLY
    const isInterrupted = text.toLowerCase() === "interrupted"
    if (!was && text && text !== lastReplyText && !isQuiet && !isInterrupted) {
      const turn = say(text, null, hadStream ? draftTurnId : null)
      if (hadStream && draftTurnId) deps.broadcast(buildBrainDoneFrame(draftTurnId, turn, blockIdx) as unknown as Record<string, unknown>)
    } else if (draftTurnId && (isQuiet || (hadStream && (isInterrupted || !!was || !text)))) {
      deps.broadcast(buildBrainClearFrame(draftTurnId, isQuiet ? "quiet_reply" : "interrupted", blockIdx) as unknown as Record<string, unknown>)
    }
    if (text) lastReplyText = text
    if (!was) {
      turnsSinceReset++
      if (isInterrupted && finishedTurn?.trigger === "event" && !finishedTurn.sideEffectFired) {
        requeueActiveEvents(finishedTurn.turnIds)
      } else {
        trace(userIds(clearTyped()).map((id) => upsertRow({ id: rowId.turn(id), kind: "turn", status: "done", title: getTurn(id)?.text ?? id, detail: null })))
      }
    }
    if (was === "flush") {
      if (sessionKey && openDeliveries().length === 0 && !deps.paused.read()) {
        const ok = await deps.compact(sessionKey, compactText(await memoryRef(), 0))
        compacting = ok; syncActivity()
        deps.log(`[brain] idle compact ${ok ? "sent" : "refused"}`)
        if (ok) return
      }
    }
    if (was === "rollover") {
      deps.log("[brain] rollover: restarting with a fresh session")
      await deps.stopAgent(); setState("starting"); await spawnNow(true); return
    }
    await flush()
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const paused = deps.paused.read()
      const alive = await deps.alive()
      const step = superviseStep({ paused, alive, state, spawnedAt, restarts, now: deps.now() })
      restarts = step.restarts
      if (step.action === "stop") { await deps.stopAgent(); forgetSession() }
      if (step.action === "spawn") { setState("starting"); await spawnNow(); return }
      if (!alive || paused) { setState(step.state); return }
      if (!pane) pane = await deps.agentPane()
      if (!target()) {
        let found = deps.sessions().find((s) => s.taskId === BRAIN_AGENT && !!pane && s.herdrPane === pane)
        if (!found && pane) {
          const untagged = deps.sessions().find((s) => !s.taskId && !!s.sessionId && s.herdrPane === pane)
          if (untagged && deps.tagBrain(untagged.key)) found = deps.sessionByKey(untagged.key) ?? undefined
        }
        if (!found || !adopt(found)) { setState("starting"); return }
      }
      spawnedAt = 0; setState("up")
      const quietFor = deps.now() - Math.max(busySince, lastHookAt)
      if (busy && quietFor > TURN_END_GRACE_MS && sessionKey && await deps.agentStatus(sessionKey) === "idle") {
        const s = target()
        if (s) {
          deps.log("[brain] idle with no Stop hook — the reply is read from the transcript")
          await finishTurn(await deps.lastReply(s)); return
        }
      }
      if (busy && quietFor > BUSY_MAX_MS) {
        deps.log("[brain] no hook from the brain while busy — the turn is considered lost, delivery resumes")
        if (activeTurn?.trigger === "event") requeueActiveEvents(activeTurn.turnIds)
        activeTurn = null; activeDraft = null; setBusy(false)
      }
      await flush(); await maintain()
    } catch (err) {
      deps.log(`[brain] tick failed: ${(err as Error)?.message ?? String(err)}`)
    } finally {
      ticking = false; syncActivity()
    }
  }

  /** Idle compaction / mid-day rollover and the 04:00 rollover — only between turns. */
  async function maintain(): Promise<void> {
    if (busy || !sessionKey || deps.paused.read()) return
    const now = deps.now()
    const startControlTurn = async (kind: "rollover" | "flush", prompt: string): Promise<"ok" | "maybe" | "refused"> => {
      activeTurn = { gen: ++turnGen, trigger: kind, turnIds: [], draftTurnId: randomUUID(), sideEffectFired: true, sideEffectReason: kind, preempted: false, startedAt: now }
      setBusy(true)
      const out = await type(prompt)
      if (out === "ok") control = kind
      else { activeTurn = null; setBusy(false) }
      return out
    }
    if (rolloverDue(new Date(now), getKv("last_rollover"))) {
      setKv("last_rollover", new Date(now).toISOString().slice(0, 10))
      await startControlTurn("rollover", rolloverPrompt(await memoryRef())); return
    }
    if (deps.middayRollover) {
      const ctxPct = deps.contextPct(sessionKey)
      if (openDeliveries().length === 0 && middayRolloverDue({ lastTurnAt: lastActivity, contextPct: ctxPct, turnsSinceReset, now, busy })) {
        deps.log(`[brain] mid-day rollover due (ctx=${ctxPct ?? "?"}%, turns=${turnsSinceReset})`)
        await startControlTurn("rollover", rolloverPrompt(await memoryRef()))
      }
      return
    }
    if (compactedAt < lastActivity && idleCompactDue({ lastTurnAt: lastActivity, contextPct: deps.contextPct(sessionKey), now, busy })) {
      compactedAt = now
      const out = await startControlTurn("flush", flushPrompt(await memoryRef()))
      deps.log(`[brain] pre-compact flush ${out}`)
    }
  }

  return {
    status, tick,

    start(): void {
      if (timer) return
      const { channel, created } = ensureChannel(BRAIN_THREAD, "Brain")
      if (created) emitChannel(channel)
      onTurnAppended(wake)
      timer = setInterval(() => void tick(), TICK_MS); timer.unref?.(); void tick()
    },

    stop(): void { clearCoalesce(); if (timer) clearInterval(timer); timer = null },

    /** A user turn in the brain thread (POST /api/orchestrator/send). Never throws: the turn is already persisted. */
    enqueue(turn: Turn): void {
      try {
        clearCoalesce()
        enqueueDelivery(turn.id, turn.createdAt)
        lastActivity = deps.now()
        const steerAfterMs = Number(process.env.COMPANION_BRAIN_USER_STEER_MS ?? 0)
        if (compacting && sessionKey) {
          compacting = false; syncActivity()
          deps.log("[brain] message during idle compact — compact cancelled")
          void deps.interrupt(sessionKey).then(() => flush())
        } else if (busy && sessionKey && (steerAfterMs <= 0 || (busySince > 0 && deps.now() - busySince >= steerAfterMs))) {
          if (canPreemptBrainTurn(activeTurn)) {
            const elapsed = busySince > 0 ? deps.now() - busySince : 0
            const preempted = activeTurn!
            preempted.preempted = true; activeTurn = null
            const finishedDraft = activeDraft; activeDraft = null
            const evToRequeue = requeueActiveEvents(preempted.turnIds)
            if (finishedDraft?.acc.hasStreamed()) {
              deps.broadcast(buildBrainClearFrame(finishedDraft.draftTurnId, "preempted", finishedDraft.acc.currentBlockIndex()) as unknown as Record<string, unknown>)
            }
            setBusy(false)
            deps.log(`[brain] user message arrived while [event] turn open ${elapsed}ms (0 side effects) — preempting and re-queueing ${evToRequeue.length} event(s)`)
            void deps.interrupt(sessionKey).then(() => flush())
          } else if (activeTurn?.trigger === "event" && activeTurn.sideEffectFired) {
            deps.log(`[brain] user message arrived during [event] turn after side effect (${activeTurn.sideEffectReason}) — waiting for turn completion`)
          }
        }
        trace([upsertRow({ id: rowId.turn(turn.id), turnId: turn.id, kind: "turn", status: "pending", title: turn.text, detail: state === "up" ? null : `brain ${state}` })])
        void flush()
      } catch (err) {
        deps.log(`[brain] enqueue failed: ${(err as Error)?.message ?? String(err)}`)
      }
    },

    async onStop(sid: string, lastMessage: string, draftTurnId?: string): Promise<void> {
      if (!sid || !sessionId || sid !== sessionId) return
      lastHookAt = deps.now()
      await finishTurn(lastMessage, draftTurnId)
    },

    onTextDelta(sid: string, ev: { draftTurnId?: string; delta: string; text?: string; blockIndex?: number } | string, isDelta = false): void {
      if (!sid || sid !== sessionId || !busy || activeTurn?.preempted) return
      lastHookAt = deps.now()
      const draftId = (typeof ev === "object" && ev.draftTurnId ? ev.draftTurnId : null) || activeDraft?.draftTurnId || activeTurn?.draftTurnId || randomUUID()
      if (!activeDraft || activeDraft.draftTurnId !== draftId) {
        activeDraft = { draftTurnId: draftId, acc: new BrainTurnAccumulator(draftId) }
        if (activeTurn) activeTurn.draftTurnId = draftId
      }
      if (typeof ev === "string") {
        const pushed = activeDraft.acc.pushText(ev, isDelta)
        if (!pushed) return
        deps.broadcast(buildBrainDeltaFrame({ draftTurnId: draftId, delta: pushed.delta, text: pushed.text, blockIndex: pushed.blockIndex }) as unknown as Record<string, unknown>)
        return
      }
      const pushed = activeDraft.acc.pushText(ev.delta, true)
      const text = typeof ev.text === "string" && ev.text ? ev.text : pushed?.text ?? ev.delta
      const blockIndex = typeof ev.blockIndex === "number" ? ev.blockIndex : activeDraft.acc.currentBlockIndex()
      if (!text) return
      deps.broadcast(buildBrainDeltaFrame({ draftTurnId: draftId, delta: ev.delta, text, blockIndex }) as unknown as Record<string, unknown>)
    },

    noteActivity(sid: string, call?: { phase: "pre" | "post"; tool: string; input: Record<string, unknown>; toolUseId: string }): void {
      if (!sid || sid !== sessionId) return
      lastHookAt = deps.now()
      if (call && busy) {
        activeDraft?.acc.noteTool()
        const sideEffect = isMutatingBrainToolCall(call.tool, call.input)
        if (sideEffect) noteSideEffect(sideEffect)
        activity.tool(call.phase, call.tool, call.input, call.toolUseId)
      }
    },

    noteSideEffect,
    activeTurnState: (): ActiveBrainTurnState | null => activeTurn ? { ...activeTurn, turnIds: [...activeTurn.turnIds] } : null,
    activeDraftFrame(): BrainStreamFrame | null {
      if (!busy || !activeDraft || !activeDraft.acc.hasStreamed()) return null
      const text = activeDraft.acc.currentText()
      return text ? buildBrainDeltaFrame({ draftTurnId: activeDraft.draftTurnId, delta: text, text, blockIndex: activeDraft.acc.currentBlockIndex() }) : null
    },
    onSessionStart(s: Session): void {
      if (!deps.paused.read() && adopt(s)) { compacting = false; syncActivity(); spawnedAt = 0; setState("up"); void flush() }
    },
    async propose(p: ProposeInput): Promise<{ status: number; body: Record<string, unknown> }> {
      noteSideEffect("propose")
      return proposeBrainTask(p, { dispatch: deps.dispatch, trace, log: deps.log })
    },
    attachAudio(turnId: string, audioId: string): void {
      const turn = getTurn(turnId)
      if (!turn || turn.threadId !== BRAIN_THREAD || turn.card?.kind !== "voice") return
      const updated = setTurnCard(turnId, { audioId })
      if (updated) orchEmit(updated)
      trace([upsertRow({ id: rowId.voice(turnId), parentId: rowId.turn(turnId), turnId, kind: "voice", status: "done", title: "Voice take archived", ref: { audioId } })])
    },
    pause(): BrainStatus { deps.paused.write(true); void deps.stopAgent().then(forgetSession); setState("paused"); return status() },
    resume(): BrainStatus { deps.paused.write(false); setKv("session_id", ""); restarts = []; setState("starting"); void tick(); return status() },
    onTurn: wake,
    setSpawnedPaneForTests(p: string): void { pane = p },
    async restart(): Promise<BrainStatus | null> {
      if (deps.paused.read()) return null
      restarts = []; await deps.stopAgent()
      if (deps.paused.read()) return null
      setState("starting"); await spawnNow(); return status()
    },
  }
}

export type BrainWiring = ReturnType<typeof createBrainWiring>

// ── Real Headless Brain Deps (BKM-Q24R: stream-json supervisor, zero herdr/tmux) ──

const PAUSED_FLAG = join(homedir(), ".claude-companion", ".brain-paused")

let deliverFn: ((text: string, key: string) => Promise<Response>) | null = null
/** Legacy hook kept for companion-server.ts compatibility. */
export function setBrainDeliver(fn: (text: string, key?: string) => Promise<Response>): void {
  deliverFn = fn
}
export const getBrainDeliver = (): ((text: string, key: string) => Promise<Response>) | null => deliverFn

export const headlessBrainRunner = createHeadlessBrainRunner({
  noteActivity: (sid, call) => brainWiring.noteActivity(sid, call),
  onTextDelta: (sid, ev: BrainDeltaEvent) => brainWiring.onTextDelta(sid, ev),
  onStop: (sid, reply, draftTurnId) => brainWiring.onStop(sid, reply, draftTurnId),
})

export function setBrainModel(model: string): void {
  headlessBrainRunner.setModel(model)
}

export const brainWiring = createBrainWiring({
  now: Date.now,
  alive: () => headlessBrainRunner.alive(),
  agentPane: () => headlessBrainRunner.agentPane(),
  spawn: (resume) => headlessBrainRunner.spawn(resume),
  stopAgent: () => headlessBrainRunner.stopAgent(),
  sessions: listSessions,
  sessionByKey: getSessionByKey,
  tagBrain: (key) => { const s = getSessionByKey(key); return !!s && recordSession({ ...s, taskId: BRAIN_AGENT })?.key === key },
  agentStatus: () => headlessBrainRunner.agentStatus(),
  lastReply: (s) => headlessBrainRunner.lastReply(s),
  interrupt: () => headlessBrainRunner.interrupt(),
  deliver: (text) => headlessBrainRunner.deliver(text),
  broadcast,
  push: (payload) => { if (apnsConfigured()) void pushToAll(payload).catch(() => { /* best effort */ }) },
  paused: {
    read: () => existsSync(PAUSED_FLAG),
    write: (on) => {
      if (!on) return rmSync(PAUSED_FLAG, { force: true })
      mkdirSync(dirname(PAUSED_FLAG), { recursive: true })
      writeFileSync(PAUSED_FLAG, `${new Date().toISOString()}\n`)
    },
  },
  contextPct: (key) => gauge.snapshot().sessions.find((s) => s.sessionKey === key)?.ctxPercent ?? null,
  compact: async () => true,
  dispatch: dispatchWiring,
  host: HOST_INFO.name,
  log: companionLog,
  eventCoalesceMs: 15_000,
  middayRollover: true,
  triageEvents: triageOpsEvents,
})
