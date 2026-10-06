import { type Catalog, type Candidate, NONE_KEY, jevCriteria, matchAlias } from "./project-catalog"
import { type JevOpts, type JevOutcome, type JevQuestion, systemOne } from "./jev"

// The front door's tier 0: one Jev call per user message → intent + project +
// confidence. Code decides what to do with it (mode, threshold, route).

export const INTENTS = ["status", "quick_look", "task", "body", "my_tasks", "chat"] as const
export type Intent = (typeof INTENTS)[number]
export type RouterMode = "off" | "shadow" | "live"
export type ProjectSource = "jev" | "alias" | "channel" | "none"

export const DEFAULT_MIN_CONF = 0.7

export function routerMode(env: Record<string, string | undefined> = process.env): RouterMode {
  const v = env.COMPANION_JEV_ROUTER?.trim().toLowerCase()
  return v === "off" || v === "live" ? v : "shadow"
}

export function minConfidence(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.COMPANION_JEV_MIN_CONF)
  return env.COMPANION_JEV_MIN_CONF?.trim() && Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_MIN_CONF
}

// Literal criteria (jev-1.13 reads instructions at face value): each option says
// exactly what belongs in it, boundary cases included.
export const INTENT_CRITERIA: Record<Intent, string> = {
  status:
    "Asks about the state of the agent work queue: what is running, blocked, queued, failed or dead right now, what is next, " +
    "what workers are doing. Answered from the queue, no repository needs to be read.",
  quick_look:
    "A factual question about ONE specific project or code repository that is answered by reading its files, git history or the " +
    "package registry: which version of a dependency it uses, whether it is on the latest version, whether a file or feature exists, " +
    "what a file says, the last commit, whether it is deployed. Nothing is changed.",
  task:
    "Asks for work to be done in a project: build, fix, change, add, update, upgrade, migrate, deploy, write, refactor, or " +
    "investigate-and-fix something. An imperative request for a change.",
  body:
    "Asks about the health of machines, servers, services, daemons, cron jobs or the Body monitor: what is down, broken, " +
    "crashing or failing on the Mac or Zettlab.",
  my_tasks:
    "About Jeremie's OWN to-do list (his personal tasks and their due dates, not the agent work queue): what is on his plate " +
    "today or this week, what is due, moving or rescheduling his tasks to a day, marking his tasks done.",
  chat:
    "Conversation, an opinion, planning, brainstorming, a general-knowledge question, a reply or follow-up to the previous " +
    "orchestrator message (yes, no, approve, thanks), or anything the other options do not describe.",
}

const INTENT_INSTRUCTIONS =
  "Jeremie sent `latest_message` to his orchestrator chat. The orchestrator can answer, look things up in his code repositories, " +
  "report on his agent work queue and system health, and dispatch worker agents. Which handler fits `latest_message`?"

const PROJECT_INSTRUCTIONS =
  "Which one of Jeremie's projects or code repositories is `latest_message` about? A website domain, client name, repo name or " +
  "project code counts as naming it. Use `channel_project` only if the message refers to \"it\"/\"this\" without naming one. " +
  "Choose none if no project is meant."

export interface RouterInput {
  text: string
  channelName: string
  channelProject: string | null
  /** Last few turns, oldest first, already trimmed. */
  recent: { role: string; text: string }[]
}

export function routerQuestions(catalog: Catalog): Record<string, JevQuestion> {
  return {
    intent: { type: "choice", instructions: INTENT_INSTRUCTIONS, criteria: { ...INTENT_CRITERIA } },
    project: { type: "choice", instructions: PROJECT_INSTRUCTIONS, criteria: jevCriteria(catalog) },
  }
}

export function routerState(input: RouterInput): Record<string, unknown> {
  return {
    latest_message: input.text.slice(0, 2000),
    channel: input.channelName,
    channel_project: input.channelProject ?? "none",
    previous_messages: input.recent.slice(-4).map((t) => `${t.role}: ${t.text.replace(/\s+/g, " ").slice(0, 240)}`),
  }
}

export interface RouteDecision {
  intent: Intent
  intentConf: number
  /** Resolved project (Jev, else code alias match, else the channel's note). */
  project: Candidate | null
  projectConf: number
  projectSource: ProjectSource
  jevMs: number
}

export type Decided = { ok: true; decision: RouteDecision } | { ok: false; error: string; jevMs: number }

const isIntent = (s: string): s is Intent => (INTENTS as readonly string[]).includes(s)

/** Jev answers → decision. Project: confident Jev pick, else alias match, else channel note. */
export function toDecision(
  out: JevOutcome, input: RouterInput, catalog: Catalog, opts: { minConf: number; channelNoteId: string | null },
): Decided {
  if (!out.ok) return { ok: false, error: out.error, jevMs: out.latencyMs }
  const i = out.answers.intent
  const p = out.answers.project
  if (i?.type !== "choice" || !isIntent(i.choice)) return { ok: false, error: "no_intent", jevMs: out.latencyMs }
  let project: Candidate | null = null
  let projectConf = 0
  let projectSource: ProjectSource = "none"
  const jevPick = p?.type === "choice" && p.choice !== NONE_KEY ? catalog.byKey.get(p.choice) ?? null : null
  if (jevPick && p?.type === "choice" && p.confidence >= opts.minConf) {
    project = jevPick; projectConf = p.confidence; projectSource = "jev"
  } else {
    const alias = matchAlias(input.text, catalog)
    if (alias) {
      project = alias; projectConf = 1; projectSource = "alias"
    } else if (jevPick && p?.type === "choice") {
      project = jevPick; projectConf = p.confidence; projectSource = "jev"
    } else if (opts.channelNoteId) {
      project = catalog.candidates.find((c) => c.noteId === opts.channelNoteId) ?? null
      projectSource = project ? "channel" : "none"
    }
  }
  return { ok: true, decision: { intent: i.choice, intentConf: i.confidence, project, projectConf, projectSource, jevMs: out.latencyMs } }
}

/** One Jev call for a message. Never throws. */
export async function decideRoute(
  input: RouterInput, catalog: Catalog, opts: { minConf: number; channelNoteId: string | null; jev?: JevOpts },
): Promise<Decided> {
  const out = await systemOne(routerState(input), routerQuestions(catalog), opts.jev)
  return toDecision(out, input, catalog, opts)
}

export type Route = "status" | "quick_look" | "task" | "body" | "my_tasks" | "brain"

/**
 * What answers in live mode. Below the threshold, or a quick_look with no
 * local repo to read, or a chat → the old brain path. A task with a
 * low-confidence project still skips the gate; compose picks the project.
 */
export function pickRoute(d: RouteDecision, minConf: number): Route {
  if (d.intentConf < minConf) return "brain"
  switch (d.intent) {
    case "status": return "status"
    case "quick_look": return d.project?.repo && (d.projectSource !== "jev" || d.projectConf >= minConf) ? "quick_look" : "brain"
    case "task": return "task"
    case "body": return "body"
    case "my_tasks": return "my_tasks"
    default: return "brain"
  }
}
