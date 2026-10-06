import { companionLog } from "../lib/log"
import type { TasksAgent } from "../lib/tasks-agent"
import type { TasksChat } from "../lib/tasks-agent-chat"
import { TursoUnreachable } from "../lib/turso"

// Brain → Tasks agent tab (PRJ-CT4M WP5, contract docs/tasks-agent-api.md):
//   GET  /api/tasks/agent                      → { generatedAt, today, tz, digest, proposals, load }
//   POST /api/tasks/agent/undo {activityId}    → { ok, taskId, field, restored }
//   POST /api/tasks/agent/proposals/:id {action:"accept"|"dismiss", due?, subtasks?}
//   POST /api/tasks/agent/chat/:planId {confirm} → apply / drop a held chat move
// Device = `X-Companion-Device` (the digest baseline is per device). Every
// write pushes `tasks_changed`. Turso failures → 503 turso_unreachable.

const PROPOSAL = /^\/api\/tasks\/agent\/proposals\/([^/]+)$/
const CHAT = /^\/api\/tasks\/agent\/chat\/([A-Za-z0-9]{8,64})$/
const PROPOSAL_ID = /^(slip|assign|split):[\w.-]{1,64}$|^merge:[\w.-]{1,64}:[\w.-]{1,64}$/

export interface TasksAgentRouteDeps {
  agent: TasksAgent
  chat: TasksChat | null
  notify: (frame: Record<string, unknown>) => void
}

function fail(err: unknown): Response {
  const what = err instanceof TursoUnreachable ? err.message : `unexpected error (${(err as Error)?.name ?? typeof err})`
  companionLog(`[tasks-agent] ${what}`)
  return Response.json({ error: "turso_unreachable" }, { status: 503 })
}

const err = (status: number, error: string) => Response.json({ error }, { status })

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await req.json()) as unknown
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  } catch { return null }
}

export function deviceOf(req: Request): string {
  const d = (req.headers.get("x-companion-device") ?? "").replace(/[^\w .:-]/g, "").trim().slice(0, 80)
  return d || "default"
}

export function createTasksAgentRoute(deps: TasksAgentRouteDeps) {
  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname
    if (p !== "/api/tasks/agent" && !p.startsWith("/api/tasks/agent/")) return null

    if (p === "/api/tasks/agent") {
      if (req.method !== "GET") return err(405, "method_not_allowed")
      try { return Response.json(await deps.agent.view(deviceOf(req), url.searchParams.get("fresh") === "1")) } catch (e) { return fail(e) }
    }

    if (p === "/api/tasks/agent/undo") {
      if (req.method !== "POST") return err(405, "method_not_allowed")
      const body = await jsonBody(req)
      if (!body) return err(400, "bad_json")
      const id = body.activityId
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return err(400, "activity_id_must_be_positive_integer")
      try {
        const r = await deps.agent.undo(id)
        if (!r.ok) return err(r.status, r.error)
        deps.notify({ type: "tasks_changed", taskId: r.taskId, why: "undo" })
        return Response.json(r)
      } catch (e) { return fail(e) }
    }

    const pm = PROPOSAL.exec(p)
    if (pm) {
      if (req.method !== "POST") return err(405, "method_not_allowed")
      const id = decodeURIComponent(pm[1]!)
      if (!PROPOSAL_ID.test(id)) return err(400, "bad_id")
      const body = await jsonBody(req)
      if (!body) return err(400, "bad_json")
      if (body.action !== "accept" && body.action !== "dismiss") return err(400, "action_must_be_accept_or_dismiss")
      try {
        const r = await deps.agent.decide(id, body.action, { due: body.due, subtasks: body.subtasks })
        if (!r.ok) return err(r.status, r.error)
        if ("decision" in r && r.decision === "accept") deps.notify({ type: "tasks_changed", taskId: r.taskIds[r.taskIds.length - 1], why: "agent" })
        return Response.json(r)
      } catch (e) { return fail(e) }
    }

    const cm = CHAT.exec(p)
    if (cm) {
      if (req.method !== "POST") return err(405, "method_not_allowed")
      if (!deps.chat) return err(404, "no_such_plan")
      const body = await jsonBody(req)
      if (!body) return err(400, "bad_json")
      if (typeof body.confirm !== "boolean") return err(400, "confirm_must_be_boolean")
      try {
        const r = await deps.chat.confirm(cm[1]!, body.confirm)
        return r.ok ? Response.json(r) : err(r.status, r.error)
      } catch (e) { return fail(e) }
    }

    return err(404, "not_found")
  }
}
