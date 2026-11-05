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
  | { type: "merged"; taskId: string }
  | { type: "closed"; taskId: string; refile: Array<{ title: string; prompt: string }> }
  | { type: "close_refused"; taskId: string; refile: Array<{ title: string; prompt: string }> }
  | { type: "blocked"; taskId: string; kind: string; line: string }

export type LeadAction =
  | { kind: "idle"; held: number }
  | { kind: "wait"; taskId: string; state: TaskState }
  | { kind: "build"; taskId: string; title: string; prompt: string }
  | { kind: "fix"; taskId: string; pr: number; findings: string[]; fresh: boolean }
  | { kind: "merge_main"; taskId: string; pr: number }
  | { kind: "merge"; taskId: string; pr: number; title: string }
  | { kind: "close_refile"; taskId: string; pr: number; title: string; findings: string[] }

export const leadName = (repo: string): string => `${LEAD_PREFIX}${repo}`
export const emptyQueue = (): LeadQueue => ({ tasks: [], updatedAt: 0 })

/** Same turn + same prompt = same id, so a repeated send queues nothing. */
export function enqueue(q: LeadQueue, title: string, prompt: string, seed: string, now: number): LeadTask {
  const id = createHash("sha256").update(`${seed}\n${prompt}`).digest("hex").slice(0, 8)
  const hit = q.tasks.find((t) => t.id === id)
  if (hit) return hit
  const task: LeadTask = { id, title, prompt, state: "queued", pr: null, fixes: 0, findings: null, approved: false, behind: false, closeTriedAt: null }
  q.tasks.push(task)
  q.updatedAt = now
  return task
}

/** Moves the queue; answers the one line for the brain, when this event deserves one. Throws on an unknown task. */
export function applyEvent(q: LeadQueue, e: LeadEvent, now: number): string | null {
  const t = q.tasks.find((x) => x.id === e.taskId)
  if (!t) throw new Error("unknown_task")
  q.updatedAt = now
  const drop = () => { q.tasks = q.tasks.filter((x) => x !== t) }
  const refile = (tasks: Array<{ title: string; prompt: string }>) => { for (const r of tasks) enqueue(q, r.title, r.prompt, `refile:${t.id}`, now) }
  switch (e.type) {
    case "started": t.state = "building"; return `Started: ${t.title}`
    case "pr": t.state = "pr"; t.pr = e.pr; return `PR ready: ${t.title} (#${e.pr})`
    case "findings":
      t.findings = e.findings
      t.approved = false
      return null
    case "fix_started": t.state = "fixing"; t.fixes++; return null
    case "fix_pushed": t.state = "pr"; t.findings = null; return null
    case "builder_died":
      // No PR yet: the build starts over. With one, the attempt counts as a failed fix.
      if (t.pr === null) t.state = "queued"
      else { t.state = "pr"; t.findings ??= ["builder died mid-fix"] }
      return null
    case "approved": t.approved = true; return null
    case "behind": t.behind = true; t.approved = false; return null
    case "main_merged": t.behind = false; return null
    // The gates post their own event turn for a merge or a close.
    case "merged": drop(); return null
    case "closed": drop(); refile(e.refile); return null
    case "close_refused":
      t.state = "closing"
      t.closeTriedAt = now
      refile(e.refile)
      return null
    case "blocked":
      if (!DECISION_KINDS.has(e.kind)) throw new Error("not_a_decision")
      return `Blocked (${e.kind}): ${t.title}: ${e.line}`
  }
}

/** One step, rework first; new work only below the cap. `openPrs` = the repo's open dispatch/* PRs on GitHub. */
export function nextAction(q: LeadQueue, openPrs: number, now: number): LeadAction {
  for (const t of q.tasks) {
    if (t.state === "pr" && t.pr !== null && t.findings && t.fixes > FIXES_BEFORE_FRESH) return { kind: "close_refile", taskId: t.id, pr: t.pr, title: t.title, findings: t.findings }
    if (t.state === "closing" && t.pr !== null && now - (t.closeTriedAt ?? 0) >= CLOSE_RETRY_MS) return { kind: "close_refile", taskId: t.id, pr: t.pr, title: t.title, findings: t.findings ?? [] }
  }
  for (const t of q.tasks) {
    if (t.state === "pr" && t.pr !== null && t.findings) return { kind: "fix", taskId: t.id, pr: t.pr, findings: t.findings, fresh: t.fixes === FIXES_BEFORE_FRESH }
  }
  for (const t of q.tasks) if (t.state === "pr" && t.pr !== null && t.behind) return { kind: "merge_main", taskId: t.id, pr: t.pr }
  for (const t of q.tasks) if (t.state === "pr" && t.pr !== null && t.approved) return { kind: "merge", taskId: t.id, pr: t.pr, title: t.title }
  const building = q.tasks.filter((t) => t.state === "building").length
  const queued = q.tasks.filter((t) => t.state === "queued")
  const room = openPrs + building < LEAD_PR_CAP
  if (queued[0] && room) return { kind: "build", taskId: queued[0].id, title: queued[0].title, prompt: queued[0].prompt }
  const busy = q.tasks.find((t) => t.state !== "queued" && t.state !== "closing")
  return busy ? { kind: "wait", taskId: busy.id, state: busy.state } : { kind: "idle", held: queued.length }
}
