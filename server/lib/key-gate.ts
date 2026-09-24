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
// So the cooldown lives here, keyed by tmux pane — socket+pane, via paneKey()
// in lib/tmux-argv.ts, since %N is only unique per tmux server — and every sender goes
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
// A queue must never wedge (Codex HIGH round 3): a tmux that hangs inside one
// send used to block every later send on that pane forever. So every turn
// runs under a deadline (SEND_TIMEOUT_MS). On expiry the callback's
// AbortSignal fires (runTmux kills its subprocess on it), the send rejects
// with KeyGateTimeout, one line is logged, and the next sender proceeds.
// A caller that must answer by a fixed time (an inject) passes `startBy`:
// if its turn has not STARTED by then it is rejected, and its queued turn is
// cancelled — it will not type late into a pane the caller already gave up on.
//
// Module state on purpose, like command-scrape's flow map: a per-process fact
// about a pane that every consumer must see the same way.

import { companionLog } from "./log"
import { ESC_SETTLE_MS } from "./command-list"
import { paneKey, tmuxArgv } from "./tmux-argv"

// How long one turn (normally a single send-keys) may hold a pane's queue.
// A healthy send-keys returns in a few ms; this is only for a wedged tmux.
export const SEND_TIMEOUT_MS = 3_000

export class KeyGateTimeout extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KeyGateTimeout"
  }
}

export interface KeyGateDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  settleMs?: number
  sendTimeoutMs?: number
  log?: (line: string) => void
}

export interface SendOpts {
  // Per-turn deadline override, ms (default SEND_TIMEOUT_MS).
  timeoutMs?: number
  // Absolute time (gate clock) by which this turn must have STARTED. Past it,
  // the send rejects with KeyGateTimeout and never runs. Once started, the
  // turn is bounded by timeoutMs, so the caller's worst case is
  // startBy + timeoutMs.
  startBy?: number
}

export interface KeyGate {
  // Run `doSend` (one tmux send-keys) when it is this pane's turn. `key` is
  // what is being sent, used only to decide whether it opens a chord window.
  // `doSend` gets an AbortSignal that fires when its deadline passes; pass it
  // to runTmux so a hung subprocess is killed rather than orphaned.
  send<T>(pane: string, key: string, doSend: (signal: AbortSignal) => Promise<T>, opts?: SendOpts): Promise<T>
  // Earliest time the next key may go to this pane (0 = now).
  earliestNextSend(pane: string): number
  // How long until that is (0 when no window is open). Read by
  // command-scrape's yieldPane, which must not call a pane free inside one.
  remainingMs(pane: string): number
  // Drop everything known about a pane (it was retired).
  forget(pane: string): void
  // Entries currently tracked. Tests only: the maps must not grow forever.
  size(): { windows: number; queues: number }
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
  const sendTimeoutMs = deps.sendTimeoutMs ?? SEND_TIMEOUT_MS
  const log = deps.log ?? companionLog
  const earliest = new Map<string, number>()
  const tails = new Map<string, Promise<void>>()

  // A window is only worth remembering while it is open. Expire it once it
  // has passed — guarded, so a NEWER Escape's window is never cut short — so
  // a pane that is destroyed right after an Escape does not stay in the map.
  function openWindow(pane: string, until: number): void {
    earliest.set(pane, until)
    const t = setTimeout(() => {
      if (earliest.get(pane) === until && until <= now()) earliest.delete(pane)
    }, Math.max(0, until - now()) + 1)
    ;(t as { unref?: () => void }).unref?.()
  }

  function remainingMs(pane: string): number {
    const until = earliest.get(pane)
    if (until === undefined) return 0
    const left = until - now()
    if (left <= 0) earliest.delete(pane)
    return Math.max(0, left)
  }

