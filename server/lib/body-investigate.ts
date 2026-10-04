import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Body auto-investigation (living-system nervous system): policy + store.
// A component that goes dead / crash_loop / failing gets ONE read-only
// headless investigation on the host that owns it, with no tap. Any fix comes
// back as a #Body proposal card; the investigator never mutates anything.
// This module is pure policy (gate, routing, kill switch) plus the sqlite
// record store (injected Database, so tests use :memory:). The engine is
// wiring/body-investigate.ts; the claude -p runner is lib/body-investigator.ts.

export const PROBLEM_STATES = ["dead", "crash_loop", "failing"] as const
export const COOLDOWN_MS = 12 * 60 * 60_000
export const RETRY_MS = 10 * 60_000
export const FORWARD_STALE_MS = 30 * 60_000
export const MAX_CONCURRENT = 3
export const MAX_PER_DAY = 10
export const MAX_ATTEMPTS = 2
const DAY_MS = 24 * 60 * 60_000

export type BodyHost = "mac" | "zettlab"
export type InvestigationStatus = "running" | "pending_host" | "forwarded" | "done" | "failed" | "dropped"
export const OPEN_STATUSES: readonly InvestigationStatus[] = ["running", "pending_host", "forwarded"]

export interface RecommendedFix {
  summary: string
  steps: string[]
  risk: "low" | "med" | "high"
  reversible: boolean
}

export interface InvestigationResult {
  rootCause: string
  evidence: string[]
  confidence: number
  severity: "low" | "med" | "high" | "critical"
  recommendedFix: RecommendedFix | null
  retire: boolean
  notes: string
}

export interface InvestigationRecord {
  id: string
  componentId: string
  host: string
  state: string
  fromState: string | null
  trigger: string
  status: InvestigationStatus
  runOn: string
  attempt: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  result: InvestigationResult | null
  error: string | null
  proposalId: string | null
  reported: boolean
  peerId: string | null
}

// ── Kill switch + host identity ──────────────────────────────────────────────

export function disabledFlagPath(home: string = homedir()): string {
  return join(home, ".claude-companion", ".body-investigate-disabled")
}

/** Off when the flag file exists or COMPANION_BODY_INVESTIGATE=0. Read on every decision. */
export function investigateEnabled(
  env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync, home: string = homedir(),
): boolean {
  if (env.COMPANION_BODY_INVESTIGATE?.trim() === "0") return false
  return !exists(disabledFlagPath(home))
}

export function localBodyHost(env: Record<string, string | undefined> = process.env, platform: string = process.platform): BodyHost {
  const v = env.COMPANION_BODY_HOST?.trim().toLowerCase()
  if (v === "mac" || v === "zettlab") return v
  return platform === "darwin" ? "mac" : "zettlab"
}

/** The host whose Companion investigates this component (cloud probes run on Zettlab). */
export function ownerHost(componentHost: string | null | undefined): BodyHost | null {
  const h = (componentHost ?? "").trim().toLowerCase()
  if (h === "mac") return "mac"
  if (h === "zettlab" || h === "cloud") return "zettlab"
  return null
}

/** `mac:launchd:x` → "mac"; null when the id carries no known host prefix. */
export function hostFromId(componentId: string): string | null {
  const p = componentId.split(":")[0]?.toLowerCase() ?? ""
  return p === "mac" || p === "zettlab" || p === "cloud" ? p : null
}

export type Route = "local" | "forward" | "not_owner"

/** Run here, forward to the Mac (Zettlab only), or leave it to its owner. */
export function routeFor(componentHost: string | null | undefined, local: BodyHost): Route {
  const owner = ownerHost(componentHost)
  if (!owner) return "not_owner"
  if (owner === local) return "local"
  return local === "zettlab" && owner === "mac" ? "forward" : "not_owner"
}

export function isProblemState(state: string | null | undefined): boolean {
  return (PROBLEM_STATES as readonly string[]).includes(state ?? "")
}

// ── Store ────────────────────────────────────────────────────────────────────

