import { type Herdr, herdrErrorCode } from "../lib/herdr"
import { type SeedGate, seedGate as gateOf, promptLanded } from "../lib/herdr-seed"

// Is a herdr worker still running (takeover runs, orchestrator workers)? The Companion's session
// registry first, then herdr: the run's agent and what is in front of its pane. An
// idle session fires no hook after a Companion restart, and herdr may keep an exited
// agent's record, so neither alone decides. A herdr read that errors (a timeout) is
// never "gone": it spends a budget of PANE_ERRORS_MAX reads in a row, then counts as gone.
// An orchestrator worker also names the pane it was spawned in (`Expect`): herdr
// reuses agent names and pane ids, so an agent of that name in another pane (or
// workspace) is a stranger — the worker is gone. Its counters are keyed by task id.

export const START_GRACE_MS = 3 * 60_000
export const PANE_ERRORS_MAX = 5

export interface HerdrAgentRef { pane: string; workspaceId?: string; terminalId?: string; status?: string; interactiveReady?: boolean }
export type AgentLookup = { kind: "present"; ref: HerdrAgentRef } | { kind: "absent" } | { kind: "error" }

/** Who the worker is: the hooks' task id (default: the agent name), and the pane / workspace herdr gave it at spawn. */
export interface Expect { sessionTaskId?: string; pane?: string; workspaceId?: string | null }

export interface LivenessDeps { herdr: Herdr; sessions: () => { key: string; taskId: string }[]; now: () => number }

export function createLiveness(get: () => LivenessDeps) {
  const errors = new Map<string, number>()
  const seenLive = new Set<string>()

  /** herdr's agent of that name: present (pane + workspace ids), absent (agent_not_found), or error (herdr could not say). */
  async function agentOf(name: string): Promise<AgentLookup> {
    try {
      const r = await get().herdr.call(["agent", "get", name])
      const a = (r.agent ?? {}) as { pane_id?: unknown; workspace_id?: unknown; terminal_id?: unknown; agent_status?: unknown; interactive_ready?: unknown }
      return {
        kind: "present",
        ref: {
          pane: typeof a.pane_id === "string" ? a.pane_id : "",
          ...(typeof a.workspace_id === "string" ? { workspaceId: a.workspace_id } : {}),
          ...(typeof a.terminal_id === "string" ? { terminalId: a.terminal_id } : {}),
          ...(typeof a.agent_status === "string" ? { status: a.agent_status } : {}),
          ...(typeof a.interactive_ready === "boolean" ? { interactiveReady: a.interactive_ready } : {}),
        },
      }
    } catch (err) {
      return herdrErrorCode(err) === "agent_not_found" ? { kind: "absent" } : { kind: "error" }
    }
  }

  /** `sessionTaskId`: the COMPANION_TASK_ID the run's hooks carry (a takeover's is its agent name). */
  const sessionLive = (name: string, sessionTaskId = name): boolean => get().sessions().some((s) => s.taskId === sessionTaskId)

  /** agentOf, with an agent of that name in another pane / workspace than expected read as absent (name reuse). */
  async function agentAt(name: string, e: Expect): Promise<AgentLookup> {
    const a = await agentOf(name)
    if (a.kind !== "present") return a
    if (e.pane && a.ref.pane !== e.pane) return { kind: "absent" }
    if (e.workspaceId && a.ref.workspaceId && a.ref.workspaceId !== e.workspaceId) return { kind: "absent" }
    return a
  }

  /** What is in front of a herdr pane (herdrPaneShellPid's read, with a read error kept apart from "busy"). */
  async function paneFront(pane: string): Promise<"shell" | "busy" | "error"> {
    try {
      const r = await get().herdr.call(["pane", "process-info", "--pane", pane], 2_000)
      const p = r.process_info as { shell_pid?: number; foreground_process_group_id?: number } | undefined
      if (typeof p?.shell_pid !== "number" || p.shell_pid <= 0) return "error"
      return p.foreground_process_group_id === p.shell_pid ? "shell" : "busy"
    } catch {
      return "error"
    }
  }

  /** One more unreadable answer: still alive while the budget lasts. */
  function spend(name: string): boolean {
    const n = (errors.get(name) ?? 0) + 1
    errors.set(name, n)
    return n < PANE_ERRORS_MAX
  }

  /** Still running: a registered session, or claude (not the shell) in front of the agent's pane. */
  async function alive(name: string, e: Expect = {}): Promise<boolean> {
    const key = e.sessionTaskId ?? name
    if (sessionLive(name, key)) {
      errors.delete(key)
      return true
    }
    const a = await agentAt(name, e)
    if (a.kind === "error") return spend(key)
    if (a.kind === "absent" || !a.ref.pane) {
      errors.delete(key)
      return false
    }
    const front = await paneFront(a.ref.pane)
    if (front === "error") return spend(key)
    errors.delete(key)
    return front === "busy"
  }

  /** Gone = not alive; counted once seen live, past the start grace, or when herdr says the agent is absent (an error never counts). */
  async function missing(name: string, createdAt: number, e: Expect = {}): Promise<boolean> {
    const key = e.sessionTaskId ?? name
    if (await alive(name, e)) {
      seenLive.add(key)
      return false
    }
    if (seenLive.has(key) || get().now() - createdAt > START_GRACE_MS) return true
    return (await agentAt(name, e)).kind === "absent"
  }

  /** The pane's seed gate (lib/herdr-seed.ts); herdr's agent status only when no dialog shows. */
  function seedGate(name: string, pane: string): Promise<SeedGate> {
    return gateOf(
      () => get().herdr.read(pane).catch(() => null),
      async () => { const a = await agentOf(name); return a.kind === "present" ? a.ref.status ?? null : null },
    )
  }

  /** A refused delivery of `text` to the agent's pane that went in anyway (lib/herdr-seed.ts promptLanded). */
  function landed(name: string, pane: string, text: string): Promise<boolean> {
    return promptLanded(
      text,
      () => get().herdr.read(pane).catch(() => null),
      async () => { const a = await agentOf(name); return a.kind === "present" ? a.ref.status ?? null : null },
    )
  }

  return {
    agentOf, agentAt, landed, sessionLive, alive, missing, seedGate,
    seen: (name: string) => { seenLive.add(name) },
    forget: (name: string) => { seenLive.delete(name); errors.delete(name) },
    reset: () => { seenLive.clear(); errors.clear() },
  }
}
