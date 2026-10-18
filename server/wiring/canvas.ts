import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { companionDbPath } from "../lib/db-path"
import { type CanvasStatus, type CanvasStore, createCanvasStore, sessionStatuses } from "../lib/canvas"
import { listActivities, onActivity } from "../lib/activity"
import { listSessions, onSessions } from "../lib/sessions"
import { HOST_INFO, broadcast } from "../state"

// Live canvas (PRJ-FL49 P5): the store on companion.db (its own lazy connection)
// and the tri-state status, pushed as `canvas` frames. Ops:
//   snapshot     { host, nodes, edges, status }      — on WS open (ws.ts), non-empty board only
//   node         { node }                            — created or moved/edited
//   node_removed { id, edgeIds }
//   edge         { edge }
//   edge_removed { id }
//   status       { status: { [sessionKey]: state } } — only when it changed
// Status rides the sessions + activity listeners; the activity heartbeat ticks
// every 1.5 s, so a frame goes out only when the map actually differs.

// Opened lazily, on first use, at companionDbPath() like the other stores: ws.ts
// imports this module, so an eager open (or importing orchestrator-db) would pin
// the db before a test points COMPANION_DB_PATH at its own fixture.
let store: CanvasStore | null = null

function openStore(): CanvasStore {
  if (!store) {
    const path = companionDbPath()
    mkdirSync(dirname(path), { recursive: true })
    const d = new Database(path)
    d.exec("PRAGMA busy_timeout = 3000") // companion.db is shared with other stores
    store = createCanvasStore(d)
  }
  return store
}

export const canvasStore: CanvasStore = {
  nodes: () => openStore().nodes(),
  edges: () => openStore().edges(),
  addNode: (input, now) => openStore().addNode(input, now),
  patchNode: (id, patch, now) => openStore().patchNode(id, patch, now),
  removeNode: (id) => openStore().removeNode(id),
  addEdge: (input, now) => openStore().addEdge(input, now),
  removeEdge: (id) => openStore().removeEdge(id),
}

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
