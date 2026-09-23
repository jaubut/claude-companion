// The event feed — one line per tool call / prompt / assistant block / turn
// end, 200-cap, in memory. Producers: activity.ts (hook-fed), transcript.ts
// (poll-fed), codex-feed.ts (rollout-fed, brings its own stable ids — the
// id-dedupe in appendFeedEvent is what makes its re-reads idempotent).
// Announced by wiring/events.ts as `event` / `feed_pruned`. Removals also fire
// onFeedEvict, which wiring/media.ts uses to free image files.

export type EventKind =
  | "user_prompt"
  | "assistant_text"
  | "tool_start"
  | "tool_end"
  | "turn_end"
  | "image"
  // RES-L5NG step 4 — Claude's thinking block. Reuses `text`; `durationMs`
  // is the transcript gap to the next entry when known.
  | "assistant_thinking"

export type Verdict = "auto-allow" | "auto-deny" | "approved" | "denied" | "pending"

export interface FeedEvent {
  id: string
  ts: number
  kind: EventKind
  // Optional public session key when a producer can resolve it exactly.
  // Hook-fed events usually carry tty/sessionId/cwd and let clients resolve
  // against the current sessions table; log-fed imports can often name the
  // final key directly.
  key?: string
  tool?: string
  summary?: string
  verdict?: Verdict
  durationMs?: number
  text?: string
  cwd?: string
  tty?: string
  sessionId?: string
  // Bash + similar — first non-empty lines of stdout/stderr after the
  // tool ran. Capped at ~200 chars so the feed message stays small.
  outputExcerpt?: string
  // True when the tool wrote to stderr (not necessarily a non-zero
  // exit, but a useful "something went sideways" signal for the badge).
  errored?: boolean
  // kind "image" (RES-L5NG step 3) — a reference into lib/media.ts, never
  // bytes. Fetched via GET /api/media/:id. width/height are the stored JPEG's.
  mediaId?: string
  width?: number
  height?: number
  caption?: string
}

const feed: FeedEvent[] = []
const FEED_CAP = 200

type Listener = (ev: FeedEvent) => void
type FeedResetListener = (removedIds: string[]) => void
type FeedEvictListener = (evicted: FeedEvent[]) => void
const feedListeners = new Set<Listener>()
const feedResetListeners = new Set<FeedResetListener>()
const feedEvictListeners = new Set<FeedEvictListener>()

export function onFeed(fn: Listener): () => void {
  feedListeners.add(fn)
  return () => feedListeners.delete(fn)
}

export function onFeedReset(fn: FeedResetListener): () => void {
  feedResetListeners.add(fn)
  return () => feedResetListeners.delete(fn)
}

// Fires whenever events leave the feed: the 200-cap trim and the session
// prune. The only resource-freeing signal (wiring/media.ts unlinks images).
// Listeners are READ-ONLY observers: unlink / release only, never append to
// or prune the feed from inside one. They run once per removal, after the
// splice is complete, each with its own copy of the removed events.
export function onFeedEvict(fn: FeedEvictListener): () => void {
  feedEvictListeners.add(fn)
  return () => feedEvictListeners.delete(fn)
}

function fireEvict(evicted: FeedEvent[]): void {
  if (evicted.length === 0) return
  for (const fn of [...feedEvictListeners]) {
    try { fn(evicted.slice()) } catch { /* ignore */ }
  }
}

export function getFeed(): FeedEvent[] {
  return feed.slice()
}

export function appendFeedEvent(ev: FeedEvent): void {
  if (feed.some((existing) => existing.id === ev.id)) return
  feed.push(ev)
  const evicted = feed.length > FEED_CAP ? feed.splice(0, feed.length - FEED_CAP) : []
  for (const fn of feedListeners) {
    try { fn(ev) } catch { /* ignore */ }
  }
  fireEvict(evicted)
}

// Drop every feed event that originated from a session, and tell clients
// which ids went (`feed_pruned`) — otherwise the phone replays a dead
// conversation when the user spawns a fresh chat. Match on tty / sessionId
// only; cwd alone is too weak (two windows can share a cwd).
export function pruneFeedForSession(meta: { tty?: string; sessionId?: string }): void {
if (meta.tty || meta.sessionId) {
  const removed: string[] = []
  const removedEvents: FeedEvent[] = []
  for (let i = feed.length - 1; i >= 0; i--) {
    const ev = feed[i]
    if (!ev) continue
    const hit =
      (meta.tty && ev.tty === meta.tty) ||
      (meta.sessionId && ev.sessionId === meta.sessionId)
    if (hit) {
      removed.push(ev.id)
      removedEvents.push(ev)
      feed.splice(i, 1)
    }
  }
  if (removed.length > 0) {
    for (const fn of feedResetListeners) {
      try { fn(removed) } catch { /* ignore */ }
    }
  }
  fireEvict(removedEvents)
}
}
