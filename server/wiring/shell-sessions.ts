import type { ServerWebSocket } from "bun"
import { companionLog } from "../lib/log"
import { listSessions } from "../lib/sessions"
import { getShellSession, onShellSessions, readShellSessions, store, wireSessions } from "../lib/shell-sessions"
import { TERMINAL_ENDED, openTerminal } from "../lib/terminal-bridge"
import { broadcast, describeClient, type WsData } from "../state"

// Shell sessions on the wire (lib/shell-sessions.ts) and the /api/terminal
// socket handlers (lib/terminal-bridge.ts). A shell coming, going or changing
// directory re-sends the `sessions` frame: agents as lib/sessions.ts has them,
// shells after.

onShellSessions(() => {
  broadcast({ type: "sessions", sessions: wireSessions(listSessions()) })
})

type Bridge = ReturnType<typeof openTerminal>
const bridges = new WeakMap<ServerWebSocket<WsData>, Bridge>()

export function terminalOpen(ws: ServerWebSocket<WsData>): void {
  const t = ws.data.terminal!
  const shell = getShellSession(t.key)
  if (!shell) { ws.close(TERMINAL_ENDED, "gone"); return }
  companionLog(`\x1b[36mterminal\x1b[0m attach ${shell.name} ${t.cols}x${t.rows} ${describeClient("ws", ws.data.client)}`)
  const bridge = openTerminal(shell, t, {
    send: (d) => { ws.sendBinary(d) },
    end: (code, reason) => ws.close(code, reason),
  }, undefined, () => {
    // The attach ended: maybe the shell exited. Refresh now, not at the next poll.
    void readShellSessions().then((list) => store.replace(list))
  })
  bridges.set(ws, bridge)
}

export function terminalMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  bridges.get(ws)?.input(raw)
}

export function terminalClose(ws: ServerWebSocket<WsData>): void {
  bridges.get(ws)?.close()
  bridges.delete(ws)
  companionLog(`\x1b[2mterminal detach ${ws.data.terminal?.key ?? "?"}\x1b[0m`)
}
