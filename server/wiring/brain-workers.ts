import { BRAIN_AGENT } from "../lib/brain"
import {
  type Decision, type ReapMode, type SweepView, type WsKind, classifyBrainWs, classifyWorker, reapMode, settledNow,
  WORKER_PREFIX, WORKER_SWEEP_MS, workerTaskId, type BrainLive,
} from "../lib/brain-workers"
import { type TraceRow, getRow, rowId, upsertRow } from "../lib/brain-trace"
import { processEnvEntries } from "../lib/discover"
import { type DispatchTask, getDispatchTask, phaseOf } from "../lib/dispatch-tasks"
import { type Herdr, type HerdrWorkspaceInfo, herdrErrorCode, herdrWorkspacePanes, herdrWorkspaces, realHerdr } from "../lib/herdr"
import { companionLog } from "../lib/log"
import { getTaskByDispatchId } from "../lib/orchestrator-chat"
import { type Session, listSessions } from "../lib/sessions"
import { broadcast } from "../state"
import { dispatchWiring } from "./dispatch"
import { createLiveness } from "./takeover-liveness"

// brain-workers reconciler (STATE.md § Change Plan — brain-workers): closes
// the herdr workspaces the brain owns once they are finished — leftover
// `brain` workspaces (claude exited, herdr cleared the agent name) and the
// `dispatch-<id8>` workspaces of brain-proposed tasks whose live Turso phase is
// terminal. Level-triggered and idempotent: every sweep re-reads herdr, the
// env on each pane's shell and Turso; the policy is lib/brain-workers.ts.
// Jeremie's sessions (cc-*, builder-*, tko-*, phone spawns) carry neither env
// and are only ever counted as `foreign`.
//
// COMPANION_BRAIN_REAP: observe (default) logs `would close` once per
// workspace and never runs `workspace close`; on acts; off sweeps nothing.
//
// Split race (why COMPANION_HERDR_AUTOCLOSE is off): herdr has no conditional
// close. `workspace get` is re-read (one pane, same label) right before
// `workspace close`, with nothing else awaited between them; a split opened in
// that one round trip would still be closed with the workspace. Only
// machine-labelled workspaces (`brain`, `dispatch-*`) are ever candidates.

const FETCH_PER_SWEEP = 5

export interface ProposalRef { proposalId: string; threadId: string }

export interface BrainWorkersDeps {
  herdr: Herdr
  envOf(pid: string): Promise<string[] | null>
  sessions(): Pick<Session, "key" | "taskId" | "herdrPane">[]
  proposalOf(dispatchTaskId: string): ProposalRef | null
  snapshot(): DispatchTask[] | null
  cached(id: string): DispatchTask | null
  fetchTask(id: string): Promise<DispatchTask | null>
  mode(): ReapMode
  now(): number
  log(msg: string): void
  trace(rows: TraceRow[]): void
}

export interface SessionEntry {
  workspaceId: string
  kind: WsKind
  taskId?: string
  proposalId?: string
  phase?: string
  agentStatus: string
  verdict: Decision["verdict"]
  reason: string
}

interface Surveyed { entry: SessionEntry; view: SweepView; owned: boolean }
export interface Survey { mode: ReapMode; sessions: SessionEntry[]; foreign: number; items: Surveyed[] }

export type CloseOutcome = "closed" | "gone" | "observe" | "off" | "in_flight" | "changed" | "error"

