// Minimal Chrome DevTools Protocol client for the brain's read-only browser
// (docs/web-read.md). Loopback only: the browser binds CDP to 127.0.0.1 and
// this client refuses any other debugger address it is handed.

export interface CdpTab {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  close(): Promise<void>
}

export interface CdpBrowser {
  /** A fresh blank tab. Throws when the browser is not running. */
  open(): Promise<CdpTab>
}

export const WEB_CDP_PORT = Number(process.env.COMPANION_WEB_CDP_PORT ?? 9333)
const CALL_TIMEOUT_MS = 30_000

const isLoopbackWs = (raw: string): boolean => {
  try {
    const u = new URL(raw)
    return u.protocol === "ws:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")
  } catch {
    return false
  }
}

export function cdpBrowser(port = WEB_CDP_PORT): CdpBrowser {
  const base = `http://127.0.0.1:${port}`
  return {
    async open(): Promise<CdpTab> {
      const res = await fetch(`${base}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5_000) })
      if (!res.ok) throw new Error(`cdp /json/new ${res.status}`)
      const target = await res.json() as { id?: unknown; webSocketDebuggerUrl?: unknown }
      if (typeof target.id !== "string" || typeof target.webSocketDebuggerUrl !== "string" || !isLoopbackWs(target.webSocketDebuggerUrl)) {
        throw new Error("cdp: unexpected target")
      }
      const tab = await connect(target.webSocketDebuggerUrl)
      const id = target.id
      return {
        send: tab.send,
        async close(): Promise<void> {
          tab.close()
          await fetch(`${base}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
        },
      }
    },
  }
}

interface Pending { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

async function connect(wsUrl: string): Promise<{ send: CdpTab["send"]; close: () => void }> {
  const ws = new WebSocket(wsUrl)
  const pending = new Map<number, Pending>()
  let next = 1
  const failAll = (why: string): void => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)) }
    pending.clear()
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("cdp: websocket error"))
  })
  ws.onclose = () => failAll("cdp: websocket closed")
  ws.onmessage = (ev) => {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    if (typeof msg.id !== "number") return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(`cdp: ${msg.error.message ?? "error"}`))
    else p.resolve(msg.result ?? {})
  }
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = next++
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp: ${method} timed out`)) }, CALL_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    }),
    close: () => { failAll("cdp: closed"); ws.close() },
  }
}
