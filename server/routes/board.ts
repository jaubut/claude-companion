import { checkBearer, unauthorized } from "../lib/auth"
import { brainEnabled } from "../lib/brain"
import { BOARD_ASSET_MAX_BYTES, boardAssetFile, saveBoardAsset } from "../lib/board-assets"
import { type BoardMcpHandler, createBoardMcpHandler } from "../lib/board-mcp"
import { type BoardRoom, importBoard } from "../lib/board-room"
import { byqThumb } from "../lib/byq"
import { isObject, jsonObject } from "../lib/json-body"

// Canvas board routes (canvas-board-sync), all behind the /api/ Bearer gate in
// companion-server.ts (the sync WS upgrade too, BOARD_SYNC_PATH):
//   POST /api/board/import          a device's legacy board → the empty room
//   POST /api/board/assets          raw image body → {ok, src, path}
//   GET  /api/board/assets/<file>   the bytes (an <img> sends ?token=)
//   GET  /api/board/byq/thumbs/<kind>-<id>[.jpg|.webp]  a BYQ library thumbnail (lib/byq.ts)
//   POST /api/mcp/board             the board MCP (lib/board-mcp.ts); GET → 405
// The board exists only on the brain host: elsewhere every path is 404
// board_disabled. CORS: /api/board/* only, the Canvas page's origin only.

export const BOARD_SYNC_PATH = "/api/board/sync"
const MCP_PATH = "/api/mcp/board"
const ASSETS_PATH = "/api/board/assets"
const BYQ_THUMBS_PATH = "/api/board/byq/thumbs"
const ALLOWED_ORIGINS = new Set(["companion-sketch://app"])
const MAX_MCP_SESSIONS = 200

const isBoardPath = (p: string): boolean => p === "/api/board" || p.startsWith("/api/board/")

function corsHeaders(req: Request, url: URL): Record<string, string> {
  if (!isBoardPath(url.pathname)) return {}
  const origin = req.headers.get("origin") ?? ""
  if (!ALLOWED_ORIGINS.has(origin)) return { Vary: "Origin" }
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
}

/** The OPTIONS preflight for /api/board/*, answered before the Bearer gate (a preflight carries no token). Null elsewhere. */
export function boardCors(req: Request, url: URL): Response | null {
  if (req.method !== "OPTIONS" || !isBoardPath(url.pathname)) return null
  const headers = corsHeaders(req, url)
  if (headers["Access-Control-Allow-Origin"]) {
    Object.assign(headers, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    })
  }
  return new Response(null, { status: 204, headers })
}

/** Header values are client-controlled: printable, capped. */
const label = (v: string | null | undefined): string => (v ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64)

export interface BoardRouteDeps {
  enabled?: () => boolean
  room?: () => BoardRoom
  mcp?: BoardMcpHandler
}

export function createBoardRoute(deps: BoardRouteDeps = {}) {
  const enabled = deps.enabled ?? (() => brainEnabled())
  const mcp = deps.mcp ?? createBoardMcpHandler({ room: deps.room })
  // Mcp-Session-Id → clientInfo.name from its initialize: the fallback meta.by.
  const sessionNames = new Map<string, string>()

  async function serveMcp(req: Request): Promise<Response> {
    if (req.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } })
    let body: unknown
    try { body = await req.json() } catch { body = null }
    if (!isObject(body)) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
    let session = req.headers.get("mcp-session-id") ?? ""
    const headers: Record<string, string> = {}
    if (body.method === "initialize") {
      session = crypto.randomUUID()
      const name = label((body.params as { clientInfo?: { name?: unknown } } | undefined)?.clientInfo?.name as string | undefined)
      if (sessionNames.size >= MAX_MCP_SESSIONS) sessionNames.delete(sessionNames.keys().next().value!)
      if (name) sessionNames.set(session, name)
      headers["Mcp-Session-Id"] = session
    }
    const caller = label(req.headers.get("x-board-caller")) || sessionNames.get(session) || "agent"
    const res = await mcp.handleRpc(body, caller)
    if (res === null) return new Response(null, { status: 202 })
    return Response.json(res, { headers })
  }

  async function serve(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === MCP_PATH) return serveMcp(req)
    if (url.pathname === "/api/board/import" && req.method === "POST") {
      const body = await jsonObject(req)
      const out = await importBoard(body, deps.room?.())
      return out.ok ? Response.json(out) : Response.json(out, { status: out.status })
    }
    if (url.pathname === ASSETS_PATH && req.method === "POST") {
      // Refuse before buffering: Bun would otherwise read up to its 128 MB body limit.
      if (Number(req.headers.get("content-length") ?? 0) > BOARD_ASSET_MAX_BYTES) {
        return Response.json({ ok: false, error: "too_large", max: BOARD_ASSET_MAX_BYTES }, { status: 413 })
      }
      const saved = saveBoardAsset(new Uint8Array(await req.arrayBuffer()), req.headers.get("content-type"))
      return saved.ok ? Response.json({ ok: true, src: saved.src, path: saved.path }) : Response.json(saved, { status: saved.status })
    }
    if (url.pathname.startsWith(`${ASSETS_PATH}/`) && req.method === "GET") {
      const found = boardAssetFile(url.pathname.slice(ASSETS_PATH.length + 1))
      if (!found) return Response.json({ ok: false, error: "not_found" }, { status: 404 })
      return new Response(Bun.file(found.path), { headers: { "Content-Type": found.mime, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } })
    }
    if (url.pathname.startsWith(`${BYQ_THUMBS_PATH}/`) && req.method === "GET") {
      const found = await byqThumb(url.pathname.slice(BYQ_THUMBS_PATH.length + 1))
      if (!found) return Response.json({ ok: false, error: "not_found" }, { status: 404 })
      return new Response(Bun.file(found.path), { headers: { "Content-Type": found.mime, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } })
    }
    if (isBoardPath(url.pathname)) return Response.json({ ok: false, error: "not_found" }, { status: 404 })
    return null
  }

  return async function handleBoardRoute(req: Request, url: URL): Promise<Response | null> {
    if (!isBoardPath(url.pathname) && url.pathname !== MCP_PATH) return null
    // The global /api/ gate already ran (companion-server.ts); checked again here, as /api/mcp/workers does.
    const res = !checkBearer(req) ? unauthorized() : !enabled() ? Response.json({ ok: false, error: "board_disabled" }, { status: 404 }) : await serve(req, url)
    if (!res) return null
    for (const [k, v] of Object.entries(corsHeaders(req, url))) res.headers.set(k, v)
    return res
  }
}

export const handleBoardRoute = createBoardRoute()
