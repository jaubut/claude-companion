import { localBodyHost } from "../lib/body-investigate"
import { SLUG_RE, jobDto, parsePeerFixRequest } from "../lib/resolver-peer"
import { hasRepoHere, peerJob, startPeerFix } from "../wiring/resolver-peer"

// Peer endpoints of the Opus resolver's fix runs (contract:
// docs/orchestrator-triage-api.md#peer-fix-runs). Auth is the `/api/*` bearer
// gate in companion-server.ts (Zettlab calls with COMPANION_BODY_PEER_TOKEN).
//   GET  /api/resolver/has-repo?slug=owner/repo   does THIS host have a checkout?
//   POST /api/resolver/fix                        start (or replay) a fix job here → 202 { jobId, status }
//   GET  /api/resolver/fix/:jobId                 poll it → { status: running | done, outcome? }
// A job runs on this host only: it is never forwarded again, whatever the HOP header says.

export interface ResolverRouteDeps {
  hasRepo?: typeof hasRepoHere
  start?: typeof startPeerFix
  job?: typeof peerJob
}

const JOB_PREFIX = "/api/resolver/fix/"

export function createResolverHandler(deps: ResolverRouteDeps = {}) {
  const hasRepo = deps.hasRepo ?? hasRepoHere
  const start = deps.start ?? startPeerFix
  const job = deps.job ?? peerJob

  return async function handleResolverRoute(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/api/resolver/has-repo" && req.method === "GET") {
      const slug = (url.searchParams.get("slug") ?? "").trim()
      if (!SLUG_RE.test(slug)) return Response.json({ ok: false, error: "slug must be owner/repo" }, { status: 400 })
      return Response.json({ ok: true, slug, hasRepo: await hasRepo(slug), host: localBodyHost() })
    }
    if (url.pathname === "/api/resolver/fix" && req.method === "POST") {
      let raw: unknown
      try {
        raw = await req.json()
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 })
      }
      const parsed = parsePeerFixRequest(raw)
      if ("error" in parsed) return Response.json({ ok: false, error: parsed.error }, { status: 400 })
      const out = start(parsed)
      return Response.json(jobDto(out.job, out.replay), { status: 202 })
    }
    if (url.pathname.startsWith(JOB_PREFIX) && req.method === "GET") {
      const id = url.pathname.slice(JOB_PREFIX.length)
      if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return Response.json({ ok: false, error: "bad job id" }, { status: 400 })
      const j = job(id)
      return j ? Response.json(jobDto(j)) : Response.json({ ok: false, error: "no such job" }, { status: 404 })
    }
    return null
  }
}

export const handleResolverRoute = createResolverHandler()
