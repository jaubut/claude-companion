import { randomUUID } from "node:crypto"
import { MINE, TASKS_TZ, addDays, localDay, normDate } from "./my-tasks"
import { type AssignRule, type DueChange, type Proposal, type ProposalKind, type ScopeTask, agentFor, allProposals, duplicateMatch, hiddenBy, slipCounts } from "./tasks-agent-rules"
import { type LoadResponse, LOAD_DAYS, buildLoad } from "./tasks-agent-load"
import { type RawTask, guardedWrite, keyOf, readTask, rowKey, rowKeySql, rowVersion, versionOf } from "./tasks-agent-row"
import type { TasksAgentStore } from "./tasks-agent-store"
import type { ExecFn, QueryFn, Row, SqlArg, Stmt, TxFn } from "./turso"

// Tasks agent core (PRJ-CT4M WP5): DIGEST (what agents changed on Jeremie's
// tasks since his last open, with Undo), PROPOSALS (deterministic rules in
// tasks-agent-rules.ts; accept / dismiss) and LOAD (tasks-agent-load.ts).
// Every mutation here is one transaction: a compare-and-set write against the
// row as just read, plus its agent_activity row carrying the old value, inserted
// only if the write changed a row (`changes() > 0`). Both commit or neither
// (rule: no log, no mutation); a lost race writes nothing and reports
// `changed_since`. Contract: docs/tasks-agent-api.md.

export const AGENT_SLUG = "tasks-agent"
export const DIGEST_LIMIT = 100
export const DIGEST_FIRST_OPEN_HOURS = 24
export const PROPOSAL_CAP = 25
export const SCOPE_LIMIT = 2000
export const SNAPSHOT_TTL_MS = 30_000
export const SUBTASKS_MIN = 2
export const SUBTASKS_MAX = 5

/** Jeremie's own actions: never "news" in his digest. */
const SELF_SLUGS = ["companion", "human", "human:jeremie"]
/** Agent actions on a task the digest reports (plus anything the PM agents log). */
export const DIGEST_ACTIONS = ["status_changed", "due_changed", "assignee_changed", "subtask_created", "closed-as-duplicate", "auto_closed", "text_changed"]
const PM_SLUGS = ["pm", "pm-nightly", "project-manager"]

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ")
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null)
const isMine = (a: string | null): boolean => !!a && MINE.includes(a)

export function parseMeta(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string" || !v.trim()) return null
  try {
    const m = JSON.parse(v) as unknown
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null
  } catch { return null }
}

/** sqlite "YYYY-MM-DD HH:MM:SS" (UTC) → ISO. */
export const sqliteToIso = (ts: unknown): string | null => {
  const s = str(ts)
  if (!s) return null
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const isoToSqlite = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

// ── undo spec ────────────────────────────────────────────────────────────────

export type UndoSpec =
  | { field: "due"; from: string | null; to: string | null }
  | { field: "done"; from: boolean; to: boolean }
  | { field: "assignee"; from: string | null; to: string | null }
  | { field: "created"; from: null; to: string; parentId: string; key: string }

/** Only rows whose meta carries the old value (`from`) are undoable. */
export function undoSpec(action: string, meta: Record<string, unknown> | null): UndoSpec | null {
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, "from")) return null
  const { from, to } = meta
  switch (action) {
    case "due_changed": {
      const f = from === null ? null : normDate(from)
      const t = to === null || to === undefined ? null : normDate(to)
      if ((from !== null && !f) || (to !== null && to !== undefined && !t)) return null
      return { field: "due", from: f, to: t }
    }
    case "status_changed":
      if ((from !== "open" && from !== "done") || (to !== "open" && to !== "done") || from === to) return null
      return { field: "done", from: from === "done", to: to === "done" }
    case "assignee_changed":
      if ((from !== null && typeof from !== "string") || (to !== null && typeof to !== "string")) return null
      return { field: "assignee", from: str(from), to: str(to) }
    case "subtask_created":
      // `rowKey` = the subtask's whole row as created (tasks-agent-row.ts): undo only deletes it while it still is exactly that.
      return meta.created === true && from === null && typeof to === "string" && typeof meta.parent === "string" && typeof meta.rowKey === "string"
        ? { field: "created", from: null, to, parentId: meta.parent, key: meta.rowKey } : null
    default:
      return null
  }
}

export { readTask, type RawTask }

