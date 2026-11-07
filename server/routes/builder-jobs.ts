import { checkBearer } from "../lib/auth"
import { parseBuilderReport } from "../lib/builder-jobs"
import { isLoopback, peerOf } from "../lib/vault-guard"
import { builderJobs } from "../wiring/builder-jobs"

// Builder-job progress (lib/builder-jobs.ts, contract contracts/builder-jobs/).
//   POST /hooks/builder-progress → the brain's relay mod, one per relay event:
//        { event: task|progress|done|aborted, id, title?, builder?, pct?, step? }.
//        Loopback, or the bearer (like /hooks/copy-progress).
//   GET  /api/builder-jobs → { ok, jobs: [BuilderJobItem] } (bearer, like every /api/*).
//        Live updates ride the `builder_jobs` WS frame.
export async function handleBuilderJobsRoute(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/hooks/builder-progress" && req.method === "POST") {
    const peer = peerOf(req)
    if (!(peer && isLoopback(peer)) && !checkBearer(req)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 })
    let raw: unknown
    try { raw = await req.json() } catch { return Response.json({ ok: false, error: "invalid_json" }, { status: 400 }) }
    const report = parseBuilderReport(raw)
    if (!report) return Response.json({ ok: false, error: "invalid_report" }, { status: 400 })
    builderJobs.report(report)
    return Response.json({ ok: true })
  }
  if (url.pathname === "/api/builder-jobs" && req.method === "GET") {
    return Response.json({ ok: true, jobs: builderJobs.frame().jobs })
  }
  return null
}
