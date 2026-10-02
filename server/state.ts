import type { ServerWebSocket } from "bun"
import { hostname } from "node:os"

// Process-wide server state shared by the route hosts, the WS handler and the
// wiring modules. Imports nothing from server/ so it can never be part of a
// cycle. Everything here is a module singleton, like the lib/ stores.

export interface WsData {
  id: string
  // Who opened this socket, captured at upgrade (lib logs only; never the
  // bearer token, never the URL — the token can ride the query string).
  client?: ClientInfo
}

// Where a phone-side request came from, for the resolve/answer audit log.
export interface ClientInfo {
  remote: string
  ua: string
  device: string
}

// Bun only exposes the peer address through `server.requestIP(req)`; the
// fetch handler records it here so route modules (which never see `server`)
// can log it. Weak: the entry dies with the Request.
const remotes = new WeakMap<Request, string>()

export function rememberRemote(req: Request, address: string | undefined): void {
  if (address) remotes.set(req, address)
}

// Header values are client-controlled: strip control characters (no forged
// log lines) and cap the length.
function clean(v: string | null | undefined, max = 120): string {
  return (v ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, max)
}

export function clientInfo(req: Request): ClientInfo {
  return {
    remote: clean(remotes.get(req), 64),
    ua: clean(req.headers.get("user-agent")),
    device: clean(req.headers.get("x-companion-device"), 80),
  }
}

export function describeClient(transport: "rest" | "ws", c: ClientInfo | undefined): string {
  const parts = [`via=${transport}`, `from=${c?.remote || "?"}`, `ua="${c?.ua || "?"}"`]
  if (c?.device) parts.push(`device="${c.device}"`)
  return parts.join(" ")
}

export const clients = new Set<ServerWebSocket<WsData>>()

export function broadcast(data: Record<string, unknown>): void {
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    try { ws.send(msg) } catch { /* dead client */ }
  }
}

// Who this companion is — the phone shows it as a per-session host badge
// (Mac vs Linux host) instead of guessing from URLs. Hostname's first label,
// platform for the icon.
export const HOST_INFO = { name: hostname().split(".")[0] ?? "", platform: process.platform }
