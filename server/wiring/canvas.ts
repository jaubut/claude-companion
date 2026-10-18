import { db } from "../lib/orchestrator-db"
import { type CanvasStatus, type CanvasStore, createCanvasStore, sessionStatuses } from "../lib/canvas"
import { listActivities, onActivity } from "../lib/activity"
import { listSessions, onSessions } from "../lib/sessions"
import { HOST_INFO, broadcast } from "../state"

// Live canvas (PRJ-FL49 P5): the store on the shared companion.db connection
// and the tri-state status, pushed as `canvas` frames. Ops:
//   snapshot     { host, nodes, edges, status }      — on WS open (ws.ts), non-empty board only
//   node         { node }                            — created or moved/edited
//   node_removed { id, edgeIds }
//   edge         { edge }
//   edge_removed { id }
//   status       { status: { [sessionKey]: state } } — only when it changed
// Status rides the sessions + activity listeners; the activity heartbeat ticks
// every 1.5 s, so a frame goes out only when the map actually differs.

export const canvasStore: CanvasStore = createCanvasStore(db)

let lastStatus: Record<string, CanvasStatus> = sessionStatuses(listSessions(), listActivities())

export function canvasStatus(): Record<string, CanvasStatus> {
  return lastStatus
}

function refreshStatus(): void {
  const next = sessionStatuses(listSessions(), listActivities())
  if (sameStatus(lastStatus, next)) return
  lastStatus = next
  broadcast({ type: "canvas", op: "status", status: next })
}

function sameStatus(a: Record<string, CanvasStatus>, b: Record<string, CanvasStatus>): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

onSessions(refreshStatus)
onActivity(refreshStatus)

// null on an empty board (no frame on open, like copy_jobs); GET /api/canvas always answers.
export function canvasSnapshot(): Record<string, unknown> | null {
  const nodes = canvasStore.nodes()
  if (nodes.length === 0) return null
  return { type: "canvas", op: "snapshot", host: HOST_INFO.name, nodes, edges: canvasStore.edges(), status: canvasStatus() }
}
