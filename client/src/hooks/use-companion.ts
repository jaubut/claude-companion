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
  kind: string
  since: number
  message: string
}

interface CompanionState {
  connected: boolean
  pending: ApprovalRequest[]
  waitingByKey: Record<string, WaitingEntry>
  activity: Activity | null
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
      since: 0,
      message: "",
    }
  }
  return out
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
} {
  const [state, setState] = useState<CompanionState>({
    connected: false,
    pending: [],
    waitingByKey: {},
    activity: null,
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
            if (msg.waiting) {
              if (navigator.vibrate) navigator.vibrate([200, 100, 200])
              if (soundRef.current) playAlert("waiting")
            }
            break

          case "activity":
            setState(s => ({ ...s, activity: msg.activity ?? null }))
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
              activity: msg.activity ?? null,
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
    if (state.activity) {
      // Precise match first — tty or sessionId — so two sessions sharing a
      // cwd don't collapse to whichever is first in the list.
      const a = state.activity
      const byTty = a.tty ? state.sessions.find(s => s.tty === a.tty) : null
      if (byTty) return byTty
      const bySid = a.sessionId ? state.sessions.find(s => s.sessionId === a.sessionId) : null
      if (bySid) return bySid
      if (a.cwd) {
        const byCwd = state.sessions.find(s => s.cwd === a.cwd)
        if (byCwd) return byCwd
      }
    }
    return state.sessions[0] ?? null
  }, [resolvePin, targetKey, newestWaiting, state.activity, state.sessions])

  const targetWaiting = useMemo<WaitingEntry | null>(
    () => (effectiveTarget ? state.waitingByKey[effectiveTarget.key] ?? null : null),
    [effectiveTarget, state.waitingByKey],
  )

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
  }
}
