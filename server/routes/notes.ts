import { DashboardKeyMissing, DashboardUnreachable, createNote, getNote, listNotes, searchDashboard, updateNote } from "../lib/dashboard-client"

// Notes proxy → tls-dashboard-v2 /api/note(s) + /api/search, behind the standard
// /api bearer gate. The phone never holds the dashboard key; dashboard-client adds it.
//   GET  /api/notes?q=&folder=&limit=  → {notes:[{id, ref_code, title, folder, status, date, updated_at, tags}]}
//        no q: most recently updated first. q: exact ref_code first, then title
//        matches (recent first), then body matches (dashboard search order).
//        limit 1..200 (default 50). Journal notes are never listed.
//   GET  /api/notes/:ref               → {note:{…, body}}   404 not_found · 403 journal_protected
//   POST /api/notes {title, folder, body, tags?, status?} → 201 {ok:true, id, ref_code}   (date = today)
//   PUT  /api/notes/:ref {title?, body?, status?, tags?}  → {ok:true, updated_at}
// The list comes from the dashboard's default list view, not ?lite=1: lite has no updated_at.
// Dashboard 4xx pass through (status + body); 5xx/network/redirect → 502
// dashboard_unreachable; no key in the vault → 503 dashboard_key_missing.

const REF = /^[A-Z]{3}-[A-Z0-9]{4}$/
const ITEM = /^\/api\/notes\/([^/]+)$/
const FOLDER = /^[a-z0-9-]{1,32}$/
const CREATE_FOLDERS = ["resources", "ideas", "projects", "tasks", "bookmarks", "meetings"]
const STATUSES = ["draft", "active", "pending", "done", "archived"]
const MAX_TITLE = 200
const MAX_Q = 200
const MAX_TAGS = 50
const MAX_TAG = 64

interface NoteRow { id: string; ref_code: string | null; title: string; folder: string; status: string | null; date: string | null; updated_at: string | null; tags: string[] }

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response => json({ ok: false, error, ...extra }, status)

function dashboardError(e: unknown): Response {
  if (e instanceof DashboardKeyMissing) return fail(503, "dashboard_key_missing")
  if (e instanceof DashboardUnreachable) return fail(502, "dashboard_unreachable", { upstreamStatus: e.status })
  throw e
}

const passThrough = (status: number, body: unknown): Response => json(body ?? { ok: false, error: "dashboard_error" }, status)

const str = (v: unknown): string | null => typeof v === "string" && v !== "" ? v : null
const isJournal = (n: { folder?: unknown; id?: unknown }): boolean =>
  n.folder === "journal" || (typeof n.id === "string" && n.id.startsWith("journal/"))

function row(n: Record<string, unknown>): NoteRow {
  return {
    id: String(n.id),
    ref_code: str(n.ref_code),
    title: typeof n.title === "string" ? n.title : "",
    folder: typeof n.folder === "string" ? n.folder : "",
    status: str(n.status),
    date: str(n.date),
    updated_at: str(n.updated_at),
    tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : [],
  }
}

// updated_at is `YYYY-MM-DD HH:MM:SS` (datetime('now')) or ISO; compare on one shape.
const sortKey = (n: NoteRow): string => (n.updated_at ?? n.date ?? "").replace("T", " ").slice(0, 19)
const byRecent = (a: NoteRow, b: NoteRow): number => sortKey(b).localeCompare(sortKey(a))

async function list(url: URL): Promise<Response> {
  const folder = url.searchParams.get("folder") || null
  if (folder !== null && !FOLDER.test(folder)) return fail(400, "bad_folder")
  const rawLimit = url.searchParams.get("limit")
  let limit = 50
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) return fail(400, "bad_limit")
    limit = Number(rawLimit)
  }
  const q = (url.searchParams.get("q") ?? "").trim()
  if (q.length > MAX_Q) return fail(400, "bad_q")
  if (folder === "journal") return json({ notes: [] })

  try {
    const [all, search] = await Promise.all([
      listNotes(),
      q ? searchDashboard(q, Math.min(800, limit * 4)) : Promise.resolve(null),
    ])
    if (all.status !== 200 || !Array.isArray(all.value)) return passThrough(all.status === 200 ? 502 : all.status, all.value)
    if (search && search.status !== 200) return passThrough(search.status, search.json)

    const notes = (all.value as unknown[])
      .filter((n): n is Record<string, unknown> => !!n && typeof n === "object" && typeof (n as { id?: unknown }).id === "string")
      .filter(n => !isJournal(n))
      .map(row)
      .filter(n => folder === null || n.folder === folder)
      .sort(byRecent)
    if (!q) return json({ notes: notes.slice(0, limit) })

    const needle = q.toLowerCase()
    const byId = new Map(notes.map(n => [n.id, n]))
    const out: NoteRow[] = []
    const seen = new Set<string>()
    const add = (n: NoteRow | undefined): void => { if (n && !seen.has(n.id)) { seen.add(n.id); out.push(n) } }
    for (const n of notes) if (n.ref_code?.toLowerCase() === needle) add(n)
    for (const n of notes) if (n.title.toLowerCase().includes(needle)) add(n)
    const results = Array.isArray(search?.json?.results) ? search.json.results as unknown[] : []
    for (const r of results) {
      if (!r || typeof r !== "object") continue
      const { kind, id } = r as { kind?: unknown; id?: unknown }
      if (kind === "note" && typeof id === "string") add(byId.get(id)) // byId already excludes journal + other folders
    }
    return json({ notes: out.slice(0, limit) })
  } catch (e) { return dashboardError(e) }
}

