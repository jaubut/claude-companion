import { MAX_KEY_LENGTH } from "../lib/idempotency"
import { NOTE_MAX } from "../lib/repo-rework"
import type { TriageEngine } from "../lib/triage-engine"
import { MEMBERS_MAX } from "../lib/triage-repos"
import { triageEngine } from "../wiring/triage"
import { type RepoRunner, repoRunner } from "../wiring/triage-repos"

// Brain triage endpoints (docs/orchestrator-triage-api.md), bearer-gated like
// every /api/orchestrator/* route:
//   GET  /api/orchestrator/triage                    → {items, resolving, repos, generatedAt}
//   POST /api/orchestrator/triage/<id>/choose        {optionId, text?} + Idempotency-Key
//   POST /api/orchestrator/repos/<repo>/yes          {version, members[{id, version}]} + Idempotency-Key
//   POST /api/orchestrator/repos/<repo>/no           {version, note} + Idempotency-Key
// <id> / <repo> are percent-encoded (a PR id carries "/" and "#"). Returns null for any other path.

const PREFIX = "/api/orchestrator/triage"
const REPOS = "/api/orchestrator/repos"
const ID_MAX = 300
const REPO_RE = /^[\w.-]{1,200}$/

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

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.json() as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch {
    return null
  }
}

const bad = (error: string, status = 400): Response => Response.json({ ok: false, error }, { status })

async function choose(req: Request, id: string, engine: TriageEngine): Promise<Response> {
  const body = await jsonBody(req)
  if (!body) return bad("invalid JSON")
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

/** `/api/orchestrator/repos/<repo>/(yes|no)` → the decoded repo key + verb; null = not a repo route. */
function repoAction(pathname: string): { repo: string; decision: "yes" | "no" } | null {
  const m = /^\/api\/orchestrator\/repos\/([^/]+)\/(yes|no)$/.exec(pathname)
  if (!m) return null
  try {
    const repo = decodeURIComponent(m[1]!)
    return REPO_RE.test(repo) ? { repo, decision: m[2] as "yes" | "no" } : null
  } catch {
    return null
  }
}

function parseMembers(v: unknown): { id: string; version: string }[] | null {
  if (!Array.isArray(v) || !v.length || v.length > MEMBERS_MAX) return null
  const out: { id: string; version: string }[] = []
  for (const m of v) {
    if (!m || typeof m !== "object") return null
    const o = m as Record<string, unknown>
    if (typeof o.id !== "string" || typeof o.version !== "string" || !o.id || o.id.length > ID_MAX) return null
    out.push({ id: o.id, version: o.version })
  }
  return out
}

async function repoDecision(req: Request, repo: string, decision: "yes" | "no", runner: RepoRunner): Promise<Response> {
  const body = await jsonBody(req)
  if (!body) return bad("invalid JSON")
  if (typeof body.version !== "string" || !body.version) return bad("version_required")
  const idemKey = req.headers.get("idempotency-key")?.trim() || null
  if (idemKey && idemKey.length > MAX_KEY_LENGTH) return bad("idempotency-key-too-long")
  let members: { id: string; version: string }[] | undefined
  let note: string | null = null
  if (decision === "yes") {
    members = parseMembers(body.members) ?? undefined
    if (!members) return bad(`members must be 1-${MEMBERS_MAX} {id, version}`)
  } else {
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return bad("note must be a string")
    note = typeof body.note === "string" ? body.note.trim() : ""
    if (!note) return bad("note_required", 422)
    if (note.length > NOTE_MAX) return bad("note_too_long")
  }
  const out = await runner.submit({ repo, decision, version: body.version, members, note, idemKey })
  return Response.json(out.body, { status: out.status, headers: out.body.result === "replay" ? { "Idempotent-Replayed": "true" } : undefined })
}

export function createTriageHandler(engine: () => TriageEngine = triageEngine, runner: () => RepoRunner = repoRunner) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname.startsWith(`${REPOS}/`) && req.method === "POST") {
      const action = repoAction(url.pathname)
      if (!action) return bad("no_such_repo", 404)
      return repoDecision(req, action.repo, action.decision, runner())
    }
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
