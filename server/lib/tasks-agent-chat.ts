import { randomUUID } from "node:crypto"
import { MINE, TASKS_TZ, type TaskRow, listMine, localDay, normDate } from "./my-tasks"
import { readTask, setTaskDone, setTaskDue } from "./tasks-agent"
import type { ExecFn, QueryFn, TxFn } from "./turso"

// Tasks agent CHAT (PRJ-CT4M WP5): "what is on my plate this week" / "move
// everything Granby to Friday" in the orchestrator chat. The front door routes
// here on a Jev `my_tasks` intent (live mode) or this module's keyword hint;
// Opus turns the message into ONE tool call over Jeremie's open tasks:
//   list {from,to,project?} · move {taskIds,due} · done {taskIds} · reply {text} · not_tasks
// Code validates every id against his open tasks and writes through the
// tasks-agent write paths (setTaskDue / setTaskDone: one transaction each, a
// compare-and-set on the row as just read plus its agent_activity row). A write touching more than CONFIRM_OVER tasks is held as a confirm
// card (frame `tasks_agent_confirm`) until Jeremie confirms it. Each task's
// due/done as planned is kept; at apply time a task that changed since (or is
// no longer his) is skipped and reported, never overwritten.

export const CONFIRM_OVER = 3
export const PLAN_TTL_MS = 30 * 60_000
export const LIST_MAX_LINES = 30
export const PROMPT_MAX_TASKS = 300

export function tasksChatModel(env: Record<string, string | undefined> = process.env): string {
  return env.COMPANION_TASKS_CHAT_MODEL || "claude-opus-5-5"
}

const DAY_WORDS = "today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|next week|this week|" +
  "aujourd'hui|demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|semaine prochaine|\\d{4}-\\d{2}-\\d{2}"
const PLATE = /\b(on my plate|my (?:tasks?|to-?dos?|week|day)|what(?:'s| is) (?:due|left) (?:today|this week|tomorrow)|mes t[âa]ches|ma (?:semaine|journ[ée]e)|dans mon assiette)\b/i
const MOVE = new RegExp(`\\b(move|push|bump|shift|reschedule|postpone|d[ée]place[rz]?|reporte[rz]?|d[ée]cale[rz]?)\\b.*\\s(to|until|à|au|a)\\s+(?:next\\s+|this\\s+)?(${DAY_WORDS})\\b`, "i")
const MARK_DONE = /\b(mark|set|marque[rz]?)\b.*\b(task|tasks|t[âa]ches?)\b.*\b(done|complete|finished|fait(?:es)?|termin[ée]e?s?)\b/i

/** Cheap deterministic hint that a message is about Jeremie's own to-do list. */
export function tasksHint(text: string): boolean {
  return PLATE.test(text) || MOVE.test(text) || MARK_DONE.test(text)
}

// Only the exact words the card asks for: a bare "yes"/"ok" may answer something else in the channel.
const YES = /^\s*(confirm|confirmed|confirme[rz]?)\s*[.!]*\s*$/i
const NO = /^\s*(cancel|annule[rz]?)\s*[.!]*\s*$/i

export type ChatPlan =
  | { op: "list"; from: string; to: string; project: string | null }
  | { op: "move"; taskIds: string[]; due: string | null }
  | { op: "done"; taskIds: string[] }
  | { op: "reply"; text: string }
  | { op: "not_tasks" }

const dayLabel = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
const weekday = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })

export function planPrompt(i: { text: string; today: string; tasks: TaskRow[]; recent: string[] }): string {
  const lines = i.tasks.slice(0, PROMPT_MAX_TASKS).map((t) => `${t.id} | ${t.due ?? "-"} | ${t.noteTitle ?? t.noteId ?? "No project"} | ${t.text.replace(/\s+/g, " ").slice(0, 120)}`)
  return [
    "You are the task tool of Jeremie's orchestrator chat. Turn his latest message into ONE call over HIS open to-do tasks below.",
    `Today is ${weekday(i.today)} ${i.today} (${TASKS_TZ()}). "This week" = today through the coming Sunday. A bare weekday = its next occurrence after today (today's own weekday = 7 days later unless he says "today").`,
    "Return ONLY minified JSON, one of:",
    '{"op":"list","from":"YYYY-MM-DD","to":"YYYY-MM-DD","project":"<exact project name from the list, or null>"}',
    '{"op":"move","taskIds":["<id>",...],"due":"YYYY-MM-DD"}   (due null = drop the date)',
    '{"op":"done","taskIds":["<id>",...]}',
    '{"op":"reply","text":"<short answer or a clarifying question>"}',
    '{"op":"not_tasks"}   (the message is not about his own to-do tasks: agent work, code, the queue, anything else)',
    "Use only ids from the list. \"Everything <project>\" = every listed task of that project. Never invent tasks.",
    "",
    "Open tasks (id | due | project | text):",
    ...(lines.length ? lines : ["(none)"]),
    ...(i.tasks.length > PROMPT_MAX_TASKS ? [`(+${i.tasks.length - PROMPT_MAX_TASKS} more not shown)`] : []),
    "",
    "Recent thread:",
    ...(i.recent.length ? i.recent : ["(empty)"]),
    "",
    "Latest message:",
    i.text,
  ].join("\n")
}

