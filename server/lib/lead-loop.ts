import { createHash } from "node:crypto"

// Repo lead policy (brain-v2 P2, RES-QDHU Hierarchy; docs/brain-api.md § Repo leads).
// Pure: one queue per repo, `applyEvent` moves it, `nextAction` says what the
// lead does next. Side effects live in wiring/brain-lead.ts; the lead session
// does the work (brain/LEAD.md).

/** The repos with a lead: one line per repo, GitHub slug by repo name. */
export const LEAD_REPOS: Readonly<Record<string, string>> = {
  "claude-companion": "jaubut/claude-companion",
}
export const LEAD_PREFIX = "lead-"
export const LEAD_PR_CAP = 3
/** Fix attempts before the one fresh builder; one more and the PR is closed and refiled. */
export const FIXES_BEFORE_FRESH = 2
/** Between tries of a close the server refused: the PR may have become closable (a shepherd park, a conflict). */
export const CLOSE_RETRY_MS = 60 * 60_000
/** Why a task may reach the brain: a real decision, or `stuck` = a conflict, a refusal or anything left after the lead's retries. */
export const DECISION_KINDS: ReadonlySet<string> = new Set(["product", "money", "client", "security", "stuck"])


export type TaskState = "queued" | "building" | "pr" | "fixing" | "closing"

export interface LeadTask {
  id: string
  title: string
  prompt: string
  state: TaskState
  pr: number | null
  /** Fix attempts started so far. */
  fixes: number
  /** Unanswered review findings; null = none. */
  findings: string[] | null
  approved: boolean
  behind: boolean
  closeTriedAt: number | null
  /** Escalated: skipped by `nextAction` until the brain sends `resume`. */
  blocked?: boolean
  /** The split is queued: a later `closed` or `close_refused` must not queue it again. */
  refiled?: boolean
  /** The builder died: the next fix starts a new one, whatever the count. */
  lost?: boolean
  /** A PR the shepherd handed over: its real head. Otherwise the head is named after the task. */
  head?: string
}

export interface LeadQueue { tasks: LeadTask[]; updatedAt: number }

export type LeadEvent =
  | { type: "started"; taskId: string }
  | { type: "pr"; taskId: string; pr: number }
  | { type: "findings"; taskId: string; findings: string[] }
  | { type: "fix_started"; taskId: string }
  | { type: "fix_pushed"; taskId: string }
  | { type: "builder_died"; taskId: string }
  | { type: "approved"; taskId: string }
  | { type: "behind"; taskId: string }
  | { type: "main_merged"; taskId: string }
  | { type: "merge_refused"; taskId: string }
  | { type: "merged"; taskId: string }
  | { type: "closed"; taskId: string; refile: Array<{ title: string; prompt: string }> }
  | { type: "close_refused"; taskId: string; refile: Array<{ title: string; prompt: string }> }
  | { type: "blocked"; taskId: string; kind: string; line: string }
  | { type: "resume"; taskId: string }

/** An open PR of the repo on GitHub. */
export interface OpenPr { number: number; headRefName: string }

export type LeadAction =
  | { kind: "idle"; held: number }
  | { kind: "wait"; taskId: string; state: TaskState }
  | { kind: "gone"; taskId: string; pr: number }
  | { kind: "build"; taskId: string; title: string; prompt: string }
  | { kind: "fix"; taskId: string; pr: number; findings: string[]; fresh: boolean }
  | { kind: "merge_main"; taskId: string; pr: number }
  | { kind: "merge"; taskId: string; pr: number; title: string }
  | { kind: "close_refile"; taskId: string; pr: number; title: string; findings: string[] }

export const leadName = (repo: string): string => `${LEAD_PREFIX}${repo}`
export const emptyQueue = (): LeadQueue => ({ tasks: [], updatedAt: 0 })

/** Same turn + same prompt = same id, so a repeated send queues nothing while the task is in the queue. */
export function enqueue(q: LeadQueue, title: string, prompt: string, seed: string, now: number): LeadTask {
  const id = createHash("sha256").update(`${seed}\n${prompt}`).digest("hex").slice(0, 8)
  const hit = q.tasks.find((t) => t.id === id)
  if (hit) return hit
  const task: LeadTask = { id, title, prompt, state: "queued", pr: null, fixes: 0, findings: null, approved: false, behind: false, closeTriedAt: null }
  q.tasks.push(task)
  q.updatedAt = now
  return task
}

/**
 * A PR the shepherd handed over. Tracked: its findings are refreshed. Otherwise a new
 * task, with the next fix on a fresh builder: the shepherd spent the first attempts.
 */
export function adopt(q: LeadQueue, pr: number, head: string, title: string, prompt: string, seed: string, findings: string[], now: number): LeadTask {
  const t = q.tasks.find((x) => x.pr === pr) ?? Object.assign(enqueue(q, title, prompt, seed, now), { state: "pr" as const, pr, head, fixes: FIXES_BEFORE_FRESH })
  t.findings = findings
  t.approved = false
  q.updatedAt = now
  return t
}

/**
 * The heads a lead may close as PR `pr`: its task's, once the fix budget is gone (empty = none).
 * The lead writes `pr` and the fix count, so the gate checks the real head against these.
 */
