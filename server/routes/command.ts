import { CLEAR_LINE_KEY, inputLine, parseCommandMenu, suggestRefusal } from "../lib/command-menu"
import { type CommandEntry, type HelpTab, scrapeHelpTab } from "../lib/command-list"
import { beginFlow, endFlow, scrapeAbortRequested } from "../lib/command-scrape"
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
const HELP_OPEN_MS = 1_800
const TAB_SWITCH_MS = 700
const ESCAPE_SETTLE_MS = 500

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

async function tmux(args: string[]): Promise<boolean> {
  try {
    await Bun.spawn(["tmux", ...args], { stdout: "ignore", stderr: "ignore" }).exited
    return true
  } catch {
    return false
  }
}

const sendKey = (pane: string, key: string) => tmux(["send-keys", "-t", pane, key])
const sendLiteral = (pane: string, text: string) => tmux(["send-keys", "-t", pane, "-l", text])

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

    const typedNow = session?.tmuxPane ? inputLine(await capturePane(session.tmuxPane) ?? "") : null
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
      await sendKey(pane, CLEAR_LINE_KEY)
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
      await sendKey(pane, CLEAR_LINE_KEY)

      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
      process.stderr.write(`${dim}[companion]${reset} ${cyan}commands${reset} "/${prefix}" → ${commands.length} on ${session!.label || session!.key}\n`)
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

    const typedNow = session.tmuxPane ? inputLine(await capturePane(session.tmuxPane) ?? "") : null
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
    try {
      const all: CommandEntry[] = []
      let rowsPerPage = 0
      let gaveUp = false
      for (const tab of ["default", "custom"] as HelpTab[]) {
        // A fresh /help per tab: once the list has taken focus, Tab no longer
        // switches tabs (measured — it silently stays put).
        await sendKey(pane, CLEAR_LINE_KEY)
        await sendLiteral(pane, "/help")
        await sendKey(pane, "Enter")
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
        }

        // Close the help dialog whatever happened — an abandoned scrape must
        // not leave a modal on the pane for the next inject to hit.
        await sendKey(pane, "Escape")
        await sleep(ESCAPE_SETTLE_MS)
        if (gaveUp) break
      }
      // Leave the box exactly as found: empty.
      await sendKey(pane, CLEAR_LINE_KEY)

      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
      const who = session.label || session.key
      if (gaveUp) {
        // Partial by construction — never cached, or one interrupted warm
        // would serve a truncated list for an hour.
        process.stderr.write(`${dim}[companion]${reset} ${cyan}commands${reset} full list aborted after ${all.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s on ${who}\n`)
        return Response.json({ ok: false, error: "aborted", key: session.key, partial: all.length }, { status: 409 })
      }
      if (all.length) listCache.set(session.cwd, { at: Date.now(), commands: all })
      process.stderr.write(`${dim}[companion]${reset} ${cyan}commands${reset} full list → ${all.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${rowsPerPage} rows/page) on ${who}\n`)
      return Response.json({ ok: true, key: session.key, cached: false, commands: all })
    } finally {
      // Released only after Escape + C-u above, so whoever was waiting on the
      // abort finds a clean input box.
      endFlow(session.key)
    }
  }

  return null
}
