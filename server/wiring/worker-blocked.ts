import { BRAIN_THREAD, brainEnabled } from "../lib/brain"
import { appendTurn, getTurn, setTurnCard } from "../lib/orchestrator-chat"
import { GENERAL_CHANNEL } from "../lib/orchestrator-db"
import { pushToAll } from "../lib/push"
import { createWorkerBlocked } from "../lib/worker-blocked"
import { broadcast } from "../state"

// The live blocked-worker alerts (lib/worker-blocked.ts): the brain thread on the
// brain host, #General elsewhere; APNs to every paired phone.

export const workerBlocked = createWorkerBlocked({
  appendTurn: (text, card) => appendTurn("orchestrator", text, null, brainEnabled() ? BRAIN_THREAD : GENERAL_CHANNEL, card),
  getTurn,
  setCard: setTurnCard,
  broadcast,
  push: (payload) => void pushToAll(payload).catch(() => { /* a failed push never fails the alert */ }),
})
