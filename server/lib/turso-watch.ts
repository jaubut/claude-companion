import { BRAIN_AGENT } from "./brain"
import { MINE, addDays, localDay } from "./my-tasks"
import { RESOLVER_SLUG } from "./resolver"
import { AGENT_SLUG as TASKS_AGENT_SLUG } from "./tasks-agent"
import type { QueryFn, Row, SqlArg } from "./turso"

// Brain Turso watcher, pure core (wiring/turso-watch.ts runs it): every tick,
// read the important Turso changes since a per-signal high-water mark and hand
// the brain ONE grouped `[event]` at most every 3 min. Only ids, ref_codes,
// invoice numbers and enum fields reach the text — never a body, raw_text, task
// text or ticket title: the brain reads content itself, as untrusted data.
//
// Marks are DB time (the row's own updated_at / created_at), never the host
// clock, and every read re-scans LOOKBACK before the mark: a row written with a
// slightly older timestamp is still seen, and the (signal, id, state) dedupe
// absorbs the overlap. Reads page through (at, id) with a persisted keyset
// cursor, so a burst bigger than READ_LIMIT drains instead of re-reading the
// same page forever. Never read: the journal folder, token_usage,
// token_sessions, brain-log / brain-memory / session-archive notes, and task
// changes the brain or this server logged in agent_activity.

export const WATCH_TICK_MS = 45_000
export const COALESCE_MS = 3 * 60_000
export const EVENT_ITEMS_MAX = 10
/** Rows per signal per tick. */
export const READ_LIMIT = 500
/** Re-read window before a mark (clock skew between writers). */
export const LOOKBACK = "-120 seconds"
/** Overdue tasks: only those due in the last 14 days (older ones were overdue before the watcher existed). */
export const OVERDUE_DAYS = 14
const SENT_MAX_AGE_MS = 45 * 86_400_000
const BACKOFF_MAX_STEPS = 5

/** agent_activity slugs that are the brain or this server: their task writes are not news to the brain. */
export const SELF_SLUGS = [BRAIN_AGENT, "companion", TASKS_AGENT_SLUG, RESOLVER_SLUG]
/** Note tags the brain or the session archiver write: never an event. */
export const NOISE_TAGS = ["brain-log", "brain-memory", "session-archive"]
/** Assignees that mean "Jeremie's" (plus empty). */
const JEREMIE = [...new Set([...MINE, "jeremie", "human:jeremie"])]

export type SignalName = "inbox" | "task-blocked" | "task-mine" | "task-overdue" | "meeting" | "ticket" | "invoice-paid" | "invoice-overdue"

export interface Item { signal: SignalName; id: string; label: string }

interface Signal {
  name: SignalName
  /** Event text label. */
  label: string
  table: string
  /** Mark column (null: a state scan, no mark — task-overdue). */
  at: string | null
  /** Columns this signal reads (probed with pragma_table_info; a missing one disables the signal). */
  needs: string[]
  /** Rows changed since `mark` (DB time), after the cursor. Columns: id, at, and what `label` reads. */
  sql: string
  /** `w`: the since() args (mark, then cursor). */
  args(w: SqlArg[], today: string): SqlArg[]
  item(r: Row): Item
}

const ph = (n: number): string => Array.from({ length: n }, () => "?").join(", ")
const s = (v: unknown): string => (v == null ? "" : String(v))
// An empty mark (the table was empty at seed time) reads every row. Then keyset on (col, id) past the cursor (null: from the start).
const since = (col: string, id = "id"): string =>
  `${col} > COALESCE(datetime(?, '${LOOKBACK}'), '') AND (? IS NULL OR ${col} > ? OR (${col} = ? AND ${id} > ?))`
/** The task's latest change was not logged by the brain or this server. */
const NOT_SELF = `NOT EXISTS (SELECT 1 FROM agent_activity a WHERE a.target_kind = 'task' AND a.target_id = t.id ` +
  `AND a.agent_slug IN (${ph(SELF_SLUGS.length)}) AND a.ts >= datetime(t.updated_at, '-5 seconds'))`
