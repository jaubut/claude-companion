import type { Database } from "bun:sqlite"
import {
  classifyBackgroundEventNotification,
  fetchAndMarkUnsurfacedNotifications,
  insertAgentNotification,
  openIsolatedNotificationDb,
} from "./agent-notifications"
import { BRAIN_THREAD, type DeliveryTurn, brainText, fitQueued } from "./brain"
import { classifyBrainEvent } from "./brain-event-triage"
import { companionDbPath } from "./db-path"
import type { OpsTriageDecision, OpsTriageEvent } from "./ops-triage"
import type { Turn } from "./orchestrator-chat"
import { db as defaultDb } from "./orchestrator-db"
import type { TelemetrySink } from "./orchestrator-telemetry"

export function fitPrioritizedTurns(queued: string[], found: DeliveryTurn[]): { turns: DeliveryTurn[]; ids: string[] } {
  const fitted = fitQueued(queued, found)
  if (!found.some((t) => t.role === "user") || fitted.turns.some((t) => t.role === "user")) return fitted
  return fitQueued(queued, [...found.filter((t) => t.role === "user"), ...found.filter((t) => t.role !== "user")])
}

export async function runLegacyPureEventTriage(opts: {
  turns: DeliveryTurn[]
  triageEvents: (events: OpsTriageEvent[]) => Promise<OpsTriageDecision>
  log: (msg: string) => void
  isCurrentGen: () => boolean
  dismissIds: (ids: string[]) => void
  ids: string[]
}): Promise<"aborted" | "ignored" | "escalated"> {
  try {
    const d = await opts.triageEvents(opts.turns.map((t) => ({ id: t.id, text: brainText(t), cardKind: t.card?.kind ?? null })))
    if (!opts.isCurrentGen()) return "aborted"
    if (d.provider !== "none") {
      opts.log(`[brain] ops-triage (${d.mode}) ${d.verdict}→${d.action} [${d.provider}/${d.model} ${d.latencyMs}ms]: ${d.reason}${d.error ? ` (${d.error})` : ""}`)
    }
    if (d.action === "ignore") {
      opts.dismissIds(opts.ids)
      return "ignored"
    }
  } catch (err) {
    if (!opts.isCurrentGen()) return "aborted"
    opts.log(`[brain] ops-triage failed (escalating): ${(err as Error)?.message ?? String(err)}`)
  }
  return "escalated"
}

/** Strip any internal `[event ...]` lines from an interactive assistant reply so none reach the user stream. */
export function scrubInternalEventsFromReply(reply: string): string {
  if (!reply.includes("[event")) return reply
  return reply
    .split("\n")
    .filter((line) => !/^\s*\[event(?:\s+[^\]]+)?\]/i.test(line))
    .join("\n")
    .trim()
}

export interface IsolatedBackgroundLane {
  enqueue(turn: Pick<Turn, "id" | "text" | "createdAt" | "card">): void
  pendingCount(): number
  inFlightCount(): number
  drain(): Promise<void>
  stop(): void
}

/**
 * Lane B: Isolated Background Worker Loop.
 * Processes background events (`ops-triage`, CI wakes, worker receipts, stuck PR alerts) asynchronously
 * with bounded concurrency and an isolated notification sink so Lane A interactive chat never blocks on Lane B.
 */