// ── reads ────────────────────────────────────────────────────────────────────

export async function listScope(query: QueryFn): Promise<ScopeTask[]> {
  const rows = await query(
    "SELECT t.id, t.note_id, t.parent_id, t.text, t.description, t.due_date, t.position, t.assignee, n.title AS note_title, n.folder AS note_folder " +
      `FROM tasks t LEFT JOIN notes n ON n.id = t.note_id WHERE t.done = 0 AND (t.assignee IS NULL OR t.assignee = '' OR t.assignee IN (${marks(MINE.length)})) ` +
      "ORDER BY t.note_id, t.position LIMIT ?",
    [...MINE, SCOPE_LIMIT],
  )
  return rows.map((r): ScopeTask => {
    const assignee = str(r.assignee)
    return {
      id: String(r.id), noteId: str(r.note_id) ?? "", parentId: str(r.parent_id), text: str(r.text) ?? "", description: str(r.description),
      due: normDate(r.due_date), position: Number(r.position ?? 0) || 0, assignee, mine: isMine(assignee),
      version: rowVersion({
        text: str(r.text) ?? "", description: typeof r.description === "string" ? r.description : "", noteId: str(r.note_id) ?? "",
        parentRaw: typeof r.parent_id === "string" ? r.parent_id : "", dueRaw: typeof r.due_date === "string" ? r.due_date : "", done: false,
        assigneeRaw: typeof r.assignee === "string" ? r.assignee : "",
      }),
      project: str(r.note_title) ?? (str(r.note_id) || "No project"), folder: str(r.note_folder),
    }
  })
}

/** due_changed rows → from/to (meta first, else the companion summary "due A → B: …"). */
export function toDueChange(r: Row): DueChange | null {
  const id = str(r.target_id)
  if (!id) return null
  const meta = parseMeta(r.meta)
  if (meta && Object.prototype.hasOwnProperty.call(meta, "from")) {
    return { taskId: id, from: meta.from === null ? null : normDate(meta.from), to: meta.to === null || meta.to === undefined ? null : normDate(meta.to) }
  }
  const m = /due (\S+) → (\S+?):?(?:\s|$)/.exec(str(r.summary) ?? "")
  if (!m) return null
  return { taskId: id, from: normDate(m[1]), to: normDate(m[2]) }
}

export async function dueHistory(query: QueryFn, ids: string[]): Promise<DueChange[]> {
  const out: DueChange[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const rows = await query(
      `SELECT target_id, meta, summary FROM agent_activity WHERE target_kind = 'task' AND action = 'due_changed' AND target_id IN (${marks(chunk.length)}) ORDER BY id`,
      chunk,
    )
    for (const r of rows) {
      // An accepted reschedule proposal is the fix, not another slip.
      if (parseMeta(r.meta)?.proposal !== undefined) continue
      const c = toDueChange(r)
      if (c) out.push(c)
    }
  }
  return out
}

// ── digest ───────────────────────────────────────────────────────────────────

export interface DigestItem {
  activityId: number
  at: string | null
  agent: string
  action: string
  taskId: string
  taskText: string
  project: string
  summary: string
  from: unknown
  to: unknown
  undoable: boolean
  undone: boolean
}

export interface Digest { since: { activityId: number | null; at: string | null }; items: DigestItem[] }

async function undoneIds(query: QueryFn, targetIds: string[]): Promise<Set<number>> {
  const out = new Set<number>()
  for (let i = 0; i < targetIds.length; i += 200) {
    const chunk = targetIds.slice(i, i + 200)
    const rows = await query(
      `SELECT meta FROM agent_activity WHERE agent_slug = ? AND action = 'undo' AND target_kind = 'task' AND target_id IN (${marks(chunk.length)})`,
      [AGENT_SLUG, ...chunk],
    )
    for (const r of rows) { const u = Number(parseMeta(r.meta)?.undoes); if (Number.isInteger(u)) out.add(u) }
  }
  return out
}

export async function maxActivityId(query: QueryFn): Promise<number> {
  const rows = await query("SELECT MAX(id) AS max_id FROM agent_activity", [])
  return Number(rows[0]?.max_id ?? 0) || 0
}

