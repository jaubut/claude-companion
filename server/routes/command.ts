import { CLEAR_LINE_KEY, inputLine, parseCommandMenu, suggestRefusal } from "../lib/command-menu"
import { type CommandEntry, type HelpTab, helpTab, mergePages, parseHelpPage } from "../lib/command-list"
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
const inFlight = new Set<string>()

// Full list cache (Phase 16b). Keyed by cwd: built-ins are per host, but the
// custom tab includes project-level skills and commands, so two sessions in
// different projects can legitimately see different lists. An hour is long
// enough that the phone's `/` is instant all session, short enough that a
// skill added today shows up today. `force` bypasses it.
const LIST_TTL_MS = 60 * 60 * 1000
const listCache = new Map<string, { at: number; commands: CommandEntry[] }>()
// Help pages hold ~17 rows; the cursor must walk to the bottom before the
// list scrolls, so the first batch may not change the page — that is why the
// end condition is TWO unchanged pages, not one. Keys go one at a time: a
// single send-keys carrying 17 Downs was seen to drop most of them mid-repaint.
const PAGE_ROWS = 17
const KEY_MS = 45
const PAGE_SETTLE_MS = 600
const MAX_PAGES = 40

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
    if (inFlight.has(session!.key)) {
      return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })
    }
    inFlight.add(session!.key)
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
      inFlight.delete(session!.key)
    }
  }

  // ── Every command the session knows about ──
  // Body: { key, force? }. Drives /help twice (default tab, custom tab), pages
  // each with Down until nothing new appears, Escapes, and caches per cwd.
  // Slow the first time — several seconds — so the phone calls it in the
  // background when a session becomes active, not when the user types "/".
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
    if (inFlight.has(session.key)) return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })

    const pane = session.tmuxPane
    inFlight.add(session.key)
    const t0 = Date.now()
    try {
      const all: CommandEntry[] = []
      for (const tab of ["default", "custom"] as HelpTab[]) {
        // A fresh /help per tab: once the list has taken focus, Tab no longer
        // switches tabs (measured — it silently stays put).
        await sendKey(pane, CLEAR_LINE_KEY)
        await sendLiteral(pane, "/help")
        await sendKey(pane, "Enter")
        await sleep(1_800)
        for (let i = 0; i < (tab === "default" ? 1 : 2); i++) { await sendKey(pane, "Tab"); await sleep(700) }

        const pages: ReturnType<typeof parseHelpPage>[] = []
        const seen = new Set<string>()
        let stale = 0
        for (let page = 0; page < MAX_PAGES; page++) {
          const text = await capturePane(pane) ?? ""
          if (page === 0 && helpTab(text) !== tab) break   // wrong tab — bail rather than mislabel
          const rows = parseHelpPage(text)
          const before = seen.size
          for (const r of rows) seen.add(r.name)
          pages.push(rows)
          stale = seen.size === before ? stale + 1 : 0
          if (stale >= 2) break
          for (let k = 0; k < PAGE_ROWS; k++) { await sendKey(pane, "Down"); await sleep(KEY_MS) }
          await sleep(PAGE_SETTLE_MS)
        }
        all.push(...mergePages(pages, tab))
        await sendKey(pane, "Escape")
        await sleep(500)
      }
      // Leave the box exactly as found: empty.
      await sendKey(pane, CLEAR_LINE_KEY)

      if (all.length) listCache.set(session.cwd, { at: Date.now(), commands: all })
      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
      process.stderr.write(`${dim}[companion]${reset} ${cyan}commands${reset} full list → ${all.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s on ${session.label || session.key}\n`)
      return Response.json({ ok: true, key: session.key, cached: false, commands: all })
    } finally {
      inFlight.delete(session.key)
    }
  }

  return null
}
