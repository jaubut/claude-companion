// Cache, de-duplication and concurrency for the hidden /help enumeration
// (lib/command-offpane.ts). The route (routes/command.ts) talks to
// `commandLister` only.

import { homedir } from "node:os"
import type { CommandEntry } from "./command-list"
import { enumerateCommandsOffPane, realSleep, type OffPaneResult, type OffPaneStatus } from "./command-offpane"
import { claudeVersion, computeFingerprint, defaultTmux, defaultWhich, resolveClaudeLaunch, type ClaudeLaunch } from "./command-offpane-launch"

// ── Cache, de-duplication, concurrency ─────────────────────────────────────

export interface PreparedList {
  fingerprint: string
  enumerate: () => Promise<OffPaneResult>
}

export interface ListerDeps {
  // Resolve claude + fingerprint for a cwd. An `error` result (claude not
  // on PATH) is answered at once, never after a timeout.
  prepare: (cwd: string) => Promise<PreparedList | { error: string }>
  now?: () => number
  ttlMs?: number
  negativeTtlMs?: number
  maxParallel?: number
  // How long one request waits for a running enumeration before answering
  // "retry later". The enumeration keeps going and caches when it lands.
  waitMs?: number
}

export interface ListOutcome {
  cached: boolean
  result: OffPaneResult
}

// A safety net only: the fingerprint catches every change we know of; this
// catches the ones we don't (a plugin updated in place, a new built-in behind
// a server-side flag).
export const LIST_TTL_MS = 24 * 60 * 60 * 1000
// A wizard or an error for a fingerprint is answered from memory this long:
// the phone warms on every activation, and each would otherwise boot a claude
// into the same dialog.
export const NEGATIVE_TTL_MS = 10 * 60 * 1000
// Under the iOS client's 60s request timeout, with room for the response.
export const LIST_WAIT_MS = 50_000
export const MAX_PARALLEL = 2

const errResult = (status: OffPaneStatus, detail: string): OffPaneResult => ({ status, commands: [], rowsPerPage: 0, session: "", detail })

// A counting semaphore that HANDS a released slot to the next waiter instead
// of freeing it: between a release and the waiter resuming, a newcomer would
// otherwise see a free slot and take it too (3 claudes under a cap of 2).
export function createSlots(max: number) {
  let running = 0
  const queue: Array<() => void> = []
  return {
    async acquire(): Promise<void> {
      if (running < max) { running++; return }
      await new Promise<void>((r) => queue.push(r))
      // The slot came with the wake-up: `running` was never decremented.
    },
    release(): void {
      const next = queue.shift()
      if (next) next()
      else running--
    },
    get running() { return running },
    get waiting() { return queue.length },
  }
}

// - A hit needs the same fingerprint and < 24h age: nothing changed, nothing re-runs.
// - A wizard/error for the same fingerprint < 10 min old is answered as-is.
// - Concurrent callers for the same fingerprint share one enumeration (the
//   phone warms on every session activation — two sessions in one project
//   must not spawn two claudes).
// - Different fingerprints run in parallel, at most `maxParallel` at a time:
//   each is a full claude process.
export function createCommandLister(deps: ListerDeps) {
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? LIST_TTL_MS
  const negativeTtl = deps.negativeTtlMs ?? NEGATIVE_TTL_MS
  const waitMs = deps.waitMs ?? LIST_WAIT_MS
  const slots = createSlots(Math.max(1, deps.maxParallel ?? MAX_PARALLEL))
  const cache = new Map<string, { fp: string; at: number; commands: CommandEntry[] }>()
  const failures = new Map<string, { at: number; result: OffPaneResult }>()
  const inflight = new Map<string, Promise<OffPaneResult>>()

  const limit = async <T>(fn: () => Promise<T>): Promise<T> => {
    await slots.acquire()
    try {
      return await fn()
    } finally {
      slots.release()
    }
  }

  async function list(cwd: string, opts: { force?: boolean } = {}): Promise<ListOutcome> {
    let prep: PreparedList | { error: string }
    try { prep = await deps.prepare(cwd) } catch (err) { prep = { error: err instanceof Error ? err.message : String(err) } }
    if ("error" in prep) return { cached: false, result: errResult("error", prep.error) }
    const fp = prep.fingerprint

    const hit = cache.get(cwd)
    if (hit && !opts.force && hit.fp === fp && now() - hit.at < ttl) {
      return { cached: true, result: { status: "ok", commands: hit.commands, rowsPerPage: 0, session: "" } }
    }
    const failed = failures.get(fp)
    if (failed && now() - failed.at < negativeTtl) {
      if (!opts.force) return { cached: false, result: { ...failed.result, detail: `${failed.result.detail ?? failed.result.status} (remembered)` } }
    } else if (failed) {
      failures.delete(fp)
    }

    let job = inflight.get(fp)
    if (!job) {
      const run = prep.enumerate
      job = limit(run)
        .catch((err): OffPaneResult => errResult("error", err instanceof Error ? err.message : String(err)))
        .then((res) => {
          // Only a whole list is cached: a partial one would be served until
          // the next skill change.
          if (res.status === "ok" && res.commands.length) {
            cache.set(cwd, { fp, at: now(), commands: res.commands })
            failures.delete(fp)
          } else if (res.status === "wizard" || res.status === "error") {
            failures.set(fp, { at: now(), result: res })
          }
          return res
        })
        .finally(() => inflight.delete(fp))
      inflight.set(fp, job)
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const gaveUp = new Promise<OffPaneResult>((r) => {
      timer = setTimeout(() => r(errResult("pending", `still enumerating after ${waitMs}ms`)), waitMs)
    })
    try {
      return { cached: false, result: await Promise.race([job, gaveUp]) }
    } finally {
      clearTimeout(timer)
    }
  }

  return { list, clear: () => { cache.clear(); failures.clear() } }
}

// Launch resolution is memoised briefly: the phone warms every session at
// once, and each would otherwise ask tmux for its environment.
const LAUNCH_TTL_MS = 60_000
let launchMemo: { at: number; value: ClaudeLaunch | null } | null = null
async function currentLaunch(): Promise<ClaudeLaunch | null> {
  if (launchMemo && Date.now() - launchMemo.at < LAUNCH_TTL_MS) return launchMemo.value
  const value = await resolveClaudeLaunch({ tmux: defaultTmux, which: defaultWhich, processEnv: process.env, home: homedir() })
  launchMemo = { at: Date.now(), value }
  return value
}

export async function prepareRealList(cwd: string): Promise<PreparedList | { error: string }> {
  const launch = await currentLaunch()
  if (!launch) return { error: "claude not on PATH (tmux server env or usual install dirs)" }
  const version = await claudeVersion(launch)
  return {
    fingerprint: await computeFingerprint(cwd, launch, version),
    enumerate: () => enumerateCommandsOffPane(cwd, { tmux: defaultTmux, sleep: realSleep, now: Date.now, launch }),
  }
}

export const commandLister = createCommandLister({ prepare: prepareRealList })
