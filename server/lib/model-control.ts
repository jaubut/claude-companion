import type { Dialog, DialogItem } from "./dialogs"
import type { Session } from "./sessions"

// Model control (PRJ-OR1T Phase 14, gap-table rows A1·A2·A3).
//
// The phone gets rc's native model control: the real list, the current pick,
// and both scopes — this session only, or also the new-session default.
//
// Why this drives the picker instead of sending `/model <id>` as text, which
// the teardown proved works and is picker-free (docs/rc-teardown.md §3):
//
//   The text form needs a model ID. The picker only shows display labels
//   ("Opus (1M context)", "Fable"). Turning one into the other means shipping
//   a label→id table, which is precisely the hardcoded model list row A3
//   forbids — it rots the day Anthropic ships a model. And the list has to be
//   read off the picker regardless, so opening it costs nothing extra.
//
//   The picker also expresses the one thing the text form cannot. Its footer
//   is "Enter to set as default · s to use this session only", and the text
//   form always writes the default (measured, every single set replied "and
//   saved as your default for new sessions"). Session-only scope is reachable
//   ONLY through that `s` hint.
//
// So: open `/model`, parse the rows, arrow to the chosen one, confirm with
// Enter or `s`. Every primitive already exists and is already driven from the
// phone — /api/dialog/pick and /api/dialog/key — which is also why this module
// must not grow its own `tmux send-keys`. Two inject sites are how the Phase 13
// dialog bug survived in both of them.

// A model as the picker presents it. `index` is what /api/dialog/pick takes.
export interface ModelChoice {
  index: number
  // The row exactly as Claude Code renders it, e.g.
  // "Opus (1M context) Opus 5 with 1M context · Best for everyday, complex tasks".
  //
  // Deliberately NOT split into label + description. On the pane the two are
  // separated by a run of padding spaces, but `parseDialog` normalises runs to
  // a single space before this module ever sees the row, so the boundary is
  // already gone. Re-deriving it would be a guess that breaks the first time
  // a model name contains the pattern. The client renders the row as one
  // string, which is what the terminal shows too.
  text: string
  // The ✔ row: what the session is set to right now.
  current: boolean
}

export type ModelScope = "session" | "default"

export type ModelRefusalCode =
  | "no_pane"        // the session isn't in tmux, so nothing can be driven
  | "busy"           // mid-turn: opening a picker would interrupt the user
  | "other_dialog"   // some other dialog is up; don't stack on it
  | "not_a_picker"   // the pane has something open that isn't the model picker
  | "no_such_model"

export interface ModelRefusal { error: ModelRefusalCode }

// The picker's rows as choices. Rejects a dialog that isn't the model picker:
// every list in Claude Code parses the same way, so the title is the only
// thing separating "Select model" from "Manage MCP servers", and driving the
// wrong one would send arrow keys into somebody else's list.
export function isModelPicker(dialog: Dialog | null | undefined): boolean {
  return !!dialog && dialog.kind === "dialog" && /select model/i.test(dialog.title)
}

export function choicesFrom(dialog: Dialog): ModelChoice[] {
  return dialog.items.map((it: DialogItem) => ({
    index: it.index,
    text: it.text,
    current: it.selected,
  }))
}

// Which key confirms a pick at the requested scope. Both come from the
// picker's own footer rather than being assumed: "Enter to set as default ·
// s to use this session only". If a future Claude Code renames the hint, this
// finds it by its label instead of hardcoding "s".
export function confirmKeyFor(dialog: Dialog, scope: ModelScope): string | null {
  if (scope === "default") {
    return dialog.hints.find((h) => h.key === "Enter")?.key ?? "Enter"
  }
  const sessionHint = dialog.hints.find((h) => /this session only/i.test(h.label))
  return sessionHint?.key ?? null
}

// Whether the picker may be opened on this session right now.
//
// Opening one mid-turn would drop a modal over the user's own work, and
// stacking it on an existing dialog would drive arrow keys into that one. The
// `dialog` argument is whatever dialogWatcher already reports for the session;
// a model picker that is ALREADY open is not a refusal — it is the thing we
// were about to open.
export function openRefusal(session: Session | null, dialog: Dialog | null | undefined): ModelRefusal | null {
  if (!session?.tmuxPane) return { error: "no_pane" }
  if (dialog && !isModelPicker(dialog)) return { error: "other_dialog" }
  // Claude Code's own status: "busy" while a turn runs. A session with no
  // status file (older CLI) reports "" — treat that as free rather than
  // blocking the feature on a file that may not exist.
  if (!dialog && session.agentStatus === "busy") return { error: "busy" }
  return null
}

// Arrow keys from the cursor row to `index`, then the confirm key. Mirrors
// lib/dialogs.ts pickKeys, which /api/dialog/pick uses, so the two cannot
// disagree about how a row is reached.
export function setKeys(dialog: Dialog, index: number, scope: ModelScope): string[] | ModelRefusal {
  if (index < 0 || index >= dialog.items.length) return { error: "no_such_model" }
  const confirm = confirmKeyFor(dialog, scope)
  if (!confirm) return { error: "not_a_picker" }
  const from = Math.max(0, dialog.items.findIndex((it) => it.cursor))
  const delta = index - from
  const arrows = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "Down" : "Up"))
  return [...arrows, confirm]
}
