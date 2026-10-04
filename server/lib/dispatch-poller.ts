import type { ApnsPayload } from "./apns"
import { BODY_CHANNEL } from "./body"
import {
  type DispatchColumns,
  type DispatchTask,
  type LiveIdentity,
  type AnyProjectRef,
  type ProjectRef,
  type TaskDto,
  detectColumns,
  dispatchToDto,
  effectiveStatus,
  listDispatchTasks,
  listAllProjects,
  listProjects,
  phaseOf,
} from "./dispatch-tasks"
import type { Channel } from "./orchestrator-channels"
import type { Turn } from "./orchestrator-chat"
import { type ExecFn, type QueryFn, TursoUnreachable } from "./turso"

// Turso dispatch poller core (orchestrator-one-queue P1). Status flows from the
// record: every 20 s (or on a /hooks/dispatch-event nudge) read the agent
// tasks, diff each against the persisted announce cursor, and on a change emit
// `orchestrator_task`; a move into blocked / pr / completed / done appends one
// turn in the owning channel, and blocked / pr push when the host owns pushes.
// Channel counts and the `orchestrator_queue` frame follow. Pure over injected
// seams (no sqlite import) — wiring/dispatch.ts builds the one live instance.

export interface DispatchCounts { queued: number; running: number; blocked: number; pr: number }
export type ChannelWithCounts = Channel & { counts: DispatchCounts }
export interface QueueSummary { cap: number; live: number; queued: number; dispatch: DispatchCounts }

export interface Seen { phase: string; updatedAt: string; key: string }

/** The persisted announce cursor (lib/dispatch-mirror.ts in production). */
export interface Mirror {
  seenKey(t: DispatchTask): string
  lastSeen(taskId: string): Seen | null
  markSeen(t: DispatchTask, now?: number): void
  seenCount(): number
  pruneSeen(keep: ReadonlySet<string>, maxAgeMs: number, now?: number): number
}

export interface DispatchWiringDeps {
  query: QueryFn
  /** Guarded writes (P2). Absent → every write fails as turso_unreachable. */
  exec?: ExecFn
  broadcast: (frame: Record<string, unknown>) => void
  appendTurn: (text: string, taskId: string, channelId: string) => Turn
  push: (payload: ApnsPayload) => void
  pushEnabled: () => boolean
  linkedNotes: () => Map<string, string>
  getChannel: (id: string) => Channel | null
  localQueue: () => { cap: number; live: number; queued: number }
  /** Live mode (P4): the local tmux worker behind a Turso id, if any. */
  liveIdentity?: (dispatchTaskId: string) => LiveIdentity | null
  mirror: Mirror
  /** The catch-all channel id (orchestrator-db GENERAL_CHANNEL). */
  generalChannel: string
  now?: () => number
  log?: (msg: string) => void
  pollMs?: number
  nudgeMinMs?: number
  columnsTtlMs?: number
}

const ANNOUNCE = new Set(["blocked", "pr", "completed", "done"])
const PUSH = new Set(["blocked", "pr"])
const MAX_PUSHES_PER_POLL = 3
const PROJECTS_TTL_MS = 5 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000
const SEEN_MAX_AGE_MS = 30 * 24 * 60 * 60_000

const zero = (): DispatchCounts => ({ queued: 0, running: 0, blocked: 0, pr: 0 })
const DIGEST_MAX = 800
const DIGEST_BLOCKED = 5

const noExec: ExecFn = async () => { throw new TursoUnreachable("no writer configured") }

/**
 * The brain's dispatch context (P2/P3): counts, then the top blocked tasks with
 * their reasons, ≤ 800 chars. `scope` names the view ("#Dash", "all projects").
 */