/** Agent changes on Jeremie's tasks after `sinceId` (null → the last 24 h). Jeremie's own actions are left out. */
export async function buildDigest(query: QueryFn, sinceId: number | null, nowMs: number): Promise<Digest> {
  const sinceTs = sinceId === null ? isoToSqlite(nowMs - DIGEST_FIRST_OPEN_HOURS * 3_600_000) : ""
  const rows = await query(
    "SELECT a.id, a.agent_slug, a.action, a.target_id, a.summary, a.meta, a.ts, t.text AS task_text, t.assignee AS task_assignee, n.title AS note_title " +
      "FROM agent_activity a JOIN tasks t ON t.id = a.target_id LEFT JOIN notes n ON n.id = t.note_id " +
      `WHERE a.target_kind = 'task' AND a.id > ? AND a.ts >= ? AND a.agent_slug NOT IN (${marks(SELF_SLUGS.length)}) ` +
      `AND (a.action IN (${marks(DIGEST_ACTIONS.length)}) OR a.agent_slug IN (${marks(PM_SLUGS.length)})) ` +
      `AND (t.assignee IN (${marks(MINE.length)}) OR a.action = 'assignee_changed') ` +
      "ORDER BY a.id DESC LIMIT ?",
    [sinceId ?? 0, sinceTs, ...SELF_SLUGS, ...DIGEST_ACTIONS, ...PM_SLUGS, ...MINE, DIGEST_LIMIT],
  )
  const kept = rows.flatMap((r): DigestItem[] => {
    const meta = parseMeta(r.meta)
    // Jeremie's own accepts / confirms through this agent are not news to him.
    if (meta?.by === "jeremie") return []
    const action = str(r.action) ?? ""
    // A reassignment shows only when it moved a task to or from him.
    if (action === "assignee_changed" && !isMine(str(r.task_assignee)) && !isMine(str(meta?.from)) && !isMine(str(meta?.to))) return []
    return [{
      activityId: Number(r.id), at: sqliteToIso(r.ts), agent: str(r.agent_slug) ?? "", action, taskId: String(r.target_id),
      taskText: str(r.task_text) ?? "", project: str(r.note_title) ?? "", summary: str(r.summary) ?? "",
      from: meta?.from ?? null, to: meta?.to ?? null, undoable: undoSpec(action, meta) !== null, undone: false,
    }]
  })
  const undone = await undoneIds(query, [...new Set(kept.map((k) => k.taskId))])
  for (const k of kept) if (undone.has(k.activityId)) { k.undone = true; k.undoable = false }
  return { since: { activityId: sinceId, at: sinceId === null ? sqliteToIso(sinceTs) : null }, items: kept }
}

// ── guarded writes ───────────────────────────────────────────────────────────

export type WriteOutcome = { ok: true } | { ok: false; status: number; error: string }
const conflict = (error: string, status = 409): WriteOutcome => ({ ok: false, status, error })

type Col = "due_date" | "done" | "assignee"

/** Extra SQL condition ANDed into the CAS (fixed text, args bound). */
type Guard = { sql: string; args: SqlArg[] }

/** The activity row, inserted only if the statement just before it changed a row. */
const logIfChanged = (action: string, targetId: string, summary: string, meta: Record<string, unknown>): Stmt => ({
  sql: "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) SELECT ?, ?, 'task', ?, ?, ? WHERE changes() > 0 RETURNING id",
  args: [AGENT_SLUG, action, targetId, summary.slice(0, 200), JSON.stringify({ source: "companion", by: "jeremie", ...meta })],
})

/** CAS on the WHOLE row as read (every tracked field, tasks-agent-row.ts) + its log row, in one transaction; lost race → nothing written. */
async function mutate(
  tx: TxFn, before: RawTask, col: Col, value: SqlArg, action: string, summary: string, meta: Record<string, unknown>, guard?: Guard,
): Promise<WriteOutcome> {
  // `col` comes from the fixed Col union, never from input.
  const [upd, log] = await tx([
    {
      sql: `UPDATE tasks SET ${col} = ?, updated_at = datetime('now') WHERE id = ? AND ${rowKeySql()} = ?${guard ? ` AND ${guard.sql}` : ""}`,
      args: [value, before.id, keyOf(before), ...(guard?.args ?? [])],
    },
    logIfChanged(action, before.id, summary, meta),
  ])
  if (upd!.affected > 0 && log!.rows.length > 0) return { ok: true }
  return conflict("changed_since")
}

