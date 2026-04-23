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
}

export interface Session {
  cwd: string
  sessionId: string
  termProgram: string
  tty: string
  iTermSessionId: string
  pid: string
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
}

interface CompanionState {
  connected: boolean
  pending: ApprovalRequest[]
  waitingForInput: boolean
  waitingMessage: string
  waitingCwd: string
  activity: Activity | null
  feed: FeedEvent[]
  sessions: Session[]
  injectError: { error: string; cwd?: string; at: number } | null
}

const SOUND_KEY = "companion.sound"
const TARGET_KEY = "companion.target"
const FEED_CAP = 200

function readSoundPref(): boolean {
  if (typeof window === "undefined") return true
  const stored = window.localStorage.getItem(SOUND_KEY)
  return stored === null ? true : stored === "1"
}

function readTargetPref(): string {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem(TARGET_KEY) ?? ""
}

function appendEvent(feed: FeedEvent[], ev: FeedEvent): FeedEvent[] {
  const next = feed.concat(ev)
  return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next
}

export function useCompanion(): CompanionState & {
  approve: (id: string) => void
  deny: (id: string) => void
  sendInput: (text: string, cwd?: string) => void
  clearInjectError: () => void
  soundEnabled: boolean
  setSoundEnabled: (next: boolean) => void
  targetCwd: string
  setTargetCwd: (cwd: string) => void
  effectiveTargetCwd: string
  pinnedOffline: boolean
} {
  const [state, setState] = useState<CompanionState>({
    connected: false,
    pending: [],
    waitingForInput: false,
    waitingMessage: "",
    waitingCwd: "",
    activity: null,
    feed: [],
    sessions: [],
    injectError: null,
  })
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(readSoundPref)
  const [targetCwd, setTargetCwdState] = useState<string>(readTargetPref)

  const wsRef = useRef<WebSocket | null>(null)
  const retriesRef = useRef(0)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const soundRef = useRef(soundEnabled)

  useEffect(() => { soundRef.current = soundEnabled }, [soundEnabled])

  const setSoundEnabled = useCallback((next: boolean) => {
    setSoundEnabledState(next)
    try { window.localStorage.setItem(SOUND_KEY, next ? "1" : "0") } catch { /* ignore */ }
  }, [])

  const setTargetCwd = useCallback((cwd: string) => {
    setTargetCwdState(cwd)
    try {
      if (cwd) window.localStorage.setItem(TARGET_KEY, cwd)
      else window.localStorage.removeItem(TARGET_KEY)
    } catch { /* ignore */ }
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      retriesRef.current = 0
      setState(s => ({ ...s, connected: true }))

      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }))
        }
      }, 25_000)
    }

    ws.onmessage = (e) => {
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
              activity: msg.activity ?? null,
              feed: Array.isArray(msg.feed) ? (msg.feed as FeedEvent[]) : s.feed,
              sessions: Array.isArray(msg.sessions) ? (msg.sessions as Session[]) : s.sessions,
            }))
            break
          case "inject_error":
            setState(s => ({
              ...s,
              injectError: { error: String(msg.error ?? "unknown"), cwd: msg.cwd, at: Date.now() },
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
    (text: string, cwd?: string) => send({ type: "input", text, cwd: cwd ?? undefined }),
    [send],
  )

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && wsRef.current?.readyState !== WebSocket.OPEN) {
        retriesRef.current = 0
        connect()
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
  // - explicit pin is sticky — honored even if the session isn't currently in
  //   the registry (the pinned Claude Code may have gone idle, paused the
  //   heartbeat, or be mid-reconnect). The server will 410 if it's truly gone,
  //   and the UI surfaces that via `pinnedOffline` below instead of silently
  //   rerouting to the wrong terminal.
  // - otherwise fall back to waiting > most-recent-activity > most-recent-seen
  const pinnedOffline = !!targetCwd && !state.sessions.some(s => s.cwd === targetCwd)
  const effectiveTargetCwd = useMemo(() => {
    if (targetCwd) return targetCwd
    const known = new Set(state.sessions.map(s => s.cwd))
    if (state.waitingCwd && known.has(state.waitingCwd)) return state.waitingCwd
    if (state.activity?.cwd && known.has(state.activity.cwd)) return state.activity.cwd
    return state.sessions[0]?.cwd ?? ""
  }, [targetCwd, state.waitingCwd, state.activity, state.sessions])

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
    targetCwd,
    setTargetCwd,
    effectiveTargetCwd,
    pinnedOffline,
  }
}
