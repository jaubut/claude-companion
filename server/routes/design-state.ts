// FigCraft is retired (canvas-strip S1, 2026-11-18): every design-state route answers 410 without
// reading the body. S2 moves this to routes/figcraft-retired.ts; S3 removes it.
const RETIRED = new Set([
  "GET /api/canvas/design-state",
  "POST /api/canvas/design-state",
  "POST /api/canvas/design-state/export-tokens",
  "GET /api/canvas/figcraft/preview",
])

export async function handleDesignStateRoute(req: Request, url: URL): Promise<Response | null> {
  if (!RETIRED.has(`${req.method} ${url.pathname}`)) return null
  return Response.json({ error: "figcraft_retired" }, { status: 410 })
}
