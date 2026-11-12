import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BRAIN_AGENT, BRAIN_THREAD, LEAD_PREFIX, brainEnabled, isRoutineLeadAck, leadSlug } from "../lib/brain"
import { type Herdr, herdrWorkspacePanes, herdrWorkspaces, realHerdr } from "../lib/herdr"
import { type ShFn, githubName, isDir, realSh, repoEntriesSafe } from "../lib/live-repo"
import { appendTurn } from "../lib/orchestrator-chat"
import { type SpawnResult, ensureFolderTrusted, folderTrusted, spawnInHerdr } from "../lib/spawn-session"
import { defaultResolveRepoDir } from "../lib/worker-supervisor"
import { brainLiveness } from "./brain-workers"
import type { AgentLookup } from "./takeover-liveness"

// Repo leads (docs/brain-api.md § Repo leads): one persistent `lead-<repo>` herdr
// workspace per repo, one pane, following brain/LEAD.md. The server only starts it.

/** `--name` is what the session registers as, so what SendMessage reaches; `--remote-control` only titles the bridge. Plan mode is off: nobody answers ExitPlanMode's approval in a lead's pane. No file-editing tools: a lead never edits code, and they ignore the Bash sandbox. */
export const leadArgs = (name: string): string[] => ["--name", name, "--remote-control", name, "--model", "claude-sonnet-5-5", "--permission-mode", "auto", "--disallowedTools", "EnterPlanMode", "ExitPlanMode", "Edit", "Write", "MultiEdit", "NotebookEdit"]

/** A lead works in its own clone: the sandbox limits its Bash to this tree, so the live checkout and brain/ stay out of reach. */
export const leadDir = (repo: string, home = homedir()): string => join(home, "leads", repo)

/** A checkout this host can lead from: the lead's own clone, one the worker supervisor resolves (incl. the dispatch-repos cache), or a REPO_MAP checkout of that GitHub name (what the first spawn clones from). */
export const leadCheckout = (repo: string, home = homedir(), entries = repoEntriesSafe()): boolean =>
  isDir(leadDir(repo, home)) || defaultResolveRepoDir(repo, home) !== null || entries.some((e) => githubName(e)?.toLowerCase() === repo.toLowerCase() && isDir(e.path))

const settingsFile = (dir: string): string => join(dir, ".claude", "settings.local.json")

interface LeadSettings {
  model: string
  permissions: { allow: string[]; deny: string[] }
  sandbox: { enabled: boolean; allowUnsandboxedCommands: boolean; failIfUnavailable: boolean; excludedCommands: string[]; filesystem: { denyWrite: string[] } }
}

const NO_FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "EnterPlanMode", "ExitPlanMode"]

/**
 * Project settings, unlike launch args, survive a herdr restore (`claude --resume` with no args), and the sandbox
 * refuses a lead's Bash writing or moving them. No way out of the sandbox: no unsandboxed Bash, no running without one,
 * and every user-level `excludedCommands` entry is denied, since those run unsandboxed and project settings can't remove them.
 * Only `brain/bin/worker` and `brain/bin/sessions` are allowed outside the bwrap network/PID namespace so a lead can
 * talk to the local Companion loopback (`127.0.0.1:4245`) and verify its own `claude` PID.
 */
export function leadSettings(excluded: string[], dir: string): LeadSettings {
  const home = dirname(dirname(dir))
  const commands = excluded.flatMap((c) => [`Bash(${c})`, `Bash(${c.replace(/ \*$/, ":*")})`])
  const allow = [
    "Bash(~/claude-companion/brain/bin/worker:*)",
    "Bash(~/claude-companion/brain/bin/sessions:*)",
    "Bash(~/claude-companion/brain/bin/pr-update-branch:*)",
    `Bash(${join(home, "claude-companion/brain/bin/worker")}:*)`,
    `Bash(${join(home, "claude-companion/brain/bin/sessions")}:*)`,
    `Bash(${join(home, "claude-companion/brain/bin/pr-update-branch")}:*)`,
  ]
  const excludedBins = [
    "~/claude-companion/brain/bin/worker *",
    "~/claude-companion/brain/bin/sessions *",
    "~/claude-companion/brain/bin/pr-update-branch *",
    `${join(home, "claude-companion/brain/bin/worker")} *`,
    `${join(home, "claude-companion/brain/bin/sessions")} *`,
    `${join(home, "claude-companion/brain/bin/pr-update-branch")} *`,
  ]
  return {
    model: "claude-sonnet-5-5",
    permissions: { allow, deny: [...NO_FILE_TOOLS, ...new Set(commands)] },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      excludedCommands: excludedBins,
      filesystem: { denyWrite: [join(dir, ".claude"), join(dir, ".git")] },
    },
  }
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