export async function setTaskDue(tx: TxFn, t: RawTask, due: string | null, extra: Record<string, unknown> = {}): Promise<WriteOutcome> {
  if (t.due === due) return { ok: true }
  return mutate(tx, t, "due_date", due ?? "", "due_changed", `due ${t.due ?? "none"} → ${due ?? "none"}: ${t.text}`, { from: t.due, to: due, ...extra })
}

export async function setTaskDone(tx: TxFn, t: RawTask, done: boolean, extra: Record<string, unknown> = {}, guard?: Guard): Promise<WriteOutcome> {
  if (t.done === done) return { ok: true }
  const from = t.done ? "done" : "open"
  const to = done ? "done" : "open"
  return mutate(tx, t, "done", done ? 1 : 0, "status_changed", `${done ? "closed" : "reopened"}: ${t.text}`, { from, to, ...extra }, guard)
}

export async function setTaskAssignee(tx: TxFn, t: RawTask, assignee: string | null, extra: Record<string, unknown> = {}): Promise<WriteOutcome> {
  if (t.assignee === assignee) return { ok: true }
  return mutate(tx, t, "assignee", assignee, "assignee_changed", `assignee ${t.assignee ?? "none"} → ${assignee ?? "none"}: ${t.text}`, { from: t.assignee, to: assignee, ...extra })
}

/**
 * Subtasks under `parent` (his, undated), each with its log row, in ONE transaction. The first insert
 * only happens while the parent row is still exactly as read (every tracked field) and has no subtasks; every later statement
 * only if the one before changed a row. So it is all or nothing, and two concurrent accepts insert once.
 * null = the parent changed (or got subtasks) meanwhile.
 */
export async function insertSubtasks(tx: TxFn, parent: RawTask, texts: string[], firstPosition: number): Promise<string[] | null> {
  const ids = texts.map(() => randomUUID().replace(/-/g, ""))
  const assignee = parent.assignee ?? MINE[0] ?? "human:jeremie"
  const stmts: Stmt[] = []
  texts.forEach((text, i) => {
    const id = ids[i]!
    const cond = i === 0
      ? `EXISTS (SELECT 1 FROM tasks p WHERE p.id = ? AND ${rowKeySql("p.")} = ?) AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = ?)`
      : "changes() > 0"
    stmts.push({
      sql: `INSERT INTO tasks (id, note_id, parent_id, text, description, done, due_date, position, assignee) SELECT ?, ?, ?, ?, '', 0, '', ?, ? WHERE ${cond}`,
      args: [id, parent.noteId, parent.id, text, firstPosition + i, assignee, ...(i === 0 ? [parent.id, keyOf(parent), parent.id] : [])],
    })
    stmts.push(logIfChanged("subtask_created", id, `subtask of "${parent.text}": ${text}`, {
      from: null, to: text, created: true, parent: parent.id,
      rowKey: rowKey({ text, description: "", noteId: parent.noteId, parentRaw: parent.id, dueRaw: "", done: false, assigneeRaw: assignee }),
    }))
  })
  const res = await tx(stmts)
  return res.every((r) => r.affected > 0 || r.rows.length > 0) ? ids : null
}

// ── undo ─────────────────────────────────────────────────────────────────────

export type UndoResult = { ok: true; taskId: string; field: UndoSpec["field"]; restored: unknown } | { ok: false; status: number; error: string }

