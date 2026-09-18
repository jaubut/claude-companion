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

import { inputLine } from "./command-menu"

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

// The dialog's own title line, present on EVERY tab: "Help  General
// Commands   Custom commands". This is the one that matters for "is the
// overlay up", because /help OPENS ON THE GENERAL TAB — a page of Shortcuts
// text with no "Browse … commands" line anywhere on it. Detecting the overlay
// with `helpTab()` therefore missed the first ~2s of every scrape: an abort
// landing in the open window never saw a dialog to Escape, and the close
// path's `!helpTab(text)` check then declared the pane clean with Help still
// on screen.
const TITLE_RE = /Help\s+General\s+Commands\s+Custom commands/

export function helpTab(pane: string): HelpTab | null {
  const m = pane.match(TAB_RE)
  return m ? (m[1] as HelpTab) : null
}

// Is the /help overlay on screen at all — General, Commands or Custom
// commands? The tab line counts too: a capture can clip the title row while
// still clearly showing the list, and for "is it safe to release the pane"
// the answer has to be the pessimistic one.
export function helpOverlayVisible(pane: string): boolean {
  return TITLE_RE.test(pane) || TAB_RE.test(pane)
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
  // Largest list we are willing to page through. The PAGE budget is derived
  // from this and the rows the pane actually shows — see `pageBudget`.
  maxCommands?: number
  // Explicit page cap, tests and callers that know better. Overrides the
  // derived budget.
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
  // The page budget ran out before the list stopped producing new rows, so
  // what came back is a PREFIX of the real list. Never cache one of these:
  // a truncated list served for an hour is worse than no list at all.
  incomplete: boolean
}

// Help pages repeat once the list has hit the bottom; the end condition is TWO
// unchanged pages, not one, because the FIRST page's Downs only walk the
// cursor to the bottom row and scroll by one, so an early page can legitimately
// add nothing new.
//
// The page cap was also a constant (40) and had the same bug as the 17-row
// step: 40 pages is ten screens on a Mac terminal and a third of the list on
// an 80x24 pane, where 356 commands at 5 rows/page need 72. It reported
// success with 196 commands and the route cached that for an hour. A cap has
// to be expressed in COMMANDS, then divided by the rows this pane can show.
const MAX_COMMANDS = 1_000
// Slack for the pages that legitimately add nothing: the first page's Downs
// only walk the cursor to the bottom, and the two stale pages that end the
// loop are also spent.
const PAGE_SLACK = 8
// Backstop for a pane that parses one row per page (or none): even derived,
// the budget must not let a broken pane page forever.
const HARD_PAGE_CEILING = 400

export function pageBudget(rowsPerPage: number, maxCommands = MAX_COMMANDS): number {
  if (rowsPerPage <= 0) return PAGE_SLACK
  return Math.min(HARD_PAGE_CEILING, Math.ceil(maxCommands / rowsPerPage) + PAGE_SLACK)
}

export async function scrapeHelpTab(deps: HelpTabScrapeDeps): Promise<HelpTabScrape> {
  const empty = { commands: [], pages: 0, rowsPerPage: 0 }
  const pages: Array<Array<Pick<CommandEntry, "name" | "description">>> = []
  const seen = new Set<string>()
  let rowsPerPage = 0
  let stale = 0
  // Until page 0 has been read we do not know the pane's height, so start at
  // the ceiling and tighten it as soon as the rows have been counted.
  let budget = deps.maxPages ?? HARD_PAGE_CEILING
  let reachedEnd = false

  for (let page = 0; page < budget; page++) {
    if (deps.aborted?.()) {
      return { commands: mergePages(pages, deps.tab), pages: pages.length, rowsPerPage, wrongTab: false, aborted: true, incomplete: true }
    }
    const text = await deps.capture()
    if (page === 0 && helpTab(text) !== deps.tab) return { ...empty, wrongTab: true, aborted: false, incomplete: false }
    const rows = parseHelpPage(text)
    if (page === 0) {
      rowsPerPage = rows.length
      if (deps.maxPages === undefined) budget = pageBudget(rowsPerPage, deps.maxCommands)
    }
    const before = seen.size
    for (const r of rows) seen.add(r.name)
    pages.push(rows)
    stale = seen.size === before ? stale + 1 : 0
    if (stale >= 2) { reachedEnd = true; break }
    // Never zero: a pane that parsed no rows still has to be nudged, or the
    // loop spins on the same screen until the budget runs out.
    await deps.pageDown(Math.max(1, rows.length))
  }

  return {
    commands: mergePages(pages, deps.tab),
    pages: pages.length,
    rowsPerPage,
    wrongTab: false,
    aborted: false,
    // Fell out of the loop on the budget, not on two stale pages: the tail of
    // the list was never rendered.
    incomplete: !reachedEnd,
  }
}

