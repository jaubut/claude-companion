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

export type InjectRefusalCode = "target_gone" | "target_idle" | "dialog_open"

export interface InjectRefusal {
  error: InjectRefusalCode
  // Carried only for `dialog_open`, so the client can show what is in the way
  // instead of a bare error code. Same shape as the `dialog` frame the phone
  // already renders.
  dialog?: Dialog
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
}

// Returns the reason to refuse, or null to proceed with the inject.
//
// Order matters and is the order the two call sites already used: a target the
// caller named but that isn't registered, then one with no live tty, then a
// dialog in the way. Callers must run this BEFORE clearing any waiting reason
// — a refused inject answered nothing, so blanking the badge would tell the
// phone the session is unblocked when it is still sitting on a dialog.
export function injectRefusal({ lookup, target, dialog }: InjectAttempt): InjectRefusal | null {
  // The caller asked for a specific target and we don't have it registered.
  // Refuse rather than silently pasting into whatever is frontmost.
  if (lookup && !target) return { error: "target_gone" }

  // A resolved session without a tty (e.g. rehydrated from a transcript but
  // nothing live has fired a hook) can't be focused, so a paste would land on
  // whatever macOS app is frontmost.
  if (target && !target.tty) return { error: "target_idle" }

  if (target && dialog && dialog.kind !== "question") return { error: "dialog_open", dialog }

  return null
}
