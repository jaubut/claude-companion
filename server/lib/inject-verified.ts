// Deliver `/compact keep: …` so Claude Code EXECUTES it, and prove it landed
// before Enter. Two bugs shaped this:
//
// 1. Burst head loss (companion.log 2026-10-06 22:35-22:37, ttys010). Typing
//    the whole `/compact keep: <1.5k chars>` in one `send-keys -l` burst lost
//    its head on the Mac: the `/` opens Claude Code's command menu while the
//    rest of the burst is still arriving. The session got a prompt that began
//    mid-keep-text and submitted it as a normal prompt.
//
// 2. Pasted slash commands never run (seen live 2026-10-06). The fix for (1)
//    (PR #144) used ONE bracketed paste. Claude Code treats bracketed-paste
//    input as pasted content: the prompt arrives as a <pasted_content> block
//    and a pasted slash command is never executed. The read-back passed (the
//    line did start with `/compact`), Enter went in, nothing compacted, and
//    the next boundary pasted the same command again (3 times).
//
// So here: TYPED, in stages, never pasted. `/compact` alone first, a pause so
// the command menu settles, then the rest (` keep: …`) in small `send-keys -l`
// chunks with a short gap. The input box is read back (wrapped rows included,
// command-menu.ts inputText) and Enter is pressed only when it starts with
// the command's head. A mismatch clears the line (Ctrl-U) and retries once
// with the short generic command, typed the same way; if that also
// mismatches nothing is submitted.
//
// VERIFIED_TEXT_MAX stays 800: typed text has no paste-placeholder problem,
// but the input box grows one row per wrap (~10 rows at 80 columns) and a
// short pane must still show the whole box for the read-back.
//
// Clearing (live 2026-10-08, pane %204): Claude Code's Ctrl-U deletes ONE row
// of a wrapped input, not the whole input. A single Ctrl-U after a mismatch
// left most of the keep text in the box, and every later phone inject was
// refused input_not_empty for ~10h. So a failure clears until the read-back is
// empty (capped), and a residue that will not clear is logged and reported.
// A pane under MIN_INJECT_PANE_WIDTH columns is refused before any key: at 11
// columns the keep text wrapped to ~50 rows and could not be read back.

import { keyGate } from "./key-gate"
import { companionLog } from "./log"
import { INJECT_SEND_MS, INJECT_QUEUE_MS, tmuxSendKeys } from "./keyboard-inject"
import { inputText } from "./command-menu"
import { MIN_INJECT_PANE_WIDTH, capturePane, paneKey, paneTooNarrow, sendKeysArgs, tmuxPaneWidth, type PaneRef } from "./tmux-pane"
import { COMPACT_TEXT } from "./auto-compact-keep"

export const VERIFIED_TEXT_MAX = 800
export const COMMAND = "/compact"
/** After `/compact`: the command menu opens and settles. */
export const MENU_SETTLE_MS = 300
export const CHUNK_CHARS = 200
export const CHUNK_GAP_MS = 25
/** After the last chunk, before the read-back. */
export const TYPE_SETTLE_MS = 400
// `/compact keep: ` + this many chars of the keep text must read back.
const HEAD_CHARS = 24
const VERIFY_TURN_MS = 8_000
/** Ctrl-U presses before giving up on a residue (one press = one wrapped row). */
export const CLEAR_MAX_PRESSES = 40

export interface VerifiedInjectDeps {
  /** Type `text` literally into the pane (`send-keys -l`). Never a paste. */
  type(ref: PaneRef, text: string, signal: AbortSignal): Promise<boolean>
  /** A `capture-pane -e` of the pane (null when unreadable). */
  capture(ref: PaneRef, signal: AbortSignal): Promise<string | null>
  /** A named key (Enter, C-u). */
  key(ref: PaneRef, key: string, signal: AbortSignal): Promise<boolean>
  sleep(ms: number): Promise<void>
  log(line: string): void
  /** Pane width in columns (null = unknown). Absent → no width check. */
  width?(ref: PaneRef, signal: AbortSignal): Promise<number | null>
}

export type VerifiedResult =
  | { ok: true; text: string; fellBack: boolean }
  | {
    ok: false
    error: "type_failed" | "input_mismatch" | "unreadable" | "key_gate" | "pane_too_narrow"
    seen?: string
    /** Typed text could not be cleared: the input box still holds it. */
    residue?: boolean
    /** pane_too_narrow: the width read. */
    width?: number
  }

type Failure = Extract<VerifiedResult, { ok: false }>

const squash = (s: string) => s.replace(/\s+/g, "")

/** Cap the keep text so the wrapped input box stays readable. */
export function capKeep(text: string, max = VERIFIED_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** One line: a newline typed into the pane would submit early. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ")
}

/** `/compact` + the rest split into ≤ CHUNK_CHARS code points. */
export function stages(text: string): { head: string; chunks: string[] } {
  const head = text.startsWith(COMMAND) ? COMMAND : ""
  const rest = Array.from(text.slice(head.length))
  const chunks: string[] = []
  for (let i = 0; i < rest.length; i += CHUNK_CHARS) chunks.push(rest.slice(i, i + CHUNK_CHARS).join(""))
  return { head, chunks }
}

// The input box must start with `/compact keep: ` + the head of the keep text.
// Whitespace is ignored on both sides: a wrapped row may break mid-word.
export function landed(typed: string | null, text: string): boolean {
  if (typed === null) return false
  const want = squash(text.slice(0, text.indexOf("keep:") + "keep: ".length + HEAD_CHARS))
  return want.length > 0 && squash(typed).startsWith(want)
}

