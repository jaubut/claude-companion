import { type QueryFn, type Row, TursoUnreachable, tursoQuery } from "../lib/turso"

// GET /api/goals — read-only proxy of active projects + their next open tasks
// from Turso (Phase 19 step 6, RES-B9CL). The phone never holds the Turso
// token; auth is the `/api/*` bearer gate in companion-server.ts. Responses
// are cached in memory for 60 s per server; `?fresh=1` bypasses. Any Turso
// failure maps to 503 `{ error: "turso_unreachable" }` — never a stack, never
// the SQL. Never log the URL: a `?token=` query would land in the log.

export interface GoalTask {
  id: string
  text: string
  dueDate: string | null
  assignee: string | null
  dispatchStatus: string | null
}

export interface GoalProject {
  id: string
  refCode: string | null
  title: string
  status: string
  statusParagraph: string
  updatedAt: string | null
  nextTasks: GoalTask[]
  openCount: number
}

export interface GoalsResponse {
  generatedAt: string
  projects: GoalProject[]
}

export const PROJECT_CAP = 25
export const TASKS_PER_PROJECT = 3
export const CACHE_TTL_MS = 60_000
const PARAGRAPH_MAX = 400
const STATUS_HEADING = /status|where we are|living status/i

const PROJECTS_SQL =
  "SELECT id, ref_code, title, status, body, updated_at FROM notes " +
  "WHERE folder = ? AND status IN (?, ?) ORDER BY updated_at DESC LIMIT ?"

// One round trip for every project's open tasks: the first N per note by
// position plus the per-note open count. Placeholders are generated; values
// stay parameterized.
function tasksSql(noteCount: number): string {
  const marks = Array.from({ length: noteCount }, () => "?").join(", ")
  return (
    "SELECT id, note_id, text, due_date, assignee, dispatch_status, open_count FROM (" +
    "SELECT id, note_id, text, due_date, assignee, dispatch_status, " +
    "ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY position, id) AS rn, " +
    "COUNT(*) OVER (PARTITION BY note_id) AS open_count " +
    `FROM tasks WHERE done = 0 AND note_id IN (${marks})` +
    ") WHERE rn <= ? ORDER BY note_id, rn"
  )
}

// ── Status paragraph ─────────────────────────────────────────────────────────

type Block = { kind: "heading"; text: string } | { kind: "para"; text: string }

function stripFrontmatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return lines
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
  return end < 0 ? lines : lines.slice(end + 1)
}

function toBlocks(body: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let inFence = false
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ").replace(/\s+/g, " ").trim() })
    para = []
  }
  for (const raw of stripFrontmatter(body.split(/\r?\n/))) {
    const line = raw.trim()
    if (line.startsWith("```")) {
      flush()
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: "heading", text: heading[1] ?? "" })
    } else if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush()
    } else {
      para.push(line)
    }
  }
  flush()
  return blocks.filter((b) => b.kind === "heading" || b.text.length > 0)
}

function clamp(text: string): string {
  return text.length <= PARAGRAPH_MAX ? text : text.slice(0, PARAGRAPH_MAX - 1).trimEnd() + "…"
}

/** First paragraph under a status-like heading, else the first non-heading paragraph. */
export function extractStatusParagraph(body: string | null): string {
  if (!body) return ""
  const blocks = toBlocks(body)
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b?.kind !== "heading" || !STATUS_HEADING.test(b.text)) continue
    const next = blocks[i + 1]
    if (next?.kind === "para") return clamp(next.text)
  }
  const first = blocks.find((b) => b.kind === "para")
  return first ? clamp(first.text) : ""
}

// ── Build ────────────────────────────────────────────────────────────────────

const str = (v: Row[string] | undefined): string | null => (v == null ? null : String(v))

// Schema default is '' for due_date: the wire shape is null, never "".
function emptyToNull(v: string | null): string | null {
  return v == null || v.trim() === "" ? null : v
}

// updated_at mixes "2026-09-14 01:52:57" (UTC, dashboard writes) and ISO
// "2026-09-11T00:09:59.238Z". The wire shape is ISO 8601 UTC, always.
export function isoDate(v: string | null): string | null {
  if (v == null || v.trim() === "") return null
  const t = v.trim()
  const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(t)
  const d = new Date(sql ? `${sql[1]}T${sql[2]}Z` : t)
  return Number.isNaN(d.getTime()) ? t : d.toISOString()
}

function toTask(r: Row): GoalTask {
  return {
    id: String(r.id),
    text: str(r.text) ?? "",
    dueDate: emptyToNull(str(r.due_date)),
    assignee: str(r.assignee),
    dispatchStatus: str(r.dispatch_status),
  }
}

export async function buildGoals(query: QueryFn, now: () => number = Date.now): Promise<GoalsResponse> {
  const notes = await query(PROJECTS_SQL, ["projects", "active", "pending", PROJECT_CAP])
  const capped = notes.slice(0, PROJECT_CAP)
  const ids = capped.map((n) => String(n.id))
  const taskRows = ids.length ? await query(tasksSql(ids.length), [...ids, TASKS_PER_PROJECT]) : []

  const byNote = new Map<string, { tasks: GoalTask[]; open: number }>()
  for (const r of taskRows) {
    const key = String(r.note_id)
    const entry = byNote.get(key) ?? { tasks: [], open: Number(r.open_count) || 0 }
    if (entry.tasks.length < TASKS_PER_PROJECT) entry.tasks.push(toTask(r))
    byNote.set(key, entry)
  }

  const projects = capped.map((n): GoalProject => {
    const id = String(n.id)
    const t = byNote.get(id)
    return {
      id,
      refCode: str(n.ref_code),
      title: str(n.title) ?? id,
      status: str(n.status) ?? "",
      statusParagraph: extractStatusParagraph(str(n.body)),
      updatedAt: isoDate(str(n.updated_at)),
      nextTasks: t?.tasks ?? [],
      openCount: t?.open ?? 0,
    }
  })
  return { generatedAt: new Date(now()).toISOString(), projects }
}

// ── Handler + cache ──────────────────────────────────────────────────────────

export interface GoalsDeps {
  query?: QueryFn
  now?: () => number
  ttlMs?: number
}

export function createGoalsHandler(deps: GoalsDeps = {}) {
  const query = deps.query ?? tursoQuery
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? CACHE_TTL_MS
  let cached: { at: number; body: GoalsResponse; gen: number } | null = null
  // Requests are numbered when they START; a slower, older fetch must never
  // overwrite the cache written by a newer one (e.g. a ?fresh=1 refresh).
  let nextGen = 0

  return async function handleGoalsRoute(req: Request, url: URL): Promise<Response | null> {
    if (!(url.pathname === "/api/goals" && req.method === "GET")) return null
    const fresh = url.searchParams.get("fresh") === "1"
    if (!fresh && cached && now() - cached.at < ttl) return Response.json(cached.body)
    const gen = ++nextGen
    try {
      const body = await buildGoals(query, now)
      if (!cached || gen > cached.gen) cached = { at: now(), body, gen }
      return Response.json(body)
    } catch (err) {
      // TursoUnreachable messages are fixed strings (no SQL, no token). A
      // code bug still maps to 503 but is distinguishable in the log.
      const what = err instanceof TursoUnreachable ? err.message : `unexpected error (${(err as Error)?.name ?? typeof err})`
      console.error(`[goals] ${what}`)
      return Response.json({ error: "turso_unreachable" }, { status: 503 })
    }
  }
}

export const handleGoalsRoute = createGoalsHandler()
