import { createHash } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { companionLog } from "../lib/log"
import { HOST_INFO, broadcast } from "../state"
import {
  BRAIN_AGENT, BRAIN_THREAD, type BrainState, type DeliveryTurn,
  BUSY_MAX_MS, MEMORY_TAG, QUIET_REPLY, TURN_END_GRACE_MS, bootSeed, compactText, deliveryText, flushPrompt, idleCompactDue, rolloverDue, rolloverPrompt, superviseStep, TICK_MS, voiceConsent,
} from "../lib/brain"
import {
  claimConsent, clearTyped, consentClaimed, enqueueDelivery, getKv, markDelivered, markMaybe,
  openDeliveries, proposeSeen, rememberPropose, setKv, takeDeliveries,
} from "../lib/brain-store"
import { type TraceRow, rowId, upsertRow } from "../lib/brain-trace"
import { type Turn, appendTurn, createProposal, getTurn, onTurnAppended, setTurnCard } from "../lib/orchestrator-chat"
import { ensureChannel } from "../lib/orchestrator-channels"
import { DEFAULT_AGENT, getNote, resolveAgent } from "../lib/dispatch-tasks"
import { type Session, getSessionByKey, listSessions, recordSession } from "../lib/sessions"
import { type SpawnResult, spawnInHerdr } from "../lib/spawn-session"
import { realHerdr } from "../lib/herdr"
import { extractLastAssistantMessage } from "../lib/last-assistant"
import { transcriptPath } from "../lib/session-titles"
import { pushToAll } from "../lib/push"
import { apnsConfigured } from "../lib/apns"
import type { ApnsPayload } from "../lib/apns"
import { gauge } from "./gauge"
import { realAutoCompactDeps } from "./auto-compact"
import { createLiveness } from "./takeover-liveness"
import { emitChannel, emitTask, orchEmit } from "./orchestrator"
import { approveProposal } from "./proposals"
import { type DispatchWiring, dispatchWiring } from "./dispatch"

// brain-v2 (RES-QDHU) runtime: supervises the one `brain` agent (a herdr pane
// running interactive claude under Remote Control `brain`), relays Jeremie's
// brain-thread turns into it, records its replies, and keeps the trace. The
// server only supervises, relays and records; the thread (sqlite) is the
// store, not the transcript. Started by companion-server.ts iff COMPANION_BRAIN=1.
//
// Adoption: only the session in the pane this supervisor spawned (herdr's
// `brain` agent pane after a Companion restart), never a second one while the
// adopted session is still the delivery target. Delivery is strict: a
// non-empty session key whose registered session has taskId "brain" AND the
// adopted session id — never a cwd, never the "most recent session" fallback.
// not_submitted → `maybe`, never retyped into that session. The paused flag is
// re-read before every spawn, every adoption and every delivery.

export interface BrainStatus { state: BrainState; sessionKey: string | null; since: number; restarts: number; host: string }

export interface ProposeInput { title: string; prompt: string; noteId: string; agent: string | null; reasoning: string; sourceTurnId: string }

export interface BrainDeps {
  now(): number
  alive(): Promise<boolean>
  /** herdr's `brain` agent pane ("" when absent): what to adopt after a Companion restart. */
  agentPane(): Promise<string>
  /** Start the brain: resume that conversation (claude --resume), or a fresh one when null. */
  spawn(resume: string | null): Promise<SpawnResult>
  stopAgent(): Promise<void>
  sessions(): Session[]
  sessionByKey(key: string): Session | null
  /** Set taskId "brain" on a session found in the spawned pane. */
  tagBrain(key: string): boolean
  deliver(text: string, key: string): Promise<Response>
  /** Claude Code's own status for the session ("busy" | "waiting" | "idle" | ""). */
  agentStatus(key: string): Promise<string>
  /** The text the brain wrote after its last prompt, read from its transcript ("" when none). */
  lastReply(s: Session): Promise<string>
  /** Esc into the brain's pane: cancels a running /compact. */
  interrupt(key: string): Promise<void>
  broadcast(frame: Record<string, unknown>): void
  push(payload: ApnsPayload): void
  paused: { read(): boolean; write(on: boolean): void }
  contextPct(key: string): number | null
  compact(key: string, text: string): Promise<boolean>
  dispatch: DispatchWiring
  host: string
  log(msg: string): void
}

export function emitTrace(rows: TraceRow[]): void {
  if (rows.length) broadcast({ type: "brain_trace", op: "row", rows })
}

