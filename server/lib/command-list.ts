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
//
// R2 — "no overlay" is itself an absence of evidence until Claude Code has
// had its paint window. The open wait was 1.5s against a 1.8s paint: an abort
// landing at 300ms polled a pane with no overlay (the Enter had already
// cleared the input line, so it even read as a clean prompt), gave up at 1.5s,
// Escaped nothing, confirmed "clean", released the flow — and the dialog
// painted 300ms later onto a pane nobody was holding. So an expired open wait
// with no overlay seen is UNVERIFIED, not clean: it only counts once
// `paintMs` has passed since the Enter that opened /help.

// Claude Code's worst case between the Enter that submits `/help` and the
// dialog being on the pane (measured on the Linux host, 2.1.270). The route
// sleeps exactly this long before it starts paging.
//
// R4d — LOAD-BEARING ON BOTH ENDS, and they pull in opposite directions:
//   - the route waits it out after the Enter before the first capture, so
//     shrinking it starts the paging on a half-painted dialog (wrongTab, an
//     empty first page, a truncated list);
//   - the close path uses it as the proof that "no overlay on the pane" MEANS
//     no overlay (`paintWindowPassed`) and as its early exit, so shrinking it
//     re-opens R2 — an abort inside the paint window releases a pane the
//     dialog lands on a moment later — while growing it costs every normal
//     close the difference.
// Re-measure on a real pane before touching it, and re-read both call sites.
export const HELP_PAINT_MS = 1_800

// ── Escape is a chord PREFIX, not just a key ───────────────────────────────
//
// Measured on the Linux host with raw tmux (Claude Code 2.1.270): a byte that
// arrives within a few ms of an ESC is read as a META chord rather than as two
// keystrokes. `Escape` then `p` is opt+p — "switch model", a shortcut the Help
// page itself lists; `Escape` then `C-u` is an unknown chord. Either way the
// Escape does NOT act as Escape and the byte that followed it is SWALLOWED.
//
// That is what ate the first character of an inject handed the pane by an
// aborted scrape (post-deploy E2E, 2026-09-18, reproduced 3/3): this function
// sent Escape and C-u back to back (a chord — the overlay stayed up), its
// retry loop sent another Escape and captured 10-40ms later, called the pane
// clean, `endFlow` released, and the waiting inject typed "ping"+Enter into
// the chord window. The pane showed "❯ ing", no UserPromptSubmit hook fired,
// and the next scrape refused with input_busy because "ing" sat in the box.
//
// Any gap of 100ms or more delivers correctly (tested 0.1 / 0.15 / 0.3 / 0.6s,
// with and without a C-u in between). 250ms is that floor with room for a
// loaded host, and it is the quiet period EVERY escape below opens: no other
// key, and no capture that feeds the clean verdict, inside it.
export const ESC_SETTLE_MS = 250
// A C-u is not a chord prefix, but the pane still needs a frame to redraw
// before a capture of it means anything.
export const CLEAR_SETTLE_MS = 50
// Two clean captures at least this far apart before the pane is called clean.
// One capture can land on a single good frame while a repaint is still in
// flight; two cannot, and 100ms is a whole frame on the slowest pane measured.
export const CLEAN_CONFIRM_GAP_MS = 100
// What the close path must be willing to wait for the overlay, so that not
// seeing one MEANS there is none: the paint window plus margin for a slow
// capture. Kept under SCRAPE_ABORT_WAIT_MS (5s) together with the clear wait,
// so an inject aborting the scrape is refused late rather than timed out.
export const HELP_CLOSE_OPEN_WAIT_MS = HELP_PAINT_MS + 700

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
  // When the Enter that opened /help was sent. An empty pane before
  // `enterAt + paintMs` proves nothing — the dialog may simply not have
  // painted yet. Defaults to "now", i.e. the whole paint window is waited out
  // from here, which is the conservative reading.
  enterAt?: number
  paintMs?: number
  now?: () => number
  // The quiet period every Escape opens (see ESC_SETTLE_MS). Injectable so a
  // test can assert the RULE — no key, no verdict capture, inside the window —
  // rather than the number.
  escSettleMs?: number
  clearSettleMs?: number
  cleanGapMs?: number
}

export interface CloseHelpResult {
  // The overlay was seen on screen (so the Escape had something to close).
  sawOverlay: boolean
  // The pane is back to an empty input box with no overlay: safe to release.
  clean: boolean
}

