import type { ServerWebSocket } from "bun"
import { companionLog } from "../lib/log"
import { herdrSocketCall } from "../lib/herdr-socket"
import { PaneMirror, type MirrorSource, type MirrorViewer } from "../lib/pane-mirror"
import { describeClient, type WsData } from "../state"

// /api/pane-mirror sockets (lib/pane-mirror.ts). One PaneMirror per
// herdr pane, shared by up to MAX_MIRROR_VIEWERS sockets; the last one to
// close stops its poll.

export const herdrSocketSource: MirrorSource = {
  async read(pane) {
    const r = await herdrSocketCall("pane.read", { pane_id: pane, source: "visible", format: "ansi" }, { timeoutMs: 1_500 })
    const text = (r.read as { text?: unknown } | undefined)?.text
    return typeof text === "string" ? text : null
  },
  async cols(pane) {
    const r = await herdrSocketCall("pane.layout", { pane_id: pane }, { timeoutMs: 1_500 })
    const panes = (r.layout as { panes?: Array<{ pane_id?: string; rect?: { width?: number } }> } | undefined)?.panes ?? []
    const w = panes.find((p) => p.pane_id === pane)?.rect?.width
    return typeof w === "number" && w > 0 ? w : null
  },
  async send(pane, text) {
    await herdrSocketCall("pane.send_text", { pane_id: pane, text }, { timeoutMs: 1_500 })
  },
}

const mirrors = new Map<string, PaneMirror>()
const viewers = new WeakMap<ServerWebSocket<WsData>, MirrorViewer>()

export const mirrorViewerCount = (pane: string): number => mirrors.get(pane)?.viewerCount ?? 0

export function mirrorOpen(ws: ServerWebSocket<WsData>, source: MirrorSource = herdrSocketSource): void {
  const { pane, key } = ws.data.mirror!
  let m = mirrors.get(pane)
  if (!m) { m = new PaneMirror(pane, source); mirrors.set(pane, m) }
  const v: MirrorViewer = {
    frame: (bytes) => { ws.sendBinary(new TextEncoder().encode(bytes)) },
    control: (json) => { ws.sendText(json) },
    end: (code, reason) => ws.close(code, reason),
  }
  viewers.set(ws, v)
  m.add(v)
  companionLog(`\x1b[36mpane-mirror\x1b[0m open ${key} ${pane} (${m.viewerCount}) ${describeClient("ws", ws.data.client)}`)
}

export function mirrorMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  mirrors.get(ws.data.mirror!.pane)?.input(typeof raw === "string" ? raw : new Uint8Array(raw))
}

export function mirrorClose(ws: ServerWebSocket<WsData>): void {
  const pane = ws.data.mirror!.pane
  const v = viewers.get(ws)
  const m = mirrors.get(pane)
  if (v && m && m.remove(v)) mirrors.delete(pane)
  viewers.delete(ws)
  companionLog(`\x1b[2mpane-mirror close ${pane}\x1b[0m`)
}
