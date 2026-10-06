import type { BrainDecision } from "./orchestrator-brain"
import type { Channel } from "./orchestrator-channels"
import type { Turn } from "./orchestrator-chat"
import type { Catalog, Candidate } from "./project-catalog"
import type { ProjectRef } from "./dispatch-tasks"
import { type Decided, type RouteDecision, type RouterInput, type RouterMode, pickRoute } from "./jev-router"
import type { OldOutcome, RouteLogRow } from "./jev-route-log"
import { type QuickLookRunner, ackText, answerTurnText, buildQuickLookPrompt, failureText, parseQuickLook } from "./quick-look"

// The orchestrator's front door: every user message goes through here.
//   off    → the old brain (Haiku gate → Opus compose), no Jev call
//   shadow → Jev decides in parallel and is logged; the old brain answers
//   live   → Jev's route answers: status (code), quick_look (read-only claude),
//            body / task / chat (old brain with hints); low confidence → old brain
// Tasks agent (PRJ-CT4M WP5, optional `tasks` dep): a "confirm"/"cancel" reply
// to a held move is consumed first; in live mode only, a message about
// Jeremie's own to-do list (Jev `my_tasks` or the tasks keyword hint) goes to
// the tasks tool, which may hand it back (not_tasks) to the normal path.
// off (kill switch) and shadow (never changes the answer) never route there.
// All modes: a transient "⏳ on it…" turn if nothing answered within ackDelayMs.
// Seams only (the live instance is wiring/front-door.ts).

export interface BrainHints {
  forceTask?: boolean
  forceBodyDigest?: boolean
  resolved?: { noteId: string | null; title: string; repo: string | null } | null
  prebuilt?: { projects: ProjectRef[]; catalog: Catalog }
}

export type BrainResult = { kind: "chat" } | { kind: "task"; noteId: string | null } | { kind: "error" }

/** The tasks tool seam (lib/tasks-agent-chat.ts). */
export interface TasksRoute {
  hint: (text: string) => boolean
  /** false = not about his tasks; the message continues down the normal path. */
  handle: (text: string, channelId: string, recent: string[]) => Promise<boolean>
  confirmReply: (text: string, channelId: string) => Promise<boolean>
}

export interface FrontDoorDeps {
  mode: () => RouterMode
  minConf: () => number
  catalog: () => Promise<{ projects: ProjectRef[]; catalog: Catalog }>
  decide: (input: RouterInput, catalog: Catalog, opts: { minConf: number; channelNoteId: string | null }) => Promise<Decided>
  thread: (channelId: string) => Turn[]
  runBrain: (text: string, channel: Channel, hints: BrainHints) => Promise<BrainResult>
  /** Templated status answer for one project note, or all projects (null). */
  status: (project: { noteId: string; title: string } | null) => Promise<string>
  quickLook: QuickLookRunner
  /** Persisted orchestrator turn + broadcast. */
  emitTurn: (text: string, channelId: string) => void
  /** Broadcast-only turn (never persisted): the ack. */
  emitTransient: (text: string, channelId: string) => void
  stageProposal: (d: Extract<BrainDecision, { kind: "proposal" }>, channel: Channel, projects: ProjectRef[]) => Promise<void>
  log: (row: RouteLogRow) => void
  tasks?: TasksRoute
  now?: () => number
  ackDelayMs?: number
  onError?: (msg: string) => void
}

export const ACK_TEXT = "⏳ on it…"
export const ACK_DELAY_MS = 800

function routerInput(text: string, channel: Channel, thread: Turn[]): RouterInput {
  // The latest turn is this message itself (/send appended it first).
  const prior = thread.length && thread[thread.length - 1]!.role === "user" && thread[thread.length - 1]!.text === text ? thread.slice(0, -1) : thread
  return {
    text, channelName: channel.name, channelProject: channel.noteTitle ?? channel.noteId ?? null,
    recent: prior.slice(-4).map((t) => ({ role: t.role, text: t.text })),
  }
}

function resolvedOf(p: Candidate | null): BrainHints["resolved"] {
  return p ? { noteId: p.noteId, title: p.title, repo: p.repo } : null
}

/** A project the message itself named (confident Jev pick or alias), not just the channel's. */
function namedProject(d: RouteDecision, minConf: number): Candidate | null {
  if (!d.project) return null
  return d.projectSource === "alias" || (d.projectSource === "jev" && d.projectConf >= minConf) ? d.project : null
}