export function createBrainWiring(deps: BrainDeps) {
  let state: BrainState = "starting"
  let since = deps.now()
  let restarts: number[] = []
  let spawnedAt = 0
  let pane = ""
  let sessionKey: string | null = null
  let sessionId: string | null = null
  let busy = false
  let busySince = 0
  let lastHookAt = 0
  let pendingSeed = false
  let lastActivity = deps.now()
  let compactedAt = 0
  let compacting = false
  /** A control turn ([flush], [rollover]) is in flight: its reply is not a thread turn. */
  let control: "flush" | "rollover" | null = null
  let lastReplyText = ""
  let timer: ReturnType<typeof setInterval> | null = null
  /** >0 while the supervisor writes its own thread turns: those never wake the brain. */
  let selfWrite = 0
  let ticking = false

  const trace = (rows: Array<TraceRow | null>): void => {
    const out = rows.filter((r): r is TraceRow => !!r)
    if (out.length) deps.broadcast({ type: "brain_trace", op: "row", rows: out })
  }

  function status(): BrainStatus {
    return { state, sessionKey, since, restarts: restarts.length, host: deps.host }
  }

  function setState(next: BrainState): void {
    if (next === state) return
    const was = state
    state = next
    since = deps.now()
    deps.log(`[brain] ${was} → ${next}`)
    deps.broadcast({ type: "brain", ...status() })
    if (next === "down") {
      deps.push({ title: "Brain is down", body: `${restarts.length} restarts in 5 min — Settings ▸ Brain to restart.`, category: "body_alert", collapseId: "brain-down", userInfo: { kind: "brain" } })
    }
  }

  function setBusy(on: boolean): void {
    busy = on
    busySince = on ? deps.now() : 0
  }

  function forgetSession(): void {
    sessionKey = null
    sessionId = null
    setBusy(false)
  }

  /** The delivery target, or null: key set, session registered as the brain, same session id. */
  function target(): Session | null {
    if (!sessionKey) return null
    const s = deps.sessionByKey(sessionKey)
    if (!s || s.taskId !== BRAIN_AGENT) return null
    if (!sessionId || s.sessionId !== sessionId) return null
    return s
  }

  /** Adopt a brain session: only in the spawned pane (both non-empty), never replacing a live adopted one. */
  function adopt(s: Session): boolean {
    if (s.taskId !== BRAIN_AGENT || !s.sessionId) return false
    if (!pane || !s.herdrPane || s.herdrPane !== pane) return false
    if (s.key === sessionKey && s.sessionId === sessionId) return true
    if (target()) return false
    sessionKey = s.key
    sessionId = s.sessionId
    setBusy(false)
    compacting = false
    setKv("session_id", s.sessionId)
    deps.log(`[brain] adopted ${s.key} sid=${s.sessionId.slice(0, 8)} pane=${pane}`)
    return true
  }

  function turnsOf(ids: string[]): DeliveryTurn[] {
    return ids.map((id) => getTurn(id)).filter((t): t is Turn => !!t).map((t) => ({ id: t.id, text: t.text, createdAt: t.createdAt, card: t.card ?? null, role: t.role }))
  }

  /** Jeremie's turns only: events get no trace rows. */
  const userIds = (ids: string[]): string[] => ids.filter((id) => getTurn(id)?.role === "user")

  /** A brain-thread turn the supervisor writes (reply, warning, proposal card). */
  function say(text: string, taskId: string | null = null): void {
    selfWrite++
    try { orchEmit(appendTurn("orchestrator", text, taskId, BRAIN_THREAD)) } finally { selfWrite-- }
  }

  /** A system turn landed in the brain thread (receipt, approval, merge…): the brain hears it on its next turn. */
  function wake(turn: Turn): void {
    if (turn.threadId !== BRAIN_THREAD || turn.role !== "orchestrator" || selfWrite > 0) return
    try {
      enqueueDelivery(turn.id, turn.createdAt)
      void flush()
    } catch (err) {
      deps.log(`[brain] wake failed: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  /** Type one prompt into the brain. ok / not_submitted / refused (left for the next try). */
  async function type(text: string): Promise<"ok" | "maybe" | "refused"> {
    const s = target()
    if (!s) return "refused"
    let res: Response
    try {
      res = await deps.deliver(text, s.key)
    } catch {
      return "refused"
    }
    const body = await res.json().catch(() => ({})) as { ok?: unknown; error?: unknown }
    if (res.ok && body.ok === true) return "ok"
    if (body.error === "not_submitted") return "maybe"
    deps.log(`[brain] delivery refused: ${typeof body.error === "string" ? body.error : res.status}`)
    return "refused"
  }

  /** The memory note's ref: remembered, else the newest note tagged brain-memory (then remembered). */
  async function memoryRef(): Promise<string | null> {
    const known = getKv("memory_ref")
    if (known) return known
    try {
      const rows = await deps.dispatch.query(
        "SELECT ref_code FROM notes WHERE folder = 'resources' AND tags LIKE ? ORDER BY updated_at DESC LIMIT 1",
        [`%"${MEMORY_TAG}"%`],
      )
      const ref = rows[0]?.ref_code
      if (typeof ref === "string" && ref) {
        setKv("memory_ref", ref)
        return ref
      }
    } catch { /* Turso unreachable: the brain looks it up itself */ }
    return null
  }

  /** Deliver what is queued (with the boot seed first after a spawn). One typed prompt per brain turn. */
  async function flush(): Promise<void> {
    // A lost post-compact SessionStart must not hold delivery forever.
    if (compacting && deps.now() - compactedAt > BUSY_MAX_MS) compacting = false
    if (deps.paused.read() || busy || compacting || state !== "up" || !target()) return
    const seed = pendingSeed
    const ids = seed ? openDeliveries().map((r) => r.turnId) : takeDeliveries()
    if (!seed && ids.length === 0) return
    const turns = turnsOf(ids)
    const text = seed ? bootSeed({ memoryRef: await memoryRef(), open: turns }) : deliveryText(turns)
    if (busy || !target()) return
    setBusy(true)
    const out = await type(text)
    if (out === "refused") {
      setBusy(false)
      return
    }
    if (seed) pendingSeed = false
    lastActivity = deps.now()
    if (out === "maybe") {
      markMaybe(ids)
      setBusy(false)
      say("⚠︎ Typed into the brain but not confirmed as submitted — not retyped. Check the brain pane, or resend.")
      return
    }
    markDelivered(ids)
    trace(userIds(ids).map((id) => upsertRow({ id: rowId.turn(id), turnId: id, kind: "turn", status: "running", title: getTurn(id)?.text ?? id, detail: "with the brain" })))
  }

  /** Spawn now, unless the kill switch is set (re-read here: callers may have awaited since). */
  /** fresh: a new conversation (the rollover, a manual resume from down); else resume the last one. */
  async function spawnNow(fresh = false): Promise<void> {
    if (deps.paused.read()) {
      setState("paused")
      return
    }
    forgetSession()
    pane = ""
    if (fresh) setKv("session_id", "")
    const r = await deps.spawn(getKv("session_id") || null)
    spawnedAt = deps.now()
    if (!r.ok) {
      deps.log(`[brain] spawn failed: ${r.error ?? "unknown"}`)
      if (r.error?.startsWith("name_taken")) await deps.stopAgent()
      return
    }
    pane = r.herdrPane ?? ""
    pendingSeed = true
    deps.log(`[brain] spawned (pane ${pane || "?"})`)
  }

  /** A brain turn ended (its Stop hook, or the transcript when that hook was lost). */
  async function finishTurn(reply: string): Promise<void> {
    setBusy(false)
    lastActivity = deps.now()
    const text = reply.trim()
    const was = control
    control = null
    // A late Stop after the transcript fallback carries the same reply: once only.
    if (!was && text && text !== lastReplyText && text.toLowerCase() !== QUIET_REPLY) say(text)
    if (text) lastReplyText = text
    if (!was) trace(userIds(clearTyped()).map((id) => upsertRow({ id: rowId.turn(id), kind: "turn", status: "done", title: getTurn(id)?.text ?? id, detail: null })))
    if (was === "flush") {
      // Memory is on disk: compact now, unless Jeremie spoke meanwhile.
      if (sessionKey && openDeliveries().length === 0 && !deps.paused.read()) {
        const ok = await deps.compact(sessionKey, compactText(await memoryRef(), 0))
        compacting = ok
        deps.log(`[brain] idle compact ${ok ? "sent" : "refused"}`)
        if (ok) return
      }
    }
    if (was === "rollover") {
      deps.log("[brain] rollover: restarting with a fresh session")
      await deps.stopAgent()
      setState("starting")
      await spawnNow(true)
      return
    }
    await flush()
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      // The kill switch first: a paused brain never respawns, whatever else holds.
      const paused = deps.paused.read()
      const alive = await deps.alive()
      const step = superviseStep({ paused, alive, state, spawnedAt, restarts, now: deps.now() })
      restarts = step.restarts
      if (step.action === "stop") {
        await deps.stopAgent()
        forgetSession()
      }
      if (step.action === "spawn") {
        setState("starting")
        await spawnNow()
        return
      }
      if (!alive || paused) {
        setState(step.state)
        return
      }
      if (!pane) pane = await deps.agentPane()
      if (!target()) {
        let found = deps.sessions().find((s) => s.taskId === BRAIN_AGENT && !!pane && s.herdrPane === pane)
        // The SessionStart hook can be lost (it posts in the background as the
        // hook exits), leaving the brain registered by discovery with no taskId.
        // The pane we spawned is proof enough: tag it.
        if (!found && pane) {
          const untagged = deps.sessions().find((s) => !s.taskId && !!s.sessionId && s.herdrPane === pane)
          if (untagged && deps.tagBrain(untagged.key)) found = deps.sessionByKey(untagged.key) ?? undefined
        }
        if (!found || !adopt(found)) {
          setState("starting")
          return
        }
      }
      spawnedAt = 0
      setState("up")
      const quietFor = deps.now() - Math.max(busySince, lastHookAt)
      if (busy && quietFor > TURN_END_GRACE_MS && sessionKey && await deps.agentStatus(sessionKey) === "idle") {
        // The Stop hook posts in the background as the hook exits and can be
        // lost: Claude Code says the turn is over, so read the reply ourselves.
        const s = target()
        if (s) {
          deps.log("[brain] idle with no Stop hook — the reply is read from the transcript")
          await finishTurn(await deps.lastReply(s))
          return
        }
      }
      if (busy && quietFor > BUSY_MAX_MS) {
        deps.log("[brain] no hook from the brain while busy — the turn is considered lost, delivery resumes")
        setBusy(false)
      }
      await flush()
      await maintain()
    } catch (err) {
      deps.log(`[brain] tick failed: ${(err as Error)?.message ?? String(err)}`)
    } finally {
      ticking = false
    }
  }

  /** Idle compaction and the 04:00 rollover — only between turns. */
  async function maintain(): Promise<void> {
    if (busy || !sessionKey || deps.paused.read()) return
    const now = deps.now()
    if (rolloverDue(new Date(now), getKv("last_rollover"))) {
      setKv("last_rollover", new Date(now).toISOString().slice(0, 10))
      setBusy(true)
      const out = await type(rolloverPrompt(await memoryRef()))
      if (out === "ok") control = "rollover"
      else setBusy(false)
      return
    }
    if (compactedAt < lastActivity && idleCompactDue({ lastTurnAt: lastActivity, contextPct: deps.contextPct(sessionKey), now, busy })) {
      compactedAt = now
      setBusy(true)
      const out = await type(flushPrompt(await memoryRef()))
      if (out === "ok") control = "flush"
      else setBusy(false)
      deps.log(`[brain] pre-compact flush ${out}`)
    }
  }

  return {
    status,
    tick,

    start(): void {
      if (timer) return
      const { channel, created } = ensureChannel(BRAIN_THREAD, "Brain")
      if (created) emitChannel(channel)
      onTurnAppended(wake)
      timer = setInterval(() => void tick(), TICK_MS)
      timer.unref?.()
      void tick()
    },

    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },

    /** A user turn in the brain thread (POST /api/orchestrator/send). Never throws: the turn is already persisted. */
    enqueue(turn: Turn): void {
      try {
        enqueueDelivery(turn.id, turn.createdAt)
        lastActivity = deps.now()
        if (compacting && sessionKey) {
          // Jeremie comes first: Esc cancels the idle /compact, delivery follows.
          compacting = false
          deps.log("[brain] message during idle compact — compact cancelled")
          void deps.interrupt(sessionKey).then(() => flush())
        }
        trace([upsertRow({ id: rowId.turn(turn.id), turnId: turn.id, kind: "turn", status: "pending", title: turn.text, detail: state === "up" ? null : `brain ${state}` })])
        void flush()
      } catch (err) {
        deps.log(`[brain] enqueue failed: ${(err as Error)?.message ?? String(err)}`)
      }
    },

    /** The brain's Stop hook (routes/hooks.ts). Its reply becomes a thread turn; the next queued turns go in. */
    async onStop(sid: string, lastMessage: string): Promise<void> {
      if (!sid || !sessionId || sid !== sessionId) return
      lastHookAt = deps.now()
      await finishTurn(lastMessage)
    },

    /** Any hook from the adopted brain session: it is alive and working (busy deadline). */
    noteActivity(sid: string): void {
      if (sid && sid === sessionId) lastHookAt = deps.now()
    },

    /** SessionStart from the brain: adopt it (a fresh spawn gets its boot seed on the next tick). */
    onSessionStart(s: Session): void {
      if (deps.paused.read()) return
      if (adopt(s)) {
        compacting = false
        spawnedAt = 0
        setState("up")
        void flush()
      }
    },

    /** A proposal from bin/propose (POST /hooks/brain/propose, auth done by the route). */
    async propose(p: ProposeInput): Promise<{ status: number; body: Record<string, unknown> }> {
      const agent = resolveAgent(p.agent ?? DEFAULT_AGENT)
      if (!agent) return { status: 400, body: { ok: false, error: "unknown_agent" } }
      let note: Awaited<ReturnType<typeof getNote>>
      try {
        note = await getNote(deps.dispatch.query, p.noteId)
      } catch {
        return { status: 503, body: { ok: false, error: "turso_unreachable" } }
      }
      if (!note) return { status: 404, body: { ok: false, error: "no such note" } }
      // Dedupe and create with no await between: two identical calls can never both create.
      const hash = createHash("sha256").update(p.prompt).digest("hex").slice(0, 32)
      const seen = proposeSeen(p.sourceTurnId, hash)
      if (seen) return { status: 200, body: { ok: true, proposalId: seen, replay: true } }
      const task = createProposal(p.prompt, "", p.reasoning, BRAIN_THREAD, { noteId: note.noteId, agent, title: p.title })
      rememberPropose(p.sourceTurnId, hash, task.taskId)
      const project = note.ref ?? note.title ?? note.noteId
      const repoId = rowId.repo(p.sourceTurnId, project)
      trace([
        upsertRow({ id: repoId, parentId: rowId.turn(p.sourceTurnId), turnId: p.sourceTurnId, kind: "repo", status: "running", title: note.title ?? project, detail: project }),
        upsertRow({ id: rowId.agent(task.taskId), parentId: repoId, turnId: p.sourceTurnId, kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: "waits for your tap" }),
      ])
      emitTask(task.taskId)
      const turn = getTurn(p.sourceTurnId)
      if (voiceConsent(turn, deps.now(), consentClaimed(p.sourceTurnId)) && claimConsent(p.sourceTurnId, task.taskId)) {
        const res = await approveProposal(task, {}, deps.dispatch)
        const body = await res.json() as Record<string, unknown>
        if (res.ok) {
          trace([upsertRow({ id: rowId.agent(task.taskId), kind: "agent", status: "pending", title: `${agent} — ${p.title}`, detail: "filed by voice", ref: { taskId: String(body.dispatchTaskId ?? "") } })])
          return { status: 200, body: { ...body, proposalId: task.taskId, consent: "voice" } }
        }
        deps.log(`[brain] voice auto-file failed (${String(body.error)}): the proposal waits for a tap`)
      }
      say(`Proposal [${task.taskId}] — ${agent} · ${note.title ?? project}\nWhy: ${p.reasoning}\nTask: ${p.prompt}\nApprove to file it.`, task.taskId)
      return { status: 200, body: { ok: true, proposalId: task.taskId, status: "proposed" } }
    },

    /** A brain voice take was archived (POST /api/capture/voice/start brainTurnId): the turn card gets its audio id. */
    attachAudio(turnId: string, audioId: string): void {
      const turn = getTurn(turnId)
      if (!turn || turn.threadId !== BRAIN_THREAD || turn.card?.kind !== "voice") return
      const updated = setTurnCard(turnId, { audioId })
      if (updated) orchEmit(updated)
      trace([upsertRow({ id: rowId.voice(turnId), parentId: rowId.turn(turnId), turnId, kind: "voice", status: "done", title: "Voice take archived", ref: { audioId } })])
    },

    pause(): BrainStatus {
      deps.paused.write(true)
      void deps.stopAgent().then(forgetSession)
      setState("paused")
      return status()
    },

    resume(): BrainStatus {
      deps.paused.write(false)
      // Out of down (or a pause): a resumed conversation may be what kept crashing.
      setKv("session_id", "")
      restarts = []
      setState("starting")
      void tick()
      return status()
    },

    /** Every appended turn (registered by start()): brain-thread system turns wake the brain. */
    onTurn: wake,

    /** Test seam: the pane a spawn would have returned (adoption requires it). */
    setSpawnedPaneForTests(p: string): void {
      pane = p
    },

    async restart(): Promise<BrainStatus | null> {
      if (deps.paused.read()) return null
      restarts = []
      await deps.stopAgent()
      if (deps.paused.read()) return null
      setState("starting")
      await spawnNow()
      return status()
    },
  }
}

export type BrainWiring = ReturnType<typeof createBrainWiring>

// ── Real deps ──

const PAUSED_FLAG = join(homedir(), ".claude-companion", ".brain-paused")
/** The brain's cwd: its CLAUDE.md + .claude/settings.json (repo `brain/`, or COMPANION_BRAIN_DIR). */
export const BRAIN_DIR = process.env.COMPANION_BRAIN_DIR?.trim() || join(import.meta.dir, "..", "..", "brain")

let deliverFn: ((text: string, key: string) => Promise<Response>) | null = null
/** companion-server.ts hands in routes/api.ts deliverInject (the guarded phone-inject path). */
export function setBrainDeliver(fn: (text: string, key?: string) => Promise<Response>): void {
  deliverFn = fn
}

const liveness = createLiveness(() => ({ herdr: realHerdr, sessions: listSessions, now: Date.now }))

async function stopBrainAgent(): Promise<void> {
  const a = await liveness.agentOf(BRAIN_AGENT)
  if (a.kind !== "present") return
  await realHerdr.call(["agent", "stop", BRAIN_AGENT]).catch(() => undefined)
  if (a.ref.workspaceId) await realHerdr.call(["workspace", "close", a.ref.workspaceId]).catch(() => undefined)
  liveness.forget(BRAIN_AGENT)
}

export const brainWiring = createBrainWiring({
  now: Date.now,
  alive: () => liveness.alive(BRAIN_AGENT),
  agentPane: async () => {
    const a = await liveness.agentOf(BRAIN_AGENT)
    return a.kind === "present" ? a.ref.pane : ""
  },
  spawn: (resume) => spawnInHerdr(BRAIN_DIR, "claude", { COMPANION_TASK_ID: BRAIN_AGENT }, realHerdr, {
    name: BRAIN_AGENT,
    // --resume of a missing transcript makes claude exit: that would read as a crash loop.
    args: ["--remote-control", BRAIN_AGENT, ...(resume && existsSync(transcriptPath(BRAIN_DIR, resume)) ? ["--resume", resume] : [])],
  }),
  stopAgent: stopBrainAgent,
  sessions: listSessions,
  sessionByKey: getSessionByKey,
  tagBrain: (key) => { const s = getSessionByKey(key); return !!s && recordSession({ ...s, taskId: BRAIN_AGENT })?.key === key },
  agentStatus: (key) => realAutoCompactDeps.agentStatus(key),
  lastReply: (s) => extractLastAssistantMessage(transcriptPath(s.cwd, s.sessionId)),
  interrupt: async (key) => {
    const p = getSessionByKey(key)?.herdrPane
    if (p) await realHerdr.call(["pane", "send-keys", p, "esc"]).catch(() => undefined)
  },
  deliver: (text, key) => deliverFn ? deliverFn(text, key) : Promise.resolve(Response.json({ ok: false, error: "deliver_unavailable" }, { status: 503 })),
  broadcast,
  push: (payload) => { if (apnsConfigured()) void pushToAll(payload).catch(() => { /* best effort */ }) },
  paused: {
    read: () => existsSync(PAUSED_FLAG),
    write: (on) => {
      if (on) {
        mkdirSync(dirname(PAUSED_FLAG), { recursive: true })
        writeFileSync(PAUSED_FLAG, `${new Date().toISOString()}\n`)
      } else rmSync(PAUSED_FLAG, { force: true })
    },
  },
  contextPct: (key) => gauge.snapshot().sessions.find((s) => s.sessionKey === key)?.ctxPercent ?? null,
  compact: async (key, text) => (await realAutoCompactDeps.inject(key, text)).ok,
  dispatch: dispatchWiring,
  host: HOST_INFO.name,
  log: companionLog,
})
