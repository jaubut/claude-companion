import type { ServerWebSocket } from "bun"
import { boardRecords, boardRoom, boardSchemaMismatch } from "../lib/board-room"
import { companionLog } from "../lib/log"
import { type WsData, describeClient } from "../state"

// The board sync socket (GET /api/board/sync, canvas-board-sync): ws.ts hands
// a socket whose `data.board` is set here, and these hand it to the room.
// Never in `clients`; the tldraw sync protocol is the only traffic.

export function boardOpen(ws: ServerWebSocket<WsData>): void {
  const sessionId = ws.data.board!.sessionId
  const room = boardRoom()
  room.handleSocketConnect({ sessionId, socket: ws })
  // The connect message carries every record: watch its size (live frames).
  const bytes = JSON.stringify(boardRecords(room)).length
  companionLog(`\x1b[2mboard open ${describeClient("ws", ws.data.client)} records≈${Math.round(bytes / 1024)}KB sessions=${room.getNumActiveSessions()}\x1b[0m`)
}

export function boardMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  const sessionId = ws.data.board!.sessionId
  const msg = typeof raw === "string" ? raw : raw.toString()
  // TLSyncClient serializes `type` first; a connect is never chunked (tiny next to the 256K chunk size).
  if (msg.startsWith('{"type":"connect"')) {
    let schema: unknown
    try { schema = (JSON.parse(msg) as { schema?: unknown }).schema } catch { /* the room reports it */ }
    const refused = boardSchemaMismatch(schema)
    if (refused) {
      companionLog(`board refused ${describeClient("ws", ws.data.client)}: ${refused}`)
      boardRoom().closeSession(sessionId, refused)
      return
    }
  }
  boardRoom().handleSocketMessage(sessionId, msg, ws)
}

export function boardClose(ws: ServerWebSocket<WsData>): void {
  boardRoom().handleSocketClose(ws.data.board!.sessionId, ws)
}
