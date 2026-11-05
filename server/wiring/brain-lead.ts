import { homedir } from "node:os"
import { join } from "node:path"
import { realHerdr } from "../lib/herdr"
import { type SpawnResult, spawnInHerdr } from "../lib/spawn-session"
import { brainLiveness } from "./brain-workers"

// Repo leads (docs/brain-api.md § Repo leads): one persistent `lead-<repo>` herdr
// session per repo, following brain/LEAD.md. No queue, no loop here: the server
// only starts a lead and proves who one is.

const MAX_DEPTH = 8

/** Plan mode is off: nobody answers ExitPlanMode's approval in a lead's pane. */
export const leadArgs = (name: string): string[] => ["--remote-control", name, "--permission-mode", "auto", "--disallowedTools", "EnterPlanMode", "ExitPlanMode"]

export interface LeadDeps {
  running(name: string): Promise<boolean>
  spawn(repo: string, name: string): Promise<Pick<SpawnResult, "ok" | "error">>
  /** Clears the herdr record a dead lead left behind (the spawn answered name_taken). */
  stop(name: string): Promise<void>
  /** The shell of the pane herdr holds for that agent, "" when unknown. */
  shellPid(name: string): Promise<string>
  parentPid(pid: string): Promise<string>
}

export function createBrainLead(deps: LeadDeps) {
  const starting = new Set<string>()
  return {
    async ensure(repo: string, name: string): Promise<{ ok: boolean; name: string; state: string; error?: string }> {
      if (starting.has(repo)) return { ok: true, name, state: "starting" }
      starting.add(repo)
      try {
        if (await deps.running(name)) return { ok: true, name, state: "running" }
        const out = await deps.spawn(repo, name)
        if (out.error?.startsWith("name_taken") && !await deps.running(name)) await deps.stop(name)
        return out.ok ? { ok: true, name, state: "started" } : { ok: false, name, state: "down", error: out.error }
      } finally {
        starting.delete(repo)
      }
    },

    /**
     * This pid runs inside the lead's pane: it descends from the shell of the pane herdr
     * holds for that agent. The kernel's parent chain, so no header, env or registered
     * session can fake it. The ceiling is the herdr socket: whoever drives herdr can type in that pane anyway.
     */
    async verified(name: string, pid: string): Promise<boolean> {
      if (!/^\d+$/.test(pid)) return false
      const shell = await deps.shellPid(name)
      if (!shell) return false
      let at = pid
      for (let i = 0; i < MAX_DEPTH && at && at !== "1"; i++) {
        at = await deps.parentPid(at)
        if (at === shell) return true
      }
      return false
    },
  }
}

export type BrainLead = ReturnType<typeof createBrainLead>

export const brainLead = createBrainLead({
  // alive(), not the agent record: herdr can keep the record of a claude that exited.
  running: (name) => brainLiveness.alive(name),
  spawn: (repo, name) => spawnInHerdr(join(homedir(), repo), "claude", { COMPANION_TASK_ID: name }, realHerdr, { name, args: leadArgs(name) }),
  stop: async (name) => {
    const a = await brainLiveness.agentOf(name)
    if (a.kind !== "present") return
    await realHerdr.call(["agent", "stop", name]).catch(() => undefined)
    if (a.ref.workspaceId) await realHerdr.call(["workspace", "close", a.ref.workspaceId]).catch(() => undefined)
    brainLiveness.forget(name)
  },
  shellPid: async (name) => {
    const a = await brainLiveness.agentOf(name)
    if (a.kind !== "present" || !a.ref.pane) return ""
    const r = await realHerdr.call(["pane", "process-info", "--pane", a.ref.pane], 2_000).catch(() => null)
    const pid = (r?.process_info as { shell_pid?: number } | undefined)?.shell_pid
    return typeof pid === "number" && pid > 0 ? String(pid) : ""
  },
  parentPid: async (pid) => {
    const p = Bun.spawn(["ps", "-o", "ppid=", "-p", pid], { stdout: "pipe", stderr: "ignore" })
    return (await new Response(p.stdout).text()).trim()
  },
})
