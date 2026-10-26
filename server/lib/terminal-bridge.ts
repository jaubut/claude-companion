// The phone's live terminal: a WebSocket on /api/terminal bridged to
// `tmux attach-session` running under a PTY on this host. The iPhone can't
// run tmux or ssh itself (the Mac Canvas does, TerminalAttach.swift), so the
// server is the terminal client and the phone is its screen and keyboard.
//
// Frames: server → phone binary = PTY output, as tmux draws it. Phone →
// server binary = keystrokes (raw bytes); text = JSON control, only
// {"type":"resize","cols":N,"rows":N}. The socket closes when the attach ends
// (shell `exit`, session killed) with code 4000 + reason "ended"; closing the
// socket only detaches — the shell keeps running in tmux.
//
// Auth is the server's /api/* Bearer gate (companion-server.ts, before the
// upgrade). Only shell sessions this server tracks can be attached: the key
// is looked up, never parsed into a target, and the argv carries nothing the
// phone typed.

import { tmuxArgv } from "./tmux-pane"
import type { ShellSession } from "./shell-sessions"

export const TERMINAL_PATH = "/api/terminal"
export const TERMINAL_ENDED = 4000

export interface TerminalSize { cols: number; rows: number }

// Phone-reported size, clamped to something tmux and a phone screen can both
// use. Anything unreadable → the iPhone portrait default.
export function terminalSize(cols: unknown, rows: unknown): TerminalSize {
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = v === null || v === undefined || v === "" ? NaN : Number(v)
    return Number.isInteger(n) ? Math.min(Math.max(n, lo), hi) : dflt
  }
  return { cols: clamp(cols, 20, 500, 50), rows: clamp(rows, 5, 200, 30) }
}

export function terminalAttachArgv(s: Pick<ShellSession, "name" | "tmuxSocket">): string[] {
  return [...tmuxArgv(s.tmuxSocket || null), "attach-session", "-t", `=${s.name}`]
}

// The attach process's env: a real terminal type, and no $TMUX — a server
// started inside tmux would otherwise get "sessions should be nested".
export function terminalEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "TMUX" || k === "TMUX_PANE") continue
    out[k] = v
  }
  out.TERM = "xterm-256color"
  out.LANG ||= "en_US.UTF-8"
  return out
}

// A resize control frame, or null for anything else (ignored).
export function parseControl(text: string): TerminalSize | null {
  try {
    const m = JSON.parse(text) as { type?: unknown; cols?: unknown; rows?: unknown }
    return m.type === "resize" ? terminalSize(m.cols, m.rows) : null
  } catch {
    return null
  }
}

export interface TerminalPty {
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  close(): void
  exited: Promise<number>
}

// The seam the WS handler goes through (tests pass a fake).
export type PtySpawner = (argv: string[], size: TerminalSize, onData: (data: Uint8Array) => void) => TerminalPty

export const spawnPty: PtySpawner = (argv, size, onData) => {
  const proc = Bun.spawn(argv, {
    env: terminalEnv(),
    terminal: { cols: size.cols, rows: size.rows, data: (_t, data) => onData(data) },
  })
  const term = proc.terminal!
  return {
    write: (data) => { term.write(data) },
    resize: (cols, rows) => term.resize(cols, rows),
    close: () => {
      try { proc.kill() } catch { /* already gone */ }
      try { term.close() } catch { /* already closed */ }
    },
    exited: proc.exited,
  }
}

// One open terminal socket. `send` / `end` are the socket's; the bridge
// owns the PTY and tears it down on either side's close.
export interface TerminalSocket {
  send(data: Uint8Array): void
  end(code: number, reason: string): void
}

export function openTerminal(
  shell: ShellSession,
  size: TerminalSize,
  sock: TerminalSocket,
  spawner: PtySpawner = spawnPty,
  onEnded: () => void = () => undefined,
): { input(data: string | Uint8Array | Buffer): void; close(): void } {
  let closed = false
  const pty = spawner(terminalAttachArgv(shell), size, (d) => { if (!closed) sock.send(d) })
  void pty.exited.then(() => {
    onEnded()
    if (closed) return
    closed = true
    sock.end(TERMINAL_ENDED, "ended")
  })
  return {
    input(data) {
      if (closed) return
      if (typeof data === "string") {
        const ctl = parseControl(data)
        if (ctl) pty.resize(ctl.cols, ctl.rows)
        return
      }
      pty.write(data instanceof Uint8Array ? data : new Uint8Array(data))
    },
    close() {
      if (closed) return
      closed = true
      pty.close()
    },
  }
}
