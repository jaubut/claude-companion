import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { leadSlug } from "../lib/brain"
import { type Herdr, herdrWorkspacePanes, herdrWorkspaces, realHerdr } from "../lib/herdr"
import { type ShFn, realSh } from "../lib/live-repo"
import { type SpawnResult, ensureFolderTrusted, folderTrusted, spawnInHerdr } from "../lib/spawn-session"
import { brainLiveness } from "./brain-workers"
import type { AgentLookup } from "./takeover-liveness"

// Repo leads (docs/brain-api.md § Repo leads): one persistent `lead-<repo>` herdr
// workspace per repo, one pane, following brain/LEAD.md. The server only starts it.

/** Plan mode is off: nobody answers ExitPlanMode's approval in a lead's pane. No file-editing tools: a lead never edits code, and they ignore the Bash sandbox. */
export const leadArgs = (name: string): string[] => ["--remote-control", name, "--permission-mode", "auto", "--disallowedTools", "EnterPlanMode", "ExitPlanMode", "Edit", "Write", "MultiEdit", "NotebookEdit"]

/** A lead works in its own clone: the sandbox limits its Bash to this tree, so the live checkout and brain/ stay out of reach. */
export const leadDir = (repo: string, home = homedir()): string => join(home, "leads", repo)

const settingsFile = (dir: string): string => join(dir, ".claude", "settings.local.json")

interface LeadSettings {
  permissions: { deny: string[] }
  sandbox: { enabled: boolean; allowUnsandboxedCommands: boolean; failIfUnavailable: boolean; filesystem: { denyWrite: string[] } }
}

const NO_FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "EnterPlanMode", "ExitPlanMode"]

/**
 * Project settings, unlike launch args, survive a herdr restore (`claude --resume` with no args), and the sandbox
 * refuses a lead's Bash writing or moving them. No way out of the sandbox: no unsandboxed Bash, no running without one,
 * and every user-level `excludedCommands` entry is denied, since those run unsandboxed and project settings can't remove them.
 */
export function leadSettings(excluded: string[], dir: string): LeadSettings {
  const commands = excluded.flatMap((c) => [`Bash(${c})`, `Bash(${c.replace(/ \*$/, ":*")})`])
  return { permissions: { deny: [...NO_FILE_TOOLS, ...new Set(commands)] }, sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, filesystem: { denyWrite: [join(dir, ".claude"), join(dir, ".git")] } } }
}

/** The user's `sandbox.excludedCommands`. Thrown on an unreadable file: a lead without the full deny list doesn't start. */
function excludedCommands(home: string): string[] {
  try {
    const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { sandbox?: { excludedCommands?: string[] } }
    return s.sandbox?.excludedCommands ?? []
  } catch (err) {
    throw new Error(`user settings unreadable: ${(err as Error)?.message ?? err}`)
  }
}

/** Running with exactly the settings the server wrote: a swapped file doesn't count. A user settings file that can't be read proves nothing, so it never tears down a lead. */
export function leadIsolated(repo: string, home = homedir(), excluded: (home: string) => string[] = excludedCommands): boolean {
  const dir = leadDir(repo, home)
  let want: string
  try {
    want = JSON.stringify(leadSettings(excluded(home), dir), null, 2)
  } catch {
    return existsSync(settingsFile(dir))
  }
  try {
    return readFileSync(settingsFile(dir), "utf8") === want
  } catch {
    return false
  }
}

const CLONE_MS = 120_000
const SETTLE_TRIES = 8, SETTLE_MS = 250

