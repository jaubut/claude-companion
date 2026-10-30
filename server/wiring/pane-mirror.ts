import type { ServerWebSocket, Subprocess } from "bun"
import { companionLog } from "../lib/log"
import { herdrSocketCall } from "../lib/herdr-socket"
import { type KeyGate, keyGate, runTmux } from "../lib/key-gate"
import { PaneMirror, mirrorControl, mirrorKey, type MirrorSize, type MirrorSource, type MirrorViewer, type PaneSizer } from "../lib/pane-mirror"
import { type PaneRef, capturePane, paneKey, sendKeysArgs, tmuxPaneWidth } from "../lib/tmux-pane"
import { describeClient, type WsData } from "../state"

// /api/pane-mirror sockets (lib/pane-mirror.ts). One PaneMirror per pane
// (mirrorKey: herdr id, or tmux socket+pane), shared by up to
// MAX_MIRROR_VIEWERS sockets; the last one to close stops its poll and
// releases its size hold (herdr only: tmux has no sizer).

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

// A tmux pane: the visible screen with escapes (`capture-pane -e -p`, ~2.4 ms
// a spawn on tmux 3.4), its width, and keystrokes as `send-keys -H` hex bytes:
// byte-exact for ESC sequences, \x03, UTF-8 and a leading "-" (measured), one
// spawn per send. Sends take the pane's turn on the shared key gate, so they
// never interleave with an inject or a dialog key (a lone ESC opens the
// gate's chord window, as from any sender).
export function tmuxPaneSource(ref: PaneRef, gate: Pick<KeyGate, "send"> = keyGate): MirrorSource {
  const gk = paneKey(ref.pane, ref.socket)
  return {
    read: () => capturePane(ref.pane, undefined, { escapes: true, socket: ref.socket }),
    cols: () => tmuxPaneWidth(ref),
    async send(_pane, text) {
      const hex = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0"))
      await gate.send(gk, text, (signal) => runTmux(sendKeysArgs(ref, "-H", ...hex), signal))
    },
  }
}

// Sizes one pane with `herdr terminal session control <pane> --cols --rows`
// (lib/pane-mirror.ts header): spawned on the first size, resized over its
// stdin, released by closing stdin. Its frames go to /dev/null (the mirror
// still polls pane.read). If this server dies, the controller's stdin hits
// EOF, it exits, and herdr restores the pane.
export class HerdrPaneSizer implements PaneSizer {
  private proc: Subprocess<"pipe", "ignore", "ignore"> | null = null

  constructor(
    private pane: string,
    private lost: () => void,
    private argv0: string = process.env.HERDR_BIN || "herdr",
  ) {}

  set(size: MirrorSize | null): void {
    const p = this.proc
    if (!size) {
      if (!p) return
      this.proc = null
      try { void p.stdin.end() } catch { /* already gone */ }
      setTimeout(() => { if (p.exitCode === null) p.kill() }, 2_000)
      return
    }
    if (p) {
      try {
        p.stdin.write(JSON.stringify({ type: "terminal.resize", cols: size.cols, rows: size.rows }) + "\n")
        void p.stdin.flush()
      } catch { /* its exit handler reports the loss */ }
      return
    }
    const next = Bun.spawn(
      [this.argv0, "terminal", "session", "control", this.pane, "--cols", String(size.cols), "--rows", String(size.rows)],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
    )
    this.proc = next
    void next.exited.then((code) => {
      if (this.proc !== next) return
      this.proc = null
      companionLog(`\x1b[33mpane-mirror\x1b[0m size hold on ${this.pane} ended (exit ${code})`)
      this.lost()
    })
  }
}

const mirrors = new Map<string, PaneMirror>()
const viewers = new WeakMap<ServerWebSocket<WsData>, MirrorViewer>()

export const mirrorViewerCount = (key: string): number => mirrors.get(key)?.viewerCount ?? 0

export function mirrorOpen(ws: ServerWebSocket<WsData>, source?: MirrorSource): void {
  const t = ws.data.mirror!
  const { pane, key } = t
  const mk = mirrorKey(t)
  let m = mirrors.get(mk)
  if (!m) {
    if (t.tmux) m = new PaneMirror(pane, source ?? tmuxPaneSource(t.tmux))
    else {
      const sizer = new HerdrPaneSizer(pane, () => created.sizeLost())
      const created: PaneMirror = new PaneMirror(pane, source ?? herdrSocketSource, undefined, {}, sizer)
      m = created
    }
    mirrors.set(mk, m)
  }
  const v: MirrorViewer = {
    frame: (bytes) => { ws.sendBinary(new TextEncoder().encode(bytes)) },
    control: (json) => { ws.sendText(json) },
    end: (code, reason) => ws.close(code, reason),
  }
  viewers.set(ws, v)
  m.add(v)
  companionLog(`\x1b[36mpane-mirror\x1b[0m open ${key} ${mk} (${m.viewerCount}) ${describeClient("ws", ws.data.client)}`)
}

export function mirrorMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  const m = mirrors.get(mirrorKey(ws.data.mirror!))
  const v = viewers.get(ws)
  if (!m) return
  const data = typeof raw === "string" ? raw : new Uint8Array(raw)
  const size = mirrorControl(data)
  if (size) { if (v) m.resize(v, size) } else m.input(data)
}

export function mirrorClose(ws: ServerWebSocket<WsData>): void {
  const mk = mirrorKey(ws.data.mirror!)
  const v = viewers.get(ws)
  const m = mirrors.get(mk)
  if (v && m && m.remove(v)) mirrors.delete(mk)
  viewers.delete(ws)
  companionLog(`\x1b[2mpane-mirror close ${mk}\x1b[0m`)
}
