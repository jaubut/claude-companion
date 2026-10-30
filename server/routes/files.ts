import { sentFilePath } from "../lib/sent-files"

// GET /api/files/:id/:name — a file a session sent with SendUserFile
// (t-server-filecards-1), copied by lib/sent-files.ts. Auth is the `/api/*`
// gate in companion-server.ts (Bearer or ?token=). Only copies are served:
// the id must be 32 lowercase hex and the decoded name must equal the one
// file stored under it — no path is ever built from client input. Never log
// the URL: a `?token=` query would land in the log.

const PREFIX = "/api/files/"

export async function handleFilesRoute(req: Request, url: URL): Promise<Response | null> {
  if (!(url.pathname.startsWith(PREFIX) && req.method === "GET")) return null
  const [id = "", rawName = "", ...rest] = url.pathname.slice(PREFIX.length).split("/")
  let name: string
  try { name = decodeURIComponent(rawName) } catch { name = "" }
  const stored = rest.length === 0 ? sentFilePath(id) : null
  if (!stored || stored.name !== name) return new Response("Not found", { status: 404 })

  const file = Bun.file(stored.path)
  // id → bytes never change (the id hashes path, size and mtime).
  const etag = `"${id}"`
  const cache = { "Cache-Control": "private, max-age=31536000, immutable", ETag: etag }
  if (req.headers.get("if-none-match")?.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers: cache })
  }
  return new Response(file, {
    headers: {
      ...cache,
      "Content-Type": file.type || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
    },
  })
}
