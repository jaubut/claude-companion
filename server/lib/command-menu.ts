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

// ── Styled captures (`tmux capture-pane -e`) ────────────────────────────────
//
// Claude Code paints a PREDICTED next reply into the empty input box as dim
// text (SGR 2), with the cursor still at column 2. A plain capture-pane shows
// it exactly as if the user had typed it, so an idle box reads as busy. With
// `-e` the attributes survive and dim text can be told apart. Every parser
// here accepts either shape: a plain capture is just one unstyled segment.

interface Cell { ch: string; dim: boolean; inverse: boolean }

// CSI (incl. SGR), OSC, and two-byte escapes. Only SGR changes state.
const ESC_SEQ_RE = /\x1b(?:\[([0-9;:?<=>]*)[ -\/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

function applySgr(params: string, st: { dim: boolean; inverse: boolean }): void {
  const ps = params === "" ? ["0"] : params.split(";")
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] === "" ? 0 : Number(ps[i])
    if (p === 0) { st.dim = false; st.inverse = false }
    else if (p === 2) st.dim = true
    else if (p === 22) st.dim = false
    else if (p === 7) st.inverse = true
    else if (p === 27) st.inverse = false
    // Extended colours carry sub-parameters that must not be read as
    // attributes: the "2" in 38;2;r;g;b is truecolour, not dim.
    else if (p === 38 || p === 48 || p === 58) i += ps[i + 1] === "5" ? 2 : ps[i + 1] === "2" ? 4 : 0
  }
}

// One pane (or line) → cells with the attributes that matter here. SGR state
// carries across newlines, as it does on the terminal.
function cells(text: string): Cell[] {
  const out: Cell[] = []
  const st = { dim: false, inverse: false }
  const push = (s: string) => { for (const ch of s) out.push({ ch, dim: st.dim, inverse: st.inverse }) }
  let last = 0
  ESC_SEQ_RE.lastIndex = 0
  for (let m = ESC_SEQ_RE.exec(text); m; m = ESC_SEQ_RE.exec(text)) {
    push(text.slice(last, m.index))
    last = ESC_SEQ_RE.lastIndex
    if (m[2] === "m" && !/[?<=>]/.test(m[1] ?? "")) applySgr(m[1] ?? "", st)
  }
  push(text.slice(last))
  return out
}

function splitLines(pane: string): Cell[][] {
  const lines: Cell[][] = [[]]
  for (const c of cells(pane)) {
    if (c.ch === "\n") lines.push([])
    else lines[lines.length - 1]!.push(c)
  }
  return lines
}

const textOf = (cs: Cell[]): string => cs.map((c) => c.ch).join("")

// The pane with every escape sequence removed and ALL text kept (dim too).
export function unstyle(pane: string): string {
  return pane.includes("\x1b") ? textOf(cells(pane)) : pane
}

// What the user typed after the prompt marker, given the line's cells.
//
// Dim text is Claude Code's, not the user's (prediction, placeholder). Its own
// cursor may be drawn as an inverse cell on the prediction's first character;
// that cell only counts as typed when nothing dim follows it — a lone inverse
// char with no ghost text is a real character under the caret.
function typedAfterPrompt(line: Cell[]): string {
  let i = line.findIndex((c) => c.ch === "❯") + 1
  while (i < line.length && /[\s ]/.test(line[i]!.ch)) i++
  const rest = line.slice(i)
  const solid = textOf(rest.filter((c) => !c.dim && !c.inverse)).trim()
  if (solid) return textOf(rest.filter((c) => !c.dim)).trim()
  if (rest.some((c) => c.dim && c.ch.trim())) return ""
  return textOf(rest).trim()
}

// Index of the input prompt line (the LAST "❯" line at column 0), or -1.
export function promptLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_RE.test(lines[i] ?? "")) return i
  }
  return -1
}

// What the user currently has typed on the input line, or null when no prompt
// line is on the pane. "" means an empty input box. Accepts a plain capture or
// a `capture-pane -e` one; with the latter, dim-only input (a predicted reply)
// reads as empty.
export function inputLine(pane: string): string | null {
  const lines = splitLines(pane)
  const idx = promptLineIndex(lines.map(textOf))
  if (idx < 0) return null
  const typed = typedAfterPrompt(lines[idx]!)
  return PLACEHOLDER_RE.test(typed) ? "" : typed
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
  // An UNREADABLE line (no prompt on the capture, or the capture failed) is
  // not an empty one. Treating "don't know" as "empty" is how a scrape could
  // C-u a phone prompt whose Enter never landed (audit 2026-09-24).
  if (typed === null) return { error: "input_busy" }
  if (typed && typed !== ours) return { error: "input_busy" }
  return null
}

// Whether the flow may C-u the input line as it reads NOW. Only an empty line
// or text the flow typed itself (`owned`) qualifies. `typed` must come from a
// `capture-pane -e` read (inputLine), so Claude Code's dim predicted reply
// reads as empty, not as the user's text. null (unreadable) never qualifies.
export function mayClearLine(typed: string | null, owned: readonly string[]): boolean {
  if (typed === null) return false
  return typed === "" || owned.includes(typed)
}

// Ctrl-U kills the line. Escape does NOT: it closes the menu and leaves the
// text, which is how an earlier attempt at this ended up typing "//".
export const CLEAR_LINE_KEY = "C-u"
