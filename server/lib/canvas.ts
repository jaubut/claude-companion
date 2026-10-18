import type { Database } from "bun:sqlite"
import type { Activity } from "./activity"
import type { Session } from "./sessions"

// Canvas graph store (PRJ-FL49 P5): the Mac board's nodes and edges live on the
// server (companion.db `canvas_nodes` / `canvas_edges`) so every client renders
// the same board and P6's edges can run with the app closed. One board per
// host. Positions are last-write-wins: a move is a single-field fact, no CAS.

export const NODE_KINDS = ["agent", "task", "note", "preview", "group"] as const
export type NodeKind = (typeof NODE_KINDS)[number]
// v1 = Context only (brief decision 1, 2026-10-17).
export const EDGE_KINDS = ["context"] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

export interface CanvasNode {
  id: string
  kind: NodeKind
  /** What the node shows: a Session.key, a Turso task id, a URL; "" for a free note/group. */
  ref: string
  x: number
  y: number
  w: number
  h: number
  /** Kind-specific client payload (note text, host label, …), opaque to the server. */
  data: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface CanvasEdge {
  id: string
  kind: EdgeKind
  from: string
  to: string
  createdAt: number
}

export type NodeInput = Pick<CanvasNode, "kind" | "ref" | "x" | "y" | "w" | "h" | "data"> & { id?: string }
export type NodePatch = Partial<Pick<CanvasNode, "ref" | "x" | "y" | "w" | "h" | "data">>
export type EdgeInput = Pick<CanvasEdge, "kind" | "from" | "to">

export type EdgeAddResult = { ok: true; edge: CanvasEdge } | { ok: false; error: "node_not_found" | "self_edge" | "edge_exists" }

export interface CanvasStore {
  nodes(): CanvasNode[]
  edges(): CanvasEdge[]
  /** created=false: a node with that client-chosen id already exists (returned unchanged). */
  addNode(input: NodeInput, now: number): { node: CanvasNode; created: boolean }
  patchNode(id: string, patch: NodePatch, now: number): CanvasNode | null
  /** Removes the node and every edge touching it; null when unknown. */
  removeNode(id: string): { edgeIds: string[] } | null
  addEdge(input: EdgeInput, now: number): EdgeAddResult
  removeEdge(id: string): boolean
}

interface RawNode { id: string; kind: string; ref: string; x: number; y: number; w: number; h: number; data: string; created_at: number; updated_at: number }
interface RawEdge { id: string; kind: string; from_id: string; to_id: string; created_at: number }

const toNode = (r: RawNode): CanvasNode => ({
  id: r.id, kind: r.kind as NodeKind, ref: r.ref, x: r.x, y: r.y, w: r.w, h: r.h,
  data: JSON.parse(r.data) as Record<string, unknown>, createdAt: r.created_at, updatedAt: r.updated_at,
})
const toEdge = (r: RawEdge): CanvasEdge => ({ id: r.id, kind: r.kind as EdgeKind, from: r.from_id, to: r.to_id, createdAt: r.created_at })

export function createCanvasStore(db: Database): CanvasStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
      data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canvas_edges (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (kind, from_id, to_id)
    );
  `)
  const getNode = (id: string): CanvasNode | null => {
    const r = db.query("SELECT * FROM canvas_nodes WHERE id = ?").get(id) as RawNode | null
    return r ? toNode(r) : null
  }
  const removeNodeTx = db.transaction((id: string): { edgeIds: string[] } | null => {
    if (db.query("DELETE FROM canvas_nodes WHERE id = ?").run(id).changes === 0) return null
    const edgeIds = (db.query("SELECT id FROM canvas_edges WHERE from_id = ? OR to_id = ?").all(id, id) as { id: string }[]).map((e) => e.id)
    db.query("DELETE FROM canvas_edges WHERE from_id = ? OR to_id = ?").run(id, id)
    return { edgeIds }
  })
  return {
    nodes: () => (db.query("SELECT * FROM canvas_nodes ORDER BY created_at, id").all() as RawNode[]).map(toNode),
    edges: () => (db.query("SELECT * FROM canvas_edges ORDER BY created_at, id").all() as RawEdge[]).map(toEdge),
    addNode(input, now) {
      const id = input.id ?? crypto.randomUUID()
      const r = db.query(
        "INSERT OR IGNORE INTO canvas_nodes (id, kind, ref, x, y, w, h, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, input.kind, input.ref, input.x, input.y, input.w, input.h, JSON.stringify(input.data), now, now)
      return { node: getNode(id)!, created: r.changes > 0 }
    },
    patchNode(id, patch, now) {
      const sets: string[] = []
      const args: (string | number)[] = []
      for (const k of ["ref", "x", "y", "w", "h"] as const) {
        if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(patch[k]) }
      }
      if (patch.data !== undefined) { sets.push("data = ?"); args.push(JSON.stringify(patch.data)) }
      sets.push("updated_at = ?")
      args.push(now)
      const r = db.query(`UPDATE canvas_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
      return r.changes > 0 ? getNode(id) : null
    },
    removeNode: (id) => removeNodeTx(id),
    addEdge(input, now) {
      if (input.from === input.to) return { ok: false, error: "self_edge" }
      if (!getNode(input.from) || !getNode(input.to)) return { ok: false, error: "node_not_found" }
      const id = crypto.randomUUID()
      const r = db.query("INSERT OR IGNORE INTO canvas_edges (id, kind, from_id, to_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, input.kind, input.from, input.to, now)
      if (r.changes === 0) return { ok: false, error: "edge_exists" }
      return { ok: true, edge: { id, kind: input.kind, from: input.from, to: input.to, createdAt: now } }
    },
    removeEdge: (id) => db.query("DELETE FROM canvas_edges WHERE id = ?").run(id).changes > 0,
  }
}

