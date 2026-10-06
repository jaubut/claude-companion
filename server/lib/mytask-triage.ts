import { TASKS_TZ, type TaskRow, addDays, listMine, localDay, setDone, setDue } from "./my-tasks"
import type { SourceItem, TriageOption } from "./triage"
import type { ExecOutcome } from "./triage-engine"
import type { ExecFn, QueryFn } from "./turso"

// Triage source `mytask` (PRJ-CT4M WP3): Jeremie's OVERDUE dated tasks, so the
// pile is honest before the calendar sync starts. One card per task, or one card
// per project once BATCH_MIN of its tasks are overdue ("8 overdue tasks in Cage
// au Sport"). Deterministic phrasing (lib/triage.ts mytaskPhrase), no model call,
// never routed to the Opus resolver: it's Jeremie's own list.
// Options ride on existing action kinds the shipped iOS build already shows:
// `approve` + `task` op (Done / Next week / Drop the date) and `snooze`.
// Writes reuse lib/my-tasks.ts (assignee-guarded, one agent_activity row each).

export const BATCH_MIN = 3
export const COLLECT_TTL_MS = 60_000
/** Overdue by more than this → recommend dropping the date instead of moving it. */
export const STALE_DAYS = 14
export const NEXT_WEEK_DAYS = 7
/** Bump when the deterministic phrasing/severity changes: the triage store caches a card per version. */
export const PHRASE_REV = 2

export type TaskOp = "done" | "next_week" | "undate"

export interface MyTaskTriageDeps {
  query: QueryFn
  exec: ExecFn
  now?: () => number
  log?: (msg: string) => void
  /** Called after a choice wrote Turso (the Tasks API pushes tasks_changed). */
  onWrite?: (taskIds: string[]) => void
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

/** Pure: open rows → overdue cards (roots and subtasks alike; each task is its own decision). */
export function overdueItems(rows: TaskRow[], today: string, nowMs: number): SourceItem[] {
  const overdue = rows.filter((r) => r.due && r.due < today)
  const byNote = new Map<string, TaskRow[]>()
  for (const r of overdue) byNote.set(r.noteId, [...(byNote.get(r.noteId) ?? []), r])
  const items: SourceItem[] = []
  for (const [noteId, list] of byNote) {
    list.sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : a.position - b.position))
    const project = list[0]!.noteTitle ?? (noteId || "No project")
    const groups = list.length >= BATCH_MIN ? [list] : list.map((r) => [r])
    for (const g of groups) {
      const oldest = g[0]!.due!
      const late = daysBetween(oldest, today)
      const batch = g.length > 1
      const t = Date.parse(`${oldest}T12:00:00Z`) || nowMs
      const titles = g.slice(0, 5).map((r) => `• ${r.text}${batch ? ` (${r.due})` : ""}`).join("\n") + (g.length > 5 ? `\n• …and ${g.length - 5} more` : "")
      items.push({
        source: "mytask",
        refId: batch ? `p:${noteId}` : g[0]!.id,
        version: `r${PHRASE_REV}|${g.map((r) => `${r.id}@${r.due}`).join(",")}`,
        title: batch ? `${g.length} overdue tasks in ${project}` : g[0]!.text,
        project,
        createdAt: t, updatedAt: t,
        facts: {
          problem: batch
            ? `${g.length} of your tasks in ${project} are past due, the oldest by ${late} days (${oldest}).`
            : `Due ${oldest}, ${late} day${late === 1 ? "" : "s"} ago.`,
          evidence: titles,
        },
        url: null,
        ref: { source: "mytask", taskIds: g.map((r) => r.id), noteId, oldestDue: oldest, lateDays: late },
      })
    }
  }
  return items
}

export function createMyTaskTriage(deps: MyTaskTriageDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  let cache: { at: number; items: SourceItem[] } | null = null
  let generation = 0
  const drop = () => { cache = null; generation++ }

  async function build(): Promise<SourceItem[]> {
    const t = now()
    return overdueItems(await listMine(deps.query), localDay(t, TASKS_TZ()), t)
  }

  /** Cached a minute; keeps the last list when Turso is down. */
  async function collect(): Promise<SourceItem[]> {
    if (cache && now() - cache.at < COLLECT_TTL_MS) return cache.items
    const gen = generation
    try {
      const items = await build()
      if (gen === generation) cache = { at: now(), items }
      return items
    } catch (err) {
      log(`[mytask] triage source unavailable (${(err as Error)?.message ?? "error"}) — keeping the last list`)
      return cache?.items ?? []
    }
  }

  /** Fresh re-read of one card: null once nothing in it is overdue any more. Throws TursoUnreachable. */
  async function current(src: SourceItem): Promise<SourceItem | null> {
    if (src.ref.source !== "mytask") return null
    return (await build()).find((i) => i.refId === src.refId) ?? null
  }

  async function execute(src: SourceItem, option: TriageOption): Promise<ExecOutcome> {
    if (src.ref.source !== "mytask") return { kind: "error", status: 400, error: "wrong_source" }
    const a = option.action
    if (a.kind !== "approve" || !a.task) return { kind: "error", status: 400, error: "wrong_action" }
    const today = localDay(now(), TASKS_TZ())
    const ids = src.ref.taskIds
    let changed = 0
    for (const id of ids) {
      const r = a.task === "done" ? await setDone(deps.exec, id, true)
        : await setDue(deps.exec, id, a.task === "undate" ? null : addDays(today, NEXT_WEEK_DAYS))
      if (r.ok) changed++
    }
    drop()
    if (changed === 0) return { kind: "stale", reason: "tasks gone" }
    deps.onWrite?.(ids)
    return { kind: "done", detail: { op: a.task, tasks: changed, ...(a.task === "next_week" ? { due: addDays(today, NEXT_WEEK_DAYS) } : {}) } }
  }

  return { collect, current, execute, invalidate: drop }
}

export type MyTaskTriage = ReturnType<typeof createMyTaskTriage>

/** The deterministic options; the first is the recommendation. */
export function mytaskOptions(lateDays: number, batch: boolean, snooze: Omit<TriageOption, "id">): Omit<TriageOption, "id">[] {
  const all = batch ? "all " : ""
  const done: Omit<TriageOption, "id"> = { label: batch ? "Mark all done" : "Done", action: { kind: "approve", task: "done" } }
  const next: Omit<TriageOption, "id"> = { label: "Move to next week", detail: `Due in ${NEXT_WEEK_DAYS} days`, action: { kind: "approve", task: "next_week" } }
  const undate: Omit<TriageOption, "id"> = { label: "Drop the date", detail: `Keep ${all}in the backlog, no deadline`, action: { kind: "approve", task: "undate" } }
  return lateDays > STALE_DAYS ? [undate, next, done, snooze] : [next, done, undate, snooze]
}
