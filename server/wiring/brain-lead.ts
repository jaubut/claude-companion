import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { leadSlug } from "../lib/brain"
import { type Herdr, herdrWorkspacePanes, herdrWorkspaces, realHerdr } from "../lib/herdr"
import { type ShFn, realSh } from "../lib/live-repo"
import { companionLog } from "../lib/log"
import { type SpawnResult, spawnInHerdr } from "../lib/spawn-session"
import { brainLiveness } from "./brain-workers"
import type { AgentLookup } from "./takeover-liveness"

// Repo leads (docs/brain-api.md § Repo leads): one persistent `lead-<repo>` herdr
// workspace per repo, one pane, following brain/LEAD.md. The server only starts it.

/** Plan mode is off: nobody answers ExitPlanMode's approval in a lead's pane. No file-editing tools: a lead never edits code, and they ignore the Bash sandbox. */
export const leadArgs = (name: string): string[] => ["--remote-control", name, "--permission-mode", "auto", "--disallowedTools", "EnterPlanMode", "ExitPlanMode", "Edit", "Write", "MultiEdit", "NotebookEdit"]

/** A lead works in its own clone: the sandbox limits its Bash to this tree, so the live checkout and brain/ stay out of reach. */
export const leadDir = (repo: string, home = homedir()): string => join(home, "leads", repo)

/**
 * Project settings, unlike launch args, survive a herdr restore (`claude --resume` with no args), and the sandbox
 * refuses a lead's Bash writing this file. failIfUnavailable: no sandbox means no lead, never an unconfined one.
 */
export const LEAD_SETTINGS = {
  permissions: { deny: ["Edit", "Write", "MultiEdit", "NotebookEdit"] },
  sandbox: { failIfUnavailable: true },
}

const GIT_MS = 120_000

/** The clone, created or fast-forwarded, with its settings written. A clone that can't be made refuses the spawn. */
export async function prepareLeadDir(repo: string, home = homedir(), sh: ShFn = realSh): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const slug = leadSlug(repo)
  if (!slug) return { ok: false, error: `no lead for ${repo}` }
  const dir = leadDir(repo, home)
  if (existsSync(join(dir, ".git"))) {
    const pull = await sh("git", ["-C", dir, "pull", "-q", "--ff-only"], { cwd: home, timeoutMs: GIT_MS })
    if (!pull.ok) companionLog(`[lead] ${repo} clone not updated: ${pull.err.trim().slice(0, 120)}`)
  } else {
    mkdirSync(dirname(dir), { recursive: true })
    const clone = await sh("git", ["clone", "-q", `https://github.com/${slug}.git`, dir], { cwd: home, timeoutMs: GIT_MS })
    if (!clone.ok) return { ok: false, error: `lead clone failed: ${clone.err.trim().slice(0, 160)}` }
  }
  mkdirSync(join(dir, ".claude"), { recursive: true })
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify(LEAD_SETTINGS, null, 2))
  return { ok: true, dir }
}

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
  spawn: async (repo, name) => {
    const out = await prepareLeadDir(repo)
    return out.ok ? spawnInHerdr(out.dir, "claude", { COMPANION_TASK_ID: name }, realHerdr, { name, args: leadArgs(name) }) : { ok: false, error: out.error }
  },
})
