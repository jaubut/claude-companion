import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { BODY_CHANNEL, BODY_CHANNEL_NAME, type BodyComponentDetail, buildComponentDetail } from "../lib/body"
import {
  type BodyAgentStore, DEFAULT_BODY_AGENT, OPEN_DISPATCH_STATES, agentFor, agentTitle, buildAgentPrompt, createBodyAgentStore,
} from "../lib/body-agent"
import { type FixCard, localizeCwd, postFix } from "../lib/body-fix"
import { type BodyHost, type InvestigationRecord, hostFromId, localBodyHost, ownerHost } from "../lib/body-investigate"
import { DEFAULT_NOTE_ID, type PeerConfig, bodyPeer } from "../lib/body-investigate-engine"
import { type KnownPaths, knownPaths } from "../lib/body-investigator"
import { resolveAgent } from "../lib/dispatch-tasks"
import { companionLog } from "../lib/log"
import { createProposal, getTask, setTaskStatus } from "../lib/orchestrator-chat"
import { ensureChannel } from "../lib/orchestrator-channels"
import { db } from "../lib/orchestrator-db"
import { broadcast, HOST_INFO } from "../state"
import { HOP_HEADER, bodyFixStore, investigationStore } from "./body-investigate"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { approveLive } from "./live"

// POST /api/body/component/:id/agent — "Get an agent on it" (lib/body-agent.ts).
// The tap is the approval: a LIVE run (proposal row + claimLive, owner
// companion:<host>, visible in Sessions) on the host that owns the component.
//   owner = this host → local #Body proposal row + approveLive in the cwd.
//   owner = the peer  → POST /api/body/fix on it (same path as an approved Mac fix).
// One open run per component (409 already_running), a component in state ok
// needs an instruction, every start logs agent_activity `body:agent`.

export interface BodyAgentDeps {
  store: BodyAgentStore
  localHost: () => BodyHost
  peer: () => PeerConfig | null
  fetchFn: typeof fetch
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
  peer: () => bodyPeer(),
  fetchFn: fetch,
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

/** Open = the last run's Turso row is still queued / running / blocked. */
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

type Started = { ok: true; taskId: string; dispatchTaskId: string } | { ok: false; res: Response }

async function runLocal(componentId: string, p: Plan, dispatch: DispatchWiring): Promise<Started> {
  const { channel, created } = ensureChannel(BODY_CHANNEL, BODY_CHANNEL_NAME)
  if (created) broadcast({ type: "orchestrator_channel", channel })
  const cwd = localizeCwd(p.cwd)
  const t = createProposal(p.prompt, cwd, `Body agent run on ${componentId} (tapped "Get an agent on it")`, BODY_CHANNEL, {
    noteId: p.noteId, agent: p.agent, title: p.title,
  })
  const out = await approveLive(t.taskId, { cwd, noteId: p.noteId, agent: p.agent }, dispatch)
  if (out.ok) return { ok: true, taskId: out.taskId, dispatchTaskId: out.dispatchTaskId }
  // The tap was the approval: never leave a stray card to approve a second time.
  if (getTask(t.taskId)?.status === "proposed") setTaskStatus(t.taskId, "cancelled")
  return { ok: false, res: err(out.status, out.error, { host: p.owner, ...out.extra }) }
}

async function runOnPeer(componentId: string, p: Plan): Promise<Started> {
  const peer = deps.peer()
  if (!peer) return { ok: false, res: err(503, "host_unreachable", { reason: "no peer configured (COMPANION_BODY_PEER)", host: p.owner }) }
  const fixId = `agent-${randomUUID().replace(/-/g, "").slice(0, 16)}`
  const out = await postFix(peer, {
    fixId, host: p.owner, componentId, prompt: p.prompt, title: p.title, cwd: p.cwd, noteId: p.noteId, agent: p.agent, investigationId: p.investigationId,
  }, HOP_HEADER, deps.fetchFn)
  if (out.kind === "unreachable") return { ok: false, res: err(503, "host_unreachable", { reason: out.reason, host: p.owner }) }
  if (out.kind === "refused") {
    const auth = out.status === 401 || out.status === 403
    const error = typeof out.json?.error === "string" ? out.json.error : auth ? "host_refused" : "host_error"
    return { ok: false, res: err(auth ? 502 : out.status, error, { host: p.owner }) }
  }
  return { ok: true, taskId: String(out.json.taskId ?? ""), dispatchTaskId: String(out.json.dispatchTaskId) }
}

async function logActivity(dispatch: DispatchWiring, componentId: string, p: Plan, s: { taskId: string; dispatchTaskId: string }, instruction: string | null) {
  const meta = JSON.stringify({ source: "companion", host: HOST_INFO.name, owner: p.owner, taskId: s.taskId, dispatchTaskId: s.dispatchTaskId, instruction })
  try {
    await dispatch.exec(
      "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [p.agent, "body:agent", "body_component", componentId, `${p.agent} live on ${p.owner} for ${componentId}`.slice(0, 200), meta],
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
    const started = owner === deps.localHost() ? await runLocal(componentId, p, dispatch) : await runOnPeer(componentId, p)
    if (!started.ok) return started.res
    deps.store.record({ componentId, taskId: started.taskId, dispatchTaskId: started.dispatchTaskId, host: owner, agent: p.agent, createdAt: deps.now() })
    await logActivity(dispatch, componentId, p, started, instruction)
    companionLog(`[body-agent] ${componentId} → ${p.agent} live on ${owner} as ${started.dispatchTaskId.slice(0, 8)}`)
    return Response.json({ ok: true, taskId: started.taskId, dispatchTaskId: started.dispatchTaskId, host: owner, agent: p.agent, status: "running", mode: "live" })
  } finally {
    starting.delete(componentId)
  }
}
