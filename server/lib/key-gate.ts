// One keyboard per pane, shared by every route that types into it (Codex
// MEDIUM on PR #38).
//
// Escape is a meta-chord PREFIX to Claude Code (see ESC_SETTLE_MS in
// lib/command-list.ts): a byte arriving within a few ms of it is read as
// opt+<byte>, the Escape never fires and the byte is swallowed. Holding the
// /api/dialog/key response for the settle only serialised ONE client's taps;
// a second request (another phone, a retry, /api/model/cancel, the /help
// close path) could still send inside the window and lose its key.
//
// So the cooldown lives here, keyed by tmux pane, and every sender goes
// through `send()`:
//   - sends to one pane run strictly one after another (a promise chain), so
//     two requests that arrive together cannot both pass the check and fire
//     at once;
//   - after an Escape, the next send on that pane starts no earlier than
//     ESC_SETTLE_MS after the Escape's send-keys RETURNED (measured from
//     completion, so a slow tmux cannot eat into the window).
// Other keys add no cooldown: only Escape opens a chord window, and the
// dialog arrows would crawl if every key cost 250ms.
//
// Module state on purpose, like command-scrape's flow map: a per-process fact
// about a pane that every consumer must see the same way.

import { ESC_SETTLE_MS } from "./command-list"

export interface KeyGateDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  settleMs?: number
}

export interface KeyGate {
  // Run `doSend` (one tmux send-keys) when it is this pane's turn. `key` is
  // what is being sent, used only to decide whether it opens a chord window.
  send<T>(pane: string, key: string, doSend: () => Promise<T>): Promise<T>
  // Earliest time the next key may go to this pane (0 = now). For tests/logs.
  earliestNextSend(pane: string): number
  reset(): void
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Named Escape, the raw ESC byte (the dialog route accepts one literal
// character), and its C-[ alias all reach the pane as the same prefix.
export function opensChordWindow(key: string): boolean {
  return key === "Escape" || key === "\x1b" || key === "C-["
}

export function createKeyGate(deps: KeyGateDeps = {}): KeyGate {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const settleMs = deps.settleMs ?? ESC_SETTLE_MS
  const earliest = new Map<string, number>()
  const tails = new Map<string, Promise<void>>()

  function send<T>(pane: string, key: string, doSend: () => Promise<T>): Promise<T> {
    const prev = tails.get(pane) ?? Promise.resolve()
    const run = prev.then(async () => {
      const wait = (earliest.get(pane) ?? 0) - now()
      if (wait > 0) await sleep(wait)
      try {
        return await doSend()
      } finally {
        // Set even when the send threw: the Escape may well have reached the
        // pane before tmux reported the failure.
        if (opensChordWindow(key)) earliest.set(pane, now() + settleMs)
      }
    })
    const tail = run.then(() => undefined, () => undefined)
    tails.set(pane, tail)
    // Drop the chain once idle so the map does not grow with every pane ever seen.
    void tail.then(() => { if (tails.get(pane) === tail) tails.delete(pane) })
    return run
  }

  return {
    send,
    earliestNextSend: (pane) => earliest.get(pane) ?? 0,
    reset: () => { earliest.clear(); tails.clear() },
  }
}

export const keyGate = createKeyGate()
