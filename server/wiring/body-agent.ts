import { homedir } from "node:os"
import { join } from "node:path"
import { BODY_CHANNEL, BODY_CHANNEL_NAME, type BodyComponentDetail, buildComponentDetail } from "../lib/body"
import {
  type BodyAgentStore, DEFAULT_BODY_AGENT, OPEN_DISPATCH_STATES, agentFor, agentTitle, buildAgentPrompt, createBodyAgentStore,
} from "../lib/body-agent"
import { type FixCard, localizeCwd } from "../lib/body-fix"
import { type BodyHost, type InvestigationRecord, hostFromId, localBodyHost, ownerHost } from "../lib/body-investigate"
import { DEFAULT_NOTE_ID } from "../lib/body-investigate-engine"
import { type KnownPaths, knownPaths } from "../lib/body-investigator"
import { approveUrl, resolveAgent } from "../lib/dispatch-tasks"
import { companionLog } from "../lib/log"
import { createProposal, getTask, setTaskStatus } from "../lib/orchestrator-chat"
import { ensureChannel } from "../lib/orchestrator-channels"
import { db } from "../lib/orchestrator-db"
import { broadcast, HOST_INFO } from "../state"
import { bodyFixStore, investigationStore } from "./body-investigate"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { fileProposal } from "./orchestrator"

// POST /api/body/component/:id/agent — "Get an agent on it" (lib/body-agent.ts).
// The tap files ONE Turso agent task (a #Body proposal row filed at once),
// tagged requires_host=<owning host> so only that host's dispatch-run claims
// it. The tap is Jeremie's own approval (2026-10-25): origin `jeremie`, so it
// goes straight to `queued`. Only a Turso without the origin column leaves it
// `pending` for the dashboard stamp (docs/one-stream-plan.md).
// One open run per component (409 already_running), a component in state ok
// needs an instruction, every start logs agent_activity `body:agent`.

export interface BodyAgentDeps {
  store: BodyAgentStore
  localHost: () => BodyHost
  now: () => number
  /** null = no such component; throws when Turso is down. */
  detail: (id: string, dispatch: DispatchWiring) => Promise<BodyComponentDetail | null>
  investigation: (id: string) => InvestigationRecord | null
  fixCard: (taskId: string) => FixCard | null
  paths: (component: BodyComponentDetail["component"]) => KnownPaths
  home: () => string
}

let deps: BodyAgentDeps = {
  store: createBodyAgentStore(db),
  localHost: () => localBodyHost(),
  now: Date.now,
  detail: (id, dispatch) => buildComponentDetail(dispatch.query, id),
  investigation: (id) => investigationStore().latestFinished(id),
  fixCard: (taskId) => bodyFixStore.card(taskId),
  paths: (c) => knownPaths(c),
  home: () => process.env.HOME || homedir(),
}

/** Test seam: override some deps; returns the previous set. */
export function setBodyAgentDeps(patch: Partial<BodyAgentDeps>): BodyAgentDeps {
  const prev = deps
  deps = { ...deps, ...patch }
  return prev
}

// Components with a start in flight: a double tap never starts two runs.
const starting = new Set<string>()

const err = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
  Response.json({ ok: false, error, ...extra }, { status })

const turso = (e: unknown): Response => {
  companionLog(`[body-agent] turso: ${(e as Error)?.message ?? e}`)
  return err(503, "turso_unreachable")
}

/** Open = the last run's Turso row is still pending / queued / running / blocked. */
async function openRun(componentId: string, dispatch: DispatchWiring): Promise<Response | null> {
  const run = deps.store.latest(componentId)
  if (!run) return null
  const [row] = await dispatch.query("SELECT dispatch_status FROM tasks WHERE id = ?", [run.dispatchTaskId])
  if (!row || !OPEN_DISPATCH_STATES.includes(String(row.dispatch_status ?? ""))) return null
  return err(409, "already_running", { taskId: run.taskId, dispatchTaskId: run.dispatchTaskId, host: run.host, agent: run.agent })
}

interface Plan { owner: BodyHost; cwd: string; agent: string; prompt: string; title: string; noteId: string; investigationId: string }

