import { apnsConfigured } from "../lib/apns"
import * as mirror from "../lib/dispatch-mirror"
import { type DispatchWiring, createDispatchWiring } from "../lib/dispatch-poller"
import { companionLog } from "../lib/log"
import { appendTurn, countLiveTasks, getTaskByDispatchId, listQueued } from "../lib/orchestrator-chat"
import { getChannel, linkedNotes } from "../lib/orchestrator-channels"
import { GENERAL_CHANNEL } from "../lib/orchestrator-db"
import { wipCap } from "../lib/orchestrator-queue"
import { pushToAll } from "../lib/push"
import { tursoExec, tursoQuery } from "../lib/turso"
import { broadcast } from "../state"

// The live Turso dispatch poller (orchestrator-one-queue P1): real Turso, the
// sqlite announce cursor, WS broadcast, APNs. Started by cli.ts; nudged by
// POST /hooks/dispatch-event. Policy lives in lib/dispatch-poller.ts.

export type { DispatchWiring } from "../lib/dispatch-poller"


/** Push only from the host that owns dispatch pushes (Zettlab: COMPANION_DISPATCH_PUSH=1). */
export function dispatchPushEnabled(senderConfigured: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return senderConfigured && env.COMPANION_DISPATCH_PUSH?.trim() === "1"
}

const polledListeners = new Set<() => void>()

/** Run `fn` after every successful dispatch poll / applied local write (wiring/triage.ts). */
export function onDispatchPolled(fn: () => void): () => void {
  polledListeners.add(fn)
  return () => polledListeners.delete(fn)
}

export const dispatchWiring: DispatchWiring = createDispatchWiring({
  query: tursoQuery,
  exec: tursoExec,
  broadcast,
  appendTurn: (text, taskId, channelId) => appendTurn("orchestrator", text, taskId, channelId),
  push: (payload) => void pushToAll(payload).catch(() => { /* a failed push never breaks the poll */ }),
  pushEnabled: () => dispatchPushEnabled(apnsConfigured()),
  linkedNotes,
  mirror,
  generalChannel: GENERAL_CHANNEL,
  log: companionLog,
  onPolled: () => { for (const fn of polledListeners) fn() },
  getChannel,
  localQueue: () => ({ cap: wipCap(), live: countLiveTasks(), queued: listQueued().length }),
  liveIdentity: (id) => {
    const t = getTaskByDispatchId(id)
    return t ? { localTaskId: t.taskId, tmuxSession: t.tmuxSession, tmuxSocket: t.tmuxSocket ?? null, sessionKey: t.sessionKey, logTail: t.logTail } : null
  },
})
