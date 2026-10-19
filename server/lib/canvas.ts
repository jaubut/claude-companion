import type { Database } from "bun:sqlite"
import type { Activity } from "./activity"
import type { Session } from "./sessions"
import type { QueryFn } from "./turso"

// Canvas graph store (PRJ-FL49 P5): the Mac board's nodes and edges live on the
// server (companion.db `canvas_nodes` / `canvas_edges`) so every client renders
// the same board and P6's edges can run with the app closed. One board per
// host. Positions are last-write-wins: a move is a single-field fact, no CAS.

export const NODE_KINDS = ["agent", "task", "note", "preview", "group"] as const
export type NodeKind = (typeof NODE_KINDS)[number]
// v1 = Context only (brief decision 1, 2026-10-17).
export const EDGE_KINDS = ["context"] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]
// P6 propose-first: an edge is born `proposed` (the agent node shows "Send?");
// only an explicit send moves it on. `sending` is the claim that stops a double tap
// from typing the prompt twice; `failed` (inject refused, source gone) may be re-sent.
export const EDGE_STATES = ["proposed", "sending", "sent", "failed"] as const
export type EdgeState = (typeof EDGE_STATES)[number]
// Hop limit = 1: context flows from a note/task straight into an agent and never
// out of one, so no edge can chain into another and no A→B→A loop can form.
const CONTEXT_SOURCES: readonly NodeKind[] = ["note", "task"]
const CONTEXT_TARGET: NodeKind = "agent"

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
  state: EdgeState
  /** Why the last send failed (an inject refusal code, source_not_found, …); "" otherwise. */
  error: string
  sentAt: number | null
  createdAt: number
  updatedAt: number
}

export type NodeInput = Pick<CanvasNode, "kind" | "ref" | "x" | "y" | "w" | "h" | "data"> & { id?: string }
export type NodePatch = Partial<Pick<CanvasNode, "ref" | "x" | "y" | "w" | "h" | "data">>
export type EdgeInput = Pick<CanvasEdge, "kind" | "from" | "to">

export type EdgeAddResult = { ok: true; edge: CanvasEdge } | { ok: false; error: "node_not_found" | "self_edge" | "edge_exists" | "invalid_endpoints" }

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
  node(id: string): CanvasNode | null
  edge(id: string): CanvasEdge | null
  /** proposed|failed → sending, atomically; null when the edge is unknown or already sending/sent. */
  claimEdge(id: string, now: number): CanvasEdge | null
  /** sending → sent|failed; null when the edge was removed meanwhile. */
  settleEdge(id: string, result: { ok: true } | { ok: false; error: string }, now: number): CanvasEdge | null
}

interface RawNode { id: string; kind: string; ref: string; x: number; y: number; w: number; h: number; data: string; created_at: number; updated_at: number }
interface RawEdge { id: string; kind: string; from_id: string; to_id: string; state: string; error: string; sent_at: number | null; created_at: number; updated_at: number }