export async function closeHelpOverlay(deps: CloseHelpDeps): Promise<CloseHelpResult> {
  const poll = deps.pollMs ?? 120
  const now = deps.now ?? Date.now
  const paintMs = deps.paintMs ?? HELP_PAINT_MS
  const escSettleMs = deps.escSettleMs ?? ESC_SETTLE_MS
  const clearSettleMs = deps.clearSettleMs ?? CLEAR_SETTLE_MS
  const cleanGapMs = deps.cleanGapMs ?? CLEAN_CONFIRM_GAP_MS
  const enterAt = deps.enterAt ?? now()
  const openDeadline = now() + (deps.openWaitMs ?? HELP_CLOSE_OPEN_WAIT_MS)
  let sawOverlay = false
  // When the last key went out. Everything downstream — the next key, and the
  // capture the clean verdict rests on — has to be at least `escSettleMs`
  // after it, or it lands inside Claude Code's meta-chord window.
  let lastKeyAt = Number.NEGATIVE_INFINITY
  const quiet = (): boolean => now() - lastKeyAt >= escSettleMs
  // Every Escape in this function goes through here, so the settle cannot be
  // forgotten on the retry path the way it was on the first cut.
  const escape = async (): Promise<void> => {
    await deps.escape()
    lastKeyAt = now()
    await deps.sleep(escSettleMs)
  }
  const clearLine = async (): Promise<void> => {
    await deps.clearLine()
    lastKeyAt = now()
    await deps.sleep(clearSettleMs)
  }
  // An empty pane is only believable once the dialog has had its window to
  // paint from the Enter that asked for it.
  const paintWindowPassed = (): boolean => now() - enterAt >= paintMs
  for (;;) {
    const text = await deps.capture()
    if (text !== null && helpOverlayVisible(text)) { sawOverlay = true; break }
    // Past the paint window with a prompt sitting there: nothing is coming.
    // Leaving early here is what keeps the longer open wait from costing a
    // second on every normal close.
    if (text !== null && isPaneClean(text) && paintWindowPassed()) break
    if (now() >= openDeadline) break
    await deps.sleep(poll)
  }

  // Escape closes the overlay; C-u kills whatever text it left on the line.
  // They are two keystrokes with a quiet period between them, NOT a pair: sent
  // back to back the terminal reads ESC+C-u as one meta chord, the Escape
  // never fires, and the overlay is still up when the flow releases.
  await escape()
  await clearLine()

  const clearDeadline = now() + (deps.clearWaitMs ?? 2_000)
  // When the first of the two confirming captures was taken. Reset by anything
  // that is not a quiet, clean pane.
  let firstCleanAt: number | null = null
  for (;;) {
    const text = await deps.capture()
    // An overlay that shows up late is still an overlay we saw: it turns the
    // guess into evidence, and it gets Escaped below like any other.
    if (text !== null && helpOverlayVisible(text)) sawOverlay = true
    const looksClean = text !== null && isPaneClean(text)
    // `clean` needs the pane AND the proof: a clean-looking pane inside the
    // paint window, with no overlay ever seen, is the race — report it dirty
    // (the flow is released `clean:false`, both inject paths answer
    // `busy_flow`) rather than hand over a pane a modal is about to land on.
    //
    // …and the pane has to have been QUIET for the whole chord window. A
    // capture taken 10-40ms after an Escape described a pane that was still
    // inside opt-chord territory: the verdict was right about the pixels and
    // wrong about the keyboard, and the inject that acted on it lost its first
    // character.
    const believable = looksClean && (sawOverlay || paintWindowPassed()) && quiet()
    if (believable) {
      // One good frame is not a settled pane. Two, `cleanGapMs` apart, with no
      // key sent between them, is.
      if (firstCleanAt === null) firstCleanAt = now()
      else if (now() - firstCleanAt >= cleanGapMs) return { sawOverlay, clean: true }
    } else if (!looksClean) {
      firstCleanAt = null
    }
    if (now() >= clearDeadline) return { sawOverlay, clean: false }
    await deps.sleep(poll)
    // Whatever is still there gets the matching key again: an overlay that
    // outlived the first Escape, or text C-u did not reach. A capture that
    // showed neither (a repaint) gets the harmless one and is polled again.
    // A pane that already looks clean gets NOTHING — the second confirming
    // capture has to see a keyboard nobody has touched.
    if (text !== null && helpOverlayVisible(text)) await escape()
    else if (!looksClean) await clearLine()
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
