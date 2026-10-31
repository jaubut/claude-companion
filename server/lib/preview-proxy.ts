import type { Server, ServerWebSocket } from "bun"

// A loopback proxy in front of a preview dev server (wiring/brain-preview.ts):
// tailscale serve → 127.0.0.1:<proxy> → 127.0.0.1:<dev>. It exists to see
// every HTTP request (the 2 h idle stop) and passes WebSockets through, so
// Vite/Astro HMR works: the HMR client derives host/port/protocol from the
// page URL (wss://<tailnet host>:<serve port>), which is this proxy's front.
// Funnel requests (public internet through tailscaled) are refused.

interface WsData { target: string; protocols: string[]; origin: string | null; up: WebSocket | null; queue: Array<string | Buffer> }

export interface PreviewProxy { port: number; stop(): void }

const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "accept-encoding"]

export function startPreviewProxy(devPort: number, onHit: () => void): PreviewProxy {
  const server: Server<WsData> = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      if (req.headers.get("tailscale-funnel-request")) return new Response("forbidden", { status: 403 })
      onHit()
      const u = new URL(req.url)
      const path = `127.0.0.1:${devPort}${u.pathname}${u.search}`
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
        const headers = protocols[0] ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined
        const data: WsData = { target: `ws://${path}`, protocols, origin: req.headers.get("origin"), up: null, queue: [] }
        return srv.upgrade(req, { data, headers }) ? undefined : new Response("upgrade failed", { status: 400 })
      }
      const headers = new Headers(req.headers)
      for (const h of HOP) headers.delete(h)
      try {
        const res = await fetch(`http://${path}`, {
          method: req.method, headers, redirect: "manual",
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        })
        const out = new Headers(res.headers)
        // Bun's fetch already decompressed the body.
        out.delete("content-encoding")
        out.delete("content-length")
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
      } catch {
        return new Response("preview dev server unreachable", { status: 502 })
      }
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const d = ws.data
        const up = new WebSocket(d.target, { protocols: d.protocols, headers: d.origin ? { origin: d.origin } : {} })
        d.up = up
        up.binaryType = "arraybuffer"
        up.onopen = () => { for (const m of d.queue.splice(0)) up.send(m) }
        up.onmessage = (e) => { ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer)) }
        up.onclose = (e) => { try { ws.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason) } catch { /* closed */ } }
        up.onerror = () => { try { ws.close(1011) } catch { /* closed */ } }
      },
      message(ws: ServerWebSocket<WsData>, msg) {
        const up = ws.data.up
        if (up && up.readyState === WebSocket.OPEN) up.send(msg)
        else ws.data.queue.push(msg)
      },
      close(ws: ServerWebSocket<WsData>) {
        try { ws.data.up?.close() } catch { /* closed */ }
      },
    },
  })
  return { port: server.port!, stop: () => server.stop(true) }
}