// Is what came back from the tabs the WHOLE list — i.e. may the route cache it
// for an hour? Only if every tab that ran read its list to the end.
//
// `wrongTab` counts as incomplete, and that is the fix: a tab that bailed
// because the first page was not the tab we asked for contributed ZERO of its
// commands, yet it used to be excluded from the incomplete test. A custom-tab
// bail (Tab didn't land, the dialog reopened on General) therefore cached a
// default-only list, and every phone on that host saw no skills or project
// commands for the next hour.
//
// `aborted` is not folded in here: the route answers 409 for those and never
// reaches a caching decision.
export function listIncomplete(
  tabs: Array<Pick<HelpTabScrape, "aborted" | "wrongTab" | "incomplete">>,
): boolean {
  return tabs.some((t) => !t.aborted && (t.wrongTab || t.incomplete))
}

// ── Closing the overlay we opened ──────────────────────────────────────────
//
// An abort (an inject wants the pane) can land in the window between typing
// `/help`+Enter and Claude Code painting the dialog. An Escape sent THEN hits
// nothing, the dialog paints a moment later, and the flow releases the pane
// with a modal up — precisely the state the abort existed to avoid, and the
// user's next line gets typed into the help list.
//
// So closing is a loop, not a keystroke: wait (bounded) for the overlay to be
// on screen, Escape it, then confirm the input line really is empty before
// handing the pane back. Escape does not clear typed text — C-u does — so the
// two are separate steps.
//
// Both halves ask `helpOverlayVisible`, not `helpTab`: /help opens on the
// GENERAL tab, which has no "Browse … commands" line, so the tab matcher was
// blind for exactly the window an abort is most likely to land in.
//
// And "clean" is a positive statement, never an absence of evidence: no
// overlay AND a prompt line AND that line empty. A capture taken mid-repaint
// shows neither an overlay nor a prompt; reading that as clean is how a pane
// with a modal one frame away gets handed to an inject.
export interface CloseHelpDeps {
  capture: () => Promise<string | null>
  escape: () => Promise<void>
  clearLine: () => Promise<void>
  sleep: (ms: number) => Promise<void>
  // Bounded wait for the overlay to paint before the first Escape.
  openWaitMs?: number
  // Bounded wait for the pane to come back clean after it.
  clearWaitMs?: number
  pollMs?: number
}

export interface CloseHelpResult {
  // The overlay was seen on screen (so the Escape had something to close).
  sawOverlay: boolean
  // The pane is back to an empty input box with no overlay: safe to release.
  clean: boolean
}

export async function closeHelpOverlay(deps: CloseHelpDeps): Promise<CloseHelpResult> {
  const poll = deps.pollMs ?? 120
  const openDeadline = Date.now() + (deps.openWaitMs ?? 2_000)
  let sawOverlay = false
  for (;;) {
    const text = await deps.capture()
    if (text !== null && helpOverlayVisible(text)) { sawOverlay = true; break }
    if (Date.now() >= openDeadline) break
    await deps.sleep(poll)
  }

  await deps.escape()
  await deps.clearLine()

  const clearDeadline = Date.now() + (deps.clearWaitMs ?? 2_000)
  for (;;) {
    const text = await deps.capture()
    if (text !== null && isPaneClean(text)) return { sawOverlay, clean: true }
    if (Date.now() >= clearDeadline) return { sawOverlay, clean: false }
    await deps.sleep(poll)
    // Whatever is still there gets the matching key again: an overlay that
    // outlived the first Escape, or text C-u did not reach. A capture that
    // showed neither (a repaint) gets the harmless one and is polled again.
    if (text !== null && helpOverlayVisible(text)) await deps.escape()
    else await deps.clearLine()
  }
}

// The pane is safe to hand to someone else: no /help overlay, and a prompt
// line that is there and empty.
//
// A pane with NO prompt line is deliberately not clean. The first cut only
// asked "is there text on the prompt line", which a missing prompt answers
// "no" — so a blank capture (tmux read the pane mid-repaint, which is exactly
// what happens right after an Escape) passed as clean and released the flow a
// frame before the dialog finished painting.
export function isPaneClean(pane: string): boolean {
  if (helpOverlayVisible(pane)) return false
  return inputLine(pane) === ""
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
