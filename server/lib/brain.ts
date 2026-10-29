// brain-v2 (RES-QDHU) policy, pure: the one `brain` agent that plans,
// dispatches and follows up but never builds. The brain is a normal Claude
// Code session: its tool limits are its instructions (brain/CLAUDE.md), its
// .claude/settings.json and the normal permission flow (SUPER, auto-judge →
// phone, like any session). What lives here is what the server decides:
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

export interface DeliveryTurn { id: string; text: string; createdAt: number; card?: { kind: string } | null; role?: string }

/** Cap of one typed delivery; the rest waits for the next Stop. */
export const DELIVERY_MAX = 4_000

/** Queued turns as one prompt, oldest first: Jeremie's `[turn <id>] (voice) text`, system `[event <id>] text`. */
export function deliveryText(turns: DeliveryTurn[]): string {
  const lines = turns.map((t) => {
    const text = t.text.replace(/\s+/g, " ").trim()
    if (t.role === "orchestrator") return `[event ${t.id}] ${text}`
    return `[turn ${t.id}]${t.card?.kind === "voice" ? " (voice)" : ""} ${text}`
  })
  const text = lines.join("\n")
  return text.length > DELIVERY_MAX ? `${text.slice(0, DELIVERY_MAX - 1)}…` : text
}

/** First prompt of a fresh brain: memory first, then every turn still open. */
export function bootSeed(input: { memoryRef: string | null; open: DeliveryTurn[] }): string {
  const memory = input.memoryRef ? `Read your memory note ${input.memoryRef} first.` : `No memory note yet: create one (note_create, resources/, tag ${MEMORY_TAG}).`
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
  return `[rollover] Nightly restart. ${MEMORY_DUTY(memoryRef)} Then reply "rollover ready". A fresh session boots from that note.`
}

// ── Memory flush (before an idle compact) ──

/** The memory note stays small (it is read at every boot); detail goes to the daily log. */
export const MEMORY_MAX_CHARS = 3_000
/** Tag that names the brain's memory note in Turso (the server finds it by this tag). */
export const MEMORY_TAG = "brain-memory"

const MEMORY_DUTY = (memoryRef: string | null): string =>
  `Append today's decisions, dispatches and outcomes to your daily log note "Brain log <YYYY-MM-DD>" (resources/, tag brain-log; note_create once a day, then note_update). Then rewrite your memory note${memoryRef ? ` ${memoryRef}` : ` (tag ${MEMORY_TAG})`} to under ${MEMORY_MAX_CHARS} chars: open threads, pending proposals, dispatched task ids, what Jeremie is waiting on.`

/** The brain's whole reply to events that need nothing from Jeremie: kept out of the thread. */
export const QUIET_REPLY = "noted"

/** Typed before an idle /compact so nothing lives only in the context that compaction drops. */
export function flushPrompt(memoryRef: string | null): string {
  return `[flush] A context compaction follows. ${MEMORY_DUTY(memoryRef)} Then reply "flushed", nothing else.`
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

// ── Activity (the steps the phone shows while the brain works) ──

export type BrainActivityKind = "thinking" | "reading" | "searching" | "writing" | "dispatching" | "working" | "compacting"
export interface BrainActivity { kind: BrainActivityKind; label: string; since: number }
export interface BrainStep { kind: BrainActivityKind; running: string; done: string; detail: string | null }

const step = (kind: BrainActivityKind, running: string, done: string, detail: string | null = null): BrainStep => ({ kind, running, done, detail })

/** A short hint for the step's line: the note, query or pattern it works on. */
function stepDetail(input: Record<string, unknown>): string | null {
  for (const k of ["ref_code", "ref", "query", "q", "pattern", "title", "url"]) {
    const v = input[k]
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80)
  }
  return null
}

/** The brain's step for one tool call (its PreToolUse / PostToolUse hook). */
export function brainToolStep(tool: string, input: Record<string, unknown>): BrainStep {
  const d = stepDetail(input)
  if (tool === "Bash") {
    const cmd = typeof input.command === "string" ? input.command.trim().replace(/^\.\//, "") : ""
    if (cmd.startsWith("bin/propose")) return step("dispatching", "Dispatching", "Dispatched")
    if (cmd.startsWith("bin/lead")) return step("dispatching", "Filing a lead", "Filed a lead")
    if (cmd.startsWith("bin/thread")) return step("searching", "Searching the thread", "Searched the thread")
    return step("working", "Running a command", "Ran a command")
  }
  if (tool === "mcp__turso__note_create" || tool === "mcp__turso__note_update") return step("writing", "Writing a note", "Wrote a note", d)
  if (tool.startsWith("mcp__turso__")) return step("reading", "Reading notes", "Read notes", d)
  if (tool.includes("Gmail__send_message") || tool.includes("Gmail__reply")) return step("writing", "Sending an email", "Sent an email")
  if (/Gmail__(create|update)_draft/.test(tool)) return step("writing", "Drafting an email", "Drafted an email")
  if (tool.includes("Gmail__")) return step("reading", "Reading mail", "Read mail", d)
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return step("reading", "Reading files", "Read files", d)
  if (tool === "WebSearch" || tool === "WebFetch") return step("searching", "Searching the web", "Searched the web", d)
  if (tool === "Agent" || tool === "Task") return step("dispatching", "Delegating", "Delegated", d)
  const name = tool.replace(/^mcp__.+?__/, "").replace(/_/g, " ")
  return step("working", `Using ${name}`, `Used ${name}`, d)
}
