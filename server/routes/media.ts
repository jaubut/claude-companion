import { isMediaId, mediaPath } from "../lib/media"

// GET /api/media/:id — the stored JPEG behind an `image` feed event
// (RES-L5NG step 3). Auth is the `/api/*` gate in companion-server.ts (Bearer
// or ?token=); this handler only validates the id. The id must be exactly 32
// lowercase hex, which is also what blocks traversal (`..%2Fauth.token` stays
// percent-encoded in pathname and fails the match). Never log the URL: a
// `?token=` query would land in the log.

const PREFIX = "/api/media/"

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false
  return header.split(",").some((raw) => {
    const tag = raw.trim().replace(/^W\//, "")
    return tag === etag || tag === "*"
  })
}

export async function handleMediaRoute(req: Request, url: URL): Promise<Response | null> {
  if (!(url.pathname.startsWith("/api/media/") && req.method === "GET")) return null
  const id = url.pathname.slice(PREFIX.length)
  if (!isMediaId(id)) return new Response("Not found", { status: 404 })

  const file = Bun.file(mediaPath(id))
  if (!(await file.exists())) return new Response("Not found", { status: 404 })

  // Content-addressed: the bytes behind an id never change.
  const etag = `"${id}"`
  const cache = { "Cache-Control": "private, max-age=31536000, immutable", ETag: etag }
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: cache })
  }
  return new Response(file, { headers: { ...cache, "Content-Type": "image/jpeg" } })
}