export function buildDispatchDigest(scope: string, counts: DispatchCounts, blocked: DispatchTask[], max = DIGEST_MAX): string {
  const head = `Dispatch queue (${scope}): ${counts.queued} queued · ${counts.running} running · ${counts.blocked} blocked · ${counts.pr} PR open`
  const lines = [head]
  if (blocked.length) lines.push("Blocked (answer one to requeue it):")
  for (const t of blocked.slice(0, DIGEST_BLOCKED)) {
    const where = t.projectTitle ? ` (${t.projectTitle})` : ""
    lines.push(`- [${short(t.id)}] ${t.agent ?? "agent"} — ${t.title}${where}: ${(t.blocker ?? "unspecified").replace(/\s+/g, " ").slice(0, 160)}`)
  }
  if (blocked.length > DIGEST_BLOCKED) lines.push(`…and ${blocked.length - DIGEST_BLOCKED} more blocked`)
  const out = lines.join("\n")
  return out.length <= max ? out : `${out.slice(0, max - 1)}…`
}

function short(id: string): string {
  return id.slice(0, 8)
}

/** The thread turn for a task that just moved into an announced phase. */
export function turnText(t: DispatchTask, phase: string): string {
  const who = `[${short(t.id)}] ${t.agent ?? "agent"} — ${t.title}`
  if (phase === "blocked") return `blocked ${who}\nReason: ${t.blocker ?? "unspecified"}`
  if (phase === "pr") return `PR ready ${who}\n${t.prUrl}${t.blocker ? ` · ${t.blocker}` : ""}`
  if (phase === "completed") return `completed ${who}${t.resultRef ? `\nResult: ${t.resultRef}` : ""}`
  return `done ${who}${t.prUrl ? `\n${t.prUrl}` : ""}`
}

export function pushPayload(t: DispatchTask, phase: string, channelId: string): ApnsPayload {
  const blocked = phase === "blocked"
  return {
    title: `${blocked ? "Blocked" : "PR ready"}: ${t.title}`.slice(0, 120),
    body: ((blocked ? t.blocker : t.prUrl) ?? t.projectTitle ?? "").slice(0, 180),
    category: "dispatch_task",
    threadId: channelId,
    collapseId: `dispatch-${t.id}`.slice(0, 64),
    interruptionLevel: "active",
    userInfo: { kind: "dispatch_task", taskId: t.id, channel: channelId },
  }
}