interface Row {
  id: string
  component_id: string
  host: string
  state: string
  from_state: string | null
  trigger: string
  status: InvestigationStatus
  run_on: string
  attempt: number
  created_at: number
  started_at: number | null
  finished_at: number | null
  result_json: string | null
  error: string | null
  proposal_id: string | null
  reported: number
  peer_id: string | null
}

function toRecord(r: Row): InvestigationRecord {
  let result: InvestigationResult | null = null
  try { result = r.result_json ? (JSON.parse(r.result_json) as InvestigationResult) : null } catch { result = null }
  return {
    id: r.id, componentId: r.component_id, host: r.host, state: r.state, fromState: r.from_state, trigger: r.trigger,
    status: r.status, runOn: r.run_on, attempt: r.attempt, createdAt: r.created_at, startedAt: r.started_at,
    finishedAt: r.finished_at, result, error: r.error, proposalId: r.proposal_id, reported: r.reported === 1, peerId: r.peer_id,
  }
}

export interface NewRecord {
  id?: string
  componentId: string
  host: string
  state: string
  fromState?: string | null
  trigger: string
  status: InvestigationStatus
  runOn: string
  attempt: number
  startedAt?: number | null
  peerId?: string | null
}

export type RecordPatch = Partial<Pick<InvestigationRecord, "status" | "startedAt" | "finishedAt" | "result" | "error" | "proposalId" | "reported" | "peerId" | "runOn" | "attempt">>

const COLS: Record<keyof RecordPatch, string> = {
  status: "status", startedAt: "started_at", finishedAt: "finished_at", result: "result_json", error: "error",
  proposalId: "proposal_id", reported: "reported", peerId: "peer_id", runOn: "run_on", attempt: "attempt",
}

export interface InvestigationStore {
  insert(rec: NewRecord, now: number): InvestigationRecord
  update(id: string, patch: RecordPatch): InvestigationRecord | null
  get(id: string): InvestigationRecord | null
  byPeerId(peerId: string): InvestigationRecord | null
  open(componentId: string): InvestigationRecord | null
  latest(componentId: string): InvestigationRecord | null
  /** Latest done/failed (dropped is not a verdict). */
  latestFinished(componentId: string): InvestigationRecord | null
  /** Consecutive `failed` for this component+state since its last `done`. */
  consecutiveFailures(componentId: string, state: string): number
  countRunningLocal(): number
  countStartedLocalSince(since: number): number
  listOpen(): InvestigationRecord[]
  listRecent(since: number, limit?: number): InvestigationRecord[]
  /** Boot: a `running` row has no process any more. Returns the ids closed. */
  closeInterrupted(now: number): string[]
}