export function createIsolatedBackgroundLane(opts: {
  triageEvents?: (events: OpsTriageEvent[]) => Promise<OpsTriageDecision>
  notificationSink?: TelemetrySink
  maxConcurrency?: number
  coalesceMs?: number
  log?: (msg: string) => void
  onEscalated?: (turn: Pick<Turn, "id" | "text" | "createdAt" | "card">, notificationId: number | null) => void
}): IsolatedBackgroundLane {
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4)
  const coalesceMs = Math.max(0, opts.coalesceMs ?? 0)
  const queue: Array<Pick<Turn, "id" | "text" | "createdAt" | "card">> = []
  const drainWaiters: Array<() => void> = []
  let ownedDb: Database | null = null
  let inFlight = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function resolveSink(): TelemetrySink {
    if (opts.notificationSink) return opts.notificationSink
    if (ownedDb) return ownedDb
    const path = companionDbPath()
    if (path === ":memory:") return defaultDb
    try {
      ownedDb = openIsolatedNotificationDb(path)
      return ownedDb
    } catch {
      return defaultDb
    }
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function notifyIdle(): void {
    if (inFlight === 0 && queue.length === 0 && !timer) {
      while (drainWaiters.length > 0) {
        drainWaiters.shift()?.()
      }
    }
  }

  async function processBatch(batch: Array<Pick<Turn, "id" | "text" | "createdAt" | "card">>): Promise<void> {
    if (stopped || batch.length === 0) return
    const immediate: Array<Pick<Turn, "id" | "text" | "createdAt" | "card">> = []
    const batchable: Array<Pick<Turn, "id" | "text" | "createdAt" | "card">> = []

    for (const item of batch) {
      const disp = classifyBrainEvent({
        threadId: BRAIN_THREAD,
        role: "orchestrator",
        text: item.text,
        card: item.card ?? null,
      })
      if (disp === "silent") continue
      if (disp === "immediate") immediate.push(item)
      else batchable.push(item)
    }

    const toPersist = [...immediate]

    if (batchable.length > 0) {
      if (opts.triageEvents) {
        try {
          const decision = await opts.triageEvents(
            batchable.map((t) => ({
              id: t.id,
              text: brainText({ id: t.id, text: t.text, createdAt: t.createdAt, card: t.card ?? null, role: "orchestrator" }),
              cardKind: t.card?.kind ?? null,
            })),
          )
          if (decision.provider !== "none") {
            opts.log?.(
              `[lane-b] ops-triage (${decision.mode}) ${decision.verdict}→${decision.action} [${decision.provider}/${decision.model} ${decision.latencyMs}ms]: ${decision.reason}`,
            )
          }
          if (decision.action === "escalate") {
            toPersist.push(...batchable)
          }
        } catch (err) {
          opts.log?.(`[lane-b] ops-triage failed (escalating to notifications): ${(err as Error)?.message ?? String(err)}`)
          toPersist.push(...batchable)
        }
      } else {
        toPersist.push(...batchable)
      }
    }

    for (const item of toPersist) {
      if (stopped) break
      const summaryText = brainText({
        id: item.id,
        text: item.text,
        createdAt: item.createdAt,
        card: item.card ?? null,
        role: "orchestrator",
      })
      const classified = classifyBackgroundEventNotification({
        text: summaryText,
        cardKind: item.card?.kind ?? null,
      })
      let notifId: number | null = null
      try {
        notifId = await insertAgentNotification(resolveSink(), {
          source: classified.source,
          severity: classified.severity,
          summary: classified.summary,
          payload: { turnId: item.id, createdAt: item.createdAt, cardKind: item.card?.kind ?? null },
        })
      } catch (err) {
        opts.log?.(`[lane-b] notification write failed: ${(err as Error)?.message ?? String(err)}`)
      }
      opts.onEscalated?.(item, notifId)
    }
  }

  function pump(): void {
    if (stopped) return
    while (inFlight < maxConcurrency && queue.length > 0) {
      const batch = queue.splice(0, Math.min(queue.length, 8))
      inFlight++
      void processBatch(batch).finally(() => {
        inFlight--
        if (!stopped && queue.length > 0) pump()
        else notifyIdle()
      })
    }
    notifyIdle()
  }

  return {
    enqueue(turn): void {
      if (stopped) return
      const disp = classifyBrainEvent({
        threadId: BRAIN_THREAD,
        role: "orchestrator",
        text: turn.text,
        card: turn.card ?? null,
      })
      if (disp === "silent") return
      queue.push(turn)
      if (disp === "batch" && coalesceMs > 0) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = null
            pump()
          }, coalesceMs)
          timer.unref?.()
        }
        return
      }
      clearTimer()
      pump()
    },
    pendingCount: () => queue.length,
    inFlightCount: () => inFlight,
    drain(): Promise<void> {
      if (timer) {
        clearTimer()
        pump()
      }
      if (inFlight === 0 && queue.length === 0) return Promise.resolve()
      return new Promise((resolve) => {
        drainWaiters.push(resolve)
      })
    },
    stop(): void {
      stopped = true
      clearTimer()
      queue.length = 0
      if (ownedDb) {
        try { ownedDb.close() } catch { /* ignore */ }
        ownedDb = null
      }
      notifyIdle()
    },
  }
}

/** Append unsurfaced `high`/`critical` notifications from Lane B onto a Lane A interactive prompt. */
export async function appendLaneANotifications(
  interactivePrompt: string,
  sink?: TelemetrySink,
): Promise<string> {
  try {
    const block = sink
      ? await fetchAndMarkUnsurfacedNotifications(sink)
      : await fetchAndMarkUnsurfacedNotifications()
    if (!block) return interactivePrompt
    return `${interactivePrompt}\n\n${block}`
  } catch {
    return interactivePrompt
  }
}
