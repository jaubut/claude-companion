// SPIKE: the phone's "Terminal" view of a herdr Claude session — the real
// Claude TUI, mirrored off herdr's pane instead of a PTY this server owns
// (lib/terminal-bridge.ts is the tmux-shell twin).
//
// Why polling: herdr 0.9.5 lists `pane_output_changed` in its event schema,
// but `events.subscribe` rejects it (unknown variant) and `events.wait` only
// matches agent status (unsupported_event_wait_match). `pane.read` carries
// `revision: 0` always. So the mirror polls `pane.read --source visible
// --format ansi` over the socket (lib/herdr-socket.ts, ~0.7 ms while Claude
// streams) and sends a frame only when the screen changed.
//
// Frames: server → phone text = JSON control ({"type":"size",cols,rows} before
// the first frame and on change); binary = one full repaint (cursor-addressed
// rows, each cleared first). Phone → server binary = keystrokes as bytes,
// passed to `pane.send_text`, which writes them to the PTY verbatim (measured:
// ESC[B moves Claude's "/" menu, a lone ESC closes it, \x03 is Ctrl-C).
// Text frames from the phone (resize) are ignored: herdr has no API to size a
// pane, and attaching a client to force one reflows the Mac's view (the last
// attached client sets every pane's PTY size and detaching doesn't restore).
//
// The phone can't choose the width: it gets the Mac's (e.g. 153x54) and
// scales or pans it.

import { clientOrigin, peerOf } from "./vault-guard"
import { herdrPaneOf } from "./herdr"

export const PANE_MIRROR_PATH = "/api/pane-mirror"
export const MAX_MIRROR_VIEWERS = 3
export const MIRROR_POLL_MS = 50
export const MIRROR_MIN_FRAME_MS = 33
// After a keystroke, poll this soon instead of waiting out the tick: the
// pane echoed a key into a read within ~4 ms (measured).
export const MIRROR_ECHO_MS = 8
export const MIRROR_MAX_INPUT = 4096
export const MIRROR_ENDED = 4000
// Consecutive unreadable polls before the viewers are told the pane is gone.
export const MIRROR_GONE_AFTER = 20

// ── Upgrade gate ──────────────────────────────────────────────────────────

export interface MirrorTarget { key: string; pane: string }
export interface MirrorUpgradeDeps {
  authorized(req: Request): boolean // Bearer, header only
  lookup(key: string): { key: string; herdrPane?: string; tmuxPane?: string } | null
  viewers(pane: string): number
}

// The pane to mirror, or the refusal. Same order and codes as /api/terminal:
// 401 auth, 403 network, 410 unknown key, then 409 not_herdr and 429.
export function paneMirrorUpgrade(req: Request, url: URL, deps: MirrorUpgradeDeps): MirrorTarget | Response {
  if (!deps.authorized(req)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
  if (clientOrigin(req, peerOf(req)).transport === "untrusted") {
    return Response.json({ ok: false, error: "network_refused" }, { status: 403 })
  }
  const key = url.searchParams.get("key") ?? ""
  const s = key ? deps.lookup(key) : null
  // Exact key only: resolveSession also accepts cwd:/sid: lookups.
  if (!s || s.key !== key) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })
  const pane = herdrPaneOf(s)
  if (!pane) return Response.json({ ok: false, error: "not_herdr" }, { status: 409 })
  if (deps.viewers(pane) >= MAX_MIRROR_VIEWERS) return Response.json({ ok: false, error: "too_many_viewers" }, { status: 429 })
  return { key, pane }
}

// ── Frames ────────────────────────────────────────────────────────────────

// herdr ends rows with CRLF and the visible read ends with one.
export function screenRows(ansi: string): string[] {
  const rows = ansi.replace(/\r\n/g, "\n").split("\n")
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop()
  return rows
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function visibleWidth(row: string): number {
  return [...row.replace(ANSI_RE, "")].length
}

export interface MirrorSize { cols: number; rows: number }

// Rows from the frame; cols from herdr's layout when it knows, never less
// than the widest row (layout rects include borders and can lag).
export function frameSize(ansi: string, layoutCols: number | null): MirrorSize {
  const rows = screenRows(ansi)
  const widest = rows.reduce((m, r) => Math.max(m, visibleWidth(r)), 0)
  return { cols: Math.max(layoutCols ?? 0, widest, 1), rows: Math.max(rows.length, 1) }
}

// One full repaint: cursor hidden, then each row addressed, cleared, drawn and
// reset. No whole-screen clear, so no flash between frames; clearing the row
// before drawing (not after) keeps a full-width row's last cell, which an
// erase-to-end at the pending-wrap position would wipe.
export function repaintFrame(ansi: string): string {
  const rows = screenRows(ansi)
  let out = "\x1b[?25l"
  rows.forEach((row, i) => { out += `\x1b[${i + 1};1H\x1b[2K${row}\x1b[0m` })
  return out
}

// ── Input ─────────────────────────────────────────────────────────────────

const decoder = new TextDecoder("utf-8", { fatal: false })

// Phone keystrokes → the text for `pane.send_text`, or null (nothing to
// send). Binary only: text frames are control, and resize is not possible.
export function mirrorInput(data: string | Uint8Array): string | null {
  if (typeof data === "string") return null
  if (data.length === 0 || data.length > MIRROR_MAX_INPUT) return null
  const text = decoder.decode(data)
  return text.length ? text : null
}

// ── Coalescing ────────────────────────────────────────────────────────────

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}
export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