const toNode = (r: RawNode): CanvasNode => ({
  id: r.id, kind: r.kind as NodeKind, ref: r.ref, x: r.x, y: r.y, w: r.w, h: r.h,
  data: JSON.parse(r.data) as Record<string, unknown>, createdAt: r.created_at, updatedAt: r.updated_at,
})
const toEdge = (r: RawEdge): CanvasEdge => ({
  id: r.id, kind: r.kind as EdgeKind, from: r.from_id, to: r.to_id, state: r.state as EdgeState, error: r.error,
  sentAt: r.sent_at, createdAt: r.created_at, updatedAt: r.updated_at,
})

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
  // P6 columns, added in place on a board created before them.
  const cols = new Set((db.query("PRAGMA table_info(canvas_edges)").all() as { name: string }[]).map((c) => c.name))
  if (!cols.has("state")) db.exec("ALTER TABLE canvas_edges ADD COLUMN state TEXT NOT NULL DEFAULT 'proposed'")
  if (!cols.has("error")) db.exec("ALTER TABLE canvas_edges ADD COLUMN error TEXT NOT NULL DEFAULT ''")
  if (!cols.has("sent_at")) db.exec("ALTER TABLE canvas_edges ADD COLUMN sent_at INTEGER")
  if (!cols.has("updated_at")) db.exec("ALTER TABLE canvas_edges ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0")
  // A send cut short by a restart never reported back: offer it again rather than leave it stuck.
  db.query("UPDATE canvas_edges SET state = 'failed', error = 'server_restart' WHERE state = 'sending'").run()
  const getNode = (id: string): CanvasNode | null => {
    const r = db.query("SELECT * FROM canvas_nodes WHERE id = ?").get(id) as RawNode | null
    return r ? toNode(r) : null
  }
  const getEdge = (id: string): CanvasEdge | null => {
    const r = db.query("SELECT * FROM canvas_edges WHERE id = ?").get(id) as RawEdge | null
    return r ? toEdge(r) : null
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
      const from = getNode(input.from)
      const to = getNode(input.to)
      if (!from || !to) return { ok: false, error: "node_not_found" }
      if (!CONTEXT_SOURCES.includes(from.kind) || to.kind !== CONTEXT_TARGET) return { ok: false, error: "invalid_endpoints" }
      const id = crypto.randomUUID()
      const r = db.query(
        "INSERT OR IGNORE INTO canvas_edges (id, kind, from_id, to_id, state, error, sent_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'proposed', '', NULL, ?, ?)",
      ).run(id, input.kind, input.from, input.to, now, now)
      if (r.changes === 0) return { ok: false, error: "edge_exists" }
      return { ok: true, edge: getEdge(id)! }
    },
    removeEdge: (id) => db.query("DELETE FROM canvas_edges WHERE id = ?").run(id).changes > 0,
    node: getNode,
    edge: getEdge,
    claimEdge(id, now) {
      const r = db.query("UPDATE canvas_edges SET state = 'sending', error = '', updated_at = ? WHERE id = ? AND state IN ('proposed', 'failed')").run(now, id)
      return r.changes > 0 ? getEdge(id) : null
    },
    settleEdge(id, result, now) {
      const r = result.ok
        ? db.query("UPDATE canvas_edges SET state = 'sent', error = '', sent_at = ?, updated_at = ? WHERE id = ? AND state = 'sending'").run(now, now, id)
        : db.query("UPDATE canvas_edges SET state = 'failed', error = ?, updated_at = ? WHERE id = ? AND state = 'sending'").run(result.error, now, id)
      return r.changes > 0 ? getEdge(id) : null
    },
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
  if (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id || raw.id.length > ID_MAX || !/^[A-Za-z0-9_-]+$/.test(raw.id))) return { ok: false, error: "invalid_id" }
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

// ── Context prompt (P6) ─────────────────────────────────────────────────────
//
// What a Context edge types into its agent: the source node's content, read
// server-side at send time (a Turso task or note, else a free note's own text).
// One line: the inject path types it with `send-keys -l` + Enter, and a raw
// newline mid-prompt would not submit cleanly; control bytes never reach the pane.

export const PROMPT_MAX = 4000

export type ContextPrompt = { ok: true; text: string } | { ok: false; error: "source_not_found" | "source_empty" }

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

export function oneLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " | ").replace(/[\x00-\x1f\x7f]/g, " ").replace(/ {2,}/g, " ").trim()
  return flat.length > PROMPT_MAX ? `${flat.slice(0, PROMPT_MAX - 1)}…` : flat
}

const noteLabel = (refCode: string, title: string): string => [refCode, title && `"${title}"`].filter(Boolean).join(" ")

export async function contextPrompt(node: CanvasNode, query: QueryFn): Promise<ContextPrompt> {
  if (node.kind === "task") {
    if (!node.ref) return { ok: false, error: "source_not_found" }
    const [t] = await query(
      "SELECT t.text, t.description, n.title, n.ref_code FROM tasks t LEFT JOIN notes n ON n.id = t.note_id WHERE t.id = ?",
      [node.ref],
    )
    if (!t) return { ok: false, error: "source_not_found" }
    if (!str(t.text)) return { ok: false, error: "source_empty" }
    const note = noteLabel(str(t.ref_code), str(t.title))
    const desc = str(t.description)
    const head = `Canvas task (Turso task ${node.ref}${note ? `, note ${note}` : ""}) — start working on it: `
    return { ok: true, text: oneLine(head + str(t.text) + (desc ? `\n${desc}` : "")) }
  }
  // A note: the Turso note by id or ref_code, else the sticky's own text.
  if (node.ref) {
    const [n] = await query("SELECT title, body, ref_code FROM notes WHERE id = ? OR ref_code = ? LIMIT 1", [node.ref, node.ref])
    if (!n) return { ok: false, error: "source_not_found" }
    if (!str(n.body)) return { ok: false, error: "source_empty" }
    return { ok: true, text: oneLine(`Canvas note context (${noteLabel(str(n.ref_code), str(n.title)) || node.ref}): ${str(n.body)}`) }
  }
  const text = str(node.data.text)
  return text ? { ok: true, text: oneLine(`Canvas note context: ${text}`) } : { ok: false, error: "source_empty" }
}
