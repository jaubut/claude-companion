import { DashboardKeyMissing, DashboardUnreachable, dashboardBytes, dashboardJson } from "../lib/dashboard-client"

// Taste Trainer proxy (PRJ-SFNG, RES-0WCI option A) → tls-dashboard-v2 /api/taste/*
// (PR #280), behind the standard /api bearer gate. The phone never holds the
// dashboard key; dashboard-client adds it per call.
//   GET  /api/taste/next?dataset=&limit=                 → {items:[{id, dataset, source_url, title, image_url}]}
//   POST /api/taste/swipe {item_id, verdict, reason_tag?, comment?} → {ok:true}   (re-swipe overwrites)
//   GET  /api/taste/items/:id/image                      → image bytes (nosniff)
//   GET  /api/taste/stats                                → {stats:[{dataset, verdict, count}]}
// Dashboard 4xx pass through (JSON routes: status + body; image: status); 5xx/network/redirect → 502
// dashboard_unreachable; no key in the vault → 503 dashboard_key_missing.

const VERDICTS = ["like", "dislike"]
const REASON_TAGS = ["layout", "type", "color", "imagery", "density"]
const IMAGE = /^\/api\/taste\/items\/([1-9]\d{0,15})\/image$/
const DATASET = /^[A-Za-z0-9_.-]{1,64}$/

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response => json({ ok: false, error, ...extra }, status)

function dashboardError(e: unknown): Response {
  if (e instanceof DashboardKeyMissing) return fail(503, "dashboard_key_missing")
  if (e instanceof DashboardUnreachable) return fail(502, "dashboard_unreachable", { upstreamStatus: e.status })
  throw e
}

async function relay(method: string, path: string, body?: unknown): Promise<Response> {
  try {
    const r = await dashboardJson(method, path, body)
    return json(r.json ?? { ok: false, error: "dashboard_error" }, r.status)
  } catch (e) { return dashboardError(e) }
}

function next(url: URL): Response | Promise<Response> {
  const qs = new URLSearchParams()
  const dataset = url.searchParams.get("dataset")
  if (dataset) {
    if (!DATASET.test(dataset)) return fail(400, "bad_dataset")
    qs.set("dataset", dataset)
  }
  const limit = url.searchParams.get("limit")
  if (limit) {
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1) return fail(400, "bad_limit")
    qs.set("limit", limit)
  }
  const q = qs.toString()
  return relay("GET", `/api/taste/next${q ? `?${q}` : ""}`)
}

async function swipe(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null) as unknown
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_json")
  const { item_id, verdict, reason_tag, comment } = body as Record<string, unknown>
  if (typeof item_id !== "number" || !Number.isInteger(item_id) || item_id < 1) return fail(400, "invalid_item_id")
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) return fail(400, "invalid_verdict", { allowed: VERDICTS })
  if (reason_tag != null && (typeof reason_tag !== "string" || !REASON_TAGS.includes(reason_tag))) return fail(400, "invalid_reason_tag", { allowed: REASON_TAGS })
  // Length cap (1000) is enforced by the dashboard; 4xx passes through.
  if (comment != null && typeof comment !== "string") return fail(400, "invalid_comment")
  // Only the known fields go upstream.
  return relay("POST", "/api/taste/swipe", {
    item_id, verdict, ...(reason_tag != null ? { reason_tag } : {}), ...(comment != null ? { comment } : {}),
  })
}

// Screenshots are <=~250 KB, so buffering (dashboardBytes) is fine. Only raster
// types are served: the Companion origin must never serve SVG/HTML from upstream.
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/
async function image(id: string): Promise<Response> {
  try {
    const got = await dashboardBytes(`/api/taste/items/${id}/image`)
    if (!got) return fail(404, "not_found")
    const mime = got.mime.split(";")[0]!.trim().toLowerCase()
    if (!IMAGE_MIME.test(mime)) return fail(502, "bad_upstream_mime")
    return new Response(got.bytes, {
      headers: { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, max-age=86400" },
    })
  } catch (e) {
    if (e instanceof DashboardUnreachable && e.status != null && e.status >= 400 && e.status < 500 && e.status !== 429) return fail(e.status, "upstream_error", { upstreamStatus: e.status })
    if (e instanceof DashboardKeyMissing || e instanceof DashboardUnreachable) return dashboardError(e)
    return fail(502, "dashboard_unreachable") // body read failed mid-transfer
  }
}

export async function handleTasteRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname
  if (!p.startsWith("/api/taste/")) return null
  if (p === "/api/taste/swipe") return req.method === "POST" ? swipe(req) : fail(405, "method_not_allowed")
  if (req.method !== "GET") return fail(405, "method_not_allowed")
  if (p === "/api/taste/next") return next(url)
  if (p === "/api/taste/stats") return relay("GET", "/api/taste/stats")
  const m = IMAGE.exec(p)
  return m ? image(m[1]!) : fail(404, "not_found")
}