/** Model text → a validated plan. Unknown ids are dropped; a write with no valid id → null. */
export function parsePlan(raw: string | null, valid: Set<string>): ChatPlan | null {
  if (!raw) return null
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(m[0]) as Record<string, unknown> } catch { return null }
  const ids = Array.isArray(o.taskIds) ? [...new Set(o.taskIds.filter((x): x is string => typeof x === "string" && valid.has(x)))] : []
  switch (o.op) {
    case "list": {
      const from = normDate(o.from)
      const to = normDate(o.to)
      if (!from || !to || to < from) return null
      return { op: "list", from, to, project: typeof o.project === "string" && o.project.trim() ? o.project.trim() : null }
    }
    case "move": {
      const due = o.due === null ? null : normDate(o.due)
      if ((o.due !== null && (!due || due !== o.due)) || !ids.length) return null
      return { op: "move", taskIds: ids, due }
    }
    case "done":
      return ids.length ? { op: "done", taskIds: ids } : null
    case "reply":
      return typeof o.text === "string" && o.text.trim() ? { op: "reply", text: o.text.trim().slice(0, 2000) } : null
    case "not_tasks":
      return { op: "not_tasks" }
    default:
      return null
  }
}

const matchesProject = (t: TaskRow, p: string | null): boolean =>
  !p || [t.noteTitle, t.noteId, t.noteRef].some((v) => v && v.toLowerCase() === p.toLowerCase())

/** Deterministic answer for a list call: overdue first (when the range starts today or earlier), then by day. */
export function renderList(tasks: TaskRow[], plan: Extract<ChatPlan, { op: "list" }>, today: string): string {
  const scoped = tasks.filter((t) => matchesProject(t, plan.project))
  const overdue = plan.from <= today ? scoped.filter((t) => t.due && t.due < today) : []
  const inRange = scoped.filter((t) => t.due && t.due >= plan.from && t.due <= plan.to)
    .sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : a.position - b.position))
  const scope = plan.project ? ` in ${plan.project}` : ""
  const range = plan.from === plan.to ? dayLabel(plan.from) : `${dayLabel(plan.from)} – ${dayLabel(plan.to)}`
  if (!inRange.length && !overdue.length) return `Nothing dated${scope} for ${range}.`
  const out = [`${inRange.length} task${inRange.length === 1 ? "" : "s"}${scope} for ${range}:`]
  for (const t of inRange.slice(0, LIST_MAX_LINES)) out.push(`• ${dayLabel(t.due!)} — ${t.noteTitle ?? "No project"}: ${t.text}`)
  if (inRange.length > LIST_MAX_LINES) out.push(`• …and ${inRange.length - LIST_MAX_LINES} more`)
  if (overdue.length) out.push("", `Plus ${overdue.length} overdue${scope} (oldest ${overdue.map((t) => t.due!).sort()[0]}).`)
  return out.join("\n")
}

interface Pending {
  id: string; channelId: string; op: "move" | "done"; taskIds: string[]; due: string | null; at: number
  /** Each task's state when the plan was made. */
  seen: Map<string, { due: string | null; done: boolean }>
  applying?: boolean
}

export interface TasksChatDeps {
  query: QueryFn
  exec: ExecFn
  /** All-or-nothing writes (tursoTx). */
  tx: TxFn
  /** One Opus call (tool-less); the model's text or null. */
  plan: (prompt: string) => Promise<string | null>
  emitTurn: (text: string, channelId: string) => void
  notify: (frame: Record<string, unknown>) => void
  now?: () => number
}

export type ConfirmResult = { ok: true; applied: number; cancelled?: boolean } | { ok: false; status: number; error: string }