// Latest-wins: at most one frame per `minMs`; a burst inside the window sends
// only its last screen when the window ends. Identical screens never resend.
export class FrameCoalescer {
  private last: string | null = null
  private lastAt = -Infinity
  private pending: string | null = null
  private timer: unknown = null

  constructor(private minMs: number, private emit: (frame: string) => void, private clock: Clock = realClock) {}

  offer(frame: string): void {
    if (this.timer === null && frame === this.last) return
    this.pending = frame
    if (this.timer !== null) return
    const wait = this.lastAt + this.minMs - this.clock.now()
    if (wait <= 0) this.flush()
    else this.timer = this.clock.setTimeout(() => { this.timer = null; this.flush() }, wait)
  }

  current(): string | null { return this.last }

  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private flush(): void {
    const f = this.pending
    this.pending = null
    if (f === null || f === this.last) return
    this.last = f
    this.lastAt = this.clock.now()
    this.emit(f)
  }
}

// ── One mirrored pane, shared by its viewers ──────────────────────────────

export interface MirrorViewer {
  frame(bytes: string): void
  control(json: string): void
  end(code: number, reason: string): void
}

export interface MirrorSource {
  read(pane: string): Promise<string | null>
  cols(pane: string): Promise<number | null>
  send(pane: string, text: string): Promise<void>
}

export class PaneMirror {
  private viewers = new Set<MirrorViewer>()
  private coalescer: FrameCoalescer
  private size: MirrorSize | null = null
  private layoutCols: number | null = null
  private misses = 0
  private polls = 0
  private timer: unknown = null
  private running = false
  private stopped = false
  private inputChain: Promise<void> = Promise.resolve()

  constructor(
    readonly pane: string,
    private source: MirrorSource,
    private clock: Clock = realClock,
    private opts: { pollMs?: number; minFrameMs?: number } = {},
  ) {
    this.coalescer = new FrameCoalescer(opts.minFrameMs ?? MIRROR_MIN_FRAME_MS, (ansi) => this.broadcast(ansi), clock)
  }

  get viewerCount(): number { return this.viewers.size }

  add(v: MirrorViewer): void {
    this.viewers.add(v)
    const cur = this.coalescer.current()
    if (cur !== null && this.size) {
      v.control(JSON.stringify({ type: "size", ...this.size }))
      v.frame(repaintFrame(cur))
    }
    if (!this.running && !this.stopped) { this.running = true; void this.poll() }
  }

  // True when this was the last viewer (the caller drops the mirror).
  remove(v: MirrorViewer): boolean {
    this.viewers.delete(v)
    if (this.viewers.size === 0) this.stop()
    return this.viewers.size === 0
  }

  input(data: string | Uint8Array): void {
    const text = mirrorInput(data)
    if (text === null || this.stopped) return
    // In order, one at a time: keystrokes must not overtake each other.
    this.inputChain = this.inputChain.then(() => this.source.send(this.pane, text)).then(() => this.kick(), () => undefined)
  }

  // Pull the next poll forward (only between polls: a poll in flight
  // reschedules itself).
  private kick(): void {
    if (this.stopped || this.timer === null) return
    this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => { this.timer = null; void this.poll() }, MIRROR_ECHO_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.coalescer.stop()
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    // Layout width every ~2 s (Mac window resizes), not every poll.
    if (this.polls++ % 40 === 0) this.layoutCols = await this.source.cols(this.pane).catch(() => null)
    const ansi = await this.source.read(this.pane).catch(() => null)
    if (this.stopped) return
    if (ansi === null) {
      if (++this.misses >= MIRROR_GONE_AFTER) {
        for (const v of [...this.viewers]) v.end(MIRROR_ENDED, "gone")
        this.viewers.clear()
        this.stop()
        return
      }
    } else {
      this.misses = 0
      this.coalescer.offer(ansi)
    }
    this.timer = this.clock.setTimeout(() => { this.timer = null; void this.poll() }, this.opts.pollMs ?? MIRROR_POLL_MS)
  }

  private broadcast(ansi: string): void {
    const size = frameSize(ansi, this.layoutCols)
    const sizeChanged = !this.size || size.cols !== this.size.cols || size.rows !== this.size.rows
    this.size = size
    const frame = repaintFrame(ansi)
    for (const v of this.viewers) {
      if (sizeChanged) v.control(JSON.stringify({ type: "size", ...size }))
      v.frame(frame)
    }
  }
}
