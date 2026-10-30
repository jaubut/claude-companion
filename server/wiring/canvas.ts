import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { companionDbPath } from "../lib/db-path"
import { type CanvasEdge, type CanvasNode, type CanvasStatus, type CanvasStore, type SendResult, contextPrompt, createCanvasStore, referenceContext, sessionStatuses } from "../lib/canvas"
import { listActivities, onActivity } from "../lib/activity"
import { companionLog } from "../lib/log"
import { listSessions, onSessions } from "../lib/sessions"
import { tursoQuery } from "../lib/turso"
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
  // Setting `ref` (re)binds the node to whichever agent holds that session right now.
  addNode: (input, now) => openStore().addNode({ ...input, boundSid: sidOf(input.ref) }, now),
  patchNode: (id, patch, now) => openStore().patchNode(id, patch.ref === undefined ? patch : { ...patch, boundSid: sidOf(patch.ref) }, now),
  removeNode: (id) => openStore().removeNode(id),
  addEdge: (input, now) => openStore().addEdge(input, now),
  removeEdge: (id) => openStore().removeEdge(id),
  node: (id) => openStore().node(id),
  edge: (id) => openStore().edge(id),
  claimEdge: (id, now) => openStore().claimEdge(id, now),
  references: (target) => openStore().references(target),
  settleEdge: (id, result, now) => openStore().settleEdge(id, result, now),
}

// P6 Context edge send: the server reads the source (Turso task / note, or the
// sticky's text) at send time and types it into the agent node's session through
// the same guarded path as a phone inject (deliverInject: refusals, pane lock,
// submit confirmation). Local sessions only: a node bound to the other host's
// session answers that host's 410 target_gone, like an inject to a gone key.
// ponytail: no per-edge auto-send yet; add it on the Phase 7 trust ramp when Jeremie asks.
// The guarded inject behind POST /api/inject (routes/api.ts). Handed in by
// companion-server.ts at boot: wiring never imports up into routes/.
type Deliver = (text: string, key?: string, cwd?: string) => Promise<Response>
let deliver: Deliver | null = null
export function setCanvasDeliver(fn: Deliver): void {
  deliver = fn
}

function sidOf(ref: string): string {
  return ref ? listSessions().find((s) => s.key === ref)?.sessionId ?? "" : ""
}

export async function canvasSend(edge: CanvasEdge): Promise<SendResult> {
  const from = canvasStore.node(edge.from)
  const to = canvasStore.node(edge.to)
  if (!from || !to) return { ok: false, status: 404, error: "node_not_found" }
  // An empty key would make deliverInject fall back to the frontmost session.
  if (!to.ref) return { ok: false, status: 410, error: "target_gone" }
  const live = listSessions().find((s) => s.key === to.ref)
  if (!live) return { ok: false, status: 410, error: "target_gone" }
  // The key is tty-based: another agent on that tty would pass every inject guard. Re-pointing rebinds.
  if (!live.sessionId || live.sessionId !== to.boundSid) return { ok: false, status: 409, error: "target_changed" }
  const prompt = await contextPrompt(from, tursoQuery)
  if (!prompt.ok) return { ok: false, status: prompt.error === "source_not_found" ? 404 : 400, error: prompt.error }
  companionLog(`canvas send ${edge.id}: ${from.kind} ${from.ref || from.id} → ${to.ref}`)
  if (!deliver) return { ok: false, status: 503, error: "deliver_unavailable" }
  const res = await deliver(prompt.text, to.ref)
  const body = (await res.json()) as Record<string, unknown>
  if (res.ok && body.ok === true) return { ok: true }
  return { ok: false, status: res.ok ? 502 : res.status, error: typeof body.error === "string" ? body.error : "deliver_failed", detail: body }
}

// canvas-note-refs: the note nodes linked to whoever sent a prompt — a session (its agent node,
// bound to this exact session id, the same tty-reuse rule as a send) or the brain.
// A key alone (GET /api/canvas/linked-notes) means the session live on it now.
export function referencesFor(who: { key?: string; sessionId?: string; brain?: boolean }): CanvasNode[] {
  if (who.brain) return canvasStore.references("brain")
  const sid = who.sessionId || sidOf(who.key ?? "")
  return who.key && sid ? canvasStore.references({ key: who.key, sid }) : []
}

// The UserPromptSubmit context block (routes/hooks.ts). Local sqlite only, inside the hook's 1 s
// budget; any error is "" so it can never cost the prompt its fromPhone note.
export function canvasHookContext(who: { key?: string; sessionId?: string; brain?: boolean }): string {
  try {
    return referenceContext(referencesFor(who))
  } catch (err) {
    console.error("[canvas] hook context failed:", err)
    return ""
  }
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
// Also null on a db error: ws.ts calls this between init and the approval/question
// replay, and a throw there would leave the phone with its pending items wiped.
export function canvasSnapshot(): Record<string, unknown> | null {
  try {
    const nodes = canvasStore.nodes()
    if (nodes.length === 0) return null
    return { type: "canvas", op: "snapshot", host: HOST_INFO.name, nodes, edges: canvasStore.edges(), status: canvasStatus() }
  } catch (err) {
    console.error("[canvas] snapshot failed:", err)
    return null
  }
}
