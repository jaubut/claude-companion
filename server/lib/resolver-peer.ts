import type { Database } from "bun:sqlite"
import type { FixOutcome } from "./resolver-fix"

// Mac-only repos run their Opus fix on the Mac (docs/orchestrator-triage-api.md#peer-fix-runs).
// The resolver runs on Zettlab; tls-review, the iOS apps and TLS Video Assist
// are checked out only on the Mac. When this host has no checkout of a PR's
// repo, the fix job goes to the body peer (COMPANION_BODY_PEER, bearer
// COMPANION_BODY_PEER_TOKEN):
//   GET  /api/resolver/has-repo?slug=owner/repo   → { ok, slug, hasRepo, host }
//   POST /api/resolver/fix  { itemId, prUrl, branch, instructions, model, timeoutMs, attempt, base?, title?, taskText? }
//        → 202 { ok, jobId, status: "running" | "done", outcome?, replay }   (idempotent on (itemId, attempt))
//   GET  /api/resolver/fix/<jobId> → { ok, jobId, status, outcome? }
// A fix run can take 30 min, longer than any HTTP hop should stay open, so the
// peer answers at once with a job id and Zettlab polls (robust to a dropped
// connection: the job keeps running and the next poll finds it). Every call
// carries the HOP header; the peer runs the job locally and never forwards it.
// Seams only: the store takes its Database, the client its fetch.

export const PEER_HTTP_TIMEOUT_MS = 15_000
export const POLL_MS = 15_000
/** How long past the fix run's own timeout Zettlab keeps polling. */
export const POLL_GRACE_MS = 5 * 60_000

export interface PeerFixRequest {
  itemId: string
  prUrl: string
  branch: string
  instructions: string
  model: string
  timeoutMs: number
  attempt: number
  base?: string
  title?: string
  taskText?: string
}

export type PeerJobStatus = "running" | "done"

export interface PeerJob { jobId: string; itemId: string; attempt: number; status: PeerJobStatus; outcome: FixOutcome | null; createdAt: number; finishedAt: number | null }

