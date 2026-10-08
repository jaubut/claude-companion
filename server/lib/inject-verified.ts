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

import { keyGate } from "./key-gate"
import { companionLog } from "./log"
import { tmuxSendKeys } from "./keyboard-inject"
import { INJECT_SEND_MS, INJECT_QUEUE_MS } from "./herdr-inject"
import { inputText } from "./command-menu"
import { capturePane, paneKey, sendKeysArgs, type PaneRef } from "./tmux-pane"
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

export interface VerifiedInjectDeps {
  /** Type `text` literally into the pane (`send-keys -l`). Never a paste. */
  type(ref: PaneRef, text: string, signal: AbortSignal): Promise<boolean>
  /** A `capture-pane -e` of the pane (null when unreadable). */
  capture(ref: PaneRef, signal: AbortSignal): Promise<string | null>
  /** A named key (Enter, C-u). */
  key(ref: PaneRef, key: string, signal: AbortSignal): Promise<boolean>
  sleep(ms: number): Promise<void>
  log(line: string): void
}

export type VerifiedResult =
  | { ok: true; text: string; fellBack: boolean }
  | { ok: false; error: "type_failed" | "input_mismatch" | "unreadable" | "key_gate"; seen?: string }

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

async function attempt(ref: PaneRef, text: string, d: VerifiedInjectDeps, signal: AbortSignal): Promise<VerifiedResult> {
  if (!(await typeStaged(ref, text, d, signal))) {
    await d.key(ref, "C-u", signal)
    return { ok: false, error: "type_failed" }
  }
  await d.sleep(TYPE_SETTLE_MS)
  const pane = await d.capture(ref, signal)
  if (pane === null) {
    await d.key(ref, "C-u", signal)
    return { ok: false, error: "unreadable" }
  }
  const typed = inputText(pane)
  if (!landed(typed, text)) {
    await d.key(ref, "C-u", signal)
    return { ok: false, error: "input_mismatch", seen: (typed ?? "").slice(0, 60) }
  }
  if (!(await d.key(ref, "Enter", signal))) return { ok: false, error: "type_failed" }
  return { ok: true, text, fellBack: false }
}

/** Type in stages → read back → Enter only if the input starts with the command. */
export async function injectVerifiedWith(ref: PaneRef, text: string, d: VerifiedInjectDeps, signal: AbortSignal): Promise<VerifiedResult> {
  const first = capKeep(oneLine(text))
  const r = await attempt(ref, first, d, signal)
  if (r.ok || first === COMPACT_TEXT) return r
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
    else deps.log(`inject NOT sent → ${where}: ${r.error}${r.seen ? ` (input began "${r.seen}")` : ""}`)
    return r
  } catch (err) {
    deps.log(`inject NOT sent → ${where}: ${String(err)}`)
    return { ok: false, error: "key_gate" }
  }
}
