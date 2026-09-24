// Did an injected prompt actually get submitted?
//
// `tmux send-keys` exiting 0 only proves tmux accepted the bytes. A modal in
// the pane, a swallowed Enter or a TUI mid-redraw can eat the prompt, and the
// phone then shows a "Thinking" pill for a turn that never started (audit
// 2026-09-24: 3 injects into Zettlab pane %89 logged "delivered (tmux)" with
// no UserPromptSubmit hook and nothing in the transcript; ~30 lost
// historically).
//
// The proof of submission is Claude Code's own UserPromptSubmit hook for the
// same session. So an inject arms a watch BEFORE its Enter is sent (the hook
// can land before send-keys returns), waits up to SUBMIT_WINDOW_MS, presses
// Enter once more if nothing came, waits again, and otherwise reports
// `not_submitted` with a short pane excerpt.

import { keyGate } from "./key-gate"
import { INJECT_SEND_MS, injectText, resolveTmuxPaneFromTty, tmuxCapture, tmuxSendKeys, type InjectTarget } from "./keyboard-inject"

export const SUBMIT_WINDOW_MS = 3_000

// Who a UserPromptSubmit hook (or a watch) is about. Any non-empty field that
// matches is enough: the hook's session key is derived from the same tty /
// session id the inject target was registered with.
export interface SubmitIdentity {
  key?: string
  sessionId?: string
  tty?: string
}

// Timer seam so the tests drive the window with a fake clock.
export interface SubmitClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: SubmitClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface SubmitWatch {
  // Resolves true as soon as a matching hook has fired since the watch was
  // armed (immediately if one already did), false after `ms`.
  wait(ms: number, clock?: SubmitClock): Promise<boolean>
  close(): void
}

interface Watch {
  id: SubmitIdentity
  hits: number
  wake: (() => void) | null
}

const watches = new Set<Watch>()

function same(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a === b
}

function matches(w: SubmitIdentity, from: SubmitIdentity): boolean {
  return same(w.key, from.key) || same(w.sessionId, from.sessionId) || same(w.tty, from.tty)
}

// Called by the /hooks/user-prompt-submit route for every hook fire.
export function noteUserPromptSubmit(from: SubmitIdentity): void {
  for (const w of watches) {
    if (!matches(w.id, from)) continue
    w.hits++
    w.wake?.()
  }
}

export function watchSubmit(id: SubmitIdentity): SubmitWatch {
  const w: Watch = { id, hits: 0, wake: null }
  watches.add(w)
  return {
    wait(ms, clock = realClock) {
      if (w.hits > 0) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        const done = (seen: boolean) => {
          w.wake = null
          clock.clearTimeout(timer)
          resolve(seen)
        }
        const timer = clock.setTimeout(() => done(false), ms)
        w.wake = () => done(true)
      })
    },
    close() {
      w.wake = null
      watches.delete(w)
    },
  }
}

// Tests only.
export function activeWatchCount(): number {
  return watches.size
}

export type ConfirmResult =
  | { ok: true; confirmed: true; retried: boolean }
  // No hook, but the pane shows Claude mid-turn: the prompt is queued behind
  // the running turn and its hook fires when that turn ends. Not a failure.
  | { ok: true; confirmed: false; queued: true }
  | { ok: false; error: "not_submitted"; excerpt: string }

export interface ConfirmDeps {
  watch: SubmitWatch
  pressEnter: () => Promise<boolean>
  capture: () => Promise<string | null>
  // Claude was busy at inject time (sessions.json said so).
  busy?: boolean
  windowMs?: number
  clock?: SubmitClock
}

const BUSY_RE = /esc to interrupt/i

// Last few non-blank lines of the pane, capped — enough for the phone to show
// what ate the prompt (a modal, a picker) without shipping the scrollback.
export function paneExcerpt(pane: string | null, lines = 8, maxChars = 600): string {
  if (!pane) return ""
  const tail = pane.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-lines).join("\n")
  return tail.length > maxChars ? tail.slice(-maxChars) : tail
}

export async function confirmSubmit(deps: ConfirmDeps): Promise<ConfirmResult> {
  const windowMs = deps.windowMs ?? SUBMIT_WINDOW_MS
  if (await deps.watch.wait(windowMs, deps.clock)) return { ok: true, confirmed: true, retried: false }
  // A busy Claude queues the prompt: no hook until its turn ends, and a second
  // Enter would only submit an empty line. Don't call that lost.
  const before = await deps.capture()
  if (deps.busy || (before && BUSY_RE.test(before))) return { ok: true, confirmed: false, queued: true }
  await deps.pressEnter()
  if (await deps.watch.wait(windowMs, deps.clock)) return { ok: true, confirmed: true, retried: true }
  return { ok: false, error: "not_submitted", excerpt: paneExcerpt(await deps.capture()) }
}

// What the inject routes answer with.
export type InjectOutcome =
  | { ok: true; confirmed: boolean; retried?: boolean; queued?: boolean }
  | { ok: false; error: "deliver_failed" }
  | { ok: false; error: "not_submitted"; excerpt: string }

export interface ConfirmTarget extends InjectTarget {
  key?: string
  sessionId?: string
  agent?: string
  agentStatus?: string
}

// A pane we can both re-press Enter in and read back. Linux sessions without
// a recorded pane resolve it from the tty, as injectText does.
async function confirmPane(target: ConfirmTarget): Promise<string> {
  const pane = target.tmuxPane?.trim() ?? ""
  if (/^%\d+$/.test(pane)) return pane
  if (target.tty && process.platform === "linux") return (await resolveTmuxPaneFromTty(target.tty)) ?? ""
  return ""
}

function pressEnterIn(pane: string): () => Promise<boolean> {
  return async () => {
    try {
      const r = await keyGate.send(pane, "Enter", (signal) => tmuxSendKeys(["send-keys", "-t", pane, "Enter"], 2000, signal), { timeoutMs: INJECT_SEND_MS })
      return r.ok
    } catch {
      return false
    }
  }
}

// injectText + submit confirmation. Only Claude sessions in a tmux pane are
// confirmed: that is where the hook is guaranteed and the pane is readable.
// Everything else keeps the old "delivered = sent" answer (confirmed: false).
export async function injectConfirmed(text: string, target: ConfirmTarget | undefined): Promise<InjectOutcome> {
  const pane = target && (target.agent ?? "claude") === "claude" ? await confirmPane(target) : ""
  if (!target || !pane) {
    return (await injectText(text, target)) ? { ok: true, confirmed: false } : { ok: false, error: "deliver_failed" }
  }
  const watch = watchSubmit({ key: target.key, sessionId: target.sessionId, tty: target.tty })
  try {
    if (!(await injectText(text, { ...target, tmuxPane: pane }))) return { ok: false, error: "deliver_failed" }
    const r = await confirmSubmit({
      watch,
      pressEnter: pressEnterIn(pane),
      capture: () => tmuxCapture(pane),
      busy: target.agentStatus === "busy",
    })
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"; const green = "\x1b[32m"; const yellow = "\x1b[33m"
    const line = !r.ok ? `${red}not submitted${reset} — no UserPromptSubmit after Enter + retry`
      : r.confirmed ? `${green}submit confirmed${reset}${r.retried ? " (after Enter retry)" : ""}`
      : `${yellow}submit queued${reset} — Claude busy, hook fires at turn end`
    process.stderr.write(`${dim}[companion]${reset} ${line} → ${pane}\n`)
    if (!r.ok) return r
    return r.confirmed ? { ok: true, confirmed: true, retried: r.retried } : { ok: true, confirmed: false, queued: true }
  } finally {
    watch.close()
  }
}
