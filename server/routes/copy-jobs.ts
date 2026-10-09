import { checkBearer } from "../lib/auth"
import { parseCopyReport } from "../lib/copy-jobs"
import { isLoopback, peerOf } from "../lib/vault-guard"
import { copyJobs } from "../wiring/copy-jobs"

// Footage-copy progress (lib/copy-jobs.ts).
//   POST /hooks/copy-progress → the copy-progress mod's report, every 2 s poll
//        of an ingest run. Only job_id is required (≤ 200 chars, the output
//        file's basename); snake_case body: session_id, label, started_at,
//        copy_started_at, total_files, total_bytes, done_files, done_bytes,
//        current, failed, finished, at. Loopback, or the bearer (like
//        /hooks/gauge); never forwarded upstream — each host owns its copies.
//   GET  /api/copy-jobs → { ok, jobs: [CopyJobItem] }
//        Bearer-gated like every /api/*. Live updates ride the `copy_jobs` WS frame.
export async function handleCopyJobsRoute(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/hooks/copy-progress" && req.method === "POST") {
    const peer = peerOf(req)
    if (!(peer && isLoopback(peer)) && !checkBearer(req)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 })
    let raw: unknown
    try { raw = await req.json() } catch { return Response.json({ ok: false, error: "invalid_json" }, { status: 400 }) }
    const report = parseCopyReport(raw)
    if (!report) return Response.json({ ok: false, error: "job_id_required" }, { status: 400 })
    copyJobs.report(report)
    return Response.json({ ok: true })
  }
  if (url.pathname === "/api/copy-jobs" && req.method === "GET") {
    return Response.json(copyJobs.snapshot())
  }
  return null
}