/**
 * Running with settings the server wrote: a missing or tampered file doesn't count.
 * When a previous server version wrote valid sandbox + deny settings and `leadSettings` evolved
 * (e.g., model or allowlist updates), refresh `settings.local.json` in place so live leads keep their context.
 * Thrown when the user settings can't be read: that proves nothing either way, so the caller stops nothing and starts nothing.
 */
export function leadIsolated(repo: string, home = homedir(), excluded: (home: string) => string[] = excludedCommands): boolean {
  const dir = leadDir(repo, home)
  const expected = leadSettings(excluded(home), dir)
  const want = JSON.stringify(expected, null, 2)
  try {
    const raw = readFileSync(settingsFile(dir), "utf8")
    if (raw === want) return true
    const cur = JSON.parse(raw) as Partial<LeadSettings>
    const sb = cur.sandbox
    const deny = cur.permissions?.deny
    const dw = sb?.filesystem?.denyWrite
    if (
      sb?.enabled !== true ||
      sb.allowUnsandboxedCommands !== false ||
      sb.failIfUnavailable !== true ||
      !Array.isArray(dw) ||
      !expected.sandbox.filesystem.denyWrite.every((p) => dw.includes(p)) ||
      !Array.isArray(deny) ||
      !expected.permissions.deny.every((d) => deny.includes(d))
    ) {
      return false
    }
    writeFileSync(settingsFile(dir), want)
    return true
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
      } catch (err) {
        return { ok: false, name, state: "down", error: (err as Error)?.message ?? String(err) }
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

// ── Brain ↔ Agent Relay (bridges headless brain's ephemeral sockets without noisy UI turns or ACK ping-pong) ──

/**
 * Enqueue an internal `[event]` turn from an agent (`lead-<repo>` or peer session) into the brain thread.
 * Routine ACKs (`ack ...`, `noted`, `on it`) are dropped so they don't burn a 230k-token Brain turn,
 * and `orchEmit` is not called so raw `[from ...]` lines never appear as Brain chat bubbles on the phone.
 */
export function relayToBrainThread(sender: string, message: string, _sessionId?: string): boolean {
  const clean = message.trim()
  if (!clean || isRoutineLeadAck(clean)) return false
  const from = sender.trim() || "agent"
  appendTurn("orchestrator", `[from ${from}] ${clean}`, null, BRAIN_THREAD)
  return true
}

/**
 * Intercept `SendMessage` tool calls from non-brain sessions aimed at `brain`, `brain-*` (auto-suffixed headless
 * `claude -p` names like `brain-eb`), or a dead `uds:/run/user/.../cc-socks/<pid>.sock` from a finished headless brain turn.
 */
export function maybeRelaySendMessageToBrain(opts: {
  tool: string
  input: Record<string, unknown>
  senderTaskId?: string | null
  senderLabel?: string | null
  sessionId?: string
  enabled?: boolean
}): boolean {
  if ((opts.enabled ?? brainEnabled()) !== true) return false
  if (opts.tool !== "SendMessage") return false
  const senderTask = (opts.senderTaskId ?? "").trim()
  if (senderTask === BRAIN_AGENT) return false
  const to = (typeof opts.input.to === "string" ? opts.input.to : typeof opts.input.recipient === "string" ? opts.input.recipient : "").trim()
  const msg = (typeof opts.input.message === "string" ? opts.input.message : typeof opts.input.content === "string" ? opts.input.content : "").trim()
  if (!to || !msg) return false
  const isBrainName = to === BRAIN_AGENT || to.startsWith(`${BRAIN_AGENT}-`)
  const isDeadUds = to.startsWith("uds:") && (senderTask.startsWith(LEAD_PREFIX) || !existsSync(to.slice(4)))
  if (!isBrainName && !isDeadUds) return false
  const sender = senderTask || (opts.senderLabel ?? "").trim() || "agent"
  return relayToBrainThread(sender, msg, opts.sessionId)
}
