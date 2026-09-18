// Full slash-command enumeration for the phone (PRJ-OR1T Phase 16b).
//
// Phase 16 filtered by prefix through Claude Code's `/` menu — right for
// autocomplete, wrong for the thing Jeremie compared against: the Claude app's
// `/` opens a dropdown of EVERY command. The `/` menu only ever renders a 2–5
// row window, so it cannot enumerate. `/help` can: its "Commands" and "Custom
// commands" tabs list a paneful of rows with descriptions (~17 on a Mac
// terminal, 5 in an 80x24 detached tmux pane — count them, never assume),
// alphabetical, and scroll one row per Down once the cursor reaches the
// bottom. Two fresh
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

// ── Paging a help tab ──────────────────────────────────────────────────────
//
// How the dialog scrolls: the cursor starts on the first row and walks down.
// Until it reaches the last VISIBLE row the list does not move; after that
// every Down scrolls it by exactly one row. So the number of Downs that
// advances the window by one full page is "however many rows this pane is
// currently showing" — which is a property of the terminal, not a constant.
//
// It was a constant (17, read off a Mac terminal) and that silently truncated
// the list everywhere else: a phone-spawned session on the Linux host runs in a
// detached tmux pane, 80x24 unless told otherwise, where /help shows 5 rows
// per page. 17 Downs there skipped 12 commands per page — measured, 208 of 356
// found in 111s. Counting the rows we can actually see can never skip: worst
// case we under-count and re-read rows we already have, which mergePages
// dedupes.
//
// Pure except for the two seams (read the pane, press Down N times) so the
// paging can be tested against a simulated pane of any height.
export interface HelpTabScrapeDeps {
  tab: HelpTab
  capture: () => Promise<string>
  // Press Down `rows` times and let the pane settle.
  pageDown: (rows: number) => Promise<void>
  // True once something else needs the pane (see lib/command-scrape.ts).
  aborted?: () => boolean
  maxPages?: number
}

export interface HelpTabScrape {
  commands: CommandEntry[]
  pages: number
  // Rows the first page showed — the step size, logged so a cramped pane is
  // visible in the companion log instead of only in the elapsed time.
  rowsPerPage: number
  // The first page was not the tab we asked for: bail rather than mislabel.
  wrongTab: boolean
  aborted: boolean
}

// Help pages repeat once the list has hit the bottom; the end condition is TWO
// unchanged pages, not one, because the FIRST page's Downs only walk the
// cursor to the bottom row and scroll by one, so an early page can legitimately
// add nothing new.
const MAX_PAGES = 40

export async function scrapeHelpTab(deps: HelpTabScrapeDeps): Promise<HelpTabScrape> {
  const empty = { commands: [], pages: 0, rowsPerPage: 0 }
  const pages: Array<Array<Pick<CommandEntry, "name" | "description">>> = []
  const seen = new Set<string>()
  let rowsPerPage = 0
  let stale = 0

  for (let page = 0; page < (deps.maxPages ?? MAX_PAGES); page++) {
    if (deps.aborted?.()) {
      return { commands: mergePages(pages, deps.tab), pages: pages.length, rowsPerPage, wrongTab: false, aborted: true }
    }
    const text = await deps.capture()
    if (page === 0 && helpTab(text) !== deps.tab) return { ...empty, wrongTab: true, aborted: false }
    const rows = parseHelpPage(text)
    if (page === 0) rowsPerPage = rows.length
    const before = seen.size
    for (const r of rows) seen.add(r.name)
    pages.push(rows)
    stale = seen.size === before ? stale + 1 : 0
    if (stale >= 2) break
    // Never zero: a pane that parsed no rows still has to be nudged, or the
    // loop spins on the same screen until MAX_PAGES.
    await deps.pageDown(Math.max(1, rows.length))
  }

  return { commands: mergePages(pages, deps.tab), pages: pages.length, rowsPerPage, wrongTab: false, aborted: false }
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
