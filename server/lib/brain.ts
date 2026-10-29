// brain-v2 (RES-QDHU) policy, pure: the one `brain` agent that plans,
// dispatches and follows up but never builds. The brain is a normal Claude
// Code session: its tool limits are its instructions (brain/CLAUDE.md), its
// .claude/settings.json and the normal permission flow (auto-judge → phone;
// SUPER never applies to it). What lives here is what the server decides:
// when the supervisor respawns it, when a voice turn counts as consent.
// wiring/brain.ts runs it.

/** The brain's thread id (orchestrator_turns.thread_id) and channel id. */
export const BRAIN_THREAD = "brain"
/** Its herdr agent name, Remote Control name and COMPANION_TASK_ID. */
export const BRAIN_AGENT = "brain"
/** Channel ids no user-created channel may take. */
export const RESERVED_CHANNELS: ReadonlySet<string> = new Set(["brain", "general", "body"])

/** inbox_entries.result_id of an archived 🧠 voice take: `brain:<turnId>` (never a Quick Capture memo). */
export const BRAIN_TAKE_PREFIX = "brain:"

export type BrainState = "up" | "starting" | "down" | "paused"

/** The brain runs on the host that sets COMPANION_BRAIN=1 (Zettlab) and nowhere else. */
export function brainEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.COMPANION_BRAIN?.trim() === "1"
}

/** A hook from the brain (its COMPANION_TASK_ID). Header first, then the registered session's. */
export function isBrainHook(taskId: string | null | undefined): boolean {
  return taskId === BRAIN_AGENT
}

/** Brain or a repo lead (P2: `lead-<repo>`): sessions the supervisor owns, never the global auto-compact's. */
export function isSupervisedTask(taskId: string | null | undefined): boolean {
  return taskId === BRAIN_AGENT || !!taskId?.startsWith("lead-")
}

// ── Delivery text ──

export interface DeliveryTurn { id: string; text: string; createdAt: number; card?: { kind: string } | null }

/** Cap of one typed delivery; the rest waits for the next Stop. */
export const DELIVERY_MAX = 4_000

/** Jeremie's queued turns as one prompt: `[turn <id>] (voice) text`, oldest first. */
export function deliveryText(turns: DeliveryTurn[]): string {
  const lines = turns.map((t) => `[turn ${t.id}]${t.card?.kind === "voice" ? " (voice)" : ""} ${t.text.replace(/\s+/g, " ").trim()}`)
  const text = lines.join("\n")
  return text.length > DELIVERY_MAX ? `${text.slice(0, DELIVERY_MAX - 1)}…` : text
}

/** First prompt of a fresh brain: memory first, then every turn still open. */
export function bootSeed(input: { memoryRef: string | null; open: DeliveryTurn[] }): string {
  const memory = input.memoryRef ? `Read your memory note ${input.memoryRef} first.` : "No memory note yet: create one (note_create, resources/) and keep its ref."
  const open = input.open.length
    ? `Open turns (answer each, cite its id):\n${deliveryText(input.open)}`
    : "No open turns."
  return `[boot] You were (re)started by the Companion supervisor. ${memory}\n${open}`
}

// ── Supervisor ──

export const TICK_MS = 15_000
export const RESTART_WINDOW_MS = 5 * 60_000
export const RESTARTS_MAX = 3
/** How long a spawn may take to register its session before it counts as failed. */
export const START_GRACE_MS = 60_000
/** No hook from the brain for this long while a delivery is in flight → the turn is considered lost. */
export const BUSY_MAX_MS = 10 * 60_000
/** Claude Code reports the brain idle this long after the last hook while a delivery is in flight → its Stop was lost: read the reply from the transcript. */
export const TURN_END_GRACE_MS = 30_000

export interface SuperviseInput {
  paused: boolean
  alive: boolean
  state: BrainState
  /** When the last spawn started (0 = none in flight). */
  spawnedAt: number
  /** Spawn times inside the restart window. */
  restarts: number[]
  now: number
}

export type SuperviseAction = "none" | "stop" | "spawn"

/** One supervisor tick: paused wins, a live agent is up, else respawn within RESTARTS_MAX per window, else down until a manual restart. */
export function superviseStep(i: SuperviseInput): { state: BrainState; action: SuperviseAction; restarts: number[] } {
  const restarts = i.restarts.filter((t) => i.now - t < RESTART_WINDOW_MS)
  if (i.paused) return { state: "paused", action: i.alive ? "stop" : "none", restarts }
  if (i.alive) return { state: i.state === "starting" ? "starting" : "up", action: "none", restarts }
  // Down is sticky: only a manual resume / restart brings it back (they reset `state`).
  if (i.state === "down") return { state: "down", action: "none", restarts }
  if (i.spawnedAt && i.now - i.spawnedAt < START_GRACE_MS) return { state: "starting", action: "none", restarts }
  if (restarts.length >= RESTARTS_MAX) return { state: "down", action: "none", restarts }
  return { state: "starting", action: "spawn", restarts: [...restarts, i.now] }
}

// ── Compaction ──

export const IDLE_COMPACT_MS = 15 * 60_000
export const IDLE_COMPACT_PCT = 60

/** Compact only when nobody is talking to it: no turn for 15 min AND the context past 60 %. */
export function idleCompactDue(i: { lastTurnAt: number; contextPct: number | null; now: number; busy: boolean }): boolean {
  return !i.busy && i.contextPct !== null && i.contextPct > IDLE_COMPACT_PCT && i.now - i.lastTurnAt >= IDLE_COMPACT_MS
}

/** The typed `/compact keep: …` for the brain (one line, short: lib/inject-verified.ts caps it). */
export function compactText(memoryRef: string | null, openTurns: number): string {
  return `/compact keep: you are the Companion brain (brain/CLAUDE.md); memory note ${memoryRef ?? "not set"}; ${openTurns} open turns; pending proposals and dispatched task ids; Jeremie's latest asks.`
}

// ── 04:00 rollover ──

export const ROLLOVER_HOUR = 4

/** Once a day at 04:00 local: write memory, then a fresh session boots from it. */
export function rolloverDue(now: Date, lastDay: string | null): boolean {
  return now.getHours() === ROLLOVER_HOUR && lastDay !== now.toISOString().slice(0, 10)
}

export function rolloverPrompt(memoryRef: string | null): string {
  return `[rollover] Nightly restart. Update your memory note${memoryRef ? ` ${memoryRef}` : ""} with note_update (open threads, pending proposals, dispatched task ids, what Jeremie is waiting on), then reply "rollover ready". A fresh session boots from that note.`
}

// ── Voice consent ──

export const VOICE_CONSENT_MS = 10 * 60_000

export interface ConsentTurn {
  threadId: string
  role: string
  createdAt: number
  card?: { kind: string; source?: string } | null
}

/**
 * Voice = consent (Jeremie, 2026-10-28): a proposal files `queued` with no tap
 * only when its source turn is an app voice turn in the brain thread, at most
 * 10 min old, that has not already auto-filed something. Anything else waits
 * for the Approve tap.
 */
export function voiceConsent(turn: ConsentTurn | null, now: number, alreadyClaimed: boolean): boolean {
  if (!turn || alreadyClaimed) return false
  if (turn.threadId !== BRAIN_THREAD || turn.role !== "user") return false
  if (turn.card?.kind !== "voice" || turn.card.source !== "app") return false
  const age = now - turn.createdAt
  return age >= 0 && age <= VOICE_CONSENT_MS
}