// ── Input validation (route boundary) ───────────────────────────────────────

const COORD_MAX = 1e7
const SIZE_MAX = 1e5
const REF_MAX = 500
const ID_MAX = 100
const DATA_MAX = 16_000

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isCoord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= COORD_MAX
const isSize = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= SIZE_MAX

// Fields shared by create and patch; `required` makes x/y/w/h mandatory.
function parseFields(b: Record<string, unknown>, required: boolean): Parsed<NodePatch> {
  const out: NodePatch = {}
  for (const k of ["x", "y"] as const) {
    if (b[k] === undefined && !required) continue
    if (!isCoord(b[k])) return { ok: false, error: `invalid_${k}` }
    out[k] = b[k]
  }
  for (const k of ["w", "h"] as const) {
    if (b[k] === undefined && !required) continue
    if (!isSize(b[k])) return { ok: false, error: `invalid_${k}` }
    out[k] = b[k]
  }
  if (b.ref !== undefined) {
    if (typeof b.ref !== "string" || b.ref.length > REF_MAX) return { ok: false, error: "invalid_ref" }
    out.ref = b.ref
  }
  if (b.data !== undefined) {
    if (!isObj(b.data) || JSON.stringify(b.data).length > DATA_MAX) return { ok: false, error: "invalid_data" }
    out.data = b.data
  }
  return { ok: true, value: out }
}

export function parseNodeInput(raw: unknown): Parsed<NodeInput> {
  if (!isObj(raw)) return { ok: false, error: "invalid_body" }
  if (!NODE_KINDS.includes(raw.kind as NodeKind)) return { ok: false, error: "invalid_kind" }
  if (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id || raw.id.length > ID_MAX)) return { ok: false, error: "invalid_id" }
  const f = parseFields(raw, true)
  if (!f.ok) return f
  const { x, y, w, h } = f.value as Required<Pick<NodePatch, "x" | "y" | "w" | "h">>
  return { ok: true, value: { id: raw.id as string | undefined, kind: raw.kind as NodeKind, ref: f.value.ref ?? "", x, y, w, h, data: f.value.data ?? {} } }
}

export function parseNodePatch(raw: unknown): Parsed<NodePatch> {
  if (!isObj(raw)) return { ok: false, error: "invalid_body" }
  const f = parseFields(raw, false)
  if (f.ok && Object.keys(f.value).length === 0) return { ok: false, error: "empty_patch" }
  return f
}

export function parseEdgeInput(raw: unknown): Parsed<EdgeInput> {
  if (!isObj(raw)) return { ok: false, error: "invalid_body" }
  const kind = raw.kind ?? "context"
  if (!EDGE_KINDS.includes(kind as EdgeKind)) return { ok: false, error: "invalid_kind" }
  for (const k of ["from", "to"] as const) {
    const v = raw[k]
    if (typeof v !== "string" || !v || v.length > ID_MAX) return { ok: false, error: `invalid_${k}` }
  }
  return { ok: true, value: { kind: kind as EdgeKind, from: raw.from as string, to: raw.to as string } }
}

// ── Tri-state session status ────────────────────────────────────────────────
//
// The one status every canvas client colours a node with, computed here so the
// Mac, iPad and phone never disagree:
//   needs-you — an approval, question or dialog blocks on Jeremie
//   working   — a live activity pill (a turn is running)
//   resting   — neither; a finished turn (`turn-end`) rests, it doesn't block
// needs-you outranks working: a pill can still be up while an approval waits.

export type CanvasStatus = "working" | "resting" | "needs-you"

const BLOCKING = new Set(["approval", "question", "dialog"])

export function sessionStatuses(sessions: Session[], activities: Activity[]): Record<string, CanvasStatus> {
  const busy = new Set(activities.map((a) => a.key).filter(Boolean))
  const out: Record<string, CanvasStatus> = {}
  for (const s of sessions) {
    out[s.key] = s.waitingReasons.some((r) => BLOCKING.has(r.kind)) ? "needs-you" : busy.has(s.key) ? "working" : "resting"
  }
  return out
}