// GitHub owner (alnum + dashes) / repo (no "." / ".." path tricks).
const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/((?!\.\.?\/)[A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.-]+$/

/** owner/repo + number of a GitHub PR URL, or null. */
export function prRef(url: string): { slug: string; number: number } | null {
  const m = PR_URL_RE.exec(url.trim())
  return m ? { slug: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)

export function parsePeerFixRequest(raw: unknown): PeerFixRequest | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be a JSON object" }
  const o = raw as Record<string, unknown>
  const itemId = str(o.itemId, 400)
  const prUrl = str(o.prUrl, 300)
  const branch = str(o.branch, 200)
  const instructions = str(o.instructions, 20_000)
  const model = str(o.model, 80)
  if (!itemId) return { error: "itemId required" }
  if (!prUrl || !prRef(prUrl)) return { error: "prUrl must be a github.com pull request URL" }
  if (!branch) return { error: "branch required" }
  if (!instructions) return { error: "instructions required" }
  if (!model) return { error: "model required" }
  const attempt = Number(o.attempt)
  if (!Number.isInteger(attempt) || attempt < 0) return { error: "attempt must be a non-negative integer" }
  const timeoutMs = Number(o.timeoutMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 2 * 60 * 60_000) return { error: "timeoutMs out of range" }
  return {
    itemId, prUrl, branch, instructions, model, timeoutMs, attempt,
    base: str(o.base, 200) ?? undefined, title: str(o.title, 300) ?? undefined, taskText: str(o.taskText, 4000) ?? undefined,
  }
}

// ── the peer's job store (companion.db) ─────────────────────────────────────

export interface PeerJobStore {
  /** The job for (itemId, attempt): the existing one (replay) or a new running one. */
  claim(itemId: string, attempt: number, jobId: string, now: number): { job: PeerJob; created: boolean }
  get(jobId: string): PeerJob | null
  finish(jobId: string, outcome: FixOutcome, now: number): void
  /** Boot: running jobs a restart interrupted → done, failed (transient). */
  closeInterrupted(now: number): number
}

interface JobRow { job_id: string; item_id: string; attempt: number; status: PeerJobStatus; outcome_json: string | null; created_at: number; finished_at: number | null }

function toJob(r: JobRow): PeerJob {
  let outcome: FixOutcome | null = null
  try { outcome = r.outcome_json ? JSON.parse(r.outcome_json) as FixOutcome : null } catch { outcome = null }
  return { jobId: r.job_id, itemId: r.item_id, attempt: r.attempt, status: r.status, outcome, createdAt: r.created_at, finishedAt: r.finished_at }
}

export const INTERRUPTED: FixOutcome = { kind: "failed", error: "the Mac Companion restarted during the fix run", transient: true }

export function createPeerJobStore(db: Database): PeerJobStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resolver_peer_fixes (
      job_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
      outcome_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, UNIQUE (item_id, attempt)
    );
  `)
  const byKey = (itemId: string, attempt: number) => db.query("SELECT * FROM resolver_peer_fixes WHERE item_id = ? AND attempt = ?").get(itemId, attempt) as JobRow | null
  return {
    claim(itemId, attempt, jobId, now) {
      const r = db.query("INSERT OR IGNORE INTO resolver_peer_fixes (job_id, item_id, attempt, status, created_at) VALUES (?, ?, ?, 'running', ?)").run(jobId, itemId, attempt, now)
      return { job: toJob(byKey(itemId, attempt)!), created: r.changes > 0 }
    },
    get(jobId) {
      const r = db.query("SELECT * FROM resolver_peer_fixes WHERE job_id = ?").get(jobId) as JobRow | null
      return r ? toJob(r) : null
    },
    finish(jobId, outcome, now) {
      db.query("UPDATE resolver_peer_fixes SET status = 'done', outcome_json = ?, finished_at = ? WHERE job_id = ?").run(JSON.stringify(outcome), now, jobId)
    },
    closeInterrupted(now) {
      return db.query("UPDATE resolver_peer_fixes SET status = 'done', outcome_json = ?, finished_at = ? WHERE status = 'running'").run(JSON.stringify(INTERRUPTED), now).changes
    },
  }
}

/** The wire form of a job (POST and GET answer the same shape). */
export function jobDto(job: PeerJob, replay = false): Record<string, unknown> {
  return { ok: true, jobId: job.jobId, status: job.status, ...(job.outcome ? { outcome: job.outcome } : {}), ...(replay ? { replay: true } : {}) }
}

// ── the Zettlab-side client ─────────────────────────────────────────────────

export interface PeerCfg { base: string; token: string }

export interface PeerClientDeps {
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollMs?: number
  hopHeader: string
}

type Call = { kind: "ok"; status: number; json: Record<string, unknown> | null } | { kind: "unreachable"; reason: string }

async function call(cfg: PeerCfg, path: string, d: PeerClientDeps, init: { method: string; body?: unknown } = { method: "GET" }): Promise<Call> {
  try {
    const res = await (d.fetchFn ?? fetch)(`${cfg.base}${path}`, {
      method: init.method, redirect: "manual", signal: AbortSignal.timeout(PEER_HTTP_TIMEOUT_MS),
      headers: { authorization: `Bearer ${cfg.token}`, [d.hopHeader]: "1", ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })
    if (res.status >= 300 && res.status < 400) return { kind: "unreachable", reason: `redirect ${res.status}` }
    if (res.status === 502 || res.status === 503 || res.status === 504) return { kind: "unreachable", reason: `http ${res.status}` }
    return { kind: "ok", status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
  } catch (e) {
    return { kind: "unreachable", reason: (e as Error)?.name ?? "error" }
  }
}

export type HasRepo = { kind: "yes" } | { kind: "no" } | { kind: "unreachable"; reason: string } | { kind: "refused"; status: number }

export async function peerHasRepo(cfg: PeerCfg, slug: string, d: PeerClientDeps): Promise<HasRepo> {
  const r = await call(cfg, `/api/resolver/has-repo?slug=${encodeURIComponent(slug)}`, d)
  if (r.kind === "unreachable") return r
  if (r.status !== 200 || r.json?.ok !== true) return { kind: "refused", status: r.status }
  return r.json.hasRepo === true ? { kind: "yes" } : { kind: "no" }
}

const unreachable = (reason: string): FixOutcome => ({ kind: "failed", error: `Mac unreachable (${reason})`, transient: true })

/** A job's outcome from the wire (anything malformed is a failure, never "pushed"). */
export function outcomeOf(v: unknown): FixOutcome | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const s = (k: string) => (typeof o[k] === "string" ? o[k] as string : "")
  if (o.kind === "pushed" && s("sha")) return { kind: "pushed", sha: s("sha"), summary: s("summary") }
  if (o.kind === "no_changes") return { kind: "no_changes", summary: s("summary") }
  if (o.kind === "blocked") return { kind: "blocked", reason: s("reason") || "blocked on the Mac" }
  if (o.kind === "failed") return { kind: "failed", error: s("error") || "failed on the Mac", ...(o.transient === true ? { transient: true } : {}) }
  return null
}

/**
 * Run a fix job on the peer: POST it, then poll until it is done or the
 * deadline passes. Peer down (at the start, or for the whole tail of the run)
 * → failed + transient "Mac unreachable"; a malformed answer → failed.
 */
export async function runFixOnPeer(cfg: PeerCfg, req: PeerFixRequest, d: PeerClientDeps): Promise<FixOutcome> {
  const now = d.now ?? Date.now
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + req.timeoutMs + POLL_GRACE_MS
  const started = await call(cfg, "/api/resolver/fix", d, { method: "POST", body: req })
  if (started.kind === "unreachable") return unreachable(started.reason)
  if (started.status !== 200 && started.status !== 202) {
    const err = typeof started.json?.error === "string" ? started.json.error : `http ${started.status}`
    return { kind: "failed", error: `the Mac refused the fix job: ${err}` }
  }
  const jobId = typeof started.json?.jobId === "string" ? started.json.jobId : ""
  if (!jobId) return { kind: "failed", error: "the Mac answered without a job id" }
  let last: Record<string, unknown> | null = started.json
  let lost: string | null = null
  while (true) {
    if (last?.status === "done") return outcomeOf(last.outcome) ?? { kind: "failed", error: "the Mac's fix outcome was malformed" }
    if (now() >= deadline) return lost ? unreachable(`lost contact during the fix run: ${lost}`) : { kind: "failed", error: "the Mac's fix run did not finish in time" }
    await sleep(d.pollMs ?? POLL_MS)
    const r = await call(cfg, `/api/resolver/fix/${encodeURIComponent(jobId)}`, d)
    if (r.kind === "unreachable") { lost = r.reason; last = null; continue }
    if (r.status === 404) return { kind: "failed", error: "the Mac lost the fix job", transient: true }
    if (r.status !== 200) { lost = `http ${r.status}`; last = null; continue }
    lost = null
    last = r.json
  }
}
