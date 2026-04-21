import { useCallback, useEffect, useRef, useState } from "react"
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
}

interface CompanionState {
  connected: boolean
  pending: ApprovalRequest[]
  waitingForInput: boolean
  claudeMessage: string
  activity: Activity | null
}

const SOUND_KEY = "companion.sound"

function readSoundPref(): boolean {
  if (typeof window === "undefined") return true
  const stored = window.localStorage.getItem(SOUND_KEY)
  return stored === null ? true : stored === "1"
}

export function useCompanion() {
  const [state, setState] = useState<CompanionState>({
    connected: false,
    pending: [],
    waitingForInput: false,
    claudeMessage: "",
    activity: null,
  })
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(readSoundPref)

  const wsRef = useRef<WebSocket | null>(null)
  const retriesRef = useRef(0)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const soundRef = useRef(soundEnabled)

  useEffect(() => { soundRef.current = soundEnabled }, [soundEnabled])

  const setSoundEnabled = useCallback((next: boolean) => {
    setSoundEnabledState(next)
    try { window.localStorage.setItem(SOUND_KEY, next ? "1" : "0") } catch { /* ignore */ }
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

          case "resolved":
            setState(s => ({
              ...s,
              pending: s.pending.filter(p => p.id !== msg.id),
            }))
            break

          case "waiting_input":
            setState(s => ({
              ...s,
              waitingForInput: msg.waiting,
              claudeMessage: msg.message ?? "",
            }))
            if (msg.waiting) {
              if (navigator.vibrate) navigator.vibrate([200, 100, 200])
              if (soundRef.current) playAlert("waiting")
            }
            break

          case "activity":
            setState(s => ({ ...s, activity: msg.activity ?? null }))
            break

          case "init":
            setState(s => ({
              ...s,
              waitingForInput: msg.waitingForInput ?? false,
              activity: msg.activity ?? null,
            }))
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
  const sendInput = useCallback((text: string) => send({ type: "input", text }), [send])

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

  return { ...state, approve, deny, sendInput, soundEnabled, setSoundEnabled }
}