export function createTasksChat(deps: TasksChatDeps) {
  const now = deps.now ?? Date.now
  const pending = new Map<string, Pending>()

  const live = (p: Pending | undefined): p is Pending => !!p && now() - p.at < PLAN_TTL_MS
  const latestFor = (channelId: string): Pending | null => {
    let best: Pending | null = null
    for (const [id, p] of pending) {
      if (!live(p)) { pending.delete(id); continue }
      if (p.channelId === channelId && (!best || p.at >= best.at)) best = p
    }
    return best
  }

  async function apply(p: Pending): Promise<number> {
    let changed = 0
    const skipped: string[] = []
    let gone = 0
    let failed = 0
    for (const id of p.taskIds) {
      try {
        const was = p.seen.get(id)
        const cur = await readTask(deps.exec, id)
        if (!cur || !was || !cur.assignee || !MINE.includes(cur.assignee)) { gone++; continue }
        if (cur.due !== was.due || cur.done !== was.done) { skipped.push(cur.text); continue }
        // The CAS inside the write is on the row as read just above, i.e. as planned: an edit landing
        // in between makes it a conflict (skipped), never an overwrite.
        const r = p.op === "move" ? await setTaskDue(deps.tx, cur, p.due, { via: "chat" }) : await setTaskDone(deps.tx, cur, true, { via: "chat" })
        if (r.ok) changed++
        else skipped.push(cur.text)
      } catch { failed++ }
    }
    if (changed) deps.notify({ type: "tasks_changed", why: p.op === "move" ? "due" : "done" })
    const what = p.op === "move" ? `Moved ${changed} task${changed === 1 ? "" : "s"} to ${p.due ? dayLabel(p.due) : "no date"}` : `Marked ${changed} task${changed === 1 ? "" : "s"} done`
    const notes: string[] = []
    if (gone) notes.push(`${gone} ${gone === 1 ? "was" : "were"} already gone or no longer yours`)
    if (failed) notes.push(`${failed} failed to save`)
    if (skipped.length) notes.push(`skipped ${skipped.length} changed since the plan: ${skipped.slice(0, 5).join("; ")}${skipped.length > 5 ? "; …" : ""}`)
    deps.emitTurn(notes.length ? `${what} (${notes.join("; ")}).` : `${what}.`, p.channelId)
    return changed
  }

  /** Handle a message routed here. false = not about his tasks (the caller falls through to the brain). */
  async function handle(text: string, channelId: string, recent: string[] = [], source: "jev" | "hint" = "jev"): Promise<boolean> {
    const t = now()
    const today = localDay(t, TASKS_TZ())
    const tasks = await listMine(deps.query)
    const plan = parsePlan(await deps.plan(planPrompt({ text, today, tasks, recent })), new Set(tasks.map((x) => x.id)))
    if (!plan) {
      // A keyword hint alone is no proof the message is about his tasks: hand it back.
      if (source === "hint") return false
      deps.emitTurn("I couldn't work out which of your tasks you mean — name the project or the day and try again.", channelId)
      return true
    }
    if (plan.op === "not_tasks") return false
    if (plan.op === "reply") { deps.emitTurn(plan.text, channelId); return true }
    if (plan.op === "list") { deps.emitTurn(renderList(tasks, plan, today), channelId); return true }

    const byId = new Map(tasks.map((x) => [x.id, x]))
    const seen = new Map(plan.taskIds.map((id) => [id, { due: byId.get(id)!.due, done: false }]))
    const p: Pending = { id: randomUUID().replace(/-/g, "").slice(0, 16), channelId, op: plan.op, taskIds: plan.taskIds, due: plan.op === "move" ? plan.due : null, at: t, seen }
    if (p.taskIds.length <= CONFIRM_OVER) { await apply(p); return true }

    pending.set(p.id, p)
    const list = p.taskIds.map((id) => byId.get(id)!)
    const verb = p.op === "move" ? `Move ${list.length} tasks to ${p.due ? dayLabel(p.due) : "no date"}` : `Mark ${list.length} tasks done`
    const lines = list.slice(0, 10).map((x) => `• ${x.noteTitle ?? "No project"}: ${x.text}${x.due ? ` (${x.due})` : ""}`)
    if (list.length > 10) lines.push(`• …and ${list.length - 10} more`)
    deps.emitTurn([`${verb}?`, ...lines, "", "Reply \"confirm\" (or tap Confirm) to apply, \"cancel\" to drop it."].join("\n"), channelId)
    deps.notify({
      type: "tasks_agent_confirm", planId: p.id, threadId: channelId, op: p.op, due: p.due, title: `${verb}?`,
      tasks: list.map((x) => ({ id: x.id, text: x.text, due: x.due, project: x.noteTitle })), expiresAt: t + PLAN_TTL_MS,
    })
    return true
  }

  async function confirm(planId: string, yes: boolean): Promise<ConfirmResult> {
    const p = pending.get(planId)
    if (!live(p)) { pending.delete(planId); return { ok: false, status: 404, error: "no_such_plan" } }
    if (p.applying) return { ok: false, status: 409, error: "plan_in_progress" }
    if (!yes) { pending.delete(planId); deps.emitTurn("Cancelled — nothing changed.", p.channelId); return { ok: true, applied: 0, cancelled: true } }
    p.applying = true
    try {
      const applied = await apply(p)
      pending.delete(planId)
      return { ok: true, applied }
    } finally {
      p.applying = false
    }
  }

  /** A "confirm" / "cancel" reply while a card is pending in this channel. true = consumed. */
  async function confirmReply(text: string, channelId: string): Promise<boolean> {
    const yes = YES.test(text)
    if (!yes && !NO.test(text)) return false
    const p = latestFor(channelId)
    if (!p) return false
    await confirm(p.id, yes)
    return true
  }

  return { hint: tasksHint, handle, confirm, confirmReply, pendingCount: () => pending.size }
}

export type TasksChat = ReturnType<typeof createTasksChat>
