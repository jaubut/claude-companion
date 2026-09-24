import { helpOverlayVisible } from "./command-list"
import { inputLine, promptLineIndex, unstyle } from "./command-menu"
import type { Dialog } from "./dialogs"
import type { Session } from "./sessions"

// Why text is refused before it reaches `injectText`. Both inject call sites
// (POST /api/inject and the WebSocket "input" message) used to make these
// checks inline, in the same order, with the same messages — and only two of
// the three. The third, `dialog_open`, is the one that was missing:
//
//   Claude Code's dialogs are modal in the pane. With one up, a `tmux
//   send-keys` of the user's text does not reach the input box at all — the
//   characters land in the dialog and the trailing Enter confirms whatever row
//   the cursor sits on. Observed live 2026-09-13 (docs/rc-teardown.md Finding
//   3c): an injected "/model opus" arrived while a "Change effort level?"
//   confirm was open, and silently answered it instead. The prompt is lost and
//   an unrelated dialog gets a wrong answer the user never chose.
//
// So a dialog is a refusal, not a delivery problem: nothing can be typed into
// that session until it closes. Question pickers are the exception — the hooks
// own those end-to-end (structured card on the phone, `question-driver.ts`
// typing into the picker), so they never reach here as a `Dialog` anyway
// (`dialog-watch.ts` closes question-kind before it lands in `current()`), and
// are excluded explicitly in case that ever changes.

export type InjectRefusalCode = "target_gone" | "target_idle" | "busy_flow" | "dialog_open" | "pane_not_ready"

export interface InjectRefusal {
  error: InjectRefusalCode
  // Carried only for `dialog_open`, so the client can show what is in the way
  // instead of a bare error code. Same shape as the `dialog` frame the phone
  // already renders.
  dialog?: Dialog
  // Carried only for `pane_not_ready`: which check failed, and the bottom of
  // the pane as captured, so the phone (and the log) can show what was there.
  reason?: PaneNotReadyReason
  excerpt?: string
}

// ── pane_not_ready ──────────────────────────────────────────────────────────
//
// Audit 2026-09-24, Zettlab pane %89: three phone injects logged "delivered
// (tmux)" but no UserPromptSubmit fired and nothing reached the transcript;
// log mining puts the historical loss at 30+ prompts. The pane was in a state
// that captures keys WITHOUT a Dialog record, so every check above passed:
//
//   - the agents panel (Left on an empty prompt) — text + Enter there spawns
//     a background job instead of submitting a prompt
//   - the shortcuts overlay ("?" on an empty prompt)
//   - a /help that painted after the dialog watcher last looked
//
// So the last check is positive evidence, not absence of a dialog: capture the
// pane and proceed only if Claude Code's input box is on screen, framed, and
// empty. Anything else is refused with the reason and an excerpt.

export type PaneNotReadyReason =
  | "capture_failed"     // tmux could not read the pane
  | "help_overlay"       // /help (any tab) is on screen
  | "no_prompt"          // no input prompt line at all (a panel replaced it)
  | "prompt_unframed"    // a "❯" line, but not inside the input box dividers
  | "input_not_empty"    // the user (or a lost inject) has text in the box
  | "shortcuts_overlay"  // the "?" shortcuts list under the box
  | "panel_open"         // key hints under the box: a panel has focus

const DIVIDER_RE = /^[\s▔─━═]{8,}$/
// The "?" overlay. Two of these, below the box, and it is the overlay — the
// idle footer's own "? for shortcuts" hint matches none of them.
const SHORTCUT_MARKERS = [/! for bash mode/i, /@ for file paths/i, /\/ for commands/i, /double tap esc/i, /# to memori[sz]e/i]
// Key hints under the box mean something other than the input box has focus
// (the agents panel, a tasks list). The idle footer ("⏵⏵ auto mode on
// (shift+tab to cycle)", a status line) never carries these.
const PANEL_HINT_RE = /\b(?:Enter|Esc|Space)\s+to\s|↑\s*\/?\s*↓|←\s*\/?\s*→/

const EXCERPT_LINES = 8
const EXCERPT_MAX = 600

// The bottom of the pane, unstyled, for the refusal. Never the whole pane: it
// goes to the phone and into the log.
export function paneExcerpt(pane: string | null): string {
  if (!pane) return ""
  const lines = unstyle(pane).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim())
  const tail = lines.slice(-EXCERPT_LINES).join("\n")
  return tail.length > EXCERPT_MAX ? tail.slice(-EXCERPT_MAX) : tail
}

