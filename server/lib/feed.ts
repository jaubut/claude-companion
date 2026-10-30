// The event feed — one line per tool call / prompt / assistant block / turn
// end, 200-cap (a live session keeps its newest 40 past it), in memory.
// Producers: activity.ts (hook-fed), transcript.ts (poll-fed), codex-feed.ts
// (rollout-fed, brings its own stable ids — the id-dedupe in appendFeedEvent
// is what makes its re-reads idempotent).
// Announced by wiring/events.ts as `event` / `feed_pruned`. Removals also fire
// onFeedEvict (no in-tree listener today; media files are age/byte-capped
// independently of the feed — see wiring/media.ts).

// The exhaustive kind list — the ONE place kinds are declared. `EventKind` is
// derived from it so the runtime list cannot drift from the type; the
// contract fixtures (contracts/feed-events/, synced to the iOS repo) are
// checked against it by feed-contract.test.ts.
export const FEED_EVENT_KINDS = [
  "user_prompt",
  "assistant_text",
  "tool_start",
  "tool_end",
  "turn_end",
  "image",
  // RES-L5NG step 4 — Claude's thinking block. Reuses `text`; `durationMs`
  // is the transcript gap to the next entry when known.
  "assistant_thinking",
  // Phase 19 step 3 (RES-B9CL) — a PR / note ref / file spotted in assistant
  // text or a tool_result. Fields: artifactKind, title, url | ref | path.
  "artifact",
] as const

export type EventKind = (typeof FEED_EVENT_KINDS)[number]

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
  // kind "artifact" (RES-B9CL) — see lib/artifacts.ts. `url` for a PR, `ref`
  // for a TLS note, `path` for a file on this host. A file SendUserFile sent
  // also carries `url` (/api/files/<id>/<name>) and, for images, `mediaId`.
  artifactKind?: "pr" | "note" | "file" | "url"
  title?: string
  url?: string
  path?: string
  ref?: string
}

const feed: FeedEvent[] = []
const FEED_CAP = 200
// The cap is shared by every session, so one busy session used to push an idle
// one's whole conversation out within minutes, and a phone that reconnected
// later (suspended, or a Brain-spawned session it never watched) got an empty
// feed for it. A live session now keeps its newest SESSION_FLOOR events past
// the cap; HARD_CAP bounds the total whatever the session count.
const SESSION_FLOOR = 40
const HARD_CAP = 600

// Names the live session an event belongs to, null when it has none (ended,
// or no identity). Set by the wiring from the sessions table; unset, every
// event is evicted oldest-first at FEED_CAP.
type Retention = (ev: FeedEvent) => string | null
let retention: Retention | null = null

export function setFeedRetention(fn: Retention | null): void {
  retention = fn
}

// The retention for a sessions-table snapshot: an event belongs to the session
// its key, sessionId or tty names.
export function sessionRetention(sessions: Array<{ key: string; sessionId: string; tty: string }>): Retention {
  const keys = new Set<string>()
  const bySid = new Map<string, string>()
  const byTty = new Map<string, string>()
  for (const s of sessions) {
    keys.add(s.key)
    if (s.sessionId) bySid.set(s.sessionId, s.key)
    if (s.tty) byTty.set(s.tty, s.key)
  }
  return (ev) =>
    (ev.key && keys.has(ev.key) ? ev.key : null) ??
    (ev.sessionId ? bySid.get(ev.sessionId) : undefined) ??
    (ev.tty ? byTty.get(ev.tty) : undefined) ??
    null
}

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
// prune. Not used to free media (see wiring/media.ts for why).
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
  const evicted = feed.length > FEED_CAP ? trim() : []
  for (const fn of feedListeners) {
    try { fn(ev) } catch { /* ignore */ }
  }
  fireEvict(evicted)
}

// Oldest first, skipping a live session's newest SESSION_FLOOR events, until
// the feed is back at FEED_CAP; then oldest first regardless down to HARD_CAP.
function trim(): FeedEvent[] {
  const owners = feed.map((e) => retention?.(e) ?? null)
  const left = new Map<string, number>()
  for (const o of owners) if (o !== null) left.set(o, (left.get(o) ?? 0) + 1)
  const drop = new Set<number>()
  for (let i = 0; i < feed.length && feed.length - drop.size > FEED_CAP; i++) {
    const o = owners[i] ?? null
    if (o !== null) {
      const n = left.get(o) ?? 0
      if (n <= SESSION_FLOOR) continue
      left.set(o, n - 1)
    }
    drop.add(i)
  }
  for (let i = 0; i < feed.length && feed.length - drop.size > HARD_CAP; i++) drop.add(i)
  const evicted = feed.filter((_, i) => drop.has(i))
  const kept = feed.filter((_, i) => !drop.has(i))
  feed.length = 0
  feed.push(...kept)
  return evicted
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
