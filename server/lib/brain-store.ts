import { db } from "./orchestrator-db"

// brain-v2 persistence (companion.db, beside the orchestrator tables): the
// delivery outbox, a small kv, the voice-consent claims and the propose dedupe.
// Owner: wiring/brain.ts + routes/brain.ts; nothing else writes these tables.
//
// Outbox states: queued (persisted, not typed yet) → typed (in the brain's
// input, waiting for its Stop) → cleared on that Stop. `maybe` = the inject
// said not_submitted: the text may already sit in the input box, so it is
// never retyped into that session; only a fresh session's boot seed cites it.

db.exec(`
  CREATE TABLE IF NOT EXISTS brain_outbox (
    turn_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brain_kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brain_consent (
    turn_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brain_proposals (
    source_turn_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (source_turn_id, prompt_hash)
  );
  CREATE TABLE IF NOT EXISTS brain_handoffs (
    task_id TEXT PRIMARY KEY,
    source_turn_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    note_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    repo TEXT,
    origin TEXT NOT NULL,
    claim TEXT,
    synced INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL,
    UNIQUE (source_turn_id, request_hash)
  );
  CREATE TABLE IF NOT EXISTS brain_sync_outbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    task_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`)

export type OutboxState = "queued" | "typed" | "maybe"

export interface OutboxRow { turnId: string; state: OutboxState; createdAt: number }

/** Persist a turn for the brain. A turn already in the outbox keeps its state. */
export function enqueueDelivery(turnId: string, now = Date.now()): void {
  db.query("INSERT OR IGNORE INTO brain_outbox (turn_id, state, created_at, updated_at) VALUES (?, 'queued', ?, ?)").run(turnId, now, now)
}

/** Turns waiting to be typed, oldest first. */
export function takeDeliveries(): string[] {
  return (db.query("SELECT turn_id FROM brain_outbox WHERE state = 'queued' ORDER BY created_at ASC, rowid ASC").all() as { turn_id: string }[]).map((r) => r.turn_id)
}

/** Every open turn (any state), oldest first: what a fresh session's boot seed cites. */
export function openDeliveries(): OutboxRow[] {
  return (db.query("SELECT turn_id, state, created_at FROM brain_outbox ORDER BY created_at ASC, rowid ASC").all() as { turn_id: string; state: OutboxState; created_at: number }[])
    .map((r) => ({ turnId: r.turn_id, state: r.state, createdAt: r.created_at }))
}

function setState(ids: string[], state: OutboxState, now: number): void {
  const q = db.query("UPDATE brain_outbox SET state = ?, updated_at = ? WHERE turn_id = ?")
  for (const id of ids) q.run(state, now, id)
}

/** Typed into the brain's input and submitted. */
export function markDelivered(ids: string[], now = Date.now()): void {
  setState(ids, "typed", now)
}

/** A boot seed or preempted turn that couldn't finish these: back in line, even if clearTyped() already deleted the row. */
export function requeueDeliveries(ids: string[], now = Date.now()): void {
  const upd = db.query("UPDATE brain_outbox SET state = 'queued', updated_at = ? WHERE turn_id = ?")
  const turnTs = db.query("SELECT created_at FROM orchestrator_turns WHERE id = ?")
  const ins = db.query("INSERT OR IGNORE INTO brain_outbox (turn_id, state, created_at, updated_at) VALUES (?, 'queued', ?, ?)")
  for (const id of ids) {
    const res = upd.run(now, id)
    if (res.changes === 0) {
      const createdAt = (turnTs.get(id) as { created_at: number } | null)?.created_at ?? now
      ins.run(id, createdAt, now)
    }
  }
}

/** Re-queue all currently typed deliveries in-place back to 'queued' without deleting them. Returns their ids. */
export function requeueTyped(now = Date.now()): string[] {
  const ids = (db.query("SELECT turn_id FROM brain_outbox WHERE state = 'typed' ORDER BY created_at ASC, rowid ASC").all() as { turn_id: string }[]).map((r) => r.turn_id)
  if (ids.length > 0) {
    db.query("UPDATE brain_outbox SET state = 'queued', updated_at = ? WHERE state = 'typed'").run(now)
  }
  return ids
}

