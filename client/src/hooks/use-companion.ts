import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { playAlert } from "@/lib/alert-sound"

export interface ApprovalRequest {
  id: string
  tool: string
  input: Record<string, unknown>
  sessionId: string
  cwd: string
}

export interface Activity {
  verb: string
  tool: string
  summary: string
  turnStartedAt: number
  lastBeatAt: number
  tokens: number
  cwd: string
  // v0.x: precise identity — the UI should prefer tty over cwd when two
  // sessions share a cwd (e.g. two Claude windows in the same repo).
  sessionId?: string
  tty?: string
  // The owning session's key, issued by the server (PRJ-OR1T Phase 10). The
  // exact match, tried before the identity chain above. Optional: an older
  // server's pill doesn't carry it.
  key?: string
}

export interface Session {
  key: string
  label: string
  cwd: string
  sessionId: string
  termProgram: string
  tty: string
  iTermSessionId: string
  pid: string
  firstSeenAt: number
  lastSeenAt: number
}

export type EventKind =
  | "user_prompt"
  | "assistant_text"
  | "tool_start"
  | "tool_end"
  | "turn_end"

export type Verdict = "auto-allow" | "auto-deny" | "approved" | "denied" | "pending"

export interface FeedEvent {
  id: string
  ts: number
  kind: EventKind
  tool?: string
  summary?: string
  verdict?: Verdict
  durationMs?: number
  text?: string
  cwd?: string
  tty?: string
  sessionId?: string
}

// One waiting session, keyed by session key in `waitingByKey`. `message` is
// kept per key rather than host-wide: the server deliberately sends none today,
// but an older one does, and it belongs to the session that produced it.
export interface WaitingEntry {
  cwd: string
  // "turn-end" | "approval" | "question" | "dialog", or "" from a server that
  // predates Phase 11.
  kind: string
  // What is blocking: the approval/question id, the dialog's session key, ""
  // for a turn-end. Lets a future row deep-link to the detail card.
  ref: string
  since: number
  message: string
}

// Only a turn-end is answered by typing into the composer, so only a turn-end
// may speak for the whole app. Defined once, read by all three rollups that
// used to drift apart: the header text, the auto-follow target, and the alert.
// A question or a dialog still lights its own row via waitingByKey — the PWA
// has no pending list for either, so letting one flip the header to "Done" or
// move the send target would be a frame of reference recomputed from whichever
// session most recently gained a reason.
const ANSWERS_TURN = (kind: string): boolean => kind === "turn-end" || kind === ""

interface CompanionState {
  connected: boolean
  pending: ApprovalRequest[]
  waitingByKey: Record<string, WaitingEntry>
  // Every working session's pill, most-recent-event first (the server's order).
  // The host rollup the status bar reads is derived from it, never stored.
  activities: Activity[]
  feed: FeedEvent[]
  sessions: Session[]
  injectError: { error: string; key?: string; cwd?: string; at: number } | null
}

const SOUND_KEY = "companion.sound"
const TARGET_KEY = "companion.targetKey"
const LEGACY_TARGET_KEY = "companion.target"
const FEED_CAP = 200
// iOS WKWebView keeps WebSockets in `readyState: OPEN` when the host app
// goes background, even though the underlying TCP connection is silently
// dead. When the app comes back, we appear connected but never receive
// the events that fired during the gap. Detect this by tracking time since
// the last inbound server message — a ping every 10s plus the server's
// usual broadcast traffic means real connections refresh constantly.
const PING_INTERVAL_MS = 10_000
const STALE_AFTER_MS = 12_000

function readSoundPref(): boolean {
  if (typeof window === "undefined") return true
  const stored = window.localStorage.getItem(SOUND_KEY)
  return stored === null ? true : stored === "1"
}

function readTargetPref(): string {
  if (typeof window === "undefined") return ""
  const modern = window.localStorage.getItem(TARGET_KEY)
  if (modern) return modern
  // One-time migration from the old cwd-based pin. The server now accepts
  // either a key or a cwd as a lookup target, so passing the legacy cwd still
  // resolves until the user picks a fresh target once.
  const legacy = window.localStorage.getItem(LEGACY_TARGET_KEY)
  return legacy ?? ""
}

