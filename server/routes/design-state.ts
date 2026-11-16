import { type DesignStatePatch, type DesignStateSnapshot } from "../lib/design-state"
import { jsonObject } from "../lib/json-body"
import {
  exportDesignTokens,
  getDesignStateSnapshot,
  refreshDesignState,
  renderFigcraftNodePreview,
  updateDesignState,
} from "../wiring/design-state"

export interface DesignStateRouteDeps {
  getSnapshot?: () => DesignStateSnapshot
  refresh?: (opts?: { probeMcp?: boolean }) => Promise<DesignStateSnapshot>
  update?: (patch: DesignStatePatch) => Promise<DesignStateSnapshot>
  renderPreview?: (opts: { file?: string; nodeId?: string; scale?: number }) => Promise<{ ok: true; path: string; bytes: Uint8Array } | { ok: false; status: number; error: string }>
  exportTokens?: () => Promise<{ ok: boolean; status: number; output: string; error?: string; state: DesignStateSnapshot }>
}

const bad = (error: string, status = 400): Response => Response.json({ ok: false, error }, { status })

function parsePatch(raw: Record<string, unknown>): { ok: true; value: DesignStatePatch } | { ok: false; error: string } {
  const out: DesignStatePatch = {}
  if (raw.activeFile !== undefined) {
    if (raw.activeFile !== null && typeof raw.activeFile !== "string") return { ok: false, error: "invalid_file" }
    out.activeFile = raw.activeFile
  }
  if (raw.activeFrameId !== undefined) {
    if (raw.activeFrameId !== null && typeof raw.activeFrameId !== "string") return { ok: false, error: "invalid_frame_id" }
    out.activeFrameId = raw.activeFrameId
  }
  if (raw.brand !== undefined) {
    if (typeof raw.brand !== "string" || !raw.brand.trim()) return { ok: false, error: "invalid_brand" }
    out.brand = raw.brand
  }
  if (raw.themeMode !== undefined) {
    if (raw.themeMode !== "light" && raw.themeMode !== "dark") return { ok: false, error: "invalid_theme_mode" }
    out.themeMode = raw.themeMode
  }
  if (raw.pickedDirection !== undefined) {
    if (raw.pickedDirection !== null && typeof raw.pickedDirection !== "string") return { ok: false, error: "invalid_direction" }
    out.pickedDirection = raw.pickedDirection
  }
  if (raw.pickedNodeId !== undefined) {
    if (raw.pickedNodeId !== null && typeof raw.pickedNodeId !== "string") return { ok: false, error: "invalid_node_id" }
    out.pickedNodeId = raw.pickedNodeId
  }
  if (raw.pickedAt !== undefined) {
    if (raw.pickedAt !== null && typeof raw.pickedAt !== "number") return { ok: false, error: "invalid_picked_at" }
    out.pickedAt = raw.pickedAt
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "empty_patch" }
  return { ok: true, value: out }
}

export function createDesignStateRoute(deps: DesignStateRouteDeps = {}) {
  const getSnap = deps.getSnapshot ?? getDesignStateSnapshot
  const refresh = deps.refresh ?? refreshDesignState
  const update = deps.update ?? updateDesignState
  const render = deps.renderPreview ?? renderFigcraftNodePreview
  const runExport = deps.exportTokens ?? exportDesignTokens

  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname
    if (path === "/api/canvas/design-state" && req.method === "GET") {
      const shouldRefresh = url.searchParams.get("refresh") === "1"
      const current = getSnap()
      const state = shouldRefresh || !current.activeFile ? await refresh({ probeMcp: true }) : current
      return Response.json({ ok: true, state })
    }

    if (path === "/api/canvas/design-state" && req.method === "POST") {
      const raw = await jsonObject(req)
      const parsed = parsePatch(raw)
      if (!parsed.ok) return bad(parsed.error)
      try {
        const state = await update(parsed.value)
        return Response.json({ ok: true, state })
      } catch (err) {
        const msg = err instanceof Error ? err.message : "update_failed"
        return bad(msg === "invalid_file" ? "invalid_file" : msg, 400)
      }
    }

    if (path === "/api/canvas/design-state/export-tokens" && req.method === "POST") {
      const result = await runExport()
      return Response.json(result, { status: result.status })
    }

    if (path === "/api/canvas/figcraft/preview" && req.method === "GET") {
      const file = url.searchParams.get("file") ?? undefined
      const nodeId = url.searchParams.get("node") ?? undefined
      const scaleRaw = Number(url.searchParams.get("scale") ?? "1")
      const scale = Number.isFinite(scaleRaw) ? scaleRaw : 1
      const res = await render({ file, nodeId, scale })
      if (!res.ok) return bad(res.error, res.status)
      return new Response(new Uint8Array(res.bytes), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=120",
        },
      })
    }

    return null
  }
}

export const handleDesignStateRoute = createDesignStateRoute()