export function createBrainWorkers(deps: BrainWorkersDeps) {
  const h = deps.herdr
  const liveness = createLiveness(() => ({ herdr: h, sessions: deps.sessions, now: deps.now }))
  /** In-flight closes: shared by the sweep, stopBrain and the route. */
  const closing = new Set<string>()
  /** workspace id → consecutive settled sweeps (label kept: herdr reuses ids). In memory; a restart costs one tick. */
  const settled = new Map<string, { label: string; n: number }>()
  const announced = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  async function view(w: HerdrWorkspaceInfo): Promise<SweepView> {
    const pane = (await herdrWorkspacePanes(w.workspaceId, h))[0]
    let atShell: boolean | null = null
    let env: string[] | null = null
    if (pane) {
      try {
        const r = await h.call(["pane", "process-info", "--pane", pane.paneId], 2_000)
        const p = r.process_info as { shell_pid?: unknown; foreground_process_group_id?: unknown } | undefined
        if (typeof p?.shell_pid === "number" && p.shell_pid > 0) {
          atShell = p.foreground_process_group_id === p.shell_pid
          env = await deps.envOf(String(p.shell_pid))
        }
      } catch { /* unreadable: atShell / env stay null → keep */ }
    }
    return {
      workspaceId: w.workspaceId, label: w.label, paneCount: w.paneCount, pane: pane?.paneId ?? "",
      agentStatus: pane?.agentStatus || w.agentStatus, atShell, env,
    }
  }

  /** The live brain (never closed by a sweep), or null when herdr can't say. */
  async function brainLive(): Promise<BrainLive | null> {
    const a = await liveness.agentOf(BRAIN_AGENT)
    if (a.kind === "error") return null
    const panes = deps.sessions().flatMap((s) => (s.taskId === BRAIN_AGENT && s.herdrPane ? [s.herdrPane] : []))
    if (a.kind === "absent") return { workspaceIds: [], panes }
    return { workspaceIds: a.ref.workspaceId ? [a.ref.workspaceId] : [], panes: a.ref.pane ? [...panes, a.ref.pane] : panes }
  }

  function countSettled(v: SweepView): number {
    const prev = settled.get(v.workspaceId)
    const n = settledNow(v) ? (prev && prev.label === v.label ? prev.n : 0) + 1 : 0
    settled.set(v.workspaceId, { label: v.label, n })
    return n
  }

  async function taskOf(id: string, budget: { left: number }): Promise<DispatchTask | null> {
    const hit = deps.cached(id)
    if (hit || budget.left <= 0) return hit
    budget.left--
    return deps.fetchTask(id).catch(() => null)
  }

  async function workerItem(v: SweepView, count: boolean, budget: { left: number }, manual = false): Promise<Surveyed> {
    const taskId = workerTaskId(v)
    const proposal = taskId ? deps.proposalOf(taskId) : null
    const snapshotOk = deps.snapshot() !== null
    const t = taskId && proposal && snapshotOk ? await taskOf(taskId, budget) : null
    const task = t ? { phase: phaseOf(t), updatedAt: t.updatedAt } : null
    const n = count ? countSettled(v) : settled.get(v.workspaceId)?.label === v.label ? settled.get(v.workspaceId)!.n : 0
    const d = classifyWorker(v, { proposal, snapshotOk, task, settledSweeps: n, now: deps.now(), manual })
    const entry: SessionEntry = {
      workspaceId: v.workspaceId, kind: "worker", agentStatus: v.agentStatus, verdict: d.verdict, reason: d.reason,
      ...(taskId ? { taskId } : {}), ...(proposal ? { proposalId: proposal.proposalId } : {}), ...(task ? { phase: task.phase } : {}),
    }
    return { entry, view: v, owned: d.owned }
  }

  function brainItem(v: SweepView, live: BrainLive | null): Surveyed {
    const d = classifyBrainWs(v, live)
    return { entry: { workspaceId: v.workspaceId, kind: "brain", agentStatus: v.agentStatus, verdict: d.verdict, reason: d.reason }, view: v, owned: d.owned }
  }

  /** Every brain-owned workspace with its verdict; `count` = a periodic sweep (advances the settled counters). */
  async function survey(opts: { count?: boolean; brains?: boolean; manual?: boolean } = {}): Promise<Survey> {
    const all = await herdrWorkspaces(h)
    const budget = { left: FETCH_PER_SWEEP }
    const items: Surveyed[] = []
    const brains = all.filter((w) => w.label === BRAIN_AGENT)
    const live = opts.brains !== false && brains.length ? await brainLive() : null
    if (opts.brains !== false) for (const w of brains) items.push(brainItem(await view(w), live))
    for (const w of all.filter((x) => x.label.startsWith(WORKER_PREFIX))) items.push(await workerItem(await view(w), !!opts.count, budget, opts.manual))
    for (const id of [...settled.keys()]) if (!all.some((w) => w.workspaceId === id)) settled.delete(id)
    const mine = items.filter((x) => x.owned)
    return { mode: deps.mode(), sessions: mine.map((s) => s.entry), foreign: all.length - mine.length, items: mine }
  }

  function traceClose(e: SessionEntry): void {
    if (e.kind !== "worker" || !e.proposalId) return
    const agent = getRow(rowId.agent(e.proposalId))
    if (!agent) return
    const row = upsertRow({
      id: rowId.worker(e.proposalId), parentId: agent.id, turnId: agent.turnId, kind: "worker", status: "done",
      title: "Closed worker", detail: e.reason, ref: { workspaceId: e.workspaceId, ...(e.taskId ? { taskId: e.taskId } : {}) },
    }, deps.now())
    if (row) deps.trace([row])
  }

  /** Close one workspace the verdict allows. Only `on` runs `workspace close`. */
  async function act(s: Surveyed): Promise<CloseOutcome> {
    const { entry: e, view: v } = s
    const mode = deps.mode()
    if (mode === "off") return "off"
    if (mode !== "on") {
      const key = `${e.workspaceId}|${v.label}`
      if (!announced.has(key)) {
        announced.add(key)
        deps.log(`[brain-workers] would close ${e.workspaceId} (${v.label}): ${e.reason}`)
      }
      return "observe"
    }
    if (closing.has(e.workspaceId)) return "in_flight"
    closing.add(e.workspaceId)
    try {
      const info = await h.call(["workspace", "get", e.workspaceId], 2_000)
      const w = info.workspace as { pane_count?: unknown; label?: unknown } | undefined
      if (w?.pane_count !== 1 || w.label !== v.label) return "changed"
      await h.call(["workspace", "close", e.workspaceId], 5_000)
      settled.delete(e.workspaceId)
      deps.log(`[brain-workers] closed ${e.workspaceId} (${v.label}): ${e.reason}`)
      traceClose(e)
      return "closed"
    } catch (err) {
      if (/not_found/.test(herdrErrorCode(err))) return "gone"
      deps.log(`[brain-workers] close ${e.workspaceId} failed: ${(err as Error)?.message ?? String(err)}`)
      return "error"
    } finally {
      closing.delete(e.workspaceId)
    }
  }

  /** Leftover `brain` workspaces (never the live agent's, never a brain session's pane). */
  async function sweepBrains(live: BrainLive): Promise<void> {
    if (deps.mode() === "off") return
    for (const w of (await herdrWorkspaces(h)).filter((x) => x.label === BRAIN_AGENT)) {
      const s = brainItem(await view(w), live)
      if (s.entry.verdict === "close") await act(s)
    }
  }

  async function liveOrSkip(why: string): Promise<BrainLive | null> {
    const live = await brainLive()
    if (!live) deps.log(`[brain-workers] ${why}: herdr could not say where the brain is — no sweep`)
    return live
  }

  /** The periodic sweep: workers only (a half-started brain is never seen here). */
  async function tick(): Promise<void> {
    if (ticking || deps.mode() === "off") return
    ticking = true
    try {
      const s = await survey({ count: true, brains: false })
      for (const item of s.items) if (item.entry.verdict === "close") await act(item)
    } catch (err) {
      deps.log(`[brain-workers] sweep failed: ${(err as Error)?.message ?? String(err)}`)
    } finally {
      ticking = false
    }
  }

  return {
    liveness,
    survey,
    tick,

    /** BrainDeps.stopAgent: stop herdr's `brain` agent and close its workspace (as before), then sweep leftovers. */
    async stopBrain(): Promise<void> {
      const a = await liveness.agentOf(BRAIN_AGENT)
      if (a.kind === "error") {
        deps.log("[brain-workers] stopBrain: herdr could not say where the brain is — no sweep")
        return
      }
      if (a.kind === "present") {
        await h.call(["agent", "stop", BRAIN_AGENT]).catch(() => undefined)
        const ws = a.ref.workspaceId
        if (ws && !closing.has(ws)) {
          closing.add(ws)
          await h.call(["workspace", "close", ws]).catch(() => undefined).finally(() => closing.delete(ws))
        }
        liveness.forget(BRAIN_AGENT)
      }
      const live = await liveOrSkip("stopBrain")
      if (live) await sweepBrains(live)
    },

    /** Inside the spawn dep, before `workspace create`: no leftover brain workspace survives a respawn. */
    async beforeSpawn(): Promise<void> {
      const live = await liveOrSkip("beforeSpawn")
      if (live) await sweepBrains(live)
    },

    /** POST /hooks/brain/sessions close: same verdict as the sweep, minus the time grace. */
    async close(workspaceId: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const s = await survey({ manual: true })
      const item = s.items.find((x) => x.entry.workspaceId === workspaceId)
      if (!item) {
        const exists = (await herdrWorkspaces(h)).some((w) => w.workspaceId === workspaceId)
        return exists ? { status: 404, body: { ok: false, error: "not_owned" } } : { status: 200, body: { ok: true, closed: workspaceId, gone: true } }
      }
      const e = item.entry
      if (e.verdict !== "close") {
        if (e.reason === "self") return { status: 409, body: { ok: false, error: "self" } }
        if (e.reason.startsWith("running")) return { status: 409, body: { ok: false, error: "running", phase: e.phase ?? null } }
        return { status: 409, body: { ok: false, error: "kept", reason: e.reason } }
      }
      if (s.mode !== "on") return { status: 409, body: { ok: false, error: "observe_only", verdict: e.verdict, reason: e.reason } }
      const out = await act(item)
      if (out === "closed" || out === "gone") return { status: 200, body: { ok: true, closed: workspaceId, ...(out === "gone" ? { gone: true } : {}) } }
      if (out === "changed" || out === "in_flight") return { status: 409, body: { ok: false, error: out } }
      return { status: 502, body: { ok: false, error: "herdr_error" } }
    },

    start(): void {
      if (timer) return
      deps.log(`[brain-workers] reaper mode ${deps.mode()}`)
      timer = setInterval(() => void tick(), WORKER_SWEEP_MS)
      timer.unref?.()
    },

    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

export type BrainWorkers = ReturnType<typeof createBrainWorkers>

export const brainWorkers = createBrainWorkers({
  herdr: realHerdr,
  envOf: (pid) => processEnvEntries(pid),
  sessions: listSessions,
  proposalOf: (id) => {
    const t = getTaskByDispatchId(id)
    return t ? { proposalId: t.taskId, threadId: t.threadId } : null
  },
  snapshot: () => dispatchWiring.snapshot(),
  cached: (id) => dispatchWiring.cached(id),
  fetchTask: async (id) => (await getDispatchTask(dispatchWiring.query, await dispatchWiring.columns(), id))?.task ?? null,
  mode: () => reapMode(process.env.COMPANION_BRAIN_REAP),
  now: Date.now,
  log: companionLog,
  trace: (rows) => { if (rows.length) broadcast({ type: "brain_trace", op: "row", rows }) },
})

/** The brain agent's liveness (wiring/brain.ts alive / agentPane). */
export const brainLiveness = brainWorkers.liveness