export function createFrontDoor(deps: FrontDoorDeps) {
  const now = deps.now ?? Date.now

  async function quickLook(text: string, channel: Channel, d: RouteDecision, input: RouterInput, projects: ProjectRef[]): Promise<void> {
    const p = d.project!
    const repo = p.repo!
    deps.emitTurn(ackText(repo), channel.id)
    const prompt = buildQuickLookPrompt({ question: text, repo, projectTitle: p.title, noteId: p.noteId, recent: input.recent })
    const run = await deps.quickLook(prompt, repo)
    const result = run.ok ? parseQuickLook(run.text) : null
    if (!result) {
      deps.emitTurn(failureText(repo, run.ok ? "unreadable answer" : run.error), channel.id)
      return
    }
    deps.emitTurn(answerTurnText(repo, result), channel.id)
    if (result.needsChange && result.proposal) {
      await deps.stageProposal({
        kind: "proposal", cwd: repo, prompt: result.proposal.prompt, reasoning: `Quick look: ${result.answer}`,
        noteId: p.noteId, agent: "builder", title: result.proposal.title,
      }, channel, projects)
    }
  }

  async function handle(text: string, channel: Channel): Promise<void> {
    const t0 = now()
    const mode = deps.mode()
    let answered = false
    const ack = setTimeout(() => { if (!answered) deps.emitTransient(ACK_TEXT, channel.id) }, deps.ackDelayMs ?? ACK_DELAY_MS)
    ;(ack as unknown as { unref?: () => void }).unref?.()
    const answering = () => { answered = true; clearTimeout(ack) }
    const tasks = deps.tasks
    const recentLines = () => routerInput(text, channel, deps.thread(channel.id)).recent.map((t) => `${t.role}: ${t.text.replace(/\s+/g, " ").slice(0, 240)}`)
    const tryTasks = async (): Promise<boolean> => {
      if (!tasks) return false
      try {
        return await tasks.handle(text, channel.id, recentLines())
      } catch (err) {
        deps.onError?.(`tasks tool failed: ${(err as Error)?.message ?? String(err)}`)
        return false
      }
    }
    try {
      if (tasks && await tasks.confirmReply(text, channel.id)) return
      if (mode === "off") {
        await deps.runBrain(text, channel, {})
        return
      }
      const cat = await deps.catalog()
      const input = routerInput(text, channel, deps.thread(channel.id))
      const minConf = deps.minConf()
      const opts = { minConf, channelNoteId: channel.noteId }
      if (mode === "shadow") {
        // Concurrent: shadow adds no latency to the answer.
        const jev = deps.decide(input, cat.catalog, opts)
        const outcome = await deps.runBrain(text, channel, { prebuilt: cat })
        answering()
        log(await jev, "brain", outcome)
        return
      }
      const decided = await deps.decide(input, cat.catalog, opts)
      let route = decided.ok ? pickRoute(decided.decision, minConf) : "brain"
      let outcome: BrainResult | null = null
      if (route === "my_tasks" || (tasks?.hint(text) ?? false)) {
        if (await tryTasks()) {
          answering()
          log(decided, "my_tasks", null)
          return
        }
        // Handed back (not_tasks): the brain answers and is logged as such.
        if (route === "my_tasks") route = "brain"
      }
      if (route === "status" && decided.ok) {
        const named = namedProject(decided.decision, minConf)
        const answer = await deps.status(named?.noteId ? { noteId: named.noteId, title: named.title } : null)
        answering()
        deps.emitTurn(answer, channel.id)
      } else if (route === "quick_look" && decided.ok) {
        answering()
        await quickLook(text, channel, decided.decision, input, cat.projects)
      } else {
        const d = decided.ok ? decided.decision : null
        const resolved = resolvedOf(d?.project ?? null)
        outcome = await deps.runBrain(text, channel, {
          prebuilt: cat, resolved, forceTask: route === "task", forceBodyDigest: route === "body",
        })
      }
      answering()
      // A forced task skipped the gate, so its outcome is no independent label.
      log(decided, route, route === "brain" || route === "body" ? outcome : null)
    } catch (err) {
      deps.onError?.(`front door failed: ${(err as Error)?.message ?? String(err)}`)
      if (!answered) {
        answering()
        await deps.runBrain(text, channel, {}).catch(() => { /* runBrain posts its own failure turn */ })
      }
    } finally {
      answering()
    }

    function log(d: Decided, route: string, outcome: BrainResult | null): void {
      const dec = d.ok ? d.decision : null
      deps.log({
        at: t0, channel: channel.id, text, mode,
        intent: dec?.intent ?? null, intentConf: dec?.intentConf ?? null,
        project: dec?.project?.key ?? null, projectNoteId: dec?.project?.noteId ?? null, projectConf: dec ? dec.projectConf : null,
        projectSource: dec?.projectSource ?? null, route,
        oldOutcome: (outcome?.kind ?? null) as OldOutcome | null, oldNoteId: outcome?.kind === "task" ? outcome.noteId : null,
        jevMs: d.ok ? d.decision.jevMs : d.jevMs, totalMs: now() - t0, error: d.ok ? null : d.error,
      })
    }
  }

  return { handle }
}

export type FrontDoor = ReturnType<typeof createFrontDoor>