async function typeStaged(ref: PaneRef, text: string, d: VerifiedInjectDeps, signal: AbortSignal): Promise<boolean> {
  const { head, chunks } = stages(text)
  if (head) {
    if (!(await d.type(ref, head, signal))) return false
    await d.sleep(MENU_SETTLE_MS)
  }
  for (let i = 0; i < chunks.length; i++) {
    if (signal.aborted) return false
    if (i > 0) await d.sleep(CHUNK_GAP_MS)
    if (!(await d.type(ref, chunks[i]!, signal))) return false
  }
  return true
}

// Ctrl-U until the input box reads back empty. One press clears one wrapped
// row, so a long line needs several. True when the box is empty; false (and
// logged) when it is still holding text or can no longer be read.
export async function clearInput(ref: PaneRef, d: VerifiedInjectDeps, signal: AbortSignal): Promise<boolean> {
  let left: string | null = null
  for (let i = 0; i < CLEAR_MAX_PRESSES; i++) {
    await d.key(ref, "C-u", signal)
    const pane = await d.capture(ref, signal)
    if (pane === null) {
      d.log(`inject clear: pane unreadable after ${i + 1} Ctrl-U — residue left unknown`)
      return false
    }
    left = inputText(pane)
    if (left === "") return true
  }
  d.log(`inject clear: residue left after ${CLEAR_MAX_PRESSES} Ctrl-U — input began "${(left ?? "").slice(0, 60)}"`)
  return false
}

// Clear after a failure; a residue is carried on the result, never dropped.
async function fail(ref: PaneRef, d: VerifiedInjectDeps, signal: AbortSignal, r: Failure): Promise<Failure> {
  return (await clearInput(ref, d, signal)) ? r : { ...r, residue: true }
}

async function attempt(ref: PaneRef, text: string, d: VerifiedInjectDeps, signal: AbortSignal): Promise<VerifiedResult> {
  if (!(await typeStaged(ref, text, d, signal))) return fail(ref, d, signal, { ok: false, error: "type_failed" })
  await d.sleep(TYPE_SETTLE_MS)
  const pane = await d.capture(ref, signal)
  if (pane === null) return fail(ref, d, signal, { ok: false, error: "unreadable" })
  const typed = inputText(pane)
  if (!landed(typed, text)) {
    return fail(ref, d, signal, { ok: false, error: "input_mismatch", seen: (typed ?? "").slice(0, 60) })
  }
  if (!(await d.key(ref, "Enter", signal))) return { ok: false, error: "type_failed" }
  return { ok: true, text, fellBack: false }
}

/** Type in stages → read back → Enter only if the input starts with the command. */
export async function injectVerifiedWith(ref: PaneRef, text: string, d: VerifiedInjectDeps, signal: AbortSignal): Promise<VerifiedResult> {
  if (d.width) {
    const width = await d.width(ref, signal)
    if (paneTooNarrow(width)) {
      d.log(`inject refused: pane ${width} cols wide (< ${MIN_INJECT_PANE_WIDTH}) — the input box cannot be read back`)
      return { ok: false, error: "pane_too_narrow", width: width! }
    }
  }
  const first = capKeep(oneLine(text))
  const r = await attempt(ref, first, d, signal)
  // A residue stays put: typing the retry on top of it would only mangle more.
  if (r.ok || r.residue || first === COMPACT_TEXT) return r
  d.log(`inject verify failed (${r.error}${r.seen ? `, input began "${r.seen}"` : ""}) — retrying plain keep`)
  const second = await attempt(ref, COMPACT_TEXT, d, signal)
  return second.ok ? { ...second, fellBack: true } : second
}

const real: VerifiedInjectDeps = {
  // `--`: a chunk may start with "-", which tmux would read as a flag.
  async type(ref, text, signal) {
    return (await tmuxSendKeys(sendKeysArgs(ref, "-l", "--", text), 2000, signal)).ok
  },
  capture: (ref, signal) => capturePane(ref.pane, signal, { escapes: true, socket: ref.socket }),
  async key(ref, key, signal) {
    return (await tmuxSendKeys(sendKeysArgs(ref, key), 2000, signal)).ok
  },
  width: (ref, signal) => tmuxPaneWidth(ref, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => companionLog(line),
}

/** One key-gate turn on the pane: nothing else types between the first key and Enter. */
export async function injectVerified(ref: PaneRef, text: string, deps: VerifiedInjectDeps = real): Promise<VerifiedResult> {
  const where = paneKey(ref.pane, ref.socket)
  try {
    const r = await keyGate.send(where, "Enter", (signal) => injectVerifiedWith(ref, text, deps, signal), {
      startBy: Date.now() + INJECT_QUEUE_MS,
      timeoutMs: Math.max(VERIFY_TURN_MS, INJECT_SEND_MS),
    })
    if (r.ok) deps.log(`delivered (verified typed${r.fellBack ? ", plain keep fallback" : ""}) → ${where}`)
    else deps.log(`inject NOT sent → ${where}: ${r.error}${r.width ? ` (${r.width} cols)` : ""}${r.seen ? ` (input began "${r.seen}")` : ""}${r.residue ? " — residue left in the input box" : ""}`)
    return r
  } catch (err) {
    deps.log(`inject NOT sent → ${where}: ${String(err)}`)
    return { ok: false, error: "key_gate" }
  }
}
