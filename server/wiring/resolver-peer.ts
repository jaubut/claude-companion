import { randomUUID } from "node:crypto"
import { type BodyHost, localBodyHost } from "../lib/body-investigate"
import { HOP_HEADER, type PeerConfig, bodyPeer } from "../lib/body-investigate-engine"
import { localRepoFor } from "../lib/live-repo"
import { companionLog } from "../lib/log"
import { db } from "../lib/orchestrator-db"
import { type FixOutcome, type ShFn, realSh, runPrFix } from "../lib/resolver-fix"
import {
  type PeerFixRequest, type PeerJob, type PeerJobStore, createPeerJobStore, peerHasRepo, prRef, runFixOnPeer,
} from "../lib/resolver-peer"

// Opus fix runs for repos checked out only on the peer (lib/resolver-peer.ts):
//   Zettlab (the resolver host): fixOnPeer() — has-repo, POST the job, poll it.
//   Mac (the peer):              hasRepoHere() / startPeerFix() / peerJob() behind
//                                routes/resolver.ts; the job runs the same
//                                runPrFix() as a local fix, here, never forwarded.

export interface ResolverPeerDeps {
  peer: () => PeerConfig | null
  localHost: () => BodyHost
  sh: ShFn
  /** This host's checkout of owner/repo (REPO_MAP). */
  localRepo: (slug: string) => Promise<string | null>
  runFix: typeof runPrFix
  fetchFn: typeof fetch
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  now: () => number
  store: () => PeerJobStore
}

let store: PeerJobStore | null = null
function liveStore(): PeerJobStore {
  if (store) return store
  store = createPeerJobStore(db)
  const n = store.closeInterrupted(Date.now())
  if (n) companionLog(`[resolver-peer] ${n} fix job(s) a restart interrupted → failed (transient)`)
  return store
}

let deps: ResolverPeerDeps = {
  peer: () => bodyPeer(),
  localHost: () => localBodyHost(),
  sh: realSh,
  localRepo: (slug) => localRepoFor(slug, "", realSh),
  runFix: runPrFix,
  fetchFn: fetch,
  now: Date.now,
  store: liveStore,
}

/** Test seam: override some deps; returns the previous set. */
export function setResolverPeerDeps(patch: Partial<ResolverPeerDeps>): ResolverPeerDeps {
  const prev = deps
  deps = { ...deps, ...patch }
  return prev
}

// ── peer side (the Mac) ─────────────────────────────────────────────────────

export async function hasRepoHere(slug: string): Promise<boolean> {
  return (await deps.localRepo(slug).catch(() => null)) !== null
}

async function runJob(job: PeerJob, req: PeerFixRequest): Promise<FixOutcome> {
  const ref = prRef(req.prUrl)!
  const repo = await deps.localRepo(ref.slug).catch(() => null)
  if (!repo) return { kind: "failed", error: `no local checkout of ${ref.slug} on the ${deps.localHost()} either` }
  companionLog(`[resolver-peer] job ${job.jobId}: fix run on ${ref.slug}#${ref.number} (${req.branch}) in ${repo}`)
  return deps.runFix({
    prUrl: req.prUrl, number: ref.number, title: req.title ?? `${ref.slug}#${ref.number}`, repo, head: req.branch, base: req.base ?? "main",
    instructions: req.instructions, taskText: req.taskText ?? "", model: req.model, timeoutMs: req.timeoutMs,
  }, { sh: deps.sh })
}

/** POST /api/resolver/fix: one job per (itemId, attempt); a replay returns the same job (running or done). */
export function startPeerFix(req: PeerFixRequest): { job: PeerJob; replay: boolean } {
  const s = deps.store()
  const { job, created } = s.claim(req.itemId, req.attempt, randomUUID(), deps.now())
  if (!created) return { job, replay: true }
  void runJob(job, req)
    .catch((err): FixOutcome => ({ kind: "failed", error: `fix job error: ${(err as Error)?.message ?? err}` }))
    .then((out) => {
      s.finish(job.jobId, out, deps.now())
      companionLog(`[resolver-peer] job ${job.jobId} ${out.kind}${out.kind === "failed" ? `: ${out.error}` : out.kind === "blocked" ? `: ${out.reason}` : ""}`)
    })
  return { job, replay: false }
}

export function peerJob(jobId: string): PeerJob | null {
  return deps.store().get(jobId)
}

// ── resolver side (Zettlab) ─────────────────────────────────────────────────

export interface PeerFixInput { itemId: string; prUrl: string; slug: string; branch: string; base: string; title: string; taskText: string; instructions: string; model: string; timeoutMs: number; attempt: number }

/**
 * No checkout here: ask the peer. null = the peer has none either (or none is
 * configured) — the caller reports "no local checkout". Peer down → a transient
 * failure ("Mac unreachable"), never a loop-guard count.
 */
export async function fixOnPeer(f: PeerFixInput): Promise<FixOutcome | null> {
  const peer = deps.peer()
  if (!peer) return null
  const client = { fetchFn: deps.fetchFn, hopHeader: HOP_HEADER, sleep: deps.sleep, pollMs: deps.pollMs, now: deps.now }
  const has = await peerHasRepo(peer, f.slug, client)
  if (has.kind === "unreachable") return { kind: "failed", error: `Mac unreachable (${has.reason})`, transient: true }
  if (has.kind === "refused") return { kind: "failed", error: `the Mac refused the checkout lookup (http ${has.status})` }
  if (has.kind === "no") return null
  companionLog(`[resolver-peer] ${f.slug} not checked out here → fix run on the peer (${f.itemId}, attempt ${f.attempt})`)
  return runFixOnPeer(peer, {
    itemId: f.itemId, prUrl: f.prUrl, branch: f.branch, instructions: f.instructions, model: f.model, timeoutMs: f.timeoutMs, attempt: f.attempt,
    base: f.base, title: f.title, taskText: f.taskText.slice(0, 4000),
  }, client)
}