export function createDispatchWiring(deps: DispatchWiringDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((msg: string) => console.error(msg))
  const mirror = deps.mirror
  const GENERAL_CHANNEL = deps.generalChannel
  const pollMs = deps.pollMs ?? 20_000
  const nudgeMinMs = deps.nudgeMinMs ?? 2_000
  const columnsTtlMs = deps.columnsTtlMs ?? 10 * 60_000

  let cache: DispatchTask[] = []
  let polledOk = false
  let failing = false
  let inflight: Promise<boolean> | null = null
  let cols: { value: DispatchColumns; at: number } | null = null
  let projectsCache: { value: ProjectRef[]; at: number } | null = null
  let allProjectsCache: { value: AnyProjectRef[]; at: number } | null = null
  let lastNudge = -Infinity
  let trailing: ReturnType<typeof setTimeout> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let lastPrune = 0
  let lastQueueKey = ""
  let lastChannelCounts = new Map<string, string>()

  // Optional P0 columns, probed once and re-probed every 10 min (or after a
  // failed poll) so an ALTER on the live schema is picked up without a restart.
  async function columns(): Promise<DispatchColumns> {
    if (cols && now() - cols.at < columnsTtlMs) return cols.value
    cols = { value: await detectColumns(deps.query), at: now() }
    return cols.value
  }

  function threadIdFor(t: DispatchTask, links: Map<string, string> = deps.linkedNotes()): string {
    return links.get(t.noteId) ?? GENERAL_CHANNEL
  }

  function countsOf(tasks: DispatchTask[]): DispatchCounts {
    const c = zero()
    for (const t of tasks) {
      if (t.done) continue
      const s = effectiveStatus(t)
      if (s === "queued" || s === "running" || s === "blocked" || s === "pr") c[s]++
    }
    return c
  }

  function inChannel(channelId: string, links: Map<string, string>): DispatchTask[] {
    if (channelId === BODY_CHANNEL) return cache.filter((t) => t.status === "blocked" && !t.done)
    return cache.filter((t) => threadIdFor(t, links) === channelId)
  }

  // Live rows (owner companion:*) carry their tmux worker's identity.
  function toDto(t: DispatchTask, links: Map<string, string>): TaskDto {
    const live = t.owner?.startsWith("companion:") ? deps.liveIdentity?.(t.id) ?? null : null
    return dispatchToDto(t, threadIdFor(t, links), live)
  }

  function tasksFor(channelId: string): TaskDto[] {
    const links = deps.linkedNotes()
    return inChannel(channelId, links).map((t) => toDto(t, links))
  }

  function countsFor(channelId: string): DispatchCounts {
    return countsOf(inChannel(channelId, deps.linkedNotes()))
  }

  function decorate(ch: Channel): ChannelWithCounts {
    return { ...ch, counts: countsFor(ch.id) }
  }

  function queueSummary(): QueueSummary {
    return { ...deps.localQueue(), dispatch: countsOf(cache) }
  }

  function emitTask(t: DispatchTask, links: Map<string, string>): void {
    deps.broadcast({ type: "orchestrator_task", task: toDto(t, links) })
  }

  // Per-channel count changes → `orchestrator_channel`; global → `orchestrator_queue`.
  function emitAggregates(links: Map<string, string>): void {
    const ids = new Set([...lastChannelCounts.keys(), ...links.values(), GENERAL_CHANNEL, BODY_CHANNEL])
    const next = new Map<string, string>()
    for (const id of ids) {
      const key = JSON.stringify(countsOf(inChannel(id, links)))
      next.set(id, key)
      if (lastChannelCounts.get(id) === key) continue
      const ch = deps.getChannel(id)
      if (ch && !ch.archived) deps.broadcast({ type: "orchestrator_channel", channel: decorate(ch) })
    }
    lastChannelCounts = next
    const q = queueSummary()
    const qKey = JSON.stringify(q)
    if (qKey !== lastQueueKey) deps.broadcast({ type: "orchestrator_queue", queue: q })
    lastQueueKey = qKey
  }

  function announce(list: DispatchTask[], links: Map<string, string>): void {
    // Fresh cursor (first ever poll): seed silently, or the last 7 days would
    // flood the thread. First poll of this boot: turns yes (catch-up of real
    // transitions while down), pushes no.
    const seeding = mirror.seenCount() === 0
    const pushAllowed = polledOk && deps.pushEnabled()
    let pushes = 0
    let overflow = 0
    for (const t of list) {
      const prev = mirror.lastSeen(t.id)
      if (prev && prev.key === mirror.seenKey(t)) continue
      mirror.markSeen(t, now())
      emitTask(t, links)
      const phase = phaseOf(t)
      if (seeding || prev?.phase === phase || !ANNOUNCE.has(phase)) continue
      const channelId = threadIdFor(t, links)
      deps.broadcast({ type: "orchestrator", turn: deps.appendTurn(turnText(t, phase), t.id, channelId) })
      if (!pushAllowed || !PUSH.has(phase)) continue
      if (pushes < MAX_PUSHES_PER_POLL) { deps.push(pushPayload(t, phase, channelId)); pushes++ } else overflow++
    }
    if (overflow > 0) {
      deps.push({
        title: "Dispatch", body: `${overflow} more blocked / PR updates`, category: "dispatch_task",
        collapseId: "dispatch-overflow", interruptionLevel: "active", userInfo: { kind: "dispatch_task" },
      })
    }
  }

  async function pollOnce(): Promise<boolean> {
    let list: DispatchTask[]
    try {
      list = await listDispatchTasks(deps.query, await columns())
    } catch (err) {
      cols = null
      if (!failing) log(`[dispatch] poll failed (${(err as Error)?.message ?? "error"})`)
      failing = true
      return false
    }
    if (failing) log("[dispatch] poll recovered")
    failing = false
    const links = deps.linkedNotes()
    announce(list, links)
    cache = list
    polledOk = true
    emitAggregates(links)
    if (now() - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = now()
      mirror.pruneSeen(new Set(list.map((t) => t.id)), SEEN_MAX_AGE_MS, now())
    }
    return true
  }

  /** Single-flight: a poll requested while one runs shares it. */
  function poll(): Promise<boolean> {
    inflight ??= pollOnce().finally(() => { inflight = null })
    return inflight
  }

  /** A push is only a nudge: poll now, at most once per 2 s; a nudge inside the window arms one trailing poll. */
  function nudge(): boolean {
    const wait = lastNudge + nudgeMinMs - now()
    if (wait <= 0) {
      lastNudge = now()
      void poll()
      return true
    }
    trailing ??= setTimeout(() => { trailing = null; lastNudge = now(); void poll() }, wait)
    ;(trailing as unknown as { unref?: () => void }).unref?.()
    return false
  }

  function start(): void {
    if (timer) return
    void poll()
    timer = setInterval(() => void poll(), pollMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    if (trailing) clearTimeout(trailing)
    timer = null
    trailing = null
  }

  // A channel ↔ note link changed: those notes' tasks now route elsewhere.
  function relink(noteIds: string[]): void {
    const links = deps.linkedNotes()
    for (const t of cache) if (noteIds.includes(t.noteId)) emitTask(t, links)
    emitAggregates(links)
  }

  // A Companion write just landed (P2): show it now instead of on the next poll.
  // Marked seen so the poll does not emit it twice; queued / cancelled are never
  // announced, so nothing is skipped.
  function applyLocal(t: DispatchTask): void {
    const links = deps.linkedNotes()
    cache = [t, ...cache.filter((c) => c.id !== t.id)]
    mirror.markSeen(t, now())
    emitTask(t, links)
    emitAggregates(links)
  }

  // Blocked tasks in this view (#Body: every note), oldest block first.
  function digestFor(channelId: string, scope: string): string | null {
    if (!polledOk) return null
    const links = deps.linkedNotes()
    const view = channelId === BODY_CHANNEL ? cache : inChannel(channelId, links)
    const blocked = view.filter((t) => t.status === "blocked" && !t.done).sort((a, b) => a.updatedAt - b.updatedAt)
    return buildDispatchDigest(scope, countsOf(view), blocked)
  }

  async function projects(fresh = false): Promise<ProjectRef[]> {
    if (!fresh && projectsCache && now() - projectsCache.at < PROJECTS_TTL_MS) return projectsCache.value
    projectsCache = { value: await listProjects(deps.query), at: now() }
    return projectsCache.value
  }

  /** Every project note, any status (front door + brain); same 5 min cache. */
  async function allProjects(fresh = false): Promise<AnyProjectRef[]> {
    if (!fresh && allProjectsCache && now() - allProjectsCache.at < PROJECTS_TTL_MS) return allProjectsCache.value
    allProjectsCache = { value: await listAllProjects(deps.query), at: now() }
    return allProjectsCache.value
  }

  return {
    query: deps.query, exec: deps.exec ?? noExec, columns, poll, nudge, start, stop, projects, allProjects,
    /** The last polled task list; null before the first successful poll. */
    snapshot: (): DispatchTask[] | null => (polledOk ? cache : null),
    tasksFor, countsFor, decorate, queueSummary, threadIdFor, digestFor, applyLocal,
    cached: (id: string): DispatchTask | null => cache.find((t) => t.id === id) ?? null,
    relink,
    /** Re-send a cached task's frame (its live worker identity changed); false when not cached. */
    reemit(id: string): boolean {
      const t = cache.find((c) => c.id === id)
      if (t) emitTask(t, deps.linkedNotes())
      return !!t
    },
    /** The DTO the wire would carry for a task (live identity merged). */
    dto: (t: DispatchTask): TaskDto => toDto(t, deps.linkedNotes()),
  }
}

export type DispatchWiring = ReturnType<typeof createDispatchWiring>
