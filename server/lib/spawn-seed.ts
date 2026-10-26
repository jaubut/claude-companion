// The optional `seed` of POST /api/spawn-session: a first prompt typed into
// the fresh session once it is up (Brain ▸ Queue ▸ "Open in a new session"
// on a blocked card: the task's title, blocker and evidence). Untrusted
// text: capped and checked at the route, flattened to one control-free line
// (no newline can submit early, no escape sequence reaches the pane), and
// delivered only through the inject guards to a REGISTERED agent session —
// never to a pane that is at a shell. herdr spawns only: the pane id is how
// the registered session is found.

import { oneLine } from "./canvas"
import { type RepoEntry, githubName, hostCan, isDir } from "./live-repo"

export const SEED_MAX = 4000

export type SeedParse = { ok: true; seed: string | null } | { ok: false; error: "bad_seed" | "seed_too_long" }

/** Absent / blank → no seed. A non-string or over-cap value is a 400, never truncated silently. */
export function parseSeed(raw: unknown): SeedParse {
  if (raw === undefined || raw === null) return { ok: true, seed: null }
  if (typeof raw !== "string") return { ok: false, error: "bad_seed" }
  if (raw.length > SEED_MAX) return { ok: false, error: "seed_too_long" }
  const flat = oneLine(raw.trim())
  return { ok: true, seed: flat || null }
}

/** This host's checkout of a repo (GitHub or map name, any case) it may run code in; null = none here. */
export function checkoutForRepo(repo: string, entries: RepoEntry[], can: (e: RepoEntry) => boolean = hostCan, dir: (p: string) => boolean = isDir): string | null {
  const want = repo.trim().toLowerCase()
  if (!want) return null
  const hit = entries.find((e) => (githubName(e)?.toLowerCase() === want || e.name?.toLowerCase() === want) && dir(e.path) && can(e))
  return hit?.path ?? null
}

export interface SeedDeps {
  /** The registered session in that herdr pane, if any yet. */
  find: (pane: string) => { key: string } | undefined
  /** The guarded inject (deliverInject): status + body.error. */
  inject: (text: string, key: string) => Promise<{ ok: boolean; error?: string }>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

// Refusals that mean "not ready yet" (still starting, a start dialog): wait.
const RETRY = new Set(["target_gone", "target_idle", "pane_not_ready", "dialog_open", "busy_flow", "pane_too_narrow"])

export const SEED_WAIT_MS = 120_000
const SEED_EVERY_MS = 2_000

/** Waits for the session, then types the seed once. "sent" | "timeout" | the refusal that ended it. */
export async function deliverSeed(pane: string, seed: string, deps: SeedDeps, waitMs = SEED_WAIT_MS): Promise<string> {
  const until = deps.now() + waitMs
  let last = "timeout"
  while (deps.now() < until) {
    const s = deps.find(pane)
    if (s) {
      const r = await deps.inject(seed, s.key)
      if (r.ok) return "sent"
      last = r.error ?? "unknown"
      // not_submitted / send failures: typed or half-typed — never type it twice.
      if (!RETRY.has(last)) return last
    }
    await deps.sleep(SEED_EVERY_MS)
  }
  return last === "timeout" ? last : `timeout (${last})`
}