function plan(detail: BodyComponentDetail, owner: BodyHost, instruction: string | null): Plan {
  const c = detail.component
  const inv = deps.investigation(c.id)
  let cwd: string
  let repo: boolean
  if (owner === deps.localHost()) {
    const p = deps.paths(c)
    repo = !!p.repo
    cwd = p.repo ?? p.cwd ?? join(deps.home(), ".claude")
  } else {
    // The owner's filesystem is not ours: reuse the cwd its fix card recorded, else ~/.claude there.
    const card = inv?.proposalId ? deps.fixCard(inv.proposalId) : null
    repo = card?.agent === "builder"
    cwd = card?.cwd ?? "~/.claude"
  }
  // An agent this host cannot start (no ~/.claude/agents/<name>.md) falls back to the catch-all.
  const agent = resolveAgent(agentFor(c, repo)) ?? DEFAULT_BODY_AGENT
  return {
    owner, cwd, agent, title: agentTitle(c.id), investigationId: inv?.id ?? "",
    noteId: process.env.COMPANION_BODY_NOTE_ID?.trim() || DEFAULT_NOTE_ID,
    prompt: buildAgentPrompt({ detail, investigation: inv, instruction, host: owner, cwd }),
  }
}

type Started = { ok: true; taskId: string; dispatchTaskId: string; queued: boolean } | { ok: false; res: Response }

async function file(componentId: string, p: Plan, dispatch: DispatchWiring): Promise<Started> {
  const { channel, created } = ensureChannel(BODY_CHANNEL, BODY_CHANNEL_NAME)
  if (created) broadcast({ type: "orchestrator_channel", channel })
  const cwd = p.owner === deps.localHost() ? localizeCwd(p.cwd) : p.cwd
  const t = createProposal(p.prompt, cwd, `Body agent run on ${componentId} (tapped "Get an agent on it")`, BODY_CHANNEL, {
    noteId: p.noteId, agent: p.agent, title: p.title,
  })
  const out = await fileProposal(t.taskId, { noteId: p.noteId, agent: p.agent, requiresHost: p.owner, byHand: true }, dispatch)
  if (out.ok) return { ok: true, taskId: t.taskId, dispatchTaskId: out.dispatchTaskId, queued: out.queued }
  // The tap was the approval: never leave a stray card to approve a second time.
  if (getTask(t.taskId)?.status === "proposed") setTaskStatus(t.taskId, "cancelled")
  return { ok: false, res: err(out.status, out.error, { host: p.owner }) }
}

async function logActivity(dispatch: DispatchWiring, componentId: string, p: Plan, s: { taskId: string; dispatchTaskId: string }, instruction: string | null) {
  const meta = JSON.stringify({ source: "companion", host: HOST_INFO.name, owner: p.owner, taskId: s.taskId, dispatchTaskId: s.dispatchTaskId, instruction })
  try {
    await dispatch.exec(
      "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [p.agent, "body:agent", "body_component", componentId, `${p.agent} filed for ${p.owner} for ${componentId}`.slice(0, 200), meta],
    )
  } catch (e) {
    companionLog(`[body-agent] agent_activity insert failed (${(e as Error)?.message ?? "error"})`)
  }
}

/** POST /api/body/component/:id/agent. */
export async function startBodyAgent(componentId: string, instruction: string | null, dispatch: DispatchWiring = dispatchWiring): Promise<Response> {
  if (starting.has(componentId)) return err(409, "already_running", { taskId: null })
  starting.add(componentId)
  try {
    let detail: BodyComponentDetail | null
    try {
      detail = await deps.detail(componentId, dispatch)
    } catch (e) {
      return turso(e)
    }
    if (!detail) return err(404, "no such component")
    const state = detail.vitals?.state ?? "unknown"
    if (state === "ok" && !instruction) return err(409, "component_ok", { reason: "component is ok; send an instruction to start an agent anyway" })
    const owner = ownerHost(hostFromId(componentId) ?? (detail.component.host == null ? null : String(detail.component.host)))
    if (!owner) return err(422, "unknown_host")
    try {
      const open = await openRun(componentId, dispatch)
      if (open) return open
    } catch (e) {
      return turso(e)
    }
    const p = plan(detail, owner, instruction)
    const started = await file(componentId, p, dispatch)
    if (!started.ok) return started.res
    deps.store.record({ componentId, taskId: started.taskId, dispatchTaskId: started.dispatchTaskId, host: owner, agent: p.agent, createdAt: deps.now() })
    await logActivity(dispatch, componentId, p, started, instruction)
    companionLog(`[body-agent] ${componentId} → ${p.agent} filed for ${owner} as ${started.dispatchTaskId.slice(0, 8)} (${started.queued ? "queued" : "pending approval"})`)
    return Response.json({
      ok: true, taskId: started.taskId, dispatchTaskId: started.dispatchTaskId, host: owner, agent: p.agent,
      ...(started.queued ? { status: "queued" } : { status: "pending_approval", approveUrl: approveUrl(started.dispatchTaskId) }),
    })
  } finally {
    starting.delete(componentId)
  }
}
