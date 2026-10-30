import { type CanvasEdge, type CanvasNode, type CanvasStatus, type CanvasStore, parseEdgeInput, parseNodeInput, parseNodePatch, readReferences, referenceRef, type SendResult } from "../lib/canvas"
import { noteContextBlocks } from "../lib/note-media"
import type { QueryFn } from "../lib/turso"
export type { SendResult }

// Canvas graph REST (PRJ-FL49 P5). Bearer-gated like every /api/*. Every write
// is broadcast as a `canvas` frame (wiring/canvas.ts lists the ops), so a move
// made from one client shows on every other one live.
//   GET    /api/canvas                → { ok, host, nodes, edges, status }
//   POST   /api/canvas/nodes          { kind, x, y, w, h, ref?, data?, id? } → 201 { ok, node } (200 when id exists)
//   PATCH  /api/canvas/nodes/<id>     { x?, y?, w?, h?, ref?, data? }       → { ok, node }
//   DELETE /api/canvas/nodes/<id>     → { ok, edgeIds } (its edges go with it)
//   POST   /api/canvas/edges          { from, to, kind? }                   → 201 { ok, edge }. Kind/state come from
//          the endpoints (a posted kind is ignored): task → agent = "context"/"proposed" (Send?);
//          note|turso_note → agent|brain = "reference"/"linked" (a live read-only link, never sent)
//   POST   /api/canvas/edges/<id>/send → { ok, edge } (state "sent") — the "Send?" tap (P6); 409 edge_linked on a reference
//   DELETE /api/canvas/edges/<id>     → { ok }
//   GET    /api/canvas/linked-notes?session=<key> | ?brain=1      → { ok, notes: ReferencedNote[] } — CURRENT content
//   GET    /api/canvas/linked-notes/<ref | canvas:<nodeId>>?…     → { ok, note } — 404 unless linked to that target
//          &content=1 adds { content: ContentBlock[], omitted } — the note's text + its attachments (lib/note-media.ts)
// Errors: 400 { error: invalid_* | empty_patch | self_edge | invalid_endpoints | missing_target }, 404 not_found | node_not_found,
// 409 edge_exists | edge_sending | edge_sent | edge_linked. A journal note can't be linked (invalid_endpoints). A context edge runs note|task → agent only.
// A failed send answers with the inject refusal's status + error (409 pane_not_ready / dialog_open …,
// 410 target_gone …) and leaves the edge `failed` with that error, ready to be sent again.


export interface CanvasRouteDeps {
  store: CanvasStore
  status: () => Record<string, CanvasStatus>
  host: string
  notify: (frame: Record<string, unknown>) => void
  /** Build the edge's prompt server-side and deliver it through the inject guards (wiring/canvas.ts). */
  send: (edge: CanvasEdge) => Promise<SendResult>
  /** The note nodes linked to a live session (by key) or to the brain (wiring/canvas.ts). */
  references: (who: { key?: string; brain?: boolean }) => CanvasNode[]
  query: QueryFn
  now?: () => number
}

const NODES = "/api/canvas/nodes"
const EDGES = "/api/canvas/edges"
const LINKED = "/api/canvas/linked-notes"

const bad = (error: string, status = 400): Response => Response.json({ ok: false, error }, { status })

async function body(req: Request): Promise<unknown> {
  try { return await req.json() } catch { return undefined }
}

// "/api/canvas/nodes/<id>" → "<id>"; null when the path is not exactly one segment below `base`.
function idUnder(path: string, base: string): string | null {
  if (!path.startsWith(base + "/")) return null
  let id: string
  try { id = decodeURIComponent(path.slice(base.length + 1)) } catch { return null }
  return id && !id.includes("/") ? id : null
}

