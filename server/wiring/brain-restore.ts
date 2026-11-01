import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BRAIN_AGENT } from "../lib/brain"
import { envValue } from "../lib/brain-workers"
import { processEnvEntries } from "../lib/discover"
import { type Herdr, realHerdr } from "../lib/herdr"
import { companionLog } from "../lib/log"
import { brainLiveness, brainWorkers } from "./brain-workers"
import type { AgentLookup } from "./takeover-liveness"

// Stage 0b (docs/herdr-only-migration.md): a herdr restore (crash, SIGKILL,
// reboot) relaunches the brain's pane as `claude --resume <id>` only, with no
// pane env and no launch args: no COMPANION_TASK_ID=brain, no Remote Control,
// yet herdr's agent `brain` reads as alive. On a new herdr server instance the
// supervisor reads the brain pane's env once; when the identity is gone, the
// brain is stopped and reported dead, so the supervisor's normal spawn path
// resumes the same conversation (kv session_id) with its env and args.
//
// Dispatch workers are left alone on purpose: a restore already failed their
// runner's attempt (dispatch-runner.ts herdrAttempt, server_unreachable), so a
// respawned worker would have nobody driving it (claude-config WP5).

/** herdr's API socket: re-created (new inode + mtime) by every server start. */
const SOCKET = process.env.HERDR_SOCKET_PATH?.trim() || join(homedir(), ".config", "herdr", "herdr.sock")

/** Which herdr server instance is running ("" = unreadable). A stat, no herdr call. */
export function herdrEpoch(path = SOCKET): string {
  try {
    const s = statSync(path)
    return `${s.ino}:${s.mtimeMs}`
  } catch {
    return ""
  }
}

/** ok = env intact; lost = a restored pane; absent = no `brain` agent yet; unknown = herdr or /proc unreadable. */
export type BrainIdentity = "ok" | "lost" | "absent" | "unknown"

/** The `brain` agent's pane shell env: what spawnInHerdr stamped (`--env COMPANION_TASK_ID=brain`), or not. */
export async function brainIdentity(
  agentOf: () => Promise<AgentLookup>,
  h: Herdr,
  envOf: (pid: string) => Promise<string[] | null>,
): Promise<BrainIdentity> {
  const a = await agentOf()
  if (a.kind === "absent") return "absent"
  if (a.kind === "error" || !a.ref.pane) return "unknown"
  try {
    const r = await h.call(["pane", "process-info", "--pane", a.ref.pane], 2_000)
    const pid = (r.process_info as { shell_pid?: unknown } | undefined)?.shell_pid
    if (typeof pid !== "number" || pid <= 0) return "unknown"
    const env = await envOf(String(pid))
    if (!env) return "unknown"
    return envValue(env, "COMPANION_TASK_ID") === BRAIN_AGENT ? "ok" : "lost"
  } catch {
    return "unknown"
  }
}

export interface BrainRestoreDeps {
  epoch(): string
  identity(): Promise<BrainIdentity>
  alive(): Promise<boolean>
  stop(): Promise<void>
  log(msg: string): void
}

export function createBrainRestore(deps: BrainRestoreDeps) {
  /** The herdr instance whose brain identity is settled. "" at boot: a reboot of both is checked once too. */
  let settled = ""

  return {
    /** BrainDeps.alive. Only called from the supervisor tick (serialized by its `ticking` guard). */
    async alive(): Promise<boolean> {
      const epoch = deps.epoch()
      if (epoch && epoch !== settled) {
        const id = await deps.identity()
        // absent / unknown: not settled, read again next tick (claude may not be up in the restored pane yet).
        if (id === "ok") settled = epoch
        if (id === "lost") {
          settled = epoch // one respawn per restore
          deps.log(`[brain] herdr restore: the brain pane lost COMPANION_TASK_ID and Remote Control — stopped, the supervisor resumes it`)
          await deps.stop()
          return false
        }
      }
      return deps.alive()
    },
  }
}

export const brainRestore = createBrainRestore({
  epoch: () => herdrEpoch(),
  identity: () => brainIdentity(() => brainLiveness.agentOf(BRAIN_AGENT), realHerdr, processEnvEntries),
  alive: () => brainLiveness.alive(BRAIN_AGENT),
  stop: () => brainWorkers.stopBrain(),
  log: companionLog,
})