// Why this pane cannot take typed text right now, or null when it can. Takes a
// `capture-pane -e` capture (a plain one works too, minus dim detection).
export function paneNotReady(pane: string | null): PaneNotReadyReason | null {
  if (pane === null) return "capture_failed"
  const lines = unstyle(pane).split("\n")
  if (helpOverlayVisible(lines.join("\n"))) return "help_overlay"

  const idx = promptLineIndex(lines)
  if (idx < 0) return "no_prompt"
  // The input box is framed: a divider directly above the prompt line, and one
  // below it after any continuation lines.
  if (!DIVIDER_RE.test(lines[idx - 1] ?? "")) return "prompt_unframed"
  let bottom = idx + 1
  while (bottom < lines.length && !DIVIDER_RE.test(lines[bottom] ?? "")) bottom++
  if (bottom >= lines.length) return "prompt_unframed"

  if (inputLine(pane) !== "") return "input_not_empty"
  if (lines.slice(idx + 1, bottom).some((l) => l.trim())) return "input_not_empty"

  const below = lines.slice(bottom + 1).join("\n")
  if (SHORTCUT_MARKERS.filter((re) => re.test(below)).length >= 2) return "shortcuts_overlay"
  if (PANEL_HINT_RE.test(below)) return "panel_open"
  return null
}

export interface InjectAttempt {
  // What the caller addressed: a session key or a cwd. Empty means "frontmost"
  // — the caller named nothing, so there is no target to check.
  lookup: string
  // The session `lookup` resolved to, or the fallback the route picked. Null
  // when nothing resolved.
  target: Session | null
  // The dialog currently open on `target`, from `dialogWatcher.current()`.
  // Undefined/null when none is.
  dialog?: Dialog | null
  // False when a companion flow (the /help scrape, the `/` suggest probe) is
  // still holding that pane after being asked to let go. Undefined means "not
  // applicable / free". See `busy_flow` below.
  paneFree?: boolean
  // `tmux capture-pane -e` of the target's pane, taken just before the inject.
  // Undefined when the target has no tmux pane (nothing to check — the
  // AppleScript path types into a focused tty). Null when the capture failed,
  // which refuses: a pane tmux cannot read is not one to type into blind.
  pane?: string | null
}

// Returns the reason to refuse, or null to proceed with the inject.
//
// Order matters and is the order the two call sites already used: a target the
// caller named but that isn't registered, then one with no live tty, then a
// dialog in the way, then a pane that is not showing an empty input box. Callers must run this BEFORE clearing any waiting reason
// — a refused inject answered nothing, so blanking the badge would tell the
// phone the session is unblocked when it is still sitting on a dialog.
export function injectRefusal({ lookup, target, dialog, paneFree, pane }: InjectAttempt): InjectRefusal | null {
  // The caller asked for a specific target and we don't have it registered.
  // Refuse rather than silently pasting into whatever is frontmost.
  if (lookup && !target) return { error: "target_gone" }

  // A resolved session without a tty (e.g. rehydrated from a transcript but
  // nothing live has fired a hook) can't be focused, so a paste would land on
  // whatever macOS app is frontmost.
  if (target && !target.tty) return { error: "target_idle" }

  // A companion flow that would not let go of the pane. This MUST outrank the
  // dialog check, not fall through it: while the /help scrape holds the flow,
  // `dialog-watch` deliberately skips that session, so `dialog` is null even
  // with our modal on screen. Fall through and the text is typed into the
  // help list — the exact bug the abort was added to prevent. Refusing is
  // recoverable (the phone retries a second later); typing into a modal is
  // not.
  if (target && paneFree === false) return { error: "busy_flow" }

  if (target && dialog && dialog.kind !== "question") return { error: "dialog_open", dialog }

  // After the dialog: a recorded dialog is the better answer (the phone can
  // render and drive it). This catches what dialog-watch never records.
  if (target && pane !== undefined) {
    const reason = paneNotReady(pane)
    if (reason) return { error: "pane_not_ready", reason, excerpt: paneExcerpt(pane) }
  }

  return null
}
