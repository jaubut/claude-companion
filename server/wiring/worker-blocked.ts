import { BRAIN_THREAD, brainEnabled } from "../lib/brain"
import { appendTurn, findWorkerAlert, getTurn, openWorkerAlertIds, setTurnCard } from "../lib/orchestrator-chat"
import { GENERAL_CHANNEL } from "../lib/orchestrator-db"
import { pushToAll } from "../lib/push"
import { createWorkerBlocked, pushWithRetry } from "../lib/worker-blocked"
import { broadcast } from "../state"

// The live blocked-worker alerts (lib/worker-blocked.ts): the brain thread on the
// brain host, #General elsewhere; APNs to every paired phone.

export const workerBlocked = createWorkerBlocked({
  appendTurn: (text, card) => appendTurn("orchestrator", text, null, brainEnabled() ? BRAIN_THREAD : GENERAL_CHANNEL, card),
  getTurn,
  setCard: setTurnCard,
  findByPostKey: findWorkerAlert,
  openIds: openWorkerAlertIds,
  broadcast,
  push: (payload) => void pushWithRetry(pushToAll, payload).then((ok) => {
    if (!ok) console.warn(`[worker-blocked] push failed after retries (${payload.collapseId})`)
  }),
})

setInterval(() => workerBlocked.sweep(), 60_000).unref()
