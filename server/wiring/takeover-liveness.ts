import { type Herdr, herdrErrorCode } from "../lib/herdr"

// Is a takeover session still running (wiring/takeover.ts)? The Companion's session
// registry first, then herdr: the run's agent and what is in front of its pane. An
// idle session fires no hook after a Companion restart, and herdr may keep an exited
// agent's record, so neither alone decides. A herdr read that errors (a timeout) is
// never "gone": it spends a budget of PANE_ERRORS_MAX reads in a row, then counts as gone.

export const START_GRACE_MS = 3 * 60_000
export const PANE_ERRORS_MAX = 5

export interface HerdrAgentRef { pane: string; workspaceId?: string; terminalId?: string }
export type AgentLookup = { kind: "present"; ref: HerdrAgentRef } | { kind: "absent" } | { kind: "error" }

export interface LivenessDeps { herdr: Herdr; sessions: () => { key: string; taskId: string }[]; now: () => number }

export function createLiveness(get: () => LivenessDeps) {
  const errors = new Map<string, number>()
  const seenLive = new Set<string>()

  /** herdr's agent of that name: present (pane + workspace ids), absent (agent_not_found), or error (herdr could not say). */
  async function agentOf(name: string): Promise<AgentLookup> {
    try {
      const r = await get().herdr.call(["agent", "get", name])
      const a = (r.agent ?? {}) as { pane_id?: unknown; workspace_id?: unknown; terminal_id?: unknown }
      return {
        kind: "present",
        ref: {
          pane: typeof a.pane_id === "string" ? a.pane_id : "",
          ...(typeof a.workspace_id === "string" ? { workspaceId: a.workspace_id } : {}),
          ...(typeof a.terminal_id === "string" ? { terminalId: a.terminal_id } : {}),
        },
      }
    } catch (err) {
      return herdrErrorCode(err) === "agent_not_found" ? { kind: "absent" } : { kind: "error" }
    }
  }

  const sessionLive = (name: string): boolean => get().sessions().some((s) => s.taskId === name)

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
  async function alive(name: string): Promise<boolean> {
    if (sessionLive(name)) {
      errors.delete(name)
      return true
    }
    const a = await agentOf(name)
    if (a.kind === "error") return spend(name)
    if (a.kind === "absent" || !a.ref.pane) {
      errors.delete(name)
      return false
    }
    const front = await paneFront(a.ref.pane)
    if (front === "error") return spend(name)
    errors.delete(name)
    return front === "busy"
  }

  /** Gone = not alive; counted once seen live, past the start grace, or when herdr says the agent is absent (an error never counts). */
  async function missing(name: string, createdAt: number): Promise<boolean> {
    if (await alive(name)) {
      seenLive.add(name)
      return false
    }
    if (seenLive.has(name) || get().now() - createdAt > START_GRACE_MS) return true
    return (await agentOf(name)).kind === "absent"
  }

  return {
    agentOf, sessionLive, alive, missing,
    seen: (name: string) => { seenLive.add(name) },
    forget: (name: string) => { seenLive.delete(name); errors.delete(name) },
    reset: () => { seenLive.clear(); errors.clear() },
  }
}
