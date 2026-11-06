import { homedir } from "node:os"
import { join } from "node:path"
import { type Herdr, herdrWorkspacePanes, herdrWorkspaces, realHerdr } from "../lib/herdr"
import { type SpawnResult, spawnInHerdr } from "../lib/spawn-session"
import { brainLiveness } from "./brain-workers"
import type { AgentLookup } from "./takeover-liveness"

// Repo leads (docs/brain-api.md § Repo leads): one persistent `lead-<repo>` herdr
// workspace per repo, one pane, following brain/LEAD.md. The server only starts it.

/** Plan mode is off: nobody answers ExitPlanMode's approval in a lead's pane. No file-editing tools: a lead never edits code, and they ignore the Bash sandbox. */
export const leadArgs = (name: string): string[] => ["--remote-control", name, "--permission-mode", "auto", "--disallowedTools", "EnterPlanMode", "ExitPlanMode", "Edit", "Write", "MultiEdit", "NotebookEdit"]

export interface LeadDeps {
  herdr: Herdr
  running(name: string): Promise<boolean>
  agentOf(name: string): Promise<AgentLookup>
  spawn(repo: string, name: string): Promise<Pick<SpawnResult, "ok" | "error">>
}

export function createBrainLead(deps: LeadDeps) {
  const h = deps.herdr
  const starting = new Set<string>()

  /** Clears a dead lead's leftover, only when the workspace is the lead's alone (its label, one pane, the agent's) and its shell is back in front. Anything unreadable keeps it. */
  async function clearDead(name: string): Promise<boolean> {
    const a = await deps.agentOf(name)
    const ws = a.kind === "present" ? a.ref.workspaceId : undefined
    if (a.kind !== "present" || !ws) return false
    const label = (await herdrWorkspaces(h)).find((w) => w.workspaceId === ws)?.label
    const panes = await herdrWorkspacePanes(ws, h)
    if (label !== name || panes.length !== 1 || panes[0]!.paneId !== a.ref.pane) return false
    const info = (await h.call(["pane", "process-info", "--pane", a.ref.pane], 2_000).catch(() => null))?.process_info as { shell_pid?: number; foreground_process_group_id?: number } | undefined
    if (!info?.shell_pid || info.foreground_process_group_id !== info.shell_pid) return false
    await h.call(["agent", "stop", name]).catch(() => undefined)
    await h.call(["workspace", "close", ws]).catch(() => undefined)
    return true
  }

  return {
    async ensure(repo: string, name: string): Promise<{ ok: boolean; name: string; state: string; error?: string }> {
      if (starting.has(repo)) return { ok: true, name, state: "starting" }
      starting.add(repo)
      try {
        if (await deps.running(name)) return { ok: true, name, state: "running" }
        let out = await deps.spawn(repo, name)
        if (out.error?.startsWith("name_taken") && !await deps.running(name) && await clearDead(name)) out = await deps.spawn(repo, name)
        return out.ok ? { ok: true, name, state: "started" } : { ok: false, name, state: "down", error: out.error }
      } finally {
        starting.delete(repo)
      }
    },
  }
}

export type BrainLead = ReturnType<typeof createBrainLead>

export const brainLead = createBrainLead({
  herdr: realHerdr,
  // alive(), not the agent record: herdr can keep the record of a claude that exited.
  running: (name) => brainLiveness.alive(name),
  agentOf: (name) => brainLiveness.agentOf(name),
  spawn: (repo, name) => spawnInHerdr(join(homedir(), repo), "claude", { COMPANION_TASK_ID: name }, realHerdr, { name, args: leadArgs(name) }),
})
