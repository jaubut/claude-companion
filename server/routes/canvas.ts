import { type CanvasEdge, type CanvasStatus, type CanvasStore, parseEdgeInput, parseNodeInput, parseNodePatch } from "../lib/canvas"

// Canvas graph REST (PRJ-FL49 P5). Bearer-gated like every /api/*. Every write
// is broadcast as a `canvas` frame (wiring/canvas.ts lists the ops), so a move
// made from one client shows on every other one live.
//   GET    /api/canvas                → { ok, host, nodes, edges, status }
//   POST   /api/canvas/nodes          { kind, x, y, w, h, ref?, data?, id? } → 201 { ok, node } (200 when id exists)
//   PATCH  /api/canvas/nodes/<id>     { x?, y?, w?, h?, ref?, data? }       → { ok, node }
//   DELETE /api/canvas/nodes/<id>     → { ok, edgeIds } (its edges go with it)
//   POST   /api/canvas/edges          { from, to, kind? = "context" }       → 201 { ok, edge } (state "proposed")
//   POST   /api/canvas/edges/<id>/send → { ok, edge } (state "sent") — the "Send?" tap (P6)
//   DELETE /api/canvas/edges/<id>     → { ok }
// Errors: 400 { error: invalid_* | empty_patch | self_edge | invalid_endpoints }, 404 not_found | node_not_found,
// 409 edge_exists | edge_sending | edge_sent. A context edge runs note|task → agent only.
// A failed send answers with the inject refusal's status + error (409 pane_not_ready / dialog_open …,
// 410 target_gone …) and leaves the edge `failed` with that error, ready to be sent again.

export type SendResult = { ok: true } | { ok: false; status: number; error: string; detail?: Record<string, unknown> }

export interface CanvasRouteDeps {
  store: CanvasStore
  status: () => Record<string, CanvasStatus>
  host: string
  notify: (frame: Record<string, unknown>) => void
  /** Build the edge's prompt server-side and deliver it through the inject guards (wiring/canvas.ts). */
  send: (edge: CanvasEdge) => Promise<SendResult>
  now?: () => number
}

const NODES = "/api/canvas/nodes"
const EDGES = "/api/canvas/edges"

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

    const edgeId = idUnder(path, EDGES)
    if (edgeId && req.method === "DELETE") {
      if (!deps.store.removeEdge(edgeId)) return bad("not_found", 404)
      frame("edge_removed", { id: edgeId })
      return Response.json({ ok: true })
    }

    return bad("not_found", 404)
  }
}
