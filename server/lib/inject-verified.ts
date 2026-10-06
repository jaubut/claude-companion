// Deliver a slash command whole, and prove it landed before Enter.
//
// Auto-compact used to hand `/compact keep: <1.5k chars>` to deliverViaTmux,
// i.e. `send-keys -l` of the whole string followed at once by Enter. On the
// Mac the head of the burst was lost (the `/` opens Claude Code's command
// menu while the rest of the burst is still arriving): the session got a
// prompt that began mid-keep-text, nothing compacted, and the garbage was
// submitted as a normal prompt (companion.log 2026-10-06 22:35-22:37, ttys010).
//
// So here: the text goes in as ONE bracketed paste (tmux load-buffer +
// paste-buffer -p, no per-key typing), the input line is read back, and Enter
// is pressed only when it starts with `/compact`. A mismatch clears the line
// (Ctrl-U) and retries once with the short generic command; if that also
// mismatches nothing is submitted. Keep text is capped below the length at
// which Claude Code collapses a paste into a "[Pasted text]" placeholder,
// which would make the read-back unverifiable.

import { keyGate } from "./key-gate"
import { companionLog } from "./log"
import { INJECT_SEND_MS, INJECT_QUEUE_MS, tmuxSendKeys } from "./keyboard-inject"
import { inputLine } from "./command-menu"
import { capturePane, paneKey, sendKeysArgs, tmuxArgv, tmuxSocketFlags, type PaneRef } from "./tmux-pane"
import { COMPACT_TEXT } from "./auto-compact-keep"

export const VERIFIED_TEXT_MAX = 800
export const PASTE_SETTLE_MS = 400
const VERIFY_TURN_MS = 8_000

export interface VerifiedInjectDeps {
  /** Bracketed-paste `text` into the pane as one block. */
  paste(ref: PaneRef, text: string, signal: AbortSignal): Promise<boolean>
  /** A `capture-pane -e` of the pane (null when unreadable). */
  capture(ref: PaneRef, signal: AbortSignal): Promise<string | null>
  /** A named key (Enter, C-u). */
  key(ref: PaneRef, key: string, signal: AbortSignal): Promise<boolean>
  sleep(ms: number): Promise<void>
  log(line: string): void
}

export type VerifiedResult =
  | { ok: true; text: string; fellBack: boolean }
  | { ok: false; error: "paste_failed" | "input_mismatch" | "unreadable" | "key_gate"; seen?: string }

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

/** Cap the keep text at a length proven below the paste-placeholder threshold. */
export function capKeep(text: string, max = VERIFIED_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// The head of the command must be on the input line, exactly.
function landed(typed: string | null, text: string): boolean {
  if (typed === null) return false
  const head = norm(text).slice(0, 24)
  return norm(typed).startsWith(head)
}

async function attempt(ref: PaneRef, text: string, d: VerifiedInjectDeps, signal: AbortSignal): Promise<VerifiedResult> {
  if (!(await d.paste(ref, text, signal))) return { ok: false, error: "paste_failed" }
  await d.sleep(PASTE_SETTLE_MS)
  const pane = await d.capture(ref, signal)
  if (pane === null) {
    await d.key(ref, "C-u", signal)
    return { ok: false, error: "unreadable" }
  }
  const typed = inputLine(pane)
  if (!landed(typed, text)) {
    await d.key(ref, "C-u", signal)
    return { ok: false, error: "input_mismatch", seen: (typed ?? "").slice(0, 60) }
  }
  if (!(await d.key(ref, "Enter", signal))) return { ok: false, error: "paste_failed" }
  return { ok: true, text, fellBack: false }
}

/** Paste → read back → Enter only if the input starts with `/compact`. */
export async function injectVerifiedWith(ref: PaneRef, text: string, d: VerifiedInjectDeps, signal: AbortSignal): Promise<VerifiedResult> {
  const first = capKeep(text)
  const r = await attempt(ref, first, d, signal)
  if (r.ok || first === COMPACT_TEXT) return r
  d.log(`inject verify failed (${r.error}${r.seen ? `, input began "${r.seen}"` : ""}) — retrying plain keep`)
  const second = await attempt(ref, COMPACT_TEXT, d, signal)
  return second.ok ? { ...second, fellBack: true } : second
}

const real: VerifiedInjectDeps = {
  async paste(ref, text, signal) {
    const name = `cc-ac-${process.pid}-${Date.now()}`
    try {
      const load = Bun.spawn([...tmuxArgv(ref.socket), "load-buffer", "-b", name, "-"], { stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" })
      signal.addEventListener("abort", () => { try { load.kill() } catch { /* gone */ } }, { once: true })
      if ((await load.exited) !== 0) return false
      // -p: bracketed paste, -d: drop the buffer afterwards.
      const r = await tmuxSendKeys([...tmuxSocketFlags(ref.socket), "paste-buffer", "-p", "-d", "-b", name, "-t", ref.pane], 2000, signal)
      return r.ok
    } catch {
      return false
    }
  },
  capture: (ref, signal) => capturePane(ref.pane, signal, { escapes: true, socket: ref.socket }),
  async key(ref, key, signal) {
    return (await tmuxSendKeys(sendKeysArgs(ref, key), 2000, signal)).ok
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => companionLog(line),
}

/** One key-gate turn on the pane: nothing else types between paste and Enter. */
export async function injectVerified(ref: PaneRef, text: string, deps: VerifiedInjectDeps = real): Promise<VerifiedResult> {
  const where = paneKey(ref.pane, ref.socket)
  try {
    const r = await keyGate.send(where, "Enter", (signal) => injectVerifiedWith(ref, text, deps, signal), {
      startBy: Date.now() + INJECT_QUEUE_MS,
      timeoutMs: Math.max(VERIFY_TURN_MS, INJECT_SEND_MS),
    })
    if (r.ok) deps.log(`delivered (verified paste${r.fellBack ? ", plain keep fallback" : ""}) → ${where}`)
    else deps.log(`inject NOT sent → ${where}: ${r.error}${r.seen ? ` (input began "${r.seen}")` : ""}`)
    return r
  } catch (err) {
    deps.log(`inject NOT sent → ${where}: ${String(err)}`)
    return { ok: false, error: "key_gate" }
  }
}
