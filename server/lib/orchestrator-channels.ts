import { db } from "./orchestrator-db"
import type { TaskStatus } from "./orchestrator-chat"

// ---- channels (PRJ-OR1T Phase 6) ------------------------------------------

// Trust ramp (Phase 7): how this channel's proposals have fared. approved = the
// user (or auto mode) let it run; rejected = tapped reject; streak = consecutive
// approvals since the last reject, newest first. eligible flags a streak long
// enough that the client may suggest auto-dispatch — the server never flips it.
export interface ChannelTrust {
  approved: number
  rejected: number
  streak: number
  eligible: boolean
}

export const AUTO_ELIGIBLE_STREAK = 5

export interface Channel {
  id: string
  name: string
  cwd: string | null
  createdAt: number
  archived: boolean
  autoDispatch: boolean
  trust: ChannelTrust
}

interface ChannelRow {
  id: string
  name: string
  cwd: string | null
  created_at: number
  archived: number
  auto_dispatch: number
}

// Proposals are the tasks that carry brain reasoning; manual /dispatch tasks
// don't count toward trust because the user never had a proposal to judge.
export function channelTrust(threadId: string): ChannelTrust {
  const rows = db
    .query(
      // rowid breaks same-millisecond ties so the streak walks true insertion order.
      "SELECT status FROM orchestrator_tasks WHERE thread_id = ? AND reasoning IS NOT NULL AND status != 'proposed' ORDER BY created_at DESC, rowid DESC LIMIT 200",
    )
    .all(threadId) as { status: TaskStatus }[]
  let approved = 0
  let rejected = 0
  let streak = 0
  let streakOpen = true
  for (const r of rows) {
    if (r.status === "rejected") {
      rejected++
      streakOpen = false
    } else {
      approved++
      if (streakOpen) streak++
    }
  }
  return { approved, rejected, streak, eligible: streak >= AUTO_ELIGIBLE_STREAK }
}

function toChannel(r: ChannelRow): Channel {
  return {
    id: r.id, name: r.name, cwd: r.cwd, createdAt: r.created_at, archived: !!r.archived,
    autoDispatch: !!r.auto_dispatch, trust: channelTrust(r.id),
  }
}

// Flip a channel's auto-dispatch. Returns the updated channel, null if unknown.
export function setChannelAuto(id: string, enabled: boolean): Channel | null {
  db.query("UPDATE orchestrator_channels SET auto_dispatch = ? WHERE id = ?").run(enabled ? 1 : 0, id)
  return getChannel(id)
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "channel"
}

export function listChannels(): Channel[] {
  const rows = db
    .query("SELECT * FROM orchestrator_channels WHERE archived = 0 ORDER BY created_at ASC")
    .all() as ChannelRow[]
  return rows.map(toChannel)
}

export function getChannel(id: string): Channel | null {
  const row = db.query("SELECT * FROM orchestrator_channels WHERE id = ?").get(id) as ChannelRow | null
  return row ? toChannel(row) : null
}

// Create a user-defined channel. The id is a slug of the name, disambiguated with
// a -N suffix on collision so two "TLS Dashboard" channels can coexist.
export function createChannel(name: string, cwd: string | null = null): Channel {
  const base = slugify(name)
  let id = base
  for (let n = 2; getChannel(id); n++) id = `${base}-${n}`
  const ch: Channel = {
    id, name: name.trim(), cwd: cwd?.trim() || null, createdAt: Date.now(), archived: false,
    autoDispatch: false, trust: { approved: 0, rejected: 0, streak: 0, eligible: false },
  }
  db.query("INSERT INTO orchestrator_channels (id, name, cwd, created_at, archived, auto_dispatch) VALUES (?, ?, ?, ?, 0, 0)").run(
    ch.id, ch.name, ch.cwd, ch.createdAt,
  )
  return ch
}

// A system channel with a fixed id (e.g. the Body monitor's "body"). Created
// once; an existing row with that id is reused as-is, even if archived.
export function ensureChannel(id: string, name: string): { channel: Channel; created: boolean } {
  const res = db.query("INSERT OR IGNORE INTO orchestrator_channels (id, name, cwd, created_at, archived, auto_dispatch) VALUES (?, ?, NULL, ?, 0, 0)").run(
    id, name, Date.now(),
  )
  return { channel: getChannel(id)!, created: res.changes > 0 }
}
