import { MAX_KEY_LENGTH } from "../lib/idempotency"
import type { TriageEngine } from "../lib/triage-engine"
import { triageEngine } from "../wiring/triage"

// Brain triage endpoints (docs/orchestrator-triage-api.md), bearer-gated like
// every /api/orchestrator/* route:
//   GET  /api/orchestrator/triage                    → {items, generatedAt}
//   POST /api/orchestrator/triage/<id>/choose        {optionId, text?} + Idempotency-Key
// <id> is percent-encoded (a PR id carries "/" and "#"). Returns null for any other path.

const PREFIX = "/api/orchestrator/triage"
const ID_MAX = 300

function chosenId(pathname: string): string | null {
  if (!pathname.startsWith(`${PREFIX}/`) || !pathname.endsWith("/choose")) return null
  const raw = pathname.slice(PREFIX.length + 1, -"/choose".length)
  try {
    const id = decodeURIComponent(raw)
    return id && id.length <= ID_MAX ? id : null
  } catch {
    return null
  }
}

async function choose(req: Request, id: string, engine: TriageEngine): Promise<Response> {
  let body: Record<string, unknown>
  try {
    const raw = await req.json() as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object")
    body = raw as Record<string, unknown>
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 })
  }
  const optionId = typeof body.optionId === "string" ? body.optionId.trim() : ""
  if (!optionId) return Response.json({ ok: false, error: "optionId required" }, { status: 400 })
  if (body.text !== undefined && body.text !== null && typeof body.text !== "string") {
    return Response.json({ ok: false, error: "text must be a string" }, { status: 400 })
  }
  const idemKey = req.headers.get("idempotency-key")?.trim() || null
  if (idemKey && idemKey.length > MAX_KEY_LENGTH) return Response.json({ ok: false, error: "idempotency-key-too-long" }, { status: 400 })
  const out = await engine.choose({ id, optionId, text: (body.text as string | undefined) ?? null, idemKey })
  return Response.json(out.body, { status: out.status, headers: out.body.result === "replay" ? { "Idempotent-Replayed": "true" } : undefined })
}

export function createTriageHandler(engine: () => TriageEngine = triageEngine) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname === PREFIX && req.method === "GET") {
      if (url.searchParams.get("fresh") === "1") await engine().refresh()
      return Response.json(await engine().list())
    }
    if (url.pathname.startsWith(`${PREFIX}/`) && req.method === "POST") {
      const id = chosenId(url.pathname)
      if (!id) return Response.json({ ok: false, error: "no_such_item" }, { status: 404 })
      return choose(req, id, engine())
    }
    return null
  }
}

export const handleTriageRoute = createTriageHandler()
