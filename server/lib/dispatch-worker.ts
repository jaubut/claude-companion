// Dispatch workers: the claude the dispatch runner starts for a queued task.
// Legacy runs it headless (`claude -p`); the herdr runner runs it interactive in
// a pane, so it HAS a tty and fires every hook — including PermissionRequest,
// which `-p` never reaches. Its pane env carries DISPATCH_WORKER=1 (and
// DISPATCH_TASK_ID); that is the only marker.
//
// A worker is not a phone conversation: it must not list in the session picker,
// push on Stop, or open approval/question cards. A worker stuck on a dialog is the
// runner's problem (its blocked-grace timeout), never the lock screen's.

export const DISPATCH_WORKER_ENV = "DISPATCH_WORKER"

// A process environment (NAME=value entries) that marks a dispatch worker.
export function envHasDispatchWorker(entries: Iterable<string>): boolean {
  for (const e of entries) {
    if (e === `${DISPATCH_WORKER_ENV}=1`) return true
  }
  return false
}

type EnvOf = (pid: string) => Promise<string[] | null>

const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 512
const cache = new Map<string, { worker: boolean; until: number }>()

export function resetDispatchWorkerCache(): void {
  cache.clear()
}

// Is this pid a dispatch worker? Its environment cannot change after exec, so
// the answer is cached per pid. Unreadable env → false (fail open: the session
// is handled like any other, exactly as before this guard existed).
export async function isDispatchWorkerPid(pid: string, envOf: EnvOf, now = Date.now()): Promise<boolean> {
  if (!/^\d+$/.test(pid)) return false
  const hit = cache.get(pid)
  if (hit && hit.until > now) return hit.worker
  const env = await envOf(pid)
  const worker = env ? envHasDispatchWorker(env) : false
  if (env) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
    cache.set(pid, { worker, until: now + CACHE_TTL_MS })
  }
  return worker
}

// (envOf is injected: lib/discover.ts imports this file, so it cannot import discover.)
// A hook request from a dispatch worker: the hook scripts send the agent's pid
// (X-Companion-Pid), and the server reads that process's own environment. No
// hook-script change needed.
export async function isDispatchWorkerHook(headers: Headers, envOf: EnvOf): Promise<boolean> {
  if (headers.get("x-companion-agent") === "codex") return false
  return isDispatchWorkerPid(headers.get("x-companion-pid") ?? "", envOf)
}