export async function undoActivity(exec: ExecFn, tx: TxFn, activityId: number): Promise<UndoResult> {
  const { rows } = await exec("SELECT id, agent_slug, action, target_kind, target_id, meta FROM agent_activity WHERE id = ?", [activityId])
  const a = rows[0]
  if (!a || a.target_kind !== "task" || !str(a.target_id)) return { ok: false, status: 404, error: "no_such_activity" }
  const meta = parseMeta(a.meta)
  const spec = undoSpec(str(a.action) ?? "", meta)
  if (!spec) return { ok: false, status: 409, error: "not_undoable" }
  const taskId = String(a.target_id)
  const prior = await exec(
    "SELECT id FROM agent_activity WHERE agent_slug = ? AND action = 'undo' AND target_kind = 'task' AND target_id = ? AND json_extract(meta, '$.undoes') = ?",
    [AGENT_SLUG, taskId, activityId],
  )
  if (prior.rows.length) return { ok: false, status: 409, error: "already_undone" }
  const t = await readTask(exec, taskId)

  if (spec.field === "created") {
    if (!t) return { ok: false, status: 409, error: "changed_since" }
    if (!isMine(t.assignee)) return { ok: false, status: 404, error: "no_such_task" }
    // Deleted only while the row is EXACTLY as created (spec.key): any edit since (text, date, description, project,
    // parent, assignee, done) keeps it. Checked on the read row, and again inside the DELETE.
    if (keyOf(t) !== spec.key || t.parentId !== spec.parentId) return { ok: false, status: 409, error: "changed_since" }
    const [del, log] = await tx([
      {
        sql: `DELETE FROM tasks WHERE id = ? AND ${rowKeySql()} = ? AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = ?)`,
        args: [taskId, spec.key, taskId],
      },
      logIfChanged("undo", taskId, `undo subtask: ${t.text}`, { undoes: activityId, field: "created", from: t.text, to: null }),
    ])
    if (del!.affected === 0 || log!.rows.length === 0) return { ok: false, status: 409, error: "changed_since" }
    return { ok: true, taskId, field: "created", restored: null }
  }

  if (!t) return { ok: false, status: 404, error: "no_such_task" }
  // Same scope as the digest. Due / done: his own or unassigned tasks (agent tasks belong to dispatch);
  // assignee: only a reassignment that is, was or moved to his, or one he made through this agent (an accepted assign proposal).
  const ownAccept = a.agent_slug === AGENT_SLUG && meta?.by === "jeremie"
  const inScope = spec.field === "assignee"
    ? isMine(t.assignee) || isMine(spec.from) || isMine(spec.to) || ownAccept
    : t.assignee === null || isMine(t.assignee)
  if (!inScope) return { ok: false, status: 404, error: "no_such_task" }
  const current = spec.field === "due" ? t.due : spec.field === "done" ? t.done : t.assignee
  if (current !== spec.to) return { ok: false, status: 409, error: "changed_since" }
  const col: Col = spec.field === "due" ? "due_date" : spec.field === "done" ? "done" : "assignee"
  const value: SqlArg = spec.field === "due" ? spec.from ?? "" : spec.field === "done" ? (spec.from ? 1 : 0) : spec.from
  const r = await mutate(tx, t, col, value, "undo", `undo ${spec.field} ${String(spec.to ?? "none")} → ${String(spec.from ?? "none")}: ${t.text}`,
    { undoes: activityId, field: spec.field, from: spec.to, to: spec.from })
  return r.ok ? { ok: true, taskId, field: spec.field, restored: spec.from } : r
}

// ── the agent ────────────────────────────────────────────────────────────────

/** Haiku: 2-5 subtasks for a vague task, or null. */
export type Splitter = (task: { text: string; description: string | null; project: string }) => Promise<string[] | null>

export interface TasksAgentDeps {
  query: QueryFn
  exec: ExecFn
  /** All-or-nothing writes (tursoTx). */
  tx: TxFn
  store: TasksAgentStore
  /** Busy hours per day (null = calendar unavailable). */
  busy: (days: string[], tz: string) => Promise<Map<string, number> | null>
  splitter: Splitter
  rules: () => AssignRule[]
  now?: () => number
}

export interface ProposalsView { counts: Record<ProposalKind, number>; items: Proposal[] }

export interface AgentResponse {
  generatedAt: string
  today: string
  tz: string
  digest: Digest
  proposals: ProposalsView
  load: LoadResponse
}

export type AcceptBody = { due?: unknown; subtasks?: unknown; parentVersion?: unknown }

/** What a split draft is bound to: the parent's row version (every tracked field, description included). insertSubtasks pins the same row inside its transaction. */
export const parentVersion = (t: RawTask): string => versionOf(t)

export type DecideResult =
  | { ok: true; decision: "accept" | "dismiss"; proposalId: string; taskIds: string[]; detail?: Record<string, unknown> }
  | { ok: true; stage: "confirm"; proposalId: string; subtasks: string[]; parentVersion: string }
  | { ok: false; status: number; error: string }

const KINDS: ProposalKind[] = ["reschedule", "merge", "assign", "split"]

