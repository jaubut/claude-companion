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