/** The note for `ref`, or the Response to send instead (404 / 403 journal / upstream error). */
async function fetchByRef(ref: string): Promise<Record<string, unknown> | Response> {
  const r = await getNote({ ref })
  if (r.status === 404) return fail(404, "not_found")
  if (r.status !== 200) return passThrough(r.status, r.json)
  // Upstream uppercases the ref and returns the note row; anything else is not a note.
  if (!r.json || typeof r.json.id !== "string" || r.json.ref_code !== ref) return fail(404, "not_found")
  if (isJournal(r.json)) return fail(403, "journal_protected")
  return r.json
}

async function read(ref: string): Promise<Response> {
  try {
    const n = await fetchByRef(ref)
    if (n instanceof Response) return n
    return json({ note: { ...row(n), body: typeof n.body === "string" ? n.body : "" } })
  } catch (e) { return dashboardError(e) }
}

function badTags(tags: unknown): boolean {
  return !Array.isArray(tags) || tags.length > MAX_TAGS || tags.some(t => typeof t !== "string" || t.trim() === "" || t.length > MAX_TAG)
}
function badTitle(title: unknown): string | null {
  if (typeof title !== "string" || title.trim() === "") return "missing_title"
  return title.length > MAX_TITLE ? "title_too_long" : null
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null) as unknown
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null
}

// Local calendar date (the Mac / Zettlab clock is America/Montreal), YYYY-MM-DD.
const today = (): string => new Date().toLocaleDateString("en-CA")

async function create(req: Request): Promise<Response> {
  const body = await readBody(req)
  if (!body) return fail(400, "bad_json")
  const { title, folder, body: text, tags, status } = body
  const titleErr = badTitle(title)
  if (titleErr) return fail(400, titleErr, { max: MAX_TITLE })
  if (folder === "journal") return fail(403, "journal_protected")
  if (typeof folder !== "string" || !CREATE_FOLDERS.includes(folder)) return fail(400, "bad_folder", { allowed: CREATE_FOLDERS })
  if (typeof text !== "string") return fail(400, "bad_body")
  if (tags !== undefined && badTags(tags)) return fail(400, "bad_tags")
  if (status !== undefined && (typeof status !== "string" || !STATUSES.includes(status))) return fail(400, "bad_status", { allowed: STATUSES })
  try {
    const r = await createNote({
      folder, title: (title as string).trim(), body: text, date: today(),
      status: status ?? "draft", ...(tags !== undefined ? { tags } : {}),
    })
    if (r.status !== 200 || r.json?.ok !== true) return passThrough(r.status === 200 ? 502 : r.status, r.json)
    return json({ ok: true, id: r.json.id, ref_code: r.json.ref_code }, 201)
  } catch (e) { return dashboardError(e) }
}

async function edit(req: Request, ref: string): Promise<Response> {
  const body = await readBody(req)
  if (!body) return fail(400, "bad_json")
  const { title, body: text, status, tags } = body
  const fields: Record<string, unknown> = {}
  if (title !== undefined) {
    const titleErr = badTitle(title)
    if (titleErr) return fail(400, titleErr, { max: MAX_TITLE })
    fields.title = (title as string).trim()
  }
  if (text !== undefined) {
    if (typeof text !== "string") return fail(400, "bad_body")
    fields.body = text
  }
  if (status !== undefined) {
    if (typeof status !== "string" || !STATUSES.includes(status)) return fail(400, "bad_status", { allowed: STATUSES })
    fields.status = status
  }
  if (tags !== undefined) {
    if (badTags(tags)) return fail(400, "bad_tags")
    fields.tags = tags
  }
  if (Object.keys(fields).length === 0) return fail(400, "no_fields")
  try {
    const n = await fetchByRef(ref)
    if (n instanceof Response) return n
    const r = await updateNote({ id: n.id, ...fields, changed_by: "companion" })
    if (r.status !== 200 || r.json?.ok !== true) return passThrough(r.status === 200 ? 502 : r.status, r.json)
    return json({ ok: true, updated_at: typeof r.json.updated_at === "string" ? r.json.updated_at : "" })
  } catch (e) { return dashboardError(e) }
}

export async function handleNotesRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname
  if (p === "/api/notes") {
    if (req.method === "GET") return list(url)
    if (req.method === "POST") return create(req)
    return fail(405, "method_not_allowed")
  }
  if (!p.startsWith("/api/notes/")) return null
  const m = ITEM.exec(p)
  if (!m) return fail(404, "not_found")
  let ref: string
  try { ref = decodeURIComponent(m[1]!) } catch { return fail(400, "bad_ref") }
  if (!REF.test(ref)) return fail(400, "bad_ref")
  if (req.method === "GET") return read(ref)
  if (req.method === "PUT") return edit(req, ref)
  return fail(405, "method_not_allowed")
}
