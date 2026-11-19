import type { ServerWebSocket } from "bun"
import { boardRecords, boardRoom } from "../lib/board-room"
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
  boardRoom().handleSocketMessage(ws.data.board!.sessionId, typeof raw === "string" ? raw : raw.toString(), ws)
}

export function boardClose(ws: ServerWebSocket<WsData>): void {
  boardRoom().handleSocketClose(ws.data.board!.sessionId, ws)
}
