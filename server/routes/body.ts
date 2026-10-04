import { type BodySnapshot, buildComponentDetail } from "../lib/body"
import { validateAlert } from "../lib/body-alert"
import { type InvestigationRecord, investigationDto } from "../lib/body-investigate"
import { companionLog } from "../lib/log"
import { type QueryFn, TursoUnreachable, tursoQuery } from "../lib/turso"
import { type BodyAlertSink, bodyAlertSink, bodySnapshot } from "../wiring/body"
import { parseInvestigateBody } from "../lib/body-investigator"
import { type BodyInvestigator, HOP_HEADER, bodyInvestigator } from "../wiring/body-investigate"

// Body monitor API (living-system nervous system). Auth is the `/api/*` bearer
// gate in companion-server.ts. Contract: docs/body-api.md.
//   GET  /api/body                    summary + components + last 50 events (30 s cache; ?all=1, ?fresh=1)
//   GET  /api/body/component/:id      one component + latest vitals + last 50 events (id URL-decoded)
//   POST /api/body/alert              collector alert → #Body turn, `body_alert` frame, gated push
//                                     (+ a problem state triggers an auto-investigation)
//   POST /api/body/investigate        {component_id,…} investigate on this host / {report} from a peer
// Turso failures map to 503 `{ok:false, error:"turso_unreachable"}`; never the SQL.

export interface BodyRouteDeps {
  query?: QueryFn
  snapshot?: BodySnapshot
  sink?: BodyAlertSink
  /** Lazy: the live investigator is built on first use. */
  investigator?: () => Pick<BodyInvestigator, "consider" | "receiveReport" | "latestFor">
  now?: () => number
}

const COMPONENT_PREFIX = "/api/body/component/"

function unreachable(err: unknown): Response {
  const what = err instanceof TursoUnreachable ? err.message : `unexpected error (${(err as Error)?.name ?? typeof err})`
  console.error(`[body] ${what}`)
  return Response.json({ ok: false, error: "turso_unreachable" }, { status: 503 })
}

export function createBodyHandler(deps: BodyRouteDeps = {}) {
  const query = deps.query ?? tursoQuery
  const snapshot = deps.snapshot ?? bodySnapshot
  const sink = deps.sink ?? bodyAlertSink
  const now = deps.now ?? Date.now
  const investigator = deps.investigator ?? bodyInvestigator
  const latest = (id: string): InvestigationRecord | null => {
    try { return investigator().latestFor(id) } catch { return null }
  }

  return async function handleBodyRoute(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/api/body" && req.method === "GET") {
      try {
        const all = url.searchParams.get("all") === "1"
        return Response.json(await snapshot.get({ all, fresh: url.searchParams.get("fresh") === "1" }))
      } catch (err) {
        return unreachable(err)
      }
    }
    if (url.pathname.startsWith("/api/body/component/") && req.method === "GET") {
      let id: string
      try {
        id = decodeURIComponent(url.pathname.slice(COMPONENT_PREFIX.length))
      } catch {
        return Response.json({ ok: false, error: "bad component id" }, { status: 400 })
      }
      if (!id) return Response.json({ ok: false, error: "component id required" }, { status: 400 })
      try {
        const detail = await buildComponentDetail(query, id, now)
        return detail ? Response.json({ ...detail, investigation: investigationDto(latest(id)) }) : Response.json({ ok: false, error: "no such component" }, { status: 404 })
      } catch (err) {
        return unreachable(err)
      }
    }
    if (url.pathname === "/api/body/alert" && req.method === "POST") {
      let raw: unknown
      try {
        raw = await req.json()
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 })
      }
      const alert = validateAlert(raw)
      if ("error" in alert) return Response.json({ ok: false, error: alert.error }, { status: 400 })
      sink(alert)
      // Autonomous, read-only: a component going dead / crash_loop / failing is
      // investigated with no tap (the gate drops everything else). Never blocks the POST.
      void investigator().consider({ componentId: alert.component_id, state: alert.state, fromState: alert.from_state, trigger: "alert" })
        .catch((err) => companionLog(`[body-investigate] alert trigger failed: ${(err as Error)?.message ?? err}`))
      return Response.json({ ok: true })
    }
    if (url.pathname === "/api/body/investigate" && req.method === "POST") {
      let raw: unknown
      try {
        raw = await req.json()
      } catch {
        return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 })
      }
      const parsed = parseInvestigateBody(raw)
      if ("error" in parsed) return Response.json({ ok: false, error: parsed.error }, { status: 400 })
      try {
        if (parsed.kind === "report") return Response.json({ ok: true, status: await investigator().receiveReport(parsed.report) })
        const out = await investigator().consider({ ...parsed.request, hop: req.headers.get(HOP_HEADER) === "1" })
        return Response.json({ ok: true, ...out })
      } catch (err) {
        return unreachable(err)
      }
    }
    return null
  }
}

export const handleBodyRoute = createBodyHandler()