export function createCanvasRoute(deps: CanvasRouteDeps) {
  const now = deps.now ?? Date.now
  const frame = (op: string, rest: Record<string, unknown>): void => deps.notify({ type: "canvas", op, ...rest })

  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname
    if (path !== "/api/canvas" && !path.startsWith("/api/canvas/")) return null

    if (path === "/api/canvas" && req.method === "GET") {
      return Response.json({ ok: true, host: deps.host, nodes: deps.store.nodes(), edges: deps.store.edges(), status: deps.status() })
    }

    if (path === NODES && req.method === "POST") {
      const p = parseNodeInput(await body(req))
      if (!p.ok) return bad(p.error)
      const { node, created } = deps.store.addNode(p.value, now())
      if (created) frame("node", { node })
      return Response.json({ ok: true, node }, { status: created ? 201 : 200 })
    }

    const nodeId = idUnder(path, NODES)
    if (nodeId && req.method === "PATCH") {
      const p = parseNodePatch(await body(req))
      if (!p.ok) return bad(p.error)
      const node = deps.store.patchNode(nodeId, p.value, now())
      if (!node) return bad("not_found", 404)
      frame("node", { node })
      return Response.json({ ok: true, node })
    }
    if (nodeId && req.method === "DELETE") {
      const r = deps.store.removeNode(nodeId)
      if (!r) return bad("not_found", 404)
      frame("node_removed", { id: nodeId, edgeIds: r.edgeIds })
      return Response.json({ ok: true, edgeIds: r.edgeIds })
    }

    if (path === EDGES && req.method === "POST") {
      const p = parseEdgeInput(await body(req))
      if (!p.ok) return bad(p.error)
      const r = deps.store.addEdge(p.value, now())
      if (!r.ok) return bad(r.error, r.error === "node_not_found" ? 404 : r.error === "edge_exists" ? 409 : 400)
      frame("edge", { edge: r.edge })
      return Response.json({ ok: true, edge: r.edge }, { status: 201 })
    }

    const sendId = path.endsWith("/send") ? idUnder(path.slice(0, -"/send".length), EDGES) : null
    if (sendId && req.method === "POST") {
      // Claim first: a double tap (or a second client) finds it `sending` and types nothing.
      const claimed = deps.store.claimEdge(sendId, now())
      if (!claimed) {
        const e = deps.store.edge(sendId)
        return e ? bad(`edge_${e.state}`, 409) : bad("not_found", 404)
      }
      frame("edge", { edge: claimed })
      // A throw (Turso down) must still settle the claim, or the edge stays `sending` until a restart.
      const r = await deps.send(claimed).catch((): SendResult => ({ ok: false, status: 503, error: "send_failed" }))
      const edge = deps.store.settleEdge(sendId, r.ok ? r : { ok: false, error: r.error }, now())
      if (edge) frame("edge", { edge })
      return r.ok
        ? Response.json({ ok: true, edge })
        : Response.json({ ...r.detail, ok: false, error: r.error, edge }, { status: r.status })
    }

    if ((path === LINKED || path.startsWith(LINKED + "/")) && req.method === "GET") {
      const key = url.searchParams.get("session") ?? ""
      const brain = url.searchParams.get("brain") === "1"
      if (!key && !brain) return bad("missing_target")
      let nodes = deps.references(brain ? { brain } : { key })
      if (path !== LINKED) {
        // A Turso note id has a slash (projects/2026-…): send it percent-encoded, decoded whole here.
        let one = ""
        try { one = decodeURIComponent(path.slice(LINKED.length + 1)) } catch { /* stays "" */ }
        nodes = nodes.filter((n) => one !== "" && (referenceRef(n) === one || n.id === one))
        if (nodes.length === 0) return bad("not_found", 404)
      }
      const notes = await readReferences(nodes, deps.query)
      if (path === LINKED) return Response.json({ ok: true, notes })
      const note = notes[0]!
      if (url.searchParams.get("content") !== "1") return Response.json({ ok: true, note })
      return Response.json({ ok: true, note, ...(await noteContextBlocks(note, deps.query)) })
    }

    const edgeId = idUnder(path, EDGES)
    if (edgeId && req.method === "DELETE") {
      if (!deps.store.removeEdge(edgeId)) return bad("not_found", 404)
      frame("edge_removed", { id: edgeId })
      return Response.json({ ok: true })
    }

    return bad("not_found", 404)
  }
}