const NOT_AGENT = "(t.assignee IS NULL OR t.assignee NOT LIKE 'agent:%')"
// Never tasks.text: free text written by anyone, untrusted.
const taskItem = (signal: SignalName) => (r: Row): Item => ({ signal, id: s(r.id), label: s(r.id).slice(0, 8) })
const noteTagsClean = NOISE_TAGS.map(() => "COALESCE(n.tags, '') NOT LIKE ?").join(" AND ")
const tagArgs = NOISE_TAGS.map((t) => `%"${t}"%`)

export const SIGNALS: Signal[] = [
  {
    // Brain voice takes are archived with result_id brain:<turn> — the brain's own write.
    name: "inbox", label: "inbox", table: "inbox_entries", at: "created_at",
    needs: ["id", "processed", "result_id", "created_at"],
    sql: "SELECT id, created_at AS at FROM inbox_entries WHERE processed = 0 AND COALESCE(result_id, '') NOT LIKE 'brain:%' " +
      `AND ${since("created_at")} ORDER BY created_at, id LIMIT ?`,
    args: (w) => [...w, READ_LIMIT],
    item: (r) => ({ signal: "inbox", id: s(r.id), label: s(r.id) }),
  },
  {
    // Agent tasks' blocked moves are announced by the dispatch poller (lib/dispatch-poller.ts): only the rest here.
    name: "task-blocked", label: "task blocked", table: "tasks", at: "updated_at",
    needs: ["id", "assignee", "dispatch_status", "done", "updated_at"],
    sql: `SELECT t.id, t.updated_at AS at FROM tasks t WHERE t.dispatch_status = 'blocked' AND t.done = 0 AND ${NOT_AGENT} ` +
      `AND ${NOT_SELF} AND ${since("t.updated_at", "t.id")} ORDER BY t.updated_at, t.id LIMIT ?`,
    args: (w) => [...SELF_SLUGS, ...w, READ_LIMIT],
    item: taskItem("task-blocked"),
  },
  {
    name: "task-mine", label: "task for Jeremie", table: "tasks", at: "updated_at",
    needs: ["id", "assignee", "origin", "done", "updated_at"],
    sql: `SELECT t.id, t.updated_at AS at FROM tasks t WHERE t.done = 0 AND t.origin = 'jeremie' ` +
      `AND (COALESCE(t.assignee, '') = '' OR t.assignee IN (${ph(JEREMIE.length)})) ` +
      `AND ${NOT_SELF} AND ${since("t.updated_at", "t.id")} ORDER BY t.updated_at, t.id LIMIT ?`,
    args: (w) => [...JEREMIE, ...SELF_SLUGS, ...w, READ_LIMIT],
    item: taskItem("task-mine"),
  },
  {
    name: "task-overdue", label: "task overdue", table: "tasks", at: null,
    needs: ["id", "assignee", "due_date", "done"],
    sql: `SELECT t.id FROM tasks t WHERE t.done = 0 AND ${NOT_AGENT} AND t.due_date >= ? AND t.due_date < ? ORDER BY t.due_date, t.id LIMIT ?`,
    args: (_mark, today) => [addDays(today, -OVERDUE_DAYS), today, READ_LIMIT],
    item: taskItem("task-overdue"),
  },
  {
    // Meetings only (voice memos land there) — the journal folder is never in a WHERE that could match.
    name: "meeting", label: "meeting note", table: "notes", at: "updated_at",
    needs: ["id", "folder", "tags", "ref_code", "date", "updated_at"],
    sql: `SELECT n.id, n.ref_code, n.updated_at AS at FROM notes n WHERE n.folder = 'meetings' AND ${noteTagsClean} ` +
      // "new": a note dated within 2 days of its write, not an old note re-saved.
      `AND n.date >= date(n.updated_at, '-2 days') AND ${since("n.updated_at", "n.id")} ORDER BY n.updated_at, n.id LIMIT ?`,
    args: (w) => [...tagArgs, ...w, READ_LIMIT],
    item: (r) => ({ signal: "meeting", id: s(r.id), label: s(r.ref_code) || s(r.id) }),
  },
  {
    // Client tickets and feature requests both live in client_tickets (type 'feature-request').
    name: "ticket", label: "client ticket", table: "client_tickets", at: "created_at",
    needs: ["id", "ref_code", "type", "created_at"],
    sql: `SELECT id, ref_code, type, created_at AS at FROM client_tickets WHERE ${since("created_at")} ORDER BY created_at, id LIMIT ?`,
    args: (w) => [...w, READ_LIMIT],
    item: (r) => ({ signal: "ticket", id: s(r.id), label: `${s(r.ref_code) || s(r.id).slice(0, 8)}${r.type === "feature-request" ? " feature-request" : ""}` }),
  },
  {
    name: "invoice-paid", label: "invoice paid", table: "invoices", at: "updated_at",
    needs: ["id", "number", "status", "updated_at"],
    sql: `SELECT id, number, updated_at AS at FROM invoices WHERE status = 'paid' AND ${since("updated_at")} ORDER BY updated_at, id LIMIT ?`,
    args: (w) => [...w, READ_LIMIT],
    item: (r) => ({ signal: "invoice-paid", id: s(r.id), label: s(r.number) || s(r.id) }),
  },
  {
    name: "invoice-overdue", label: "invoice overdue", table: "invoices", at: "updated_at",
    needs: ["id", "number", "status", "updated_at"],
    sql: `SELECT id, number, updated_at AS at FROM invoices WHERE status = 'overdue' AND ${since("updated_at")} ORDER BY updated_at, id LIMIT ?`,
    args: (w) => [...w, READ_LIMIT],
    item: (r) => ({ signal: "invoice-overdue", id: s(r.id), label: s(r.number) || s(r.id) }),
  },
]

