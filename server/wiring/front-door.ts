import { randomUUID } from "node:crypto"
import type { BodyResponse } from "../lib/body"
import { createFrontDoor } from "../lib/front-door"
import { decideRoute, minConfidence, routerMode } from "../lib/jev-router"
import { ensureRouteLog, insertRouteLog } from "../lib/jev-route-log"
import { companionLog } from "../lib/log"
import { appendTurn, getThread } from "../lib/orchestrator-chat"
import { db } from "../lib/orchestrator-db"
import { runQuickLookCli } from "../lib/quick-look"
import { buildStatusAnswer, scopeTasks } from "../lib/status-answer"
import { broadcast } from "../state"
import { bodySnapshot } from "./body"
import { dispatchWiring } from "./dispatch"
import { applyDecision, brainCatalog, orchEmit, runBrain } from "./orchestrator"
import { tasksChat } from "./tasks-agent"

// The live front door (lib/front-door.ts): real Jev, sqlite shadow log,
// the dispatch poller's cache, the Body snapshot, and the old brain.
// COMPANION_JEV_ROUTER=off|shadow|live (default shadow), COMPANION_JEV_MIN_CONF (0.7).

ensureRouteLog(db)

const BODY_TIMEOUT_MS = 1_200

async function bodyOrNull(): Promise<BodyResponse | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), BODY_TIMEOUT_MS) })
  try {
    return await Promise.race([bodySnapshot.get().catch(() => null), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export const frontDoor = createFrontDoor({
  mode: () => routerMode(),
  minConf: () => minConfidence(),
  catalog: () => brainCatalog(dispatchWiring),
  decide: (input, catalog, opts) => decideRoute(input, catalog, opts),
  thread: (channelId) => getThread(channelId),
  runBrain: (text, channel, hints) => runBrain(text, channel, dispatchWiring, hints),
  async status(project) {
    const q = dispatchWiring.queueSummary()
    return buildStatusAnswer({
      tasks: scopeTasks(dispatchWiring.snapshot(), project?.noteId ?? null),
      local: { cap: q.cap, live: q.live, queued: q.queued },
      body: await bodyOrNull(),
      scope: project?.title ?? "all projects",
      now: Date.now(),
    })
  },
  quickLook: runQuickLookCli,
  emitTurn: (text, channelId) => orchEmit(appendTurn("orchestrator", text, null, channelId)),
  // Same frame as a real turn, so the shipped iOS build renders it; never persisted,
  // so it is not in the thread history (or the brain's prompt) after a reload.
  // OFF by default: shipped iOS builds merge turns by id and never drop an `ack-`
  // turn, so it would stay under the real answer until relaunch. Enable with
  // COMPANION_BRAIN_ACK=1 once the app clears `ack-` turns on the next real one.
  emitTransient: (text, channelId) => {
    if (process.env.COMPANION_BRAIN_ACK !== "1") return
    broadcast({ type: "orchestrator", turn: { id: `ack-${randomUUID().slice(0, 8)}`, threadId: channelId, role: "orchestrator", text, taskId: null, createdAt: Date.now() } })
  },
  stageProposal: (d, channel, projects) => applyDecision(d, channel, projects),
  log(row) {
    try {
      insertRouteLog(db, row)
    } catch (err) {
      companionLog(`[front-door] route log write failed (${(err as Error)?.message ?? "error"})`)
    }
  },
  tasks: tasksChat,
  onError: (msg) => companionLog(`[front-door] ${msg}`),
})
