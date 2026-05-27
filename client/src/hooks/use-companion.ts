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

interface CompanionState {
  connected: boolean
  pending: ApprovalRequest[]
  waitingForInput: boolean
  waitingMessage: string
  waitingCwd: string
  waitingKey: string
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
} {
  const [state, setState] = useState<CompanionState>({
    connected: false,
    pending: [],
    waitingForInput: false,
    waitingMessage: "",
    waitingCwd: "",
    waitingKey: "",
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

          case "waiting_input":
            setState(s => ({
              ...s,
              waitingForInput: msg.waiting,
              waitingMessage: msg.waiting ? (msg.message ?? "") : "",
              waitingCwd: msg.waiting ? (msg.cwd ?? "") : "",
              waitingKey: msg.waiting ? (msg.key ?? "") : "",
            }))
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
              waitingForInput: msg.waitingForInput ?? false,
              waitingCwd: msg.waitingCwd ?? "",
              waitingKey: msg.waitingKey ?? "",
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

  const pinnedOffline = !!targetKey && resolvePin(targetKey) === null
  const effectiveTarget = useMemo<Session | null>(() => {
    const pinned = resolvePin(targetKey)
    if (pinned) return pinned
    if (state.waitingKey) {
      const bySession = state.sessions.find(s => s.key === state.waitingKey)
      if (bySession) return bySession
    }
    if (state.waitingCwd) {
      const byCwd = state.sessions.find(s => s.cwd === state.waitingCwd)
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
  }, [resolvePin, targetKey, state.waitingKey, state.waitingCwd, state.activity, state.sessions])

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
  }
}