export interface WatchState {
  /** Per signal: the newest DB time read. Absent = not seeded yet (its first read is silent). */
  marks: Partial<Record<SignalName, string>>
  /** Per signal: last (at, id) read while a page was full; absent = start from mark − LOOKBACK. */
  cursors: Partial<Record<SignalName, { at: string; id: string | number }>>
  /** `signal:id` → when it was queued: never queued twice. */
  sent: Record<string, number>
  pending: Item[]
  lastEventAt: number
}

export const emptyState = (): WatchState => ({ marks: {}, cursors: {}, sent: {}, pending: [], lastEventAt: 0 })

export function parseState(raw: string | null): WatchState {
  if (!raw) return emptyState()
  try {
    const v = JSON.parse(raw) as Partial<WatchState>
    return { marks: v.marks ?? {}, cursors: v.cursors ?? {}, sent: v.sent ?? {}, pending: Array.isArray(v.pending) ? v.pending : [], lastEventAt: Number(v.lastEventAt) || 0 }
  } catch {
    return emptyState()
  }
}

const keyOf = (i: Item): string => `${i.signal}:${i.id}`

/** `Turso: 3 changes - inbox x1 (id 944), task blocked x1 (id 1a2b3c4d), …` — at most 10 items, then +N more. */
export function eventText(items: Item[], max = EVENT_ITEMS_MAX): string {
  const shown = items.slice(0, max)
  const groups = SIGNALS.map((sig) => ({ sig, labels: shown.filter((i) => i.signal === sig.name).map((i) => i.label) })).filter((g) => g.labels.length)
  const parts = groups.map((g) => `${g.sig.label} x${g.labels.length} (${g.sig.name === "inbox" || g.sig.name.startsWith("task") ? "id " : ""}${g.labels.join(", ")})`)
  const more = items.length > max ? `, +${items.length - max} more` : ""
  return `Turso: ${items.length} change${items.length === 1 ? "" : "s"} - ${parts.join(", ")}${more}`
}

export interface WatchDeps {
  query: QueryFn
  /** Kill switch, re-read every tick. */
  enabled(): boolean
  load(): string | null
  save(raw: string): void
  event(text: string): void
  now(): number
  log(msg: string): void
}