// The init frame seeds the whole map from `waitingSessions[]`. An older server
// doesn't send that array, so fall back to its three legacy scalars — one
// waiter, the most recent one.
function waitingFromInit(msg: Record<string, unknown>): Record<string, WaitingEntry> {
  const out: Record<string, WaitingEntry> = {}
  if (Array.isArray(msg.waitingSessions)) {
    for (const raw of msg.waitingSessions) {
      const w = raw as Record<string, unknown>
      out[typeof w.key === "string" ? w.key : ""] = {
        cwd: typeof w.cwd === "string" ? w.cwd : "",
        kind: typeof w.kind === "string" ? w.kind : "",
        ref: typeof w.ref === "string" ? w.ref : "",
        since: typeof w.since === "number" ? w.since : 0,
        message: "",
      }
    }
    return out
  }
  if (msg.waitingForInput) {
    out[typeof msg.waitingKey === "string" ? msg.waitingKey : ""] = {
      cwd: typeof msg.waitingCwd === "string" ? msg.waitingCwd : "",
      kind: "",
      ref: "",
      since: 0,
      message: "",
    }
  }
  return out
}

// Both `activity` and `init` carry the per-session array. The scalar fallback
// keeps a fresh bundle working against a server that predates Phase 10 — it
// degrades to one pill, exactly what that server means.
function activitiesFrom(msg: Record<string, unknown>): Activity[] {
  if (Array.isArray(msg.activities)) return msg.activities as Activity[]
  return msg.activity ? [msg.activity as Activity] : []
}

// Which session a pill belongs to: its issued key first (exact), then the
// legacy precise-identity chain for a pill that arrived without one.
function sessionForActivity(sessions: Session[], a: Activity): Session | null {
  return (a.key ? sessions.find(s => s.key === a.key) : undefined)
    ?? (a.tty ? sessions.find(s => s.tty === a.tty) : undefined)
    ?? (a.sessionId ? sessions.find(s => s.sessionId === a.sessionId) : undefined)
    ?? (a.cwd ? sessions.find(s => s.cwd === a.cwd) : undefined)
    ?? null
}

function appendEvent(feed: FeedEvent[], ev: FeedEvent): FeedEvent[] {
  const next = feed.concat(ev)
  return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next
}

