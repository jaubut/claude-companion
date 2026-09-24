import { CLEAR_LINE_KEY, inputLine, mayClearLine, parseCommandMenu, suggestRefusal } from "../lib/command-menu"
import { companionLog } from "../lib/log"
import {
  CLEAR_SETTLE_MS, closeHelpOverlay, type CommandEntry, HELP_CLOSE_OPEN_WAIT_MS, HELP_PAINT_MS,
  type HelpTab, listIncomplete, scrapeHelpTab,
} from "../lib/command-list"
import { beginFlow, endFlow, scrapeAbortRequested } from "../lib/command-scrape"
import { keyGate, runTmux } from "../lib/key-gate"
import { resolveSession } from "../lib/sessions"
import { capturePane } from "../lib/tmux-pane"
import { dialogWatcher } from "../wiring/dialogs"

// Slash-command autocomplete (PRJ-OR1T Phase 16).
//
// One endpoint: give it a prefix, it returns what Claude Code's own command
// menu shows for that prefix. See lib/command-menu.ts for why the list is read
// off the pane rather than kept anywhere.
//
// The flow types into the session's real input box, so it is careful with it:
// it refuses outright if the user has their own text there, clears the line
// with C-u before and after, and serialises per session.

const SETTLE_POLL_MS = 120
const SETTLE_TIMEOUT_MS = 1_500

// Full list cache (Phase 16b). Keyed by cwd: built-ins are per host, but the
// custom tab includes project-level skills and commands, so two sessions in
// different projects can legitimately see different lists. An hour is long
// enough that the phone's `/` is instant all session, short enough that a
// skill added today shows up today. `force` bypasses it.
const LIST_TTL_MS = 60 * 60 * 1000
const listCache = new Map<string, { at: number; commands: CommandEntry[] }>()
// How many Downs advance one page is NOT a constant — it is the number of rows
// the pane is showing, which `lib/command-list.ts` counts per page (a detached
// 80x24 tmux pane shows 5 where a Mac terminal shows 17). Keys still go one at
// a time: a single send-keys carrying a page of Downs was seen to drop most of
// them mid-repaint.
const KEY_MS = 45
const PAGE_SETTLE_MS = 600
// How long /help takes to paint after the Enter. One number, shared with the
// close path (lib/command-list.ts), because the two have to agree: the close
// path's whole job on an abort is to outlast this.
const HELP_OPEN_MS = HELP_PAINT_MS
const TAB_SWITCH_MS = 700
// How long the close path waits for the pane to come back clean after the
// Escape. The wait for the overlay to be on screen in the first place is
// HELP_CLOSE_OPEN_WAIT_MS (2.5s = paint window + margin), and it has to be the
// longer of the two: at 1.5s it expired BEFORE the 1.8s paint, so an abort at
// ~300ms Escaped nothing, saw an empty prompt, called the pane clean and
// released it — and the dialog painted onto it 300ms later with no flow held.
//
// Sized against SCRAPE_ABORT_WAIT_MS (5s): 2.5s open wait + one Escape settle
// (250ms) + one C-u settle (50ms) + 1.5s clear wait = 4.3s worst case, so the
// aborting inject is answered (`busy_flow` or delivery) with room to spare
// rather than timing out on its own deadline.
const HELP_CLOSE_WAIT_MS = 1_500

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Sleep in slices so an inject waiting on us (lib/command-scrape.ts) isn't
// stuck behind a fixed 1.8s wait. Returns false when the abort fired.
async function sleepUnlessAborted(ms: number, aborted: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (aborted()) return false
    await sleep(Math.min(100, deadline - Date.now()))
  }
  return !aborted()
}

// Every key and every literal goes through the shared per-pane gate
// (lib/key-gate.ts): the /help close path's Escape and C-u included, so a
// phone's /api/dialog/key cannot land inside their chord window, and nothing
// here can land inside one of the phone's. A send that wedges is killed at the
// gate's deadline and reads as a failed send (false), never a stuck scrape.
async function gatedSend(pane: string, key: string, args: string[]): Promise<boolean> {
  try {
    await keyGate.send(pane, key, (signal) => runTmux(args, signal))
    return true
  } catch {
    return false
  }
}

