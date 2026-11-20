import { readFileSync, statSync } from "node:fs"
import { boardAssetFile } from "./board-assets"
import { renderBoardRegion } from "./board-render"
import type { BoardRoom } from "./board-room"
import { BOARD_MAX_OPS, BoardOpError, type Rect, boardRead, boardWrite, parseBoardOps } from "./board-tools"
import { type JsonRpcResponse, rpcErr, rpcOk, toolResult } from "./worker-mcp"

// The board MCP (canvas-board-sync A1): Streamable HTTP, JSON responses only,
// at POST /api/mcp/board (routes/board.ts). Every agent on the Mac and on
// Zettlab reaches the live board through it; the brain gets it through
// --mcp-config (wiring/brain-headless.ts). Tools wrap lib/board-tools.ts.

const IMAGE_INLINE_MAX = 5 * 1024 * 1024

const RECT_SCHEMA = {
  type: "object",
  required: ["x", "y", "w", "h"],
  properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
  description: "A page-coordinate region: the shapes on Jeremie's page that intersect it (ignored with ids).",
} as const
const MAX_DIM_SCHEMA = { type: "number", description: "Longest side of the PNG in px (default 2000)." } as const

/** A rect argument: undefined when absent, null when malformed. */
function rectArg(v: unknown): Rect | undefined | null {
  if (v === undefined) return undefined
  const r = v as Record<string, unknown> | null
  const ok = !!r && typeof r === "object" && ["x", "y", "w", "h"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k])) && (r.w as number) > 0 && (r.h as number) > 0
  return ok ? { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number } : null
}

export const BOARD_MCP_TOOLS = [
  {
    name: "board_read",
    description: "Read Jeremie's live Canvas board: pages, shapes (id, type, page coordinates, text, arrow ends, image file) and presence (who is on which page, their selection and viewport). Default scope: the page Jeremie is on. `focus` = his selection plus descendants, else the shapes in his viewport. `rect` = the shapes intersecting a page region. Capped at 500 shapes (`truncated`). `render: true` also returns a PNG of the same scope: handwriting (Apple Pencil draw / highlight strokes), notes, text, images and arrows as Jeremie sees them, so never ask him for a screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Only these shapes (and their descendants)." },
        focus: { type: "boolean", description: "Jeremie's selection plus descendants, else what his viewport shows." },
        html: { type: "boolean", description: "Include live-frame html." },
        rect: RECT_SCHEMA,
        render: { type: "boolean", description: "Also return a PNG picture of the scope (handwriting included)." },
        maxDim: MAX_DIM_SCHEMA,
      },
    },
  },
  {
    name: "board_write",
    description: `Edit the live board in one transaction (≤${BOARD_MAX_OPS} ops; any invalid op → nothing applied). Ops: {op:"create", type:"note"|"text"|"geo"|"arrow"|"live-frame"|"ui-block"|"auto-layout-frame", id?, parentId?, x?, y?, text?, geo?, color?, w?, h?, from?, to?, html?, title?, props?} (arrows: from/to shape ids; no x/y → placed right of Jeremie's selection), {op:"update", id, x?, y?, rotation?, text?, w?, h?, color?, geo?, html?, title?, props?}, {op:"delete", id} (also deletes descendants and bindings). props (ui-block / auto-layout-frame only): ui-block {slug (required, from the BYQ manifest), sizingW:"fixed"|"fill", sizingH:"fixed"|"hug"}; auto-layout-frame {name, direction:"row"|"column", justify:"flex-start"|"center"|"flex-end"|"space-between", align:"flex-start"|"center"|"flex-end"|"stretch", gap, paddingX, paddingY (0-1000), sizingW/sizingH:"fixed"|"hug"|"fill", bg:"#rrggbb[aa]"|"", radius}. Put blocks in a frame with parentId. Coordinates are page coordinates (parent-relative for children). Returns {ok, ids}.`,
    inputSchema: {
      type: "object",
      required: ["ops"],
      properties: { ops: { type: "array", items: { type: "object" }, description: "The ops, applied in order." } },
    },
  },
  {
    name: "board_asset",
    description: "See an image on the board: `file` from board_read's `image.file`. Returns the image (≤5 MB), else its url.",
    inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string", description: "The asset file name, e.g. `<hash>.png`." } } },
  },
  {
    name: "board_render",
    description: "See the board as a PNG: handwriting (Apple Pencil draw / highlight strokes), notes, text, shapes, images, arrows. Scope as board_read: `ids`, `focus` (Jeremie's selection, else his viewport), `rect` (page region); default his whole page. Returns the image + {ok, rect, shapeCount}.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Only these shapes (and their descendants)." },
        focus: { type: "boolean", description: "Jeremie's selection plus descendants, else what his viewport shows." },
        rect: RECT_SCHEMA,
        maxDim: MAX_DIM_SCHEMA,
      },
    },
  },
] as const

