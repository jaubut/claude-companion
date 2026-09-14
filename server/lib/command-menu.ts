import type { Session } from "./sessions"
import type { Dialog } from "./dialogs"

// Slash-command autocomplete for the phone (PRJ-OR1T Phase 16).
//
// Typing `/` in Claude Code opens a filtered command menu above the input box.
// It is NOT a dialog: no cursor marker, no "Enter to …" hint footer, so
// `parseDialog` deliberately ignores it and this module reads it instead.
//
// Where the list comes from, and why not from anywhere else:
//   - A list bundled in the app or the server would rot the moment a command,
//     skill or plugin is added — and this user has well over a hundred, most
//     of them his own. Same reasoning that shaped the model picker (A3).
//   - The menu can be paged with Down, but enumerating it that way is dozens
//     of round trips through a live terminal, and the pane only ever shows a
//     window of it.
//   - `/help` opens a tabbed dialog, which is worse to drive than the menu.
//
// So Claude Code does the filtering, exactly as it would for someone typing at
// the keyboard: send the prefix, read the menu it renders, clear the line.
// Whatever it knows about, the phone knows about.

export interface CommandSuggestion {
  // "/model"
  name: string
  // The one-line description the menu shows, continuation lines folded in.
  description: string
}

export type SuggestRefusalCode =
  | "no_pane"       // not in tmux, nothing to drive
  | "busy"          // mid-turn
  | "other_dialog"  // a dialog owns the pane
  | "input_busy"    // the user has their own text on the input line

export interface SuggestRefusal { error: SuggestRefusalCode }

const DIVIDER_RE = /^[\s▔─━═]{8,}$/
// Claude Code separates the prompt marker from the text with a non-breaking
// space, so a plain \s class is not enough.
const PROMPT_RE = /^❯[\s ]*(.*)$/
// An EMPTY input box is not blank on screen: Claude Code renders a rotating
// hint there, `Try "write a test for <filepath>"`. Reading that as the user's
// own text made every suggestion refuse with input_busy on a fresh session —
// exactly what prod did on the first try, where the isolated run had passed
// because that session had already been typed into. lib/dialogs.ts carries
// the same shape for the same reason.
const PLACEHOLDER_RE = /^Try\s+".*"$/
// "  /model                    Set the AI model for Claude Code (…)"
const ROW_RE = /^ {1,3}(\/[A-Za-z0-9:_.-]+)( {2,})(.*)$/

// What the user currently has typed on the input line, or null when no prompt
// line is on the pane. "" means an empty input box.
export function inputLine(pane: string): string | null {
  const lines = pane.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]?.match(PROMPT_RE)
    if (m) {
      const typed = (m[1] ?? "").trim()
      return PLACEHOLDER_RE.test(typed) ? "" : typed
    }
  }
  return null
}

// The command menu as the pane currently renders it.
//
// Rows sit between the header and the divider above the input box. A long
// description wraps onto continuation lines indented to the description
// column; those fold back into the row above rather than being dropped, so a
// suggestion reads the same on the phone as in the terminal.
export function parseCommandMenu(pane: string): CommandSuggestion[] {
  const lines = pane.split("\n")

  // Everything above the divider that sits directly above the prompt.
  let promptIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_RE.test(lines[i] ?? "")) { promptIdx = i; break }
  }
  if (promptIdx < 0) return []
  let end = promptIdx
  while (end > 0 && !DIVIDER_RE.test(lines[end - 1] ?? "")) end--
  end = Math.max(0, end - 1)

  const out: CommandSuggestion[] = []
  let descCol = -1
  for (let i = 0; i < end; i++) {
    const line = lines[i] ?? ""
    const m = line.match(ROW_RE)
    if (m) {
      descCol = (m[1]!.length + m[2]!.length + 1)
      out.push({ name: m[1]!, description: (m[3] ?? "").trim() })
      continue
    }
    // A continuation only counts when it starts at (or past) the description
    // column of the row it belongs to — otherwise the startup header would
    // fold itself into the last command.
    const last = out[out.length - 1]
    if (last && descCol > 0 && /^\s+\S/.test(line)) {
      const indent = line.length - line.trimStart().length
      if (indent >= descCol - 2) {
        last.description = `${last.description} ${line.trim()}`.trim()
        continue
      }
    }
    // Any other non-blank line ends the menu block.
    if (line.trim()) descCol = -1
  }
  return out
}

// Whether the pane can be driven for a suggestion right now.
//
// `typed` is what the input line already holds. Refusing on a non-empty line
// is the important one: the flow clears the line with C-u before typing the
// prefix, and doing that over something the user typed at their own keyboard
// would destroy it. The phone's own in-flight prefix is passed as `ours` so a
// second keystroke doesn't refuse against the text we just typed ourselves.
export function suggestRefusal(
  session: Session | null,
  dialog: Dialog | null | undefined,
  typed: string | null,
  ours: string,
): SuggestRefusal | null {
  if (!session?.tmuxPane) return { error: "no_pane" }
  if (dialog) return { error: "other_dialog" }
  if (session.agentStatus === "busy") return { error: "busy" }
  if (typed && typed !== ours) return { error: "input_busy" }
  return null
}

// Ctrl-U kills the line. Escape does NOT: it closes the menu and leaves the
// text, which is how an earlier attempt at this ended up typing "//".
export const CLEAR_LINE_KEY = "C-u"