const sendKey = (pane: string, key: string) => gatedSend(pane, key, ["send-keys", "-t", pane, key])
const sendLiteral = (pane: string, text: string) => gatedSend(pane, text, ["send-keys", "-t", pane, "-l", text])

// C-u only over an empty line or text this flow typed itself. The line is
// read fresh, with -e, right before the key: anything else on it (a phone
// prompt whose Enter never landed, the user typing at the keyboard) is left
// alone and the caller is told so. Returns true when the line is ours to have
// cleared (or already empty).
async function clearIfOurs(pane: string, owned: readonly string[], who: string): Promise<boolean> {
  const typed = inputLine(await capturePane(pane, undefined, { escapes: true }) ?? "")
  if (!mayClearLine(typed, owned)) {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"
    companionLog(`${yellow}commands${reset} left the input line alone on ${who} — not ours: ${JSON.stringify((typed ?? "<unreadable>").slice(0, 40))}`)
    return false
  }
  if (typed === "") return true
  return sendKey(pane, CLEAR_LINE_KEY)
}

export async function handleCommandRoute(req: Request, url: URL): Promise<Response | null> {
  // ── Suggestions for a slash prefix ──
  // Body: { key, prefix } where prefix is what follows "/" ("" lists the menu
  // as it opens). Returns { commands: [{name, description}] }.
  if (url.pathname === "/api/command/suggest" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { key?: string; prefix?: string }
    const key = (body.key ?? "").trim()
    // Only the command token matters: everything after the first space is the
    // command's own argument, which the menu does not filter on.
    const prefix = (body.prefix ?? "").replace(/^\//, "").split(/\s/)[0] ?? ""
    if (!/^[A-Za-z0-9:_.-]*$/.test(prefix)) {
      return Response.json({ ok: false, error: "bad_prefix" }, { status: 400 })
    }

    const session = key ? resolveSession(key) : null
    if (key && !session) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })

    const typedNow = session?.tmuxPane ? inputLine(await capturePane(session.tmuxPane, undefined, { escapes: true }) ?? "") : null
    const refusal = suggestRefusal(
      session,
      dialogWatcher.current()[session?.key ?? ""],
      typedNow,
      `/${prefix}`,
    )
    if (refusal) return Response.json({ ok: false, ...refusal }, { status: 409 })

    const pane = session!.tmuxPane
    if (!beginFlow(session!.key, "suggest")) {
      return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })
    }
    try {
      // Always start from a known-empty line: the previous suggestion left its
      // own prefix there, and Escape does not clear it (it closes the menu and
      // keeps the text, which is how an earlier attempt typed "//").
      const who = session!.label || session!.key
      if (!(await clearIfOurs(pane, [`/${prefix}`], who))) {
        return Response.json({ ok: false, error: "input_busy" }, { status: 409 })
      }
      await sendLiteral(pane, `/${prefix}`)

      // Poll rather than sleep a fixed amount — the same lesson the model
      // routes learned the hard way: a fixed wait is a guess about a redraw.
      const deadline = Date.now() + SETTLE_TIMEOUT_MS
      let commands: ReturnType<typeof parseCommandMenu> = []
      for (;;) {
        await sleep(SETTLE_POLL_MS)
        const pane2 = await capturePane(pane)
        if (pane2) {
          commands = parseCommandMenu(pane2)
          if (commands.length) break
        }
        if (Date.now() >= deadline) break
      }

      // Leave the box exactly as we found it: empty. The phone composes the
      // command on its own screen; the terminal is only being consulted.
      //
      // The settle is the same rule the close path follows (see ESC_SETTLE_MS
      // in lib/command-list.ts): an inject can be parked on this flow's
      // release, and the pane needs a frame after the C-u before anyone else
      // types into it. No Escape is ever sent here — the probe closes the menu
      // by emptying the line, because Escape keeps the typed text — so the
      // short redraw gap is enough.
      await clearIfOurs(pane, [`/${prefix}`], who)
      await sleep(CLEAR_SETTLE_MS)

      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
      companionLog(`${cyan}commands${reset} "/${prefix}" → ${commands.length} on ${session!.label || session!.key}`)
      return Response.json({ ok: true, key: session!.key, prefix, commands })
    } finally {
      endFlow(session!.key)
    }
  }

  // ── Every command the session knows about ──
  // Body: { key, force? }. Drives /help twice (default tab, custom tab), pages
  // each with Down until nothing new appears, Escapes, and caches per cwd.
  // Slow the first time — several seconds — so the phone calls it in the
  // background when a session becomes active, not when the user types "/".
  //
  // CLIENT CONTRACT: this is a long request. ~40s for 356 commands on a
  // healthy pane; a slow host or a busy agent can take longer. A client whose
  // HTTP timeout is shorter than the server's worst case doesn't just miss the
  // list — it retries the warm on every session activation, and each retry
  // drives the pane again. The iOS app's 60s modelPost timeout is the current
  // ceiling; the fix on that side (separate ship) is either a timeout above the
  // server's worst case, or `{warming:true}` returned immediately with the list
  // pushed over the WS when it lands. Until then, keep this endpoint's cost
  // down rather than assuming the caller will wait.
  if (url.pathname === "/api/command/list" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { key?: string; force?: boolean }
    const key = (body.key ?? "").trim()
    const session = key ? resolveSession(key) : null
    if (!session) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })

    const cached = listCache.get(session.cwd)
    if (cached && !body.force && Date.now() - cached.at < LIST_TTL_MS) {
      return Response.json({ ok: true, key: session.key, cached: true, commands: cached.commands })
    }

    const typedNow = session.tmuxPane ? inputLine(await capturePane(session.tmuxPane, undefined, { escapes: true }) ?? "") : null
    const refusal = suggestRefusal(session, dialogWatcher.current()[session.key], typedNow, "")
    if (refusal) return Response.json({ ok: false, ...refusal }, { status: 409 })
    // The claim is what makes the scrape visible to the rest of the process:
    // while it is held, the dialog watcher skips this session (the /help
    // overlay is ours, not something the user opened) and an inject aborts us
    // instead of refusing with "has a dialog open".
    if (!beginFlow(session.key, "list")) return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })

    const pane = session.tmuxPane
    const aborted = () => scrapeAbortRequested(session.key)
    const t0 = Date.now()
    // Give the pane back the way we found it: no overlay, empty input line.
    // Bounded polling, not a fixed sleep — an abort can land before Claude
    // Code has even painted the dialog we are about to close.
    //
    // `enterAt` is when we pressed Enter on /help: an empty pane before that
    // plus the paint window is not evidence of anything, and the close says so
    // (clean:false → dirty release → `busy_flow`) instead of guessing.
    let enterAt = Date.now()
    const closeHelp = () => closeHelpOverlay({
      capture: () => capturePane(pane),
      escape: async () => { await sendKey(pane, "Escape") },
      clearLine: async () => { await clearIfOurs(pane, ["/help"], session.label || session.key) },
      sleep,
      openWaitMs: HELP_CLOSE_OPEN_WAIT_MS,
      clearWaitMs: HELP_CLOSE_WAIT_MS,
      pollMs: SETTLE_POLL_MS,
      enterAt,
      paintMs: HELP_OPEN_MS,
    })
    // What we will tell the waiters when the flow is released (see
    // lib/command-scrape.ts). Pessimistic until a close says otherwise: a
    // throw anywhere below leaves the pane in a state nobody has looked at,
    // and an inject must not be handed that.
    let releaseClean = false
    try {
      const all: CommandEntry[] = []
      const outcomes: Array<{ aborted: boolean; wrongTab: boolean; incomplete: boolean }> = []
      let rowsPerPage = 0
      let gaveUp = false
      let dirty = false
      let wrongTab = false
      for (const tab of ["default", "custom"] as HelpTab[]) {
        // A fresh /help per tab: once the list has taken focus, Tab no longer
        // switches tabs (measured — it silently stays put).
        if (!(await clearIfOurs(pane, ["/help"], session.label || session.key))) {
          // Someone else's text is on the line: typing /help after it would
          // corrupt their prompt. Stop here, pane untouched — so on the first
          // tab the release is clean (nothing of ours is on screen); on the
          // second, the first tab's close verdict stands.
          if (tab === "default") releaseClean = true
          gaveUp = true
          break
        }
        await sendLiteral(pane, "/help")
        await sendKey(pane, "Enter")
        enterAt = Date.now()
        gaveUp = !(await sleepUnlessAborted(HELP_OPEN_MS, aborted))
        for (let i = 0; !gaveUp && i < (tab === "default" ? 1 : 2); i++) {
          await sendKey(pane, "Tab")
          gaveUp = !(await sleepUnlessAborted(TAB_SWITCH_MS, aborted))
        }

        const scrape = gaveUp ? null : await scrapeHelpTab({
          tab,
          capture: async () => await capturePane(pane) ?? "",
          pageDown: async (rows) => {
            for (let k = 0; k < rows; k++) {
              if (aborted()) return
              await sendKey(pane, "Down")
              await sleep(KEY_MS)
            }
            await sleepUnlessAborted(PAGE_SETTLE_MS, aborted)
          },
          aborted,
        })
        if (scrape) {
          all.push(...scrape.commands)
          rowsPerPage = rowsPerPage || scrape.rowsPerPage
          gaveUp = gaveUp || scrape.aborted
          wrongTab = wrongTab || scrape.wrongTab
          outcomes.push({ aborted: scrape.aborted, wrongTab: scrape.wrongTab, incomplete: scrape.incomplete })
        }

        // Close the help dialog whatever happened — an abandoned scrape must
        // not leave a modal on the pane for the next inject to hit — and only
        // report it done once the pane says so. The LAST close is what decides
        // how the flow is released: it is the one that describes the pane as
        // it will be handed over.
        const closed = await closeHelp()
        releaseClean = closed.clean
        dirty = dirty || !closed.clean
        // No extra settle here, clean or dirty: closeHelpOverlay's escape()
        // wrapper sleeps ESC_SETTLE_MS after every Escape before returning, and
        // the key gate would hold the second tab's first key off the window
        // anyway. The sleep that used to sit here only pushed the dirty-path
        // abort past SCRAPE_ABORT_WAIT_MS (Claude auto-review #1/#2, PR #38).
        if (gaveUp) break
      }
      const incomplete = listIncomplete(outcomes)

      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
      const who = session.label || session.key
      if (dirty) {
        // Said out loud rather than swallowed: the next inject will see
        // whatever is still on that pane.
        companionLog(`${red}commands${reset} /help overlay did not close cleanly on ${who}`)
      }
      if (gaveUp) {
        // Partial by construction — never cached, or one interrupted warm
        // would serve a truncated list for an hour.
        companionLog(`${cyan}commands${reset} full list aborted after ${all.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s on ${who}`)
        return Response.json({ ok: false, error: "aborted", key: session.key, partial: all.length }, { status: 409 })
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      if (incomplete) {
        // Either the page budget ran out before the list did, or a tab bailed
        // on the wrong tab and contributed nothing. What came back is a
        // prefix — serving it is fine for this one call, caching it would
        // hand out a truncated list for an hour (exactly what MAX_PAGES=40
        // did on a 5-row pane: 196 of 356, reported as success; and what a
        // custom-tab bail did: default commands only, no skills at all).
        const why = wrongTab ? "a tab bailed (wrong tab on its first page)" : "page budget exhausted"
        companionLog(`${red}commands${reset} full list INCOMPLETE — ${all.length} in ${elapsed}s (${rowsPerPage} rows/page) on ${who}; ${why}; not cached`)
        return Response.json({ ok: true, key: session.key, cached: false, incomplete: true, commands: all })
      }
      if (all.length) listCache.set(session.cwd, { at: Date.now(), commands: all })
      companionLog(`${cyan}commands${reset} full list → ${all.length} in ${elapsed}s (${rowsPerPage} rows/page) on ${who}`)
      return Response.json({ ok: true, key: session.key, cached: false, commands: all })
    } finally {
      // Released only after Escape + C-u above — and the release carries the
      // VERDICT of that close. Releasing unconditionally (the first cut) meant
      // a `clean:false` from closeHelpOverlay was logged and then thrown away:
      // the waiting inject was told the pane was free and typed into the still
      // open /help modal. False here answers `busy_flow` on both inject paths.
      endFlow(session.key, { clean: releaseClean })
    }
  }

  return null
}