export function createInvestigationStore(db: Database): InvestigationStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS body_investigations (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      host TEXT NOT NULL,
      state TEXT NOT NULL,
      from_state TEXT,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      run_on TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      result_json TEXT,
      error TEXT,
      proposal_id TEXT,
      reported INTEGER NOT NULL DEFAULT 0,
      peer_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_body_inv_component ON body_investigations (component_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_body_inv_status ON body_investigations (status);
  `)
  const one = (sql: string, ...args: (string | number)[]): InvestigationRecord | null => {
    const r = db.query(sql).get(...args) as Row | null
    return r ? toRecord(r) : null
  }
  const openList = OPEN_STATUSES.map((s) => `'${s}'`).join(", ")

  const store: InvestigationStore = {
    insert(rec, now) {
      const id = rec.id ?? randomUUID().slice(0, 8)
      db.query(
        "INSERT INTO body_investigations (id, component_id, host, state, from_state, trigger, status, run_on, attempt, created_at, started_at, peer_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, rec.componentId, rec.host, rec.state, rec.fromState ?? null, rec.trigger, rec.status, rec.runOn, rec.attempt, now, rec.startedAt ?? null, rec.peerId ?? null)
      return store.get(id)!
    },
    update(id, patch) {
      const sets: string[] = []
      const args: (string | number | null)[] = []
      for (const [k, v] of Object.entries(patch) as [keyof RecordPatch, unknown][]) {
        if (v === undefined) continue
        sets.push(`${COLS[k]} = ?`)
        if (k === "result") args.push(v ? JSON.stringify(v) : null)
        else if (k === "reported") args.push(v ? 1 : 0)
        else args.push(v as string | number | null)
      }
      if (sets.length) db.query(`UPDATE body_investigations SET ${sets.join(", ")} WHERE id = ?`).run(...args, id)
      return store.get(id)
    },
    get: (id) => one("SELECT * FROM body_investigations WHERE id = ?", id),
    byPeerId: (peerId) => one("SELECT * FROM body_investigations WHERE peer_id = ? ORDER BY created_at DESC LIMIT 1", peerId),
    open: (cid) => one(`SELECT * FROM body_investigations WHERE component_id = ? AND status IN (${openList}) ORDER BY created_at DESC, rowid DESC LIMIT 1`, cid),
    latest: (cid) => one("SELECT * FROM body_investigations WHERE component_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", cid),
    latestFinished: (cid) =>
      one("SELECT * FROM body_investigations WHERE component_id = ? AND status IN ('done', 'failed') ORDER BY COALESCE(finished_at, created_at) DESC, rowid DESC LIMIT 1", cid),
    consecutiveFailures(cid, state) {
      const rows = db
        .query("SELECT status, state FROM body_investigations WHERE component_id = ? AND status IN ('done', 'failed') ORDER BY COALESCE(finished_at, created_at) DESC, rowid DESC LIMIT 10")
        .all(cid) as { status: string; state: string }[]
      let n = 0
      for (const r of rows) {
        if (r.status !== "failed" || r.state !== state) break
        n++
      }
      return n
    },
    countRunningLocal: () => (db.query("SELECT COUNT(*) AS n FROM body_investigations WHERE status = 'running' AND run_on = 'local'").get() as { n: number }).n,
    countStartedLocalSince: (since) =>
      (db.query("SELECT COUNT(*) AS n FROM body_investigations WHERE run_on = 'local' AND started_at IS NOT NULL AND started_at >= ?").get(since) as { n: number }).n,
    listOpen: () => (db.query(`SELECT * FROM body_investigations WHERE status IN (${openList}) ORDER BY created_at ASC`).all() as Row[]).map(toRecord),
    listRecent: (since, limit = 20) =>
      (db.query("SELECT * FROM body_investigations WHERE COALESCE(finished_at, created_at) >= ? ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?").all(since, limit) as Row[]).map(toRecord),
    closeInterrupted(now) {
      const ids = (db.query("SELECT id FROM body_investigations WHERE status = 'running'").all() as { id: string }[]).map((r) => r.id)
      for (const id of ids) store.update(id, { status: "failed", finishedAt: now, error: "companion restarted mid-investigation" })
      return ids
    },
  }
  return store
}

// ── Gate (pure over the store) ───────────────────────────────────────────────

export interface Candidate {
  componentId: string
  state: string
  /** Set by the alert path; a value ≠ state is a real transition and breaks the cooldown. */
  fromState?: string | null
}

export type GateVerdict =
  | { ok: true; attempt: number; retry: InvestigationRecord | null }
  | { ok: false; reason: string; open?: InvestigationRecord }

/**
 * May this component be investigated now? `budget` is checked only for local
 * runs (a forward spends the owner's budget, not ours). A `pending_host`
 * record is handed back as `retry` so the caller re-forwards it.
 */
export function gate(store: InvestigationStore, c: Candidate, now: number, opts: { budget: boolean }): GateVerdict {
  if (!isProblemState(c.state)) return { ok: false, reason: "not a problem state" }
  const open = store.open(c.componentId)
  if (open) {
    if (open.status === "pending_host" && !opts.budget) return { ok: true, attempt: open.attempt, retry: open }
    return { ok: false, reason: `open (${open.status})`, open }
  }
  const transition = !!c.fromState && c.fromState !== c.state
  const last = store.latestFinished(c.componentId)
  let attempt = 1
  if (last && last.state === c.state && !transition) {
    const since = now - (last.finishedAt ?? last.createdAt)
    const fails = store.consecutiveFailures(c.componentId, c.state)
    if (last.status === "done" && since < COOLDOWN_MS) return { ok: false, reason: "cooldown" }
    if (last.status === "failed") {
      if (fails >= MAX_ATTEMPTS && since < COOLDOWN_MS) return { ok: false, reason: "cooldown (failed twice)" }
      if (since < RETRY_MS) return { ok: false, reason: "retry later" }
      attempt = fails >= MAX_ATTEMPTS ? 1 : fails + 1
    }
  }
  if (opts.budget) {
    if (store.countRunningLocal() >= MAX_CONCURRENT) return { ok: false, reason: "busy (3 running)" }
    if (store.countStartedLocalSince(now - DAY_MS) >= MAX_PER_DAY) return { ok: false, reason: "daily budget spent (10/24h)" }
  }
  return { ok: true, attempt, retry: null }
}

// ── Wire shapes ──────────────────────────────────────────────────────────────

export interface InvestigationDto {
  id: string
  status: InvestigationStatus
  startedAt: string | null
  finishedAt: string | null
  rootCause: string | null
  confidence: number | null
  severity: string | null
  proposalId: string | null
  error: string | null
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString())

export function investigationDto(r: InvestigationRecord | null): InvestigationDto | null {
  if (!r) return null
  return {
    id: r.id, status: r.status, startedAt: iso(r.startedAt ?? r.createdAt), finishedAt: iso(r.finishedAt),
    rootCause: r.result?.rootCause ?? null, confidence: r.result?.confidence ?? null, severity: r.result?.severity ?? null,
    proposalId: r.proposalId, error: r.error,
  }
}

/** A report a host sends to the #Body owner (and applies itself when it owns #Body). */
export interface InvestigationReport {
  id: string
  componentId: string
  host: string
  state: string
  status: "done" | "failed"
  attempt: number
  startedAt: number | null
  finishedAt: number
  runOn: string
  result: InvestigationResult | null
  error: string | null
  cwd: string | null
  repo: boolean
}

// ── Brain digest ─────────────────────────────────────────────────────────────

export const INVESTIGATION_DIGEST_MAX = 700
const RECENT_MS = 48 * 60 * 60_000

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…"
}

function digestLine(r: InvestigationRecord): string {
  if (r.status === "running" || r.status === "forwarded") return `- ${r.componentId} (${r.state}): investigating${r.status === "forwarded" ? " on the mac" : ""}`
  if (r.status === "pending_host") return `- ${r.componentId} (${r.state}): waiting for its host to be reachable`
  if (r.status === "failed") return `- ${r.componentId} (${r.state}): investigation failed — ${clip(r.error ?? "unknown error", 80)}`
  const res = r.result
  const pct = res ? ` (${Math.round(res.confidence * 100)}%)` : ""
  const fix = r.proposalId ? ` · fix proposed [${r.proposalId}]` : res?.recommendedFix ? "" : " · no fix proposed"
  return `- ${r.componentId} (${r.state}): ${clip(res?.rootCause ?? "no root cause", 140)}${pct}${fix}`
}

/** Open + last-48 h investigations (latest per component), ≤ 700 chars; null when none. */
export function investigationDigest(store: InvestigationStore, now: number, max = INVESTIGATION_DIGEST_MAX): string | null {
  const seen = new Set<string>()
  const rows: InvestigationRecord[] = []
  for (const r of [...store.listOpen(), ...store.listRecent(now - RECENT_MS, 30)]) {
    if (seen.has(r.componentId) || r.status === "dropped") continue
    seen.add(r.componentId)
    rows.push(r)
  }
  if (!rows.length) return null
  const lines = ["Body investigations (read-only diagnoses of dead/failing components; fixes wait for a tap):"]
  let used = lines[0]!.length
  let shown = 0
  for (const r of rows) {
    const line = digestLine(r)
    if (used + line.length + 1 > max - 20) break
    lines.push(line)
    used += line.length + 1
    shown++
  }
  if (shown < rows.length) lines.push(`(+${rows.length - shown} more)`)
  return lines.join("\n")
}
