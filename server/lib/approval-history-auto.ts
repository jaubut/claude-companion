import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { companionLog } from "./log"
import { capDetail, capSummary, historyDb, type AutoState } from "./approval-history"
import { summarize } from "./tool-format"

// Auto-decision audit rows for the approval history: every SUPER allow,
// auto-judge allow/deny, learned allow and read-only MCP allow becomes an
// `auto_allowed` / `auto_denied` row (resolved_at = created_at).
//
// ~800+/day on a busy host, so the hook path only pushes onto an in-memory
// buffer: redaction, caps and the sqlite write happen later, in ONE transaction
// per flush (every FLUSH_MS, or soon after FLUSH_ROWS rows pile up). A write
// error drops that batch and is logged at most once per minute — the history
// is a record, never a gate, and never throws into a hook.
//
// Auto rows are pruned after COMPANION_HISTORY_AUTO_DAYS (default 30) days;
// phone rows are permanent.

export type AutoVia = "super" | "auto_judge" | "learned" | "mcp_readonly"

export interface AutoDecision {
  agent: string
  tool: string
  input: Record<string, unknown>
  cwd: string
  sessionId: string
  sessionKey: string
  decision: "allow" | "deny"
  via: AutoVia
  reason?: string
  toolUseId?: string
}

interface Buffered { d: AutoDecision; id: string; at: string }

export const FLUSH_MS = 250
export const FLUSH_ROWS = 50
const ERROR_LOG_EVERY_MS = 60_000
const DAY_MS = 86_400_000

let buffer: Buffered[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let lastErrorLog = 0
const stats = { transactions: 0, rows: 0, dropped: 0 }

type FlushListener = (count: number, firstAt: string) => void
const flushListeners = new Set<FlushListener>()

// Called after every successful flush with how many auto rows it wrote.
export function onAutoHistoryFlush(fn: FlushListener): () => void {
  flushListeners.add(fn)
  return () => flushListeners.delete(fn)
}

// Hook-path entry point: O(1), no I/O, never throws.
export function recordAutoDecision(d: AutoDecision): void {
  try {
    buffer.push({ d, id: randomUUID(), at: new Date().toISOString() })
    schedule(buffer.length >= FLUSH_ROWS ? 0 : FLUSH_MS)
  } catch { /* never into the hook */ }
}

function schedule(ms: number): void {
  if (timer && ms > 0) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(flushAutoHistory, ms)
  ;(timer as { unref?: () => void }).unref?.()
}

function rowArgs(b: Buffered, host: string): Array<string> {
  const { d } = b
  const state: AutoState = d.decision === "allow" ? "auto_allowed" : "auto_denied"
  const detail = {
    agent: d.agent,
    input: d.input,
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.toolUseId ? { toolUseId: d.toolUseId } : {}),
  }
  const summary = summarize(d.tool, d.input) || d.tool
  return [b.id, state, d.tool, capSummary(summary), capDetail(detail), d.sessionKey, d.sessionId, d.cwd, host, d.via, b.at, b.at]
}

// Writes everything buffered in one transaction. Exported for tests/shutdown.
export function flushAutoHistory(): number {
  if (timer) { clearTimeout(timer); timer = null }
  const batch = buffer
  buffer = []
  if (batch.length === 0) return 0
  try {
    const db = historyDb()
    const host = hostname()
    const insert = db.query(`
      INSERT OR IGNORE INTO approval_history
        (id, kind, state, tool, summary, detail_json, session_key, session_id, cwd, host, decided_via, created_at, resolved_at)
      VALUES (?, 'approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    db.transaction(() => { for (const b of batch) insert.run(...rowArgs(b, host)) })()
    stats.transactions++
    stats.rows += batch.length
  } catch (err) {
    stats.dropped += batch.length
    logErrorThrottled(`write failed, ${batch.length} row(s) dropped — ${(err as Error).message}`)
    return 0
  }
  for (const fn of flushListeners) {
    try { fn(batch.length, batch[0]!.at) } catch { /* ignore */ }
  }
  return batch.length
}

function logErrorThrottled(msg: string): void {
  const now = Date.now()
  if (now - lastErrorLog < ERROR_LOG_EVERY_MS) return
  lastErrorLog = now
  companionLog(`\x1b[31mapproval history (auto)\x1b[0m ${msg}`)
}

// Test seam: flush counters, and a reset between cases.
export function autoHistoryStats(): { transactions: number; rows: number; dropped: number; buffered: number } {
  return { ...stats, buffered: buffer.length }
}
export function resetAutoHistoryForTests(): void {
  if (timer) { clearTimeout(timer); timer = null }
  buffer = []
  stats.transactions = 0; stats.rows = 0; stats.dropped = 0
  lastErrorLog = 0
}

// ── Retention: AUTO rows only ──

export function autoRetentionDays(): number {
  const n = Number(process.env.COMPANION_HISTORY_AUTO_DAYS)
  return Number.isFinite(n) && n > 0 ? n : 30
}

// Deletes auto rows created more than `days` days before `now`. Phone rows are
// never touched here.
export function pruneAutoHistory(days = autoRetentionDays(), now = Date.now()): number {
  const cutoff = new Date(now - days * DAY_MS).toISOString()
  return historyDb().query("DELETE FROM approval_history WHERE state IN ('auto_allowed', 'auto_denied') AND created_at < ?").run(cutoff).changes
}

let retention: ReturnType<typeof setInterval> | null = null

// First pass a minute after boot, then daily. Unref'd: never keeps a process up.
export function startAutoHistoryRetention(): void {
  if (retention) return
  const run = (): void => {
    try {
      const n = pruneAutoHistory()
      if (n > 0) companionLog(`approval history: pruned ${n} auto row(s) older than ${autoRetentionDays()}d`)
    } catch (err) { logErrorThrottled(`prune failed — ${(err as Error).message}`) }
  }
  const first = setTimeout(run, 60_000)
  ;(first as { unref?: () => void }).unref?.()
  retention = setInterval(run, DAY_MS)
  ;(retention as { unref?: () => void }).unref?.()
}

// ── WS throttle: at most one `approval_history_auto` frame per window ──

export interface AutoFrame { type: "approval_history_auto"; count: number; since: string }

// Accumulates flushed counts; sends at once when the window is free, else one
// trailing frame when it reopens. `since` = created_at of the oldest counted row.
export function createAutoFrameThrottle(send: (f: AutoFrame) => void, windowMs = 5000): (count: number, firstAt: string) => void {
  let count = 0
  let since = ""
  let lastSent = -Infinity
  let pending: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    pending = null
    if (count === 0) return
    lastSent = Date.now()
    const frame: AutoFrame = { type: "approval_history_auto", count, since }
    count = 0; since = ""
    try { send(frame) } catch { /* ignore */ }
  }
  return (n, firstAt) => {
    if (n <= 0) return
    count += n
    if (!since || firstAt < since) since = firstAt
    if (pending) return
    const wait = lastSent + windowMs - Date.now()
    if (wait <= 0) return fire()
    pending = setTimeout(fire, wait)
    ;(pending as { unref?: () => void }).unref?.()
  }
}
