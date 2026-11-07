import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { leadSlug } from "../lib/brain"
import { type Herdr, herdrWorkspacePanes, herdrWorkspaces, realHerdr } from "../lib/herdr"
import { type ShFn, realSh } from "../lib/live-repo"
import { type SpawnResult, ensureFolderTrusted, spawnInHerdr } from "../lib/spawn-session"
import { brainLiveness } from "./brain-workers"
import type { AgentLookup } from "./takeover-liveness"

// Repo leads (docs/brain-api.md § Repo leads): one persistent `lead-<repo>` herdr
// workspace per repo, one pane, following brain/LEAD.md. The server only starts it.

/** Plan mode is off: nobody answers ExitPlanMode's approval in a lead's pane. No file-editing tools: a lead never edits code, and they ignore the Bash sandbox. */
export const leadArgs = (name: string): string[] => ["--remote-control", name, "--permission-mode", "auto", "--disallowedTools", "EnterPlanMode", "ExitPlanMode", "Edit", "Write", "MultiEdit", "NotebookEdit"]

/** A lead works in its own clone: the sandbox limits its Bash to this tree, so the live checkout and brain/ stay out of reach. */
export const leadDir = (repo: string, home = homedir()): string => join(home, "leads", repo)

const NO_FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "EnterPlanMode", "ExitPlanMode"]

/**
 * Project settings, unlike launch args, survive a herdr restore (`claude --resume` with no args), and the sandbox
 * refuses a lead's Bash writing or moving them. No way out of the sandbox: no unsandboxed Bash, no running without one,
 * and every user-level `excludedCommands` entry is denied, since those run unsandboxed and project settings can't remove them.
 */
export function leadSettings(excluded: string[]): { permissions: { deny: string[] }; sandbox: Record<string, boolean> } {
  const commands = excluded.flatMap((c) => [`Bash(${c})`, `Bash(${c.replace(/ \*$/, ":*")})`])
  return { permissions: { deny: [...NO_FILE_TOOLS, ...new Set(commands)] }, sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true } }
}

/** The user's `sandbox.excludedCommands`. Thrown on an unreadable file: a lead without the full deny list doesn't start. */
function excludedCommands(home: string): string[] {
  const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { sandbox?: { excludedCommands?: string[] } }
  return s.sandbox?.excludedCommands ?? []
}

const CLONE_MS = 120_000

/** A fresh shallow clone each spawn: the server never runs git in a tree a lead could write, and a tampered tree doesn't survive. */
export async function prepareLeadDir(repo: string, home: string, sh: ShFn, trust: (dir: string) => void, excluded: (home: string) => string[] = excludedCommands): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const slug = leadSlug(repo)
  if (!slug) return { ok: false, error: `no lead for ${repo}` }
  const dir = leadDir(repo, home)
  try {
    const settings = leadSettings(excluded(home))
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    const clone = await sh("git", ["clone", "-q", "--depth", "1", `https://github.com/${slug}.git`, dir], { cwd: home, timeoutMs: CLONE_MS })
    if (!clone.ok) return { ok: false, error: `lead clone failed: ${clone.err.trim().slice(0, 160)}` }
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify(settings, null, 2))
  } catch (err) {
    return { ok: false, error: `lead setup failed: ${(err as Error)?.message ?? err}`.slice(0, 200) }
  }
  trust(dir)
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
    const out = await prepareLeadDir(repo, homedir(), realSh, ensureFolderTrusted)
    return out.ok ? spawnInHerdr(out.dir, "claude", { COMPANION_TASK_ID: name }, realHerdr, { name, args: leadArgs(name) }) : { ok: false, error: out.error }
  },
})
