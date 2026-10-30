// A session's terminal as the phone-driven flows (slash suggest, model
// picker) drive it: tmux when the session has a tmux pane, else herdr.
//
// Every key and literal goes through the shared per-pane gate
// (lib/key-gate.ts), so nothing here can land inside another sender's chord
// window (a phone Escape, a cancel), and a send that wedges is killed at the
// gate's deadline and reads as a failed send (false).

import { unstyle } from "./command-menu"
import { type Herdr, herdrGatedKey, herdrGatedText, herdrPaneOf, realHerdr } from "./herdr"
import { type KeyGate, keyGate, runTmux } from "./key-gate"
import { type PaneRef, capturePane, paneKey, paneRefOf, sendKeysArgs } from "./tmux-pane"

export interface SessionPane {
  // escapes = the `capture-pane -e` shape. herdr's read is always styled
  // (`--format ansi`); without escapes it is unstyled to plain text.
  capture(escapes?: boolean): Promise<string | null>
  // A named key (Enter, Escape, Up, C-u…).
  key(key: string): Promise<boolean>
  // Literal text, typed as-is.
  literal(text: string): Promise<boolean>
}

type GateSend = Pick<KeyGate, "send">

async function gated(gate: GateSend, gateKey: string, key: string, send: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> {
  try {
    await gate.send(gateKey, key, send)
    return true
  } catch {
    return false
  }
}

export function tmuxSessionPane(ref: PaneRef, gate: GateSend = keyGate): SessionPane {
  const gk = paneKey(ref.pane, ref.socket)
  return {
    capture: (escapes = false) => capturePane(ref.pane, undefined, { escapes, socket: ref.socket }),
    key: (key) => gated(gate, gk, key, (signal) => runTmux(sendKeysArgs(ref, key), signal)),
    literal: (text) => gated(gate, gk, text, (signal) => runTmux(sendKeysArgs(ref, "-l", text), signal)),
  }
}

// Sends ride the pane's key-gate turn with its abort (herdrGatedKey/Text).
export function herdrSessionPane(pane: string, h: Herdr = realHerdr, gate: GateSend = keyGate): SessionPane {
  return {
    capture: async (escapes = false) => {
      const text = await h.read(pane)
      return text === null || escapes ? text : unstyle(text)
    },
    key: (key) => herdrGatedKey(gate, pane, key, h),
    literal: (text) => herdrGatedText(gate, pane, text, h),
  }
}

// The session's drivable pane, or null when it has neither a tmux pane nor a
// herdr one (a plain terminal: nothing can be typed into it from here).
export function sessionPaneOf(session: { tmuxPane?: string; tmuxSocket?: string; herdrPane?: string } | null | undefined): SessionPane | null {
  const ref = paneRefOf(session)
  if (ref) return tmuxSessionPane(ref)
  const herdrPane = herdrPaneOf(session)
  return herdrPane ? herdrSessionPane(herdrPane) : null
}
