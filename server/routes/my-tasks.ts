import { companionLog } from "../lib/log"
import { type MyTasksResponse, TASKS_TZ, buildCascade, fingerprint, listMine, localDay, normDate, setDone, setDue } from "../lib/my-tasks"
import { type ExecFn, type QueryFn, TursoUnreachable, tursoExec, tursoQuery } from "../lib/turso"
import { broadcast } from "../state"

// Jeremie's tasks (PRJ-CT4M WP1, contract docs/tasks-api.md):
//   GET  /api/tasks/mine            → MyTasksResponse (cached 30 s; ?fresh=1 bypasses)
//   POST /api/tasks/:id/done {done} → { ok, done, due }
//   POST /api/tasks/:id/due  {due}  → { ok, done, due }   (due: "YYYY-MM-DD" | null)
// Every write and every change the 60 s watcher sees (dashboard edits, agents)
// pushes `{ type: "tasks_changed" }` so the phone refetches. Auth = the /api/*
// bearer gate. Turso failures → 503 turso_unreachable, never SQL or a stack.

export const CACHE_TTL_MS = 30_000
export const WATCH_MS = 60_000
const ID = /^[A-Za-z0-9-]{8,64}$/
const WRITE = /^\/api\/tasks\/([^/]+)\/(done|due)$/

export interface MyTasksDeps {
  query?: QueryFn
  exec?: ExecFn
  now?: () => number
  notify?: (frame: Record<string, unknown>) => void
  ttlMs?: number
}

function fail(err: unknown): Response {
  const what = err instanceof TursoUnreachable ? err.message : `unexpected error (${(err as Error)?.name ?? typeof err})`
  companionLog(`[tasks] ${what}`)
  return Response.json({ error: "turso_unreachable" }, { status: 503 })
}

export function createMyTasks(deps: MyTasksDeps = {}) {
  const query = deps.query ?? tursoQuery
  const exec = deps.exec ?? tursoExec
  const now = deps.now ?? Date.now
  const notify = deps.notify ?? broadcast
  const ttl = deps.ttlMs ?? CACHE_TTL_MS
  let cached: { at: number; body: MyTasksResponse; print: string } | null = null
  let lastPrint: string | null = null

  async function load(): Promise<{ body: MyTasksResponse; print: string }> {
    const rows = await listMine(query)
    const t = now()
    const tz = TASKS_TZ()
    const out = { body: buildCascade(rows, localDay(t, tz), t, tz), print: fingerprint(rows) }
    cached = { at: t, ...out }
    lastPrint ??= out.print
    return out
  }

  const changed = (taskId: string, why: string) => {
    cached = null
    lastPrint = null
    notify({ type: "tasks_changed", taskId, why })
  }

  async function handle(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/api/tasks/mine") {
      if (req.method !== "GET") return Response.json({ error: "method_not_allowed" }, { status: 405 })
      const fresh = url.searchParams.get("fresh") === "1"
      // A cached body from yesterday has the wrong "today": rebuild across local midnight.
      if (!fresh && cached && now() - cached.at < ttl && cached.body.today === localDay(now(), TASKS_TZ())) return Response.json(cached.body)
      try { return Response.json((await load()).body) } catch (err) { return fail(err) }
    }

    const m = WRITE.exec(url.pathname)
    if (!m) return null
    if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 })
    const id = decodeURIComponent(m[1]!)
    if (!ID.test(id)) return Response.json({ error: "bad_id" }, { status: 400 })
    let body: Record<string, unknown>
    try { body = (await req.json()) as Record<string, unknown> } catch { return Response.json({ error: "bad_json" }, { status: 400 }) }
    if (!body || typeof body !== "object") return Response.json({ error: "bad_json" }, { status: 400 })

    try {
      if (m[2] === "done") {
        if (typeof body.done !== "boolean") return Response.json({ error: "done_must_be_boolean" }, { status: 400 })
        const r = await setDone(exec, id, body.done)
        if (!r.ok) return Response.json({ error: r.error }, { status: 404 })
        changed(id, body.done ? "done" : "reopened")
        return Response.json(r)
      }
      const due = body.due === null ? null : normDate(body.due)
      if (body.due !== null && (!due || due !== body.due)) return Response.json({ error: "due_must_be_yyyy_mm_dd_or_null" }, { status: 400 })
      const r = await setDue(exec, id, due)
      if (!r.ok) return Response.json({ error: r.error }, { status: 404 })
      changed(id, "due")
      return Response.json(r)
    } catch (err) { return fail(err) }
  }

  /** One watcher tick: refetch, push tasks_changed when the open set moved since the last look. */
  async function watchTick(): Promise<boolean> {
    const before = lastPrint
    const { print } = await load()
    lastPrint = print
    if (before !== null && before !== print) {
      notify({ type: "tasks_changed", why: "external" })
      return true
    }
    return false
  }

  return { handle, watchTick }
}

const live = createMyTasks()
export const handleMyTasksRoute = live.handle

/** Boot (cli.ts): watch Turso for task edits made elsewhere (dashboard, agents, the other host). */
export function startMyTasksWatch(): () => void {
  const t = setInterval(() => { void live.watchTick().catch(() => { /* Turso blip: next tick */ }) }, WATCH_MS)
  ;(t as unknown as { unref?: () => void }).unref?.()
  return () => clearInterval(t)
}
