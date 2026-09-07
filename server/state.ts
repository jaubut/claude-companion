import type { ServerWebSocket } from "bun"
import { hostname } from "node:os"

// Process-wide server state shared by the route hosts, the WS handler and the
// wiring modules. Imports nothing from server/ so it can never be part of a
// cycle. Everything here is a module singleton, like the lib/ stores.

export interface WsData {
  id: string
}

export const clients = new Set<ServerWebSocket<WsData>>()

export function broadcast(data: Record<string, unknown>): void {
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    try { ws.send(msg) } catch { /* dead client */ }
  }
}

// Who this companion is — the phone shows it as a per-session host badge
// (Mac vs Zettlab) instead of guessing from URLs. Hostname's first label,
// platform for the icon.
export const HOST_INFO = { name: hostname().split(".")[0] ?? "", platform: process.platform }

// "Claude is waiting for input" — one flag for the host, set by the Stop hook,
// cleared by any inject or the next tool call. Behind setters because an
// imported `let` is read-only across modules; the `waiting_input` broadcast
// stays at the call sites so the wire behaviour is unchanged.
let waitingForInput = false
let waitingCwd = ""
let waitingKey = ""

export function getWaiting(): { waitingForInput: boolean; waitingCwd: string; waitingKey: string } {
  return { waitingForInput, waitingCwd, waitingKey }
}

export function setWaiting(cwd: string, key: string): void {
  waitingForInput = true
  waitingCwd = cwd
  waitingKey = key
}

export function clearWaiting(): void {
  waitingForInput = false
  waitingCwd = ""
  waitingKey = ""
}