/** not_submitted: never retyped into the same session. */
export function markMaybe(ids: string[], now = Date.now()): void {
  setState(ids, "maybe", now)
}

/** The brain's Stop answered what was typed: those turns leave the outbox. Returns their ids. */
export function clearTyped(): string[] {
  const ids = (db.query("SELECT turn_id FROM brain_outbox WHERE state = 'typed'").all() as { turn_id: string }[]).map((r) => r.turn_id)
  db.query("DELETE FROM brain_outbox WHERE state = 'typed'").run()
  return ids
}

/** Remove queued system event turns dismissed by stateless ops triage (never deletes typed turns). */
export function dismissDeliveries(ids: string[]): void {
  const q = db.query("DELETE FROM brain_outbox WHERE turn_id = ? AND state = 'queued'")
  for (const id of ids) q.run(id)
}

export function getKv(k: string): string | null {
  return (db.query("SELECT v FROM brain_kv WHERE k = ?").get(k) as { v: string } | null)?.v ?? null
}

export function setKv(k: string, v: string): void {
  db.query("INSERT INTO brain_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v)
}

/** The proposal already created for (source turn, prompt hash), if any. */
export function proposeSeen(sourceTurnId: string, promptHash: string): string | null {
  return (db.query("SELECT proposal_id FROM brain_proposals WHERE source_turn_id = ? AND prompt_hash = ?").get(sourceTurnId, promptHash) as { proposal_id: string } | null)?.proposal_id ?? null
}

export function rememberPropose(sourceTurnId: string, promptHash: string, proposalId: string, now = Date.now()): void {
  db.query("INSERT OR IGNORE INTO brain_proposals (source_turn_id, prompt_hash, proposal_id, at) VALUES (?, ?, ?, ?)").run(sourceTurnId, promptHash, proposalId, now)
}

/** The brain proposal behind a local proposal id → the turn it answered (trace parent). */
export function proposalTurnOf(proposalId: string): string | null {
  return (db.query("SELECT source_turn_id FROM brain_proposals WHERE proposal_id = ?").get(proposalId) as { source_turn_id: string } | null)?.source_turn_id ?? null
}

export function proposeSeenById(proposalId: string): string | null {
  return (db.query("SELECT proposal_id FROM brain_proposals WHERE proposal_id = ? LIMIT 1").get(proposalId) as { proposal_id: string } | null)?.proposal_id ?? null
}

export interface LocalHandoffRow {
  taskId: string
  sourceTurnId: string
  requestHash: string
  noteId: string
  title: string
  prompt: string
  reasoning: string
  repo: string | null
  origin: "jeremie" | "unknown"
  claim: string | null
  synced: boolean
  at: number
}

interface RawHandoffRow {
  task_id: string
  source_turn_id: string
  request_hash: string
  note_id: string
  title: string
  prompt: string
  reasoning: string
  repo: string | null
  origin: string
  claim: string | null
  synced: number
  at: number
}

function toHandoffRow(r: RawHandoffRow): LocalHandoffRow {
  return {
    taskId: r.task_id,
    sourceTurnId: r.source_turn_id,
    requestHash: r.request_hash,
    noteId: r.note_id,
    title: r.title,
    prompt: r.prompt,
    reasoning: r.reasoning,
    repo: r.repo ?? null,
    origin: r.origin === "jeremie" ? "jeremie" : "unknown",
    claim: r.claim ?? null,
    synced: r.synced === 1,
    at: r.at,
  }
}

export function handoffSeen(taskId: string, sourceTurnId?: string, requestHash?: string): LocalHandoffRow | null {
  const byId = db.query("SELECT * FROM brain_handoffs WHERE task_id = ? LIMIT 1").get(taskId) as RawHandoffRow | null
  if (byId) return toHandoffRow(byId)
  if (sourceTurnId && requestHash) {
    const byHash = db
      .query("SELECT * FROM brain_handoffs WHERE source_turn_id = ? AND request_hash = ? LIMIT 1")
      .get(sourceTurnId, requestHash) as RawHandoffRow | null
    if (byHash) return toHandoffRow(byHash)
  }
  return null
}

export function rememberHandoff(row: LocalHandoffRow): void {
  db.query(
    "INSERT OR IGNORE INTO brain_handoffs (task_id, source_turn_id, request_hash, note_id, title, prompt, reasoning, repo, origin, claim, synced, at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.taskId,
    row.sourceTurnId,
    row.requestHash,
    row.noteId,
    row.title,
    row.prompt,
    row.reasoning,
    row.repo,
    row.origin,
    row.claim,
    row.synced ? 1 : 0,
    row.at,
  )
}

export function updateHandoff(
  taskId: string,
  patch: { origin?: "jeremie" | "unknown"; claim?: string | null; synced?: boolean; noteId?: string },
): void {
  const cur = handoffSeen(taskId)
  if (!cur) return
  db.query("UPDATE brain_handoffs SET origin = ?, claim = ?, synced = ?, note_id = ? WHERE task_id = ?").run(
    patch.origin ?? cur.origin,
    patch.claim !== undefined ? patch.claim : cur.claim,
    (patch.synced ?? cur.synced) ? 1 : 0,
    patch.noteId ?? cur.noteId,
    taskId,
  )
}

export function removeHandoff(taskId: string): void {
  db.query("DELETE FROM brain_handoffs WHERE task_id = ?").run(taskId)
}

/** True when Companion recorded this handoff locally and its background tls-sqld sync is still in flight. */
export function isLocalHandoffPendingSync(taskId: string): boolean {
  const row = handoffSeen(taskId)
  return !!row && !row.synced
}

export interface SyncOutboxRow {
  id: string
  kind: "handoff" | "propose"
  taskId: string
  payload: Record<string, unknown>
  state: "pending" | "synced" | "failed"
  attempts: number
  nextRetryAt: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

interface RawSyncOutboxRow {
  id: string
  kind: "handoff" | "propose"
  task_id: string
  payload: string
  state: "pending" | "synced" | "failed"
  attempts: number
  next_retry_at: number
  last_error: string | null
  created_at: number
  updated_at: number
}

function toSyncOutboxRow(r: RawSyncOutboxRow): SyncOutboxRow {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(r.payload) as Record<string, unknown>
  } catch { /* ignore */ }
  return {
    id: r.id,
    kind: r.kind,
    taskId: r.task_id,
    payload,
    state: r.state,
    attempts: r.attempts,
    nextRetryAt: r.next_retry_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function enqueueSyncOutbox(
  input: { id: string; kind: "handoff" | "propose"; taskId: string; payload: Record<string, unknown> },
  now = Date.now(),
): void {
  db.query(
    "INSERT OR IGNORE INTO brain_sync_outbox (id, kind, task_id, payload, state, attempts, next_retry_at, last_error, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?)",
  ).run(input.id, input.kind, input.taskId, JSON.stringify(input.payload), now, now)
}

export function getSyncOutboxItem(id: string): SyncOutboxRow | null {
  const r = db.query("SELECT * FROM brain_sync_outbox WHERE id = ?").get(id) as RawSyncOutboxRow | null
  return r ? toSyncOutboxRow(r) : null
}

export function listPendingSyncOutbox(now = Date.now()): SyncOutboxRow[] {
  return (
    db
      .query("SELECT * FROM brain_sync_outbox WHERE state = 'pending' AND next_retry_at <= ? ORDER BY created_at ASC, rowid ASC")
      .all(now) as RawSyncOutboxRow[]
  ).map(toSyncOutboxRow)
}

export function markSyncOutboxDone(id: string, now = Date.now()): void {
  db.query("UPDATE brain_sync_outbox SET state = 'synced', last_error = NULL, updated_at = ? WHERE id = ?").run(now, id)
}

export function markSyncOutboxRetry(id: string, error: string, delayMs: number, now = Date.now()): void {
  db.query(
    "UPDATE brain_sync_outbox SET attempts = attempts + 1, last_error = ?, next_retry_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
  ).run(error.slice(0, 300), now + delayMs, now, id)
}

export function markSyncOutboxFailed(id: string, error: string, now = Date.now()): void {
  db.query("UPDATE brain_sync_outbox SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 300), now, id)
}

export function removeSyncOutbox(id: string): void {
  db.query("DELETE FROM brain_sync_outbox WHERE id = ?").run(id)
}
