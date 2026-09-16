// Full slash-command enumeration for the phone (PRJ-OR1T Phase 16b).
//
// Phase 16 filtered by prefix through Claude Code's `/` menu — right for
// autocomplete, wrong for the thing Jeremie compared against: the Claude app's
// `/` opens a dropdown of EVERY command. The `/` menu only ever renders a 2–5
// row window, so it cannot enumerate. `/help` can: its "Commands" and "Custom
// commands" tabs list ~17 rows per page with descriptions, alphabetical, and
// scroll one row per Down once the cursor reaches the bottom. Two fresh
// `/help` opens (Tab does not switch tabs once the list has focus), ~10 pages,
// a few seconds — fine for a cache warmed in the background, never on a
// keystroke.
//
// The pane is the only source. Built-ins are not on disk, and the custom list
// mixes skills, commands and plugins from several roots. Reading the same
// dialog a person would read is the one thing that stays correct.

export interface CommandEntry {
  name: string          // "/model"
  description: string   // one line, possibly ending in "…" where Claude Code truncated it
  kind: "default" | "custom"
}

export type HelpTab = "default" | "custom"

// "   Browse default commands" / "   Browse custom commands"
const TAB_RE = /Browse (default|custom) commands/
// A command row: optional cursor (❯) or more-below (↓) marker, then the name.
// Custom names may contain a space ("/agent development").
const NAME_RE = /^\s*(?:[❯›↓]\s+)?(\/[A-Za-z0-9:_.-]+(?: [a-z][a-z-]*)?)\s*$/
// Footer lines that follow the list and must not be read as descriptions.
const FOOTER_RE = /^\s*(For more help:|Something else\?|Esc to |Tab to |↑\/↓)/

export function helpTab(pane: string): HelpTab | null {
  const m = pane.match(TAB_RE)
  return m ? (m[1] as HelpTab) : null
}

// One rendered page of a help tab → its rows. A row is a name line followed by
// its description on the next indented line; a name with no description line
// (the list's last row can be cut by the footer) still counts.
export function parseHelpPage(pane: string): Array<Pick<CommandEntry, "name" | "description">> {
  const lines = pane.split("\n")
  const out: Array<{ name: string; description: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(NAME_RE)
    if (!m) continue
    const next = lines[i + 1] ?? ""
    const isDesc = next.trim() && !NAME_RE.test(next) && !FOOTER_RE.test(next) && !TAB_RE.test(next)
    out.push({ name: m[1]!, description: isDesc ? next.trim() : "" })
    if (isDesc) i++
  }
  return out
}

// Fold pages into one list, first description wins, order of first sight kept
// (which is alphabetical, since that is how the dialog lists them).
export function mergePages(pages: Array<Array<Pick<CommandEntry, "name" | "description">>>, kind: HelpTab): CommandEntry[] {
  const seen = new Map<string, CommandEntry>()
  for (const page of pages) {
    for (const row of page) {
      const prev = seen.get(row.name)
      if (!prev) seen.set(row.name, { ...row, kind })
      else if (!prev.description && row.description) prev.description = row.description
    }
  }
  return [...seen.values()]
}

// Local filter for the phone, mirroring what matters about Claude Code's own
// ranking without pretending to reproduce it: name-prefix matches first, then
// name-substring, then description-substring. Case-insensitive.
export function filterCommands(all: CommandEntry[], query: string): CommandEntry[] {
  const q = query.replace(/^\//, "").toLowerCase()
  if (!q) return all
  const prefix: CommandEntry[] = [], inName: CommandEntry[] = [], inDesc: CommandEntry[] = []
  for (const c of all) {
    const n = c.name.slice(1).toLowerCase()
    if (n.startsWith(q)) prefix.push(c)
    else if (n.includes(q)) inName.push(c)
    else if (c.description.toLowerCase().includes(q)) inDesc.push(c)
  }
  return [...prefix, ...inName, ...inDesc]
}
