import type { Database } from "bun:sqlite"
import type { BodyComponentDetail } from "./body"
import type { InvestigationRecord } from "./body-investigate"

// "Get an agent on it" (POST /api/body/component/:id/agent). The tap IS the
// approval: a #Body component whose investigation found no code fix (the
// condition is real, e.g. an inbox backlog) still gets a LIVE agent run on the
// host that owns it. Pure parts here (agent table, prompt, body, run store);
// the wiring is wiring/body-agent.ts. Contract: docs/body-api.md.

export const INSTRUCTION_MAX = 2000
export const EVENTS_IN_PROMPT = 3

// ── Agent table (first match wins) ───────────────────────────────────────────

interface AgentRule {
  match: (c: { id: string; kind: string }, repo: boolean) => boolean
  agent: string
}

/** component → agent. Extend here; the default is `claude`. */
export const AGENT_RULES: readonly AgentRule[] = [
  { match: (c) => /:turso-table:inbox_entries$/.test(c.id), agent: "inbox-processor" },
  { match: (c) => c.kind.startsWith("systemd-") || /^[^:]+:systemd-/.test(c.id), agent: "claude" },
  { match: (c) => c.kind === "launchd" || /^[^:]+:launchd:/.test(c.id), agent: "claude" },
  { match: (_c, repo) => repo, agent: "builder" },
]
export const DEFAULT_BODY_AGENT = "claude"

export function agentFor(component: { id: string; kind: unknown }, repo: boolean): string {
  const c = { id: component.id, kind: typeof component.kind === "string" ? component.kind : "" }
  return AGENT_RULES.find((r) => r.match(c, repo))?.agent ?? DEFAULT_BODY_AGENT
}

// ── Request body ─────────────────────────────────────────────────────────────

/** `{instruction?}`; an empty body is fine. */
export function parseAgentBody(text: string): { instruction: string | null } | { error: string } {
  if (!text.trim()) return { instruction: null }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: "invalid JSON" }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be a JSON object" }
  const v = (raw as Record<string, unknown>).instruction
  if (v === undefined || v === null) return { instruction: null }
  if (typeof v !== "string") return { error: "instruction must be a string" }
  return { instruction: v.trim() ? v.trim().slice(0, INSTRUCTION_MAX) : null }
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const cell = (v: unknown): string => (v === null || v === undefined || v === "" ? "-" : String(v))

export function vitalsLine(v: BodyComponentDetail["vitals"]): string {
  if (!v) return "no vitals recorded"
  return `state=${v.state} observed_at=${cell(v.observed_at)} last_exit=${cell(v.last_exit)} consecutive_failures=${v.consecutive_failures} ` +
    `last_run_at=${cell(v.last_run_at)} last_ok_at=${cell(v.last_ok_at)} detail=${cell(v.detail)}`
}

export interface AgentPromptInput {
  detail: BodyComponentDetail
  investigation: InvestigationRecord | null
  instruction: string | null
  host: string
  cwd: string
}

export function buildAgentPrompt(i: AgentPromptInput): string {
  const { component, vitals, events } = i.detail
  const state = vitals?.state ?? "unknown"
  const res = i.investigation?.result ?? null
  const lines = [
    `Jeremie asked for an agent on a Body component (tapped "Get an agent on it" — that tap is the approval).`,
    `Component: ${component.id} (kind ${cell(component.kind)}, host ${i.host}, state ${state})`,
    `Run on host: ${i.host} — the component lives there.`,
    `Working directory: ${i.cwd}`,
    `Latest vitals: ${vitalsLine(vitals)}`,
    `Last ${EVENTS_IN_PROMPT} events (newest first):`,
    ...(events.length
      ? events.slice(0, EVENTS_IN_PROMPT).map((e) => `- ${cell(e.at)} ${cell(e.kind)} ${cell(e.from_state)} → ${cell(e.to_state)}: ${cell(e.detail)}`)
      : ["- none"]),
  ]
  if (res) {
    lines.push(`Latest investigation ${i.investigation!.id} (confidence ${Math.round(res.confidence * 100)}%): ${res.rootCause}`)
    if (res.evidence.length) lines.push("Evidence:", ...res.evidence.map((e) => `- ${e}`))
    if (res.notes) lines.push(`Investigation notes: ${res.notes}`)
  } else {
    lines.push("No finished investigation for this component.")
  }
  lines.push(i.instruction ? `Instruction from Jeremie: ${i.instruction}` : "Instruction: resolve the condition the monitor reports so the component reads ok again.")
  lines.push(
    "Rules: confirm the condition still holds before acting; do the work the condition calls for (process the backlog, restart / repair the job, …) rather than raising the threshold or silencing the probe; make the smallest change; report exactly what you did and whether the component's probe now reads ok.",
  )
  return lines.join("\n")
}

export function agentTitle(componentId: string): string {
  return `Agent on ${componentId}`.slice(0, 120)
}

// ── Run store (one open agent run per component) ─────────────────────────────

export interface AgentRun {
  componentId: string
  taskId: string
  dispatchTaskId: string
  host: string
  agent: string
  createdAt: number
}

export interface BodyAgentStore {
  record(run: AgentRun): void
  latest(componentId: string): AgentRun | null
}

interface RunRow { component_id: string; task_id: string; dispatch_task_id: string; host: string; agent: string; created_at: number }

export function createBodyAgentStore(db: Database): BodyAgentStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS body_agent_runs (
      dispatch_task_id TEXT PRIMARY KEY, component_id TEXT NOT NULL, task_id TEXT NOT NULL,
      host TEXT NOT NULL, agent TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS body_agent_runs_component ON body_agent_runs (component_id, created_at);
  `)
  return {
    record(r) {
      db.query(
        "INSERT OR REPLACE INTO body_agent_runs (dispatch_task_id, component_id, task_id, host, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(r.dispatchTaskId, r.componentId, r.taskId, r.host, r.agent, r.createdAt)
    },
    latest(componentId) {
      const r = db.query("SELECT * FROM body_agent_runs WHERE component_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(componentId) as RunRow | null
      return r ? { componentId: r.component_id, taskId: r.task_id, dispatchTaskId: r.dispatch_task_id, host: r.host, agent: r.agent, createdAt: r.created_at } : null
    },
  }
}

/** Turso dispatch states that still hold the component's agent slot. */
export const OPEN_DISPATCH_STATES: readonly string[] = ["queued", "running", "blocked"]