/** A fresh shallow clone each spawn: the server never runs git in a tree a lead could write, and a tampered tree doesn't survive. */
export async function prepareLeadDir(repo: string, home: string, sh: ShFn, trust: (dir: string) => boolean, excluded: (home: string) => string[] = excludedCommands): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const slug = leadSlug(repo)
  if (!slug) return { ok: false, error: `no lead for ${repo}` }
  const dir = leadDir(repo, home)
  try {
    const settings = leadSettings(excluded(home), dir)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    const clone = await sh("git", ["clone", "-q", "--depth", "1", `https://github.com/${slug}.git`, dir], { cwd: home, timeoutMs: CLONE_MS })
    if (!clone.ok) return { ok: false, error: `lead clone failed: ${clone.err.trim().slice(0, 160)}` }
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(settingsFile(dir), JSON.stringify(settings, null, 2))
  } catch (err) {
    return { ok: false, error: `lead setup failed: ${(err as Error)?.message ?? err}`.slice(0, 200) }
  }
  return trust(dir) ? { ok: true, dir } : { ok: false, error: "lead setup failed: clone not trusted, it would stall at the trust dialog" }
}

export interface LeadDeps {
  herdr: Herdr
  running(name: string): Promise<boolean>
  isolated(repo: string): boolean
  /** Between checks that a closed lead is gone. */
  settleMs?: number
  agentOf(name: string): Promise<AgentLookup>
  spawn(repo: string, name: string): Promise<Pick<SpawnResult, "ok" | "error">>
}

export function createBrainLead(deps: LeadDeps) {
  const h = deps.herdr
  const starting = new Set<string>()

  /** Clears a lead, only when the workspace is the lead's alone (its label, one pane, the agent's) and, unless `live` (a running lead being replaced), its shell is back in front. Anything unreadable keeps it. */
  async function clearLead(name: string, live: boolean): Promise<boolean> {
    const a = await deps.agentOf(name)
    const ws = a.kind === "present" ? a.ref.workspaceId : undefined
    if (a.kind !== "present" || !ws) return false
    const label = (await herdrWorkspaces(h)).find((w) => w.workspaceId === ws)?.label
    const panes = await herdrWorkspacePanes(ws, h)
    if (label !== name || panes.length !== 1 || panes[0]!.paneId !== a.ref.pane) return false
    if (!live) {
      const info = (await h.call(["pane", "process-info", "--pane", a.ref.pane], 2_000).catch(() => null))?.process_info as { shell_pid?: number; foreground_process_group_id?: number } | undefined
      if (!info?.shell_pid || info.foreground_process_group_id !== info.shell_pid) return false
    }
    await h.call(["agent", "stop", name]).catch(() => undefined)
    await h.call(["workspace", "close", ws]).catch(() => undefined)
    // What herdr reports, not `running`: the session registry can list a closed lead for a minute or more.
    for (let i = 0; i < SETTLE_TRIES; i++) {
      if ((await deps.agentOf(name)).kind === "absent") return true
      await Bun.sleep(deps.settleMs ?? SETTLE_MS)
    }
    return false
  }

  return {
    async ensure(repo: string, name: string): Promise<{ ok: boolean; name: string; state: string; error?: string }> {
      if (starting.has(repo)) return { ok: true, name, state: "starting" }
      starting.add(repo)
      try {
        const live = await deps.running(name)
        if (live && deps.isolated(repo)) return { ok: true, name, state: "running" }
        // Before the spawn, which replaces the clone: a lead that can't be cleared may still be working in it.
        const free = (await deps.agentOf(name)).kind === "absent"
        if (!free && !await clearLead(name, live)) return { ok: false, name, state: "down", error: `name_taken: ${name}` }
        const out = await deps.spawn(repo, name)
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
  isolated: (repo) => leadIsolated(repo),
  agentOf: (name) => brainLiveness.agentOf(name),
  spawn: async (repo, name) => {
    const out = await prepareLeadDir(repo, homedir(), realSh, (dir) => { ensureFolderTrusted(dir); return folderTrusted(dir) })
    return out.ok ? spawnInHerdr(out.dir, "claude", { COMPANION_TASK_ID: name }, realHerdr, { name, args: leadArgs(name) }) : { ok: false, error: out.error }
  },
})