export function createTursoWatch(deps: WatchDeps) {
  let state = parseState(deps.load())
  let cols: Map<string, Set<string>> | null = null
  let failures = 0
  let retryAt = 0
  let busy = false
  const disabledLogged = new Set<SignalName>()

  async function columns(): Promise<Map<string, Set<string>>> {
    if (cols) return cols
    const out = new Map<string, Set<string>>()
    for (const table of new Set(SIGNALS.map((x) => x.table))) {
      const rows = await deps.query("SELECT name FROM pragma_table_info(?)", [table])
      out.set(table, new Set(rows.map((r) => s(r.name))))
    }
    return (cols = out)
  }

  /** One signal: its new items (unseeded → mark only, items recorded as already sent). */
  async function read(sig: Signal, next: WatchState, today: string, now: number): Promise<Item[]> {
    const seeding = next.marks[sig.name] === undefined
    if (sig.at && seeding) {
      // Seed at the DB's own clock: nothing before it is ever reported (the lookback rows are recorded below, silently).
      const [r] = await deps.query("SELECT datetime('now') AS at", [])
      next.marks[sig.name] = s(r?.at)
    }
    const c = next.cursors[sig.name]
    const w: SqlArg[] = [next.marks[sig.name] ?? "", c?.at ?? null, c?.at ?? null, c?.at ?? null, c?.id ?? null]
    const rows = await deps.query(sig.sql, sig.args(w, today))
    if (sig.at) {
      for (const r of rows) if (s(r.at) > (next.marks[sig.name] ?? "")) next.marks[sig.name] = s(r.at)
      // Full page: continue after its last row next tick. Short page: caught up, next tick re-scans the lookback.
      // ponytail: one page per signal per tick — a 1200-row burst takes 3 ticks; loop pages in-tick if latency matters.
      const last = rows.at(-1)
      if (rows.length >= READ_LIMIT && last) next.cursors[sig.name] = { at: s(last.at), id: last.id ?? "" }
      else delete next.cursors[sig.name]
    }
    const fresh: Item[] = []
    for (const r of rows) {
      const it = sig.item(r)
      if (next.sent[keyOf(it)] !== undefined) continue
      next.sent[keyOf(it)] = now
      if (!seeding) fresh.push(it)
    }
    if (!sig.at) next.marks[sig.name] = today
    return fresh
  }

  function prune(next: WatchState, now: number): void {
    for (const [k, at] of Object.entries(next.sent)) if (now - at > SENT_MAX_AGE_MS) delete next.sent[k]
  }

  /** Read every signal; all-or-nothing (a failure leaves the state as it was). */
  async function scan(now: number): Promise<WatchState> {
    const next: WatchState = structuredClone(state)
    const have = await columns()
    const today = localDay(now)
    for (const sig of SIGNALS) {
      const got = have.get(sig.table) ?? new Set<string>()
      const missing = sig.needs.filter((c) => !got.has(c))
      if (missing.length) {
        if (!disabledLogged.has(sig.name)) deps.log(`[turso-watch] ${sig.name} off: ${sig.table} lacks ${missing.join(", ")}`)
        disabledLogged.add(sig.name)
        continue
      }
      next.pending.push(...await read(sig, next, today, now))
    }
    prune(next, now)
    return next
  }

  async function tick(): Promise<void> {
    // A slow tick still running: skip, never overlap (two scans of one state would queue the same rows twice).
    if (busy || !deps.enabled()) return
    busy = true
    try {
      await tickOnce()
    } finally {
      busy = false
    }
  }

  async function tickOnce(): Promise<void> {
    const now = deps.now()
    if (now < retryAt) return
    let next: WatchState
    try {
      next = await scan(now)
    } catch (err) {
      failures++
      cols = null
      // Error budget: one log line per failure streak step, backoff 45 s × 2^n up to 24 min, the brain hears nothing.
      retryAt = now + WATCH_TICK_MS * 2 ** Math.min(failures, BACKOFF_MAX_STEPS)
      if (failures === 1 || failures % 10 === 0) deps.log(`[turso-watch] read failed ×${failures} (${(err as Error)?.message ?? "error"}), backing off`)
      return
    }
    if (failures) deps.log(`[turso-watch] recovered after ${failures} failures`)
    failures = 0
    retryAt = 0
    if (next.pending.length && now - next.lastEventAt >= COALESCE_MS) {
      deps.event(eventText(next.pending))
      next.pending = []
      next.lastEventAt = now
    }
    state = next
    deps.save(JSON.stringify(state))
  }

  return { tick, state: (): WatchState => state }
}

export type TursoWatch = ReturnType<typeof createTursoWatch>