export function spentHeads(q: LeadQueue, pr: number): string[] {
  const t = q.tasks.find((x) => x.pr === pr && x.fixes > FIXES_BEFORE_FRESH)
  if (!t) return []
  return t.head ? [t.head] : [`dispatch/${t.id}`, `builder/${t.id}`]
}

/** Moves the queue; answers the one line for the brain, when this event deserves one. Throws on an unknown task. */
export function applyEvent(q: LeadQueue, e: LeadEvent, now: number): string | null {
  const t = q.tasks.find((x) => x.id === e.taskId)
  if (!t) throw new Error("unknown_task")
  q.updatedAt = now
  const drop = () => { q.tasks = q.tasks.filter((x) => x !== t) }
  const refile = (tasks: Array<{ title: string; prompt: string }>) => {
    if (t.refiled || !tasks.length) return
    t.refiled = true
    for (const r of tasks) enqueue(q, r.title, r.prompt, `refile:${t.id}`, now)
  }
  switch (e.type) {
    case "started": t.state = "building"; return `Started: ${t.title}`
    case "pr": t.state = "pr"; t.pr = e.pr; return `PR ready: ${t.title} (#${e.pr})`
    case "findings":
      t.findings = e.findings
      t.approved = false
      return null
    case "fix_started":
      // A retried report of the same attempt spends nothing.
      if (t.state !== "fixing") t.fixes++
      t.state = "fixing"
      t.lost = false
      return null
    case "fix_pushed": t.state = "pr"; t.findings = null; return null
    case "builder_died":
      // No PR yet: the build starts over. Mid-fix the attempt counts as failed; otherwise the PR is as good as it was.
      if (t.pr === null) t.state = "queued"
      else {
        if (t.state === "fixing") t.findings ??= ["builder died mid-fix"]
        t.state = "pr"
        t.lost = true
      }
      return null
    case "approved": t.approved = true; t.findings = null; return null
    case "merge_refused": t.approved = false; return null
    case "behind": t.behind = true; t.approved = false; return null
    case "main_merged": t.behind = false; return null
    // The gates post their own event turn for a merge or a close.
    case "merged": drop(); return null
    case "closed": drop(); refile(e.refile); return null
    case "close_refused": {
      const again = t.state === "closing"
      t.state = "closing"
      t.closeTriedAt = now
      refile(e.refile)
      if (!again) return null
      t.blocked = true
      return `Blocked (stuck): ${t.title}: close of #${t.pr} refused twice`
    }
    case "blocked":
      if (!DECISION_KINDS.has(e.kind)) throw new Error("not_a_decision")
      if (t.blocked) return null
      t.blocked = true
      return `Blocked (${e.kind}): ${t.title}: ${e.line}`
    case "resume": t.blocked = false; return null
  }
}

/**
 * One step: a PR gone from GitHub first, then rework; new work only below the cap. A blocked
 * task waits for the brain. The cap counts open dispatch/* PRs and any other PR in the queue.
 */
export function nextAction(q: LeadQueue, open: OpenPr[], now: number): LeadAction {
  const gone = q.tasks.find((t) => t.pr !== null && !open.some((p) => p.number === t.pr))
  if (gone) return { kind: "gone", taskId: gone.id, pr: gone.pr! }
  const tasks = q.tasks.filter((t) => !t.blocked)
  for (const t of tasks) {
    if (t.state === "pr" && t.pr !== null && t.findings && t.fixes > FIXES_BEFORE_FRESH) return { kind: "close_refile", taskId: t.id, pr: t.pr, title: t.title, findings: t.findings }
    if (t.state === "closing" && t.pr !== null && now - (t.closeTriedAt ?? 0) >= CLOSE_RETRY_MS) return { kind: "close_refile", taskId: t.id, pr: t.pr, title: t.title, findings: t.findings ?? [] }
  }
  for (const t of tasks) {
    if (t.state === "pr" && t.pr !== null && t.findings) return { kind: "fix", taskId: t.id, pr: t.pr, findings: t.findings, fresh: t.fixes === FIXES_BEFORE_FRESH || !!t.lost }
  }
  for (const t of tasks) if (t.state === "pr" && t.pr !== null && t.behind) return { kind: "merge_main", taskId: t.id, pr: t.pr }
  for (const t of tasks) if (t.state === "pr" && t.pr !== null && t.approved) return { kind: "merge", taskId: t.id, pr: t.pr, title: t.title }
  const building = q.tasks.filter((t) => t.state === "building").length
  const queued = tasks.filter((t) => t.state === "queued")
  const openPrs = open.filter((p) => p.headRefName.startsWith("dispatch/") || q.tasks.some((t) => t.pr === p.number)).length
  const room = openPrs + building < LEAD_PR_CAP
  if (queued[0] && room) return { kind: "build", taskId: queued[0].id, title: queued[0].title, prompt: queued[0].prompt }
  const busy = tasks.find((t) => t.state !== "queued" && t.state !== "closing")
  return busy ? { kind: "wait", taskId: busy.id, state: busy.state } : { kind: "idle", held: queued.length }
}