export interface BoardMcpDeps {
  room?: () => BoardRoom
}

export function createBoardMcpHandler(deps: BoardMcpDeps = {}) {
  const room = (): BoardRoom | undefined => deps.room?.()

  async function callTool(id: string | number | null, name: string, args: Record<string, unknown>, by: string): Promise<JsonRpcResponse> {
    if (name === "board_read" || name === "board_render") {
      const ids = Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === "string") : undefined
      const rect = rectArg(args.rect)
      if (rect === null) return rpcOk(id, toolResult({ ok: false, error: "rect needs finite x, y and positive w, h" }, true))
      const scope = { ids, focus: args.focus === true, rect }
      const read = name === "board_read" ? boardRead({ ...scope, html: args.html === true }, room()) : null
      if (read && args.render !== true) return rpcOk(id, toolResult(read))
      const r = await renderBoardRegion({ ...scope, maxDim: typeof args.maxDim === "number" ? args.maxDim : undefined }, room())
      const meta = read ?? { ok: true, rect: r.rect, shapeCount: r.shapeCount }
      return rpcOk(id, { content: [{ type: "image", data: r.png.toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify(meta) }] })
    }
    if (name === "board_write") {
      try {
        return rpcOk(id, toolResult(await boardWrite(parseBoardOps(args.ops), by, room())))
      } catch (err) {
        if (err instanceof BoardOpError) return rpcOk(id, toolResult({ ok: false, error: err.message, at: err.at }, true))
        throw err
      }
    }
    if (name === "board_asset") {
      const file = typeof args.file === "string" ? args.file : ""
      const found = boardAssetFile(file)
      if (!found) return rpcOk(id, toolResult({ ok: false, error: "asset_not_found" }, true))
      const url = `/api/board/assets/${file}`
      if (statSync(found.path).size > IMAGE_INLINE_MAX) return rpcOk(id, toolResult({ ok: true, url, file }))
      return rpcOk(id, { content: [{ type: "image", data: readFileSync(found.path).toString("base64"), mimeType: found.mime }] })
    }
    return rpcErr(id, -32601, `Unknown tool: ${name}`)
  }

  return {
    /** `caller`: X-Board-Caller, else the session's clientInfo.name, else "agent" (routes/board.ts). Null → 202. */
    async handleRpc(raw: Record<string, unknown>, caller: string): Promise<JsonRpcResponse | null> {
      const id = typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null
      const method = typeof raw.method === "string" ? raw.method : ""
      if (!method) return rpcErr(id, -32600, "Invalid Request: missing method")
      if (method.startsWith("notifications/")) return null
      if (method === "ping") return rpcOk(id, {})
      if (method === "initialize") {
        return rpcOk(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "companion-board", version: "1.0.0" } })
      }
      if (method === "tools/list") return rpcOk(id, { tools: BOARD_MCP_TOOLS })
      if (method === "tools/call") {
        const params = raw.params && typeof raw.params === "object" && !Array.isArray(raw.params) ? (raw.params as Record<string, unknown>) : null
        const name = typeof params?.name === "string" ? params.name : ""
        if (!name) return rpcErr(id, -32602, "Invalid params: missing tool name")
        const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {}
        return callTool(id, name, args, caller)
      }
      return rpcErr(id, -32601, `Method not found: ${method}`)
    },
  }
}

export type BoardMcpHandler = ReturnType<typeof createBoardMcpHandler>
