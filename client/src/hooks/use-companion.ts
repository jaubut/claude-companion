import { useCallback, useEffect, useRef, useState } from "react"

export interface ApprovalRequest {
  id: string
  tool: string
  input: Record<string, unknown>
  sessionId: string
}

interface CompanionState {
  connected: boolean
  pending: ApprovalRequest[]
}

export function useCompanion() {
  const [state, setState] = useState<CompanionState>({
    connected: false,
    pending: [],
  })

  const wsRef = useRef<WebSocket | null>(null)
  const retriesRef = useRef(0)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
              }],
            }))
            // Vibrate
            if (navigator.vibrate) navigator.vibrate([100, 50, 100])
            break

          case "resolved":
            setState(s => ({
              ...s,
              pending: s.pending.filter(p => p.id !== msg.id),
            }))
            break

          case "init":
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

  // iOS reconnection
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

  return { ...state, approve, deny }
}