export function useCompanion(): CompanionState & {
  approve: (id: string) => void
  deny: (id: string) => void
  sendInput: (text: string, key?: string) => void
  clearInjectError: () => void
  soundEnabled: boolean
  setSoundEnabled: (next: boolean) => void
  targetKey: string
  setTargetKey: (key: string) => void
  effectiveTarget: Session | null
  pinnedOffline: boolean
  // Derived rollup: is ANY session waiting. The status bar reads this.
  waitingForInput: boolean
  // The waiting entry for the session the composer would send to, or null.
  targetWaiting: WaitingEntry | null
  // Derived rollup: the most recently active session's pill. Unchanged shape,
  // so the status bar keeps reading it.
  activity: Activity | null
  // The pill of the session the composer would send to, or null. Not to be
  // confused with Phase 9's targetWaiting.
  targetActivity: Activity | null
} {
  const [state, setState] = useState<CompanionState>({
    connected: false,
    pending: [],
    waitingByKey: {},
    activities: [],
    feed: [],
    sessions: [],
    injectError: null,
  })
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(readSoundPref)
  const [targetKey, setTargetKeyState] = useState<string>(readTargetPref)

  const wsRef = useRef<WebSocket | null>(null)
  const retriesRef = useRef(0)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const soundRef = useRef(soundEnabled)
  const lastServerMsgRef = useRef(0)

  useEffect(() => { soundRef.current = soundEnabled }, [soundEnabled])

  const setSoundEnabled = useCallback((next: boolean) => {
    setSoundEnabledState(next)
    try { window.localStorage.setItem(SOUND_KEY, next ? "1" : "0") } catch { /* ignore */ }
  }, [])

  const setTargetKey = useCallback((key: string) => {
    setTargetKeyState(key)
    try {
      if (key) window.localStorage.setItem(TARGET_KEY, key)
      else window.localStorage.removeItem(TARGET_KEY)
      window.localStorage.removeItem(LEGACY_TARGET_KEY)
    } catch { /* ignore */ }
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      retriesRef.current = 0
      lastServerMsgRef.current = Date.now()
      setState(s => ({ ...s, connected: true }))

      heartbeatRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        // Stale-detection — if no server message in STALE_AFTER_MS, treat
        // the socket as dead even though readyState says OPEN. Closing here
        // triggers `onclose`, which triggers the reconnect backoff and an
        // `init` snapshot that backfills any events we missed.
        if (Date.now() - lastServerMsgRef.current > STALE_AFTER_MS) {
          try { ws.close() } catch { /* ignore */ }
          return
        }
        ws.send(JSON.stringify({ type: "ping" }))
      }, PING_INTERVAL_MS)
    }

    ws.onmessage = (e) => {
      lastServerMsgRef.current = Date.now()
      try {
        const msg = JSON.parse(e.data)

        switch (msg.type) {
          case "approval":
            setState(s => ({
              ...s,
              pending: [...s.pending.filter(p => p.id !== msg.id), {
                id: msg.id,
                tool: msg.tool,
                input: msg.input ?? {},
                sessionId: msg.sessionId ?? "",
                cwd: msg.cwd ?? "",
              }],
            }))
            if (navigator.vibrate) navigator.vibrate([100, 50, 100])
            if (soundRef.current) playAlert("approval")
            break

          case "resolved": {
            const nextVerdict: Verdict = msg.decision === "allow" ? "approved" : "denied"
            setState(s => {
              const nextFeed = s.feed.slice()
              for (let i = nextFeed.length - 1; i >= 0; i--) {
                const entry = nextFeed[i]
                if (entry && entry.kind === "tool_start" && entry.verdict === "pending") {
                  nextFeed[i] = { ...entry, verdict: nextVerdict }
                  break
                }
              }
              return {
                ...s,
                pending: s.pending.filter(p => p.id !== msg.id),
                feed: nextFeed,
              }
            })
            break
          }

          // `msg.waiting` is the boolean on THIS frame — not to be confused
          // with `msg.waitingSessions`, the array on `init`.
          case "waiting_input":
            setState(s => {
              const key = typeof msg.key === "string" ? msg.key : ""
              if (msg.waiting) {
                return {
                  ...s,
                  waitingByKey: {
                    ...s.waitingByKey,
                    [key]: {
                      cwd: typeof msg.cwd === "string" ? msg.cwd : "",
                      kind: typeof msg.kind === "string" ? msg.kind : "",
                      ref: typeof msg.ref === "string" ? msg.ref : "",
                      since: typeof msg.since === "number" ? msg.since : Date.now(),
                      message: typeof msg.message === "string" ? msg.message : "",
                    },
                  },
                }
              }
              // A clear with no key means "nobody is waiting" and only an older
              // server sends it. A keyed clear touches exactly one session, so
              // one terminal's tool call can't blank another's badge.
              if (!key) return { ...s, waitingByKey: {} }
              if (!(key in s.waitingByKey)) return s
              const next = { ...s.waitingByKey }
              delete next[key]
              return { ...s, waitingByKey: next }
            })
            // An approval already alerted on its own `approval` frame; a
            // question or dialog on a background session is not this app's
            // turn to answer. Only a turn-end interrupts.
            if (msg.waiting && ANSWERS_TURN(typeof msg.kind === "string" ? msg.kind : "")) {
              if (navigator.vibrate) navigator.vibrate([200, 100, 200])
              if (soundRef.current) playAlert("waiting")
            }
            break

          case "activity":
            setState(s => ({ ...s, activities: activitiesFrom(msg) }))
            break

          case "event":
            if (msg.event) {
              setState(s => ({ ...s, feed: appendEvent(s.feed, msg.event as FeedEvent) }))
            }
            break

          case "feed_pruned":
            if (Array.isArray(msg.ids) && msg.ids.length > 0) {
              const drop = new Set(msg.ids as string[])
              setState(s => ({ ...s, feed: s.feed.filter(ev => !drop.has(ev.id)) }))
            }
            break

          case "sessions":
            if (Array.isArray(msg.sessions)) {
              setState(s => ({ ...s, sessions: msg.sessions as Session[] }))
            }
            break

          case "init":
            setState(s => ({
              ...s,
              waitingByKey: waitingFromInit(msg),
              activities: activitiesFrom(msg),
              feed: Array.isArray(msg.feed) ? (msg.feed as FeedEvent[]) : s.feed,
              sessions: Array.isArray(msg.sessions) ? (msg.sessions as Session[]) : s.sessions,
            }))
            break
          case "inject_error":
            setState(s => ({
              ...s,
              injectError: { error: String(msg.error ?? "unknown"), key: msg.key, cwd: msg.cwd, at: Date.now() },
            }))
            if (navigator.vibrate) navigator.vibrate([300, 100, 300])
            break
          case "pong":
            break
        }
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      setState(s => ({ ...s, connected: false }))
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
      const delay = Math.min(1000 * 2 ** retriesRef.current, 30_000)
      retriesRef.current++
      setTimeout(connect, delay)
    }

    ws.onerror = () => ws.close()
    wsRef.current = ws
  }, [])

  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  const approve = useCallback((id: string) => send({ type: "approve", id }), [send])
  const deny = useCallback((id: string) => send({ type: "deny", id }), [send])
  const sendInput = useCallback(
    (text: string, key?: string) => send({ type: "input", text, key: key ?? undefined }),
    [send],
  )

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) return
      // Coming back to foreground. Two cases:
      //   1. Socket is already CLOSED/CLOSING → start a fresh connect.
      //   2. Socket is OPEN but possibly a zombie (iOS WKWebView keeps
      //      backgrounded sockets in OPEN with no traffic flowing). Force
      //      close if the last server message is older than the stale
      //      threshold; onclose will rebuild the connection cleanly.
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        retriesRef.current = 0
        connect()
        return
      }
      if (Date.now() - lastServerMsgRef.current > STALE_AFTER_MS) {
        try { ws.close() } catch { /* ignore */ }
      }
    }
    document.addEventListener("visibilitychange", handleVisibility)
    window.addEventListener("online", () => { retriesRef.current = 0; connect() })

    connect()

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility)
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  // Effective target:
  // - explicit pin is sticky; it matches on session.key first (the new path)
  //   then falls back to cwd so a legacy localStorage pin still resolves.
  // - otherwise fall back to waiting > most-recent-activity > most-recent-seen
  const resolvePin = useCallback((pin: string): Session | null => {
    if (!pin) return null
    return state.sessions.find(s => s.key === pin)
      ?? state.sessions.find(s => s.cwd === pin)
      ?? null
  }, [state.sessions])

  // Rollups are derived, never stored — same rule the server follows.
  const newestWaiting = useMemo<(WaitingEntry & { key: string }) | null>(() => {
    let newest: (WaitingEntry & { key: string }) | null = null
    for (const [key, w] of Object.entries(state.waitingByKey)) {
      if (!ANSWERS_TURN(w.kind)) continue
      if (!newest || w.since >= newest.since) newest = { key, ...w }
    }
    return newest
  }, [state.waitingByKey])
  const waitingForInput = newestWaiting !== null

  const pinnedOffline = !!targetKey && resolvePin(targetKey) === null
  const effectiveTarget = useMemo<Session | null>(() => {
    const pinned = resolvePin(targetKey)
    if (pinned) return pinned
    if (newestWaiting) {
      const bySession = state.sessions.find(s => s.key === newestWaiting.key)
      if (bySession) return bySession
      const byCwd = newestWaiting.cwd
        ? state.sessions.find(s => s.cwd === newestWaiting.cwd)
        : null
      if (byCwd) return byCwd
    }
    // Walk the pills in rollup order (most recent event first) and take the
    // first that resolves to a live session — key, then tty/sessionId/cwd, so
    // two sessions sharing a cwd don't collapse to whichever is listed first.
    for (const a of state.activities) {
      const match = sessionForActivity(state.sessions, a)
      if (match) return match
    }
    return state.sessions[0] ?? null
  }, [resolvePin, targetKey, newestWaiting, state.activities, state.sessions])

  const targetWaiting = useMemo<WaitingEntry | null>(
    () => (effectiveTarget ? state.waitingByKey[effectiveTarget.key] ?? null : null),
    [effectiveTarget, state.waitingByKey],
  )

  // Same rule the server applies: the rollup is the head of the list.
  const activity = state.activities[0] ?? null

  // The pill for the session we'd send to, so a pinned target keeps its own
  // pill while another session fires tools.
  const targetActivity = useMemo<Activity | null>(() => {
    const t = effectiveTarget
    if (!t) return null
    return state.activities.find(a => a.key && a.key === t.key)
      ?? state.activities.find(a => !!a.tty && a.tty === t.tty)
      ?? state.activities.find(a => !!a.sessionId && a.sessionId === t.sessionId)
      ?? state.activities.find(a => !!a.cwd && a.cwd === t.cwd)
      ?? null
  }, [effectiveTarget, state.activities])

  const clearInjectError = useCallback(() => {
    setState(s => ({ ...s, injectError: null }))
  }, [])

  return {
    ...state,
    approve,
    deny,
    sendInput,
    clearInjectError,
    soundEnabled,
    setSoundEnabled,
    targetKey,
    setTargetKey,
    effectiveTarget,
    pinnedOffline,
    waitingForInput,
    targetWaiting,
    activity,
    targetActivity,
  }
}