export function createTasksAgent(deps: TasksAgentDeps) {
  const now = deps.now ?? Date.now
  let snap: { at: number; today: string; tasks: ScopeTask[]; proposals: Proposal[] } | null = null

  async function snapshot(fresh = false) {
    const t = now()
    const today = localDay(t, TASKS_TZ())
    if (!fresh && snap && t - snap.at < SNAPSHOT_TTL_MS && snap.today === today) return snap
    const tasks = await listScope(deps.query)
    const slips = slipCounts(await dueHistory(deps.query, tasks.filter((x) => x.mine).map((x) => x.id)))
    snap = { at: t, today, tasks, proposals: allProposals({ tasks, slips, rules: deps.rules(), today }) }
    return snap
  }

  function visible(proposals: Proposal[]): ProposalsView {
    const decided = deps.store.decisions()
    const open = proposals.filter((p) => !hiddenBy(p, decided.get(p.id)))
    const counts = Object.fromEntries(KINDS.map((k) => [k, open.filter((p) => p.kind === k).length])) as Record<ProposalKind, number>
    return { counts, items: KINDS.flatMap((k) => open.filter((p) => p.kind === k).slice(0, PROPOSAL_CAP)) }
  }

  async function view(device: string, fresh = false): Promise<AgentResponse> {
    const t = now()
    const tz = TASKS_TZ()
    const s = await snapshot(fresh)
    const baseline = deps.store.open(device, await maxActivityId(deps.query), t)
    const digest = await buildDigest(deps.query, baseline, t)
    const days = Array.from({ length: LOAD_DAYS }, (_, i) => addDays(s.today, i))
    const busy = await deps.busy(days, tz).catch(() => null)
    return {
      generatedAt: new Date(t).toISOString(), today: s.today, tz, digest, proposals: visible(s.proposals),
      load: buildLoad(s.tasks.filter((x) => x.mine).map((x) => x.due), s.today, busy),
    }
  }

  async function accept(p: Proposal, body: AcceptBody, today: string): Promise<DecideResult> {
    const done = (detail: Record<string, unknown> = {}): DecideResult => {
      deps.store.decide({ id: p.id, decision: "accept", version: p.version, at: now() })
      snap = null
      return { ok: true, decision: "accept", proposalId: p.id, taskIds: p.taskIds, detail }
    }
    // The task acted on (merge: the duplicate). guardedWrite refuses it (409 stale) unless it is exactly the
    // row the proposal was derived from; every write below pins that same row again inside its transaction.
    const subject = p.taskIds[p.kind === "merge" ? 1 : 0]!
    return guardedWrite<DecideResult>(deps.exec, subject, p.rowVersions?.[subject], async (t) => {
      if (t.done) return { ok: false, status: 409, error: "changed_since" }
      // Same scope as the rules: reschedule / split on his own tasks, merge on his or unassigned.
      if ((p.kind === "reschedule" || p.kind === "split") && !isMine(t.assignee)) return { ok: false, status: 409, error: "changed_since" }
      if (p.kind === "merge" && t.assignee !== null && !isMine(t.assignee)) return { ok: false, status: 409, error: "changed_since" }

      if (p.kind === "reschedule") {
        let due: string | null
        if (body.due === undefined) due = String(p.suggestion.suggestedDue ?? addDays(today, 7))
        else if (body.due === null) due = null
        else {
          due = normDate(body.due)
          if (!due || due !== body.due) return { ok: false, status: 400, error: "due_must_be_yyyy_mm_dd_or_null" }
        }
        const r = await setTaskDue(deps.tx, t, due, { proposal: p.id })
        return r.ok ? done({ due }) : r
      }
      if (p.kind === "assign") {
        if (t.assignee !== null) return { ok: false, status: 409, error: "changed_since" }
        // The rule is run again on the row as it is now (inside the transaction it is pinned), not trusted from the proposal.
        const hit = agentFor(t.text, deps.rules())
        if (!hit || hit.assignee !== p.suggestion.assignee) return { ok: false, status: 409, error: "stale" }
        const r = await setTaskAssignee(deps.tx, t, hit.assignee, { proposal: p.id })
        return r.ok ? done({ assignee: hit.assignee }) : r
      }
      if (p.kind === "merge") {
        const keepId = String(p.suggestion.keepId)
        // Never close the last open copy: the kept task must be exactly the row the proposal saw (so still open, same
        // note) and still a duplicate; a parent with open subtasks is never closed. All pinned inside the closing UPDATE.
        return guardedWrite<DecideResult>(deps.exec, keepId, p.rowVersions?.[keepId], async (keep) => {
          if (keep.done || keep.noteId !== t.noteId || !duplicateMatch(t.text, keep.text)) return { ok: false, status: 409, error: "changed_since" }
          const r = await setTaskDone(deps.tx, t, true, { proposal: p.id, merged_into: keepId }, {
            sql: `EXISTS (SELECT 1 FROM tasks k WHERE k.id = ? AND ${rowKeySql("k.")} = ?) AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = ? AND c.done = 0)`,
            args: [keepId, keyOf(keep), t.id],
          })
          return r.ok ? done({ closed: t.id, kept: keepId }) : r
        })
      }
      // split: no subtasks yet → Haiku drafts them (nothing written); with subtasks → insert.
      if (body.subtasks === undefined) {
        const drafted = await deps.splitter({ text: t.text, description: t.description || null, project: p.project }).catch(() => null)
        const clean = drafted ? cleanSubtasks(drafted) : null
        if (!clean) return { ok: false, status: 502, error: "split_unavailable" }
        return { ok: true, stage: "confirm", proposalId: p.id, subtasks: clean, parentVersion: parentVersion(t) }
      }
      const subtasks = Array.isArray(body.subtasks) ? cleanSubtasks(body.subtasks) : null
      if (!subtasks) return { ok: false, status: 400, error: "subtasks_must_be_2_to_5_strings" }
      if (typeof body.parentVersion !== "string") return { ok: false, status: 400, error: "parent_version_required" }
      // The draft was made for another version of this task (any tracked field, description included): ask for a new draft.
      if (body.parentVersion !== parentVersion(t)) return { ok: false, status: 409, error: "draft_stale" }
      // After the note's last task, so no sibling position is shared.
      const { rows: mx } = await deps.exec("SELECT MAX(position) AS p FROM tasks WHERE note_id = ?", [t.noteId])
      const pos = Math.max(Number(mx[0]?.p ?? 0) || 0, t.position) + 1
      // One transaction, the parent pinned as read and "no subtasks yet": a failure or a concurrent accept writes nothing.
      const ids = await insertSubtasks(deps.tx, t, subtasks, pos)
      if (!ids) return { ok: false, status: 409, error: "changed_since" }
      return done({ parentId: t.id, subtaskIds: ids })
    })
  }

  /** accept | dismiss one proposal, re-derived fresh from Turso (a stale id → 404). */
  async function decide(id: string, action: "accept" | "dismiss", body: AcceptBody): Promise<DecideResult> {
    const s = await snapshot(true)
    const p = s.proposals.find((x) => x.id === id)
    if (!p || hiddenBy(p, deps.store.decisions().get(p.id))) return { ok: false, status: 404, error: "no_such_proposal" }
    if (action === "dismiss") {
      deps.store.decide({ id: p.id, decision: "dismiss", version: p.version, at: now() })
      return { ok: true, decision: "dismiss", proposalId: p.id, taskIds: p.taskIds }
    }
    return accept(p, body, s.today)
  }

  async function undo(activityId: number): Promise<UndoResult> {
    const r = await undoActivity(deps.exec, deps.tx, activityId)
    if (r.ok) snap = null
    return r
  }

  return { view, decide, undo, invalidate: () => { snap = null } }
}

export type TasksAgent = ReturnType<typeof createTasksAgent>

/** 2-5 distinct, non-empty one-line subtasks, each <= 200 chars; anything else → null. */
export function cleanSubtasks(list: unknown[]): string[] | null {
  if (!list.every((x) => typeof x === "string")) return null
  const out = [...new Set((list as string[]).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))]
  if (out.length < SUBTASKS_MIN || out.length > SUBTASKS_MAX || out.some((s) => s.length > 200)) return null
  return out
}

export function splitPrompt(task: { text: string; description: string | null; project: string }): string {
  return [
    "Split this to-do item into 2 to 5 concrete subtasks. Each subtask starts with an action verb, is one line, under 120 characters,",
    "and is written in the same language as the task. Do not add work the task does not imply.",
    `Project: ${task.project}`,
    `Task: ${task.text}`,
    task.description ? `Notes: ${task.description.slice(0, 600)}` : "",
    'Reply with JSON only: {"subtasks": ["…", "…"]}',
  ].filter(Boolean).join("\n")
}

export function parseSplit(text: string | null): string[] | null {
  if (!text) return null
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { subtasks?: unknown }
    return Array.isArray(o.subtasks) ? cleanSubtasks(o.subtasks) : null
  } catch { return null }
}
