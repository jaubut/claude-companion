import { checkBearer, unauthorized } from "../lib/auth"
import { BRAIN_AGENT, BRAIN_THREAD, brainEnabled } from "../lib/brain"
import { latestRows, rowsSince } from "../lib/brain-trace"
import { companionLog } from "../lib/log"
import { searchThread } from "../lib/orchestrator-chat"
import { type Session, listSessions } from "../lib/sessions"
import { clientOrigin, peerOf } from "../lib/vault-guard"
import { type BrainWiring, brainWiring } from "../wiring/brain"

// brain-v2 routes (docs/brain-api.md):
//   GET  /api/brain                       → {ok, brain: {state, sessionKey, since, restarts, host}}
//   GET  /api/brain/trace?since=<seq>     → {ok, rows: TraceRow[]}
//   POST /api/brain/pause|resume|restart  → {ok, brain}; restart while paused → 409 paused
//   POST /hooks/brain/propose             → bin/propose: {title, prompt, noteId, agent?, reasoning, sourceTurnId}
//   POST /hooks/brain/thread              → bin/thread: {q, limit?} → {ok, turns: [{id, role, at, text}]} (brain thread, newest first)
// /api/* is Bearer-gated by companion-server.ts; checked here too. The propose
// hook is loopback only (a tailscale-serve hop is refused), and must carry the
// brain session's pid with X-Companion-Task-Id: brain.

const TURN_ID = /^[\w:-]{1,64}$/
const TITLE_MAX = 200
const PROMPT_MAX = 20_000
const NOTE_ID_MAX = 300
const REASONING_MAX = 2_000
const QUERY_MAX = 200
const SEARCH_LIMIT_MAX = 50
/** Per turn in a search answer: enough to recall, short enough for a tool result. */
const SEARCH_TEXT_MAX = 1_000

export interface BrainRouteDeps {
  wiring: BrainWiring
  sessions: () => Session[]
  enabled: () => boolean
}

const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status })
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null)

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.json() as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Only the supervised brain session may propose: loopback peer, brain task header, its pid, its session id. */
function proposeRefusal(req: Request, deps: BrainRouteDeps): Response | null {
  const origin = clientOrigin(req, peerOf(req))
  if (origin.transport !== "loopback") return fail(403, "forbidden")
  if (req.headers.get("x-companion-task-id") !== BRAIN_AGENT) return fail(403, "forbidden")
  const pid = req.headers.get("x-companion-pid")?.trim() ?? ""
  const st = deps.wiring.status()
  if (!pid || !st.sessionKey) return fail(403, "forbidden")
  const s = deps.sessions().find((x) => x.key === st.sessionKey)
  const brain = deps.sessions().find((x) => x.pid === pid)
  if (!s || !brain || brain.key !== s.key || brain.sessionId !== s.sessionId || brain.taskId !== BRAIN_AGENT) return fail(403, "forbidden")
  return null
}

async function propose(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) {
    companionLog(`[brain] propose refused (peer=${peerOf(req) ?? "?"})`)
    return refused
  }
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const noteId = str(body.noteId, NOTE_ID_MAX)
  if (!noteId) return fail(422, "no_project")
  const prompt = str(body.prompt, PROMPT_MAX)
  if (!prompt) return fail(400, "prompt required")
  const sourceTurnId = typeof body.sourceTurnId === "string" && TURN_ID.test(body.sourceTurnId) ? body.sourceTurnId : null
  if (!sourceTurnId) return fail(400, "sourceTurnId required")
  const title = str(body.title, TITLE_MAX) ?? prompt.split("\n")[0]!.slice(0, TITLE_MAX)
  const agent = body.agent === undefined || body.agent === null ? null : str(body.agent, 64)
  if (body.agent !== undefined && body.agent !== null && !agent) return fail(400, "unknown_agent")
  const reasoning = str(body.reasoning, REASONING_MAX) ?? ""
  const out = await deps.wiring.propose({ title, prompt, noteId, agent, reasoning, sourceTurnId })
  return Response.json(out.body, { status: out.status })
}

async function thread(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const q = str(body.q, QUERY_MAX)
  if (!q) return fail(400, "q required")
  const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), SEARCH_LIMIT_MAX) : 20
  const turns = searchThread(BRAIN_THREAD, q, limit).map((t) => ({
    id: t.id, role: t.role, at: new Date(t.createdAt).toISOString(),
    text: t.text.length > SEARCH_TEXT_MAX ? `${t.text.slice(0, SEARCH_TEXT_MAX - 1)}…` : t.text,
  }))
  return Response.json({ ok: true, turns })
}

export function createBrainRoute(deps: BrainRouteDeps = { wiring: brainWiring, sessions: listSessions, enabled: brainEnabled }) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const p = url.pathname
    if (p === "/hooks/brain/propose") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return propose(req, deps)
    }
    if (p === "/hooks/brain/thread") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return thread(req, deps)
    }
    if (p !== "/api/brain" && !p.startsWith("/api/brain/")) return null
    if (!checkBearer(req)) return unauthorized()
    if (!deps.enabled()) return fail(404, "brain_disabled")
    if (p === "/api/brain" && req.method === "GET") return Response.json({ ok: true, brain: deps.wiring.status() })
    if (p === "/api/brain/trace" && req.method === "GET") {
      const raw = url.searchParams.get("since")
      const since = raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null
      return Response.json({ ok: true, rows: since === null ? latestRows() : rowsSince(since) })
    }
    if (req.method !== "POST") return fail(405, "method_not_allowed")
    if (p === "/api/brain/pause") return Response.json({ ok: true, brain: deps.wiring.pause() })
    if (p === "/api/brain/resume") return Response.json({ ok: true, brain: deps.wiring.resume() })
    if (p === "/api/brain/restart") {
      const st = await deps.wiring.restart()
      return st ? Response.json({ ok: true, brain: st }) : fail(409, "paused")
    }
    return fail(404, "not_found")
  }
}

export const brainRoute = createBrainRoute()
