import type { BodyComponent, BodyResponse } from "./body"
import { type DispatchTask, effectiveStatus } from "./dispatch-tasks"

// The front door's "status" route: what's running / blocked / queued / dead /
// next, answered by code from the dispatch cache, the local WIP queue and the
// Body snapshot. No model call; a few hundred ms at most.

export interface StatusInput {
  /** The poller's cache; null when it has not polled yet. */
  tasks: DispatchTask[] | null
  local: { cap: number; live: number; queued: number }
  /** null = Body unavailable (Turso read failed or timed out). */
  body: BodyResponse | null
  /** "all projects" or one project's title. */
  scope: string
  now: number
}

const LIST_MAX = 4
const FAILED_WINDOW_MS = 24 * 60 * 60_000
const PROBLEM: readonly string[] = ["dead", "crash_loop", "failing"]

const short = (id: string): string => id.slice(0, 8)
const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

function taskLine(t: DispatchTask, extra = ""): string {
  const where = t.projectTitle ? ` (${clip(t.projectTitle, 40)})` : ""
  return `  [${short(t.id)}] ${t.agent ?? "agent"} — ${clip(t.title, 70)}${where}${extra}`
}

function section(label: string, list: DispatchTask[], line: (t: DispatchTask) => string): string[] {
  if (!list.length) return []
  const more = list.length > LIST_MAX ? [`  …and ${list.length - LIST_MAX} more`] : []
  return [`${label} (${list.length}):`, ...list.slice(0, LIST_MAX).map(line), ...more]
}

function bodyLines(body: BodyResponse | null): string[] {
  if (!body) return ["Body: unavailable right now (Turso read failed)."]
  const s = body.summary
  const bad = body.components.filter((c: BodyComponent) => PROBLEM.includes(c.state))
  if (!bad.length) return [`Body: ${s.total} components, nothing dead, crash-looping or failing.`]
  const counts = PROBLEM.filter((k) => s[k as keyof typeof s]).map((k) => `${s[k as keyof typeof s]} ${k}`).join(", ")
  return [`Body: ${s.total} components — ${counts}:`, ...bad.slice(0, LIST_MAX).map((c) => `  ${c.id} ${c.state}${c.detail ? ` — ${clip(String(c.detail), 60)}` : ""}`),
    ...(bad.length > LIST_MAX ? [`  …and ${bad.length - LIST_MAX} more`] : [])]
}

/** The templated answer. Pure. */
export function buildStatusAnswer(input: StatusInput): string {
  const lines: string[] = []
  if (!input.tasks) {
    lines.push(`Queue (${input.scope}): not read yet — the dispatch poller has not reached Turso since the restart.`)
  } else {
    const open = input.tasks.filter((t) => !t.done)
    const by = (s: string) => open.filter((t) => effectiveStatus(t) === s)
    const running = by("running").sort((a, b) => a.updatedAt - b.updatedAt)
    const blocked = by("blocked").sort((a, b) => a.updatedAt - b.updatedAt)
    const queued = by("queued").sort((a, b) => a.createdAt - b.createdAt)
    const pr = by("pr").sort((a, b) => b.updatedAt - a.updatedAt)
    const failed = input.tasks.filter((t) => t.status === "failed" && input.now - t.updatedAt < FAILED_WINDOW_MS)
    lines.push(`Queue (${input.scope}): ${running.length} running · ${blocked.length} blocked · ${queued.length} queued · ${pr.length} PR open`)
    lines.push(...section("Running", running, (t) => taskLine(t, ` · ${age(input.now - t.updatedAt)}`)))
    lines.push(...section("Blocked", blocked, (t) => taskLine(t, `: ${clip(t.blocker ?? "no reason given", 90)}`)))
    lines.push(...section("Next up", queued, (t) => taskLine(t)))
    lines.push(...section("PR open", pr, (t) => taskLine(t, t.prUrl ? ` ${t.prUrl}` : "")))
    lines.push(...section("Failed (24 h)", failed, (t) => taskLine(t)))
    if (!open.length && !failed.length) lines.push("Nothing open.")
  }
  const l = input.local
  lines.push(`Live workers here: ${l.live}/${l.cap} busy${l.queued ? `, ${l.queued} waiting for a slot` : ""}.`)
  lines.push(...bodyLines(input.body))
  return lines.join("\n")
}

/** Tasks for one project note, or all of them. */
export function scopeTasks(tasks: DispatchTask[] | null, noteId: string | null): DispatchTask[] | null {
  return tasks && noteId ? tasks.filter((t) => t.noteId === noteId) : tasks
}