  // Run one turn under its deadline. The race lets the queue move on even if
  // `doSend` never settles; the abort tells it to stop (and kill tmux).
  async function runBounded<T>(pane: string, key: string, doSend: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort()
        log(`key gate: send "${key}" to ${pane} timed out after ${timeoutMs}ms — skipped, queue continues`)
        reject(new KeyGateTimeout(`send to ${pane} timed out after ${timeoutMs}ms`))
      }, Math.max(0, timeoutMs))
    })
    try {
      return await Promise.race([doSend(ac.signal), expired])
    } finally {
      clearTimeout(timer)
      // Set even when the send threw or timed out: the Escape may well have
      // reached the pane before tmux reported the failure.
      if (opensChordWindow(key)) openWindow(pane, now() + settleMs)
    }
  }

  function send<T>(pane: string, key: string, doSend: (signal: AbortSignal) => Promise<T>, opts: SendOpts = {}): Promise<T> {
    const prev = tails.get(pane) ?? Promise.resolve()
    const startBy = opts.startBy
    let cancelled = false
    let started = false
    const tooLate = () => new KeyGateTimeout(`no turn on ${pane} before the caller's deadline`)
    const work = prev.then(async () => {
      if (cancelled) throw tooLate()
      const wait = remainingMs(pane)
      // Do not sleep into a deadline we already know we will miss.
      if (startBy !== undefined && now() + wait >= startBy) throw tooLate()
      if (wait > 0) await sleep(wait)
      if (cancelled) throw tooLate()
      // A stalled event loop can resume this continuation before the
      // deadline timer fires: check the clock itself, not just the flag.
      if (startBy !== undefined && now() >= startBy) throw tooLate()
      started = true
      return runBounded(pane, key, doSend, opts.timeoutMs ?? sendTimeoutMs)
    })
    const tail = work.then(() => undefined, () => undefined)
    tails.set(pane, tail)
    // Drop the chain once idle so the map does not grow with every pane ever seen.
    void tail.then(() => { if (tails.get(pane) === tail) tails.delete(pane) })
    if (startBy === undefined) return work

    // The caller's deadline counts while it is still QUEUED behind a slow
    // sender: reject at startBy, and cancel the queued turn so it never runs.
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (started) return
        cancelled = true
        reject(tooLate())
      }, Math.max(0, startBy - now()))
      work.then(
        (v) => { clearTimeout(timer); resolve(v) },
        (e) => { clearTimeout(timer); reject(e) },
      )
    })
  }

  return {
    send,
    earliestNextSend: (pane) => earliest.get(pane) ?? 0,
    remainingMs,
    forget: (pane) => { earliest.delete(pane); tails.delete(pane) },
    size: () => ({ windows: earliest.size, queues: tails.size }),
    reset: () => { earliest.clear(); tails.clear() },
  }
}

export const keyGate = createKeyGate()

// One tmux invocation that dies with its turn: when the gate's deadline
// fires, the subprocess is killed instead of left holding the pane's queue.
// Resolves to the exit code; rejects only if tmux could not be spawned.
// `socket` is the session's tmux server (lib/tmux-argv.ts); omit for default.
export async function runTmux(args: readonly string[], signal?: AbortSignal, socket?: string): Promise<number> {
  const proc = Bun.spawn(tmuxArgv(socket, args), { stdout: "ignore", stderr: "ignore" })
  const kill = () => { try { proc.kill() } catch { /* already gone */ } }
  if (signal?.aborted) kill()
  signal?.addEventListener("abort", kill, { once: true })
  try {
    return await proc.exited
  } finally {
    signal?.removeEventListener("abort", kill)
  }
}

// One tmux command for a session's pane, as one turn of that pane's gate, on
// the pane's own server. What the routes that drive a pane go through.
export interface PaneRef { tmuxPane: string; tmuxSocket?: string }
export function gatedTmux(p: PaneRef, key: string, args: readonly string[]): Promise<number> {
  return keyGate.send(paneKey(p.tmuxPane, p.tmuxSocket), key, (signal) => runTmux(args, signal, p.tmuxSocket))
}
