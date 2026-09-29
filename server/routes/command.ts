import { CLEAR_LINE_KEY, inputLine, mayClearLine, parseCommandMenu, suggestRefusal } from "../lib/command-menu"
import { companionLog } from "../lib/log"
import { CLEAR_SETTLE_MS } from "../lib/command-list"
import { commandLister } from "../lib/command-offpane-cache"
import { beginFlow, endFlow } from "../lib/command-scrape"
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
  // Body: { key, force? }. Returns { commands: [{name, description, kind}] },
  // plus `cached`, and `incomplete: true` when the list is a prefix.
  //
  // Enumerated OFF the user's pane (lib/command-offpane.ts): a hidden
  // `cc-scrape-*` tmux session runs claude in the same cwd (hooks and MCP
  // off), /help is scraped there, the session is killed. The user's pane gets
  // zero keystrokes, so nothing here claims it, refuses on its state, or is
  // aborted by an inject.
  //
  // CLIENT CONTRACT — unchanged from the in-pane scrape; every answer is one
  // main already gave:
  //   200 {ok, key, cached:true, commands}                    cache hit
  //   200 {ok, key, cached:false, commands}                   whole list
  //   200 {ok, key, cached:false, incomplete:true, commands}  a non-empty prefix
  //   409 {ok:false, error:"aborted", key, partial}           nothing usable yet — retry later
  //   410 {ok:false, error:"target_gone"}
  // A setup wizard in the hidden claude, a timeout, a tmux/capture failure, a
  // missing claude binary, or an enumeration still running after 50s (the iOS
  // client gives up at 60s; the run finishes and caches in the background) all
  // answer `aborted`, never an empty ok:true list. A wizard/error is remembered
  // per fingerprint for 10 min (lib/command-offpane-cache.ts) and answered with
  // that same `aborted` shape without booting another claude.
  if (url.pathname === "/api/command/list" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { key?: string; force?: boolean }
    const key = (body.key ?? "").trim()
    const session = key ? resolveSession(key) : null
    if (!session) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })

    const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
    const who = session.label || session.key
    const aborted = (partial: number) =>
      Response.json({ ok: false, error: "aborted", key: session.key, partial }, { status: 409 })

    // /help is Claude Code's; a Codex session has a different command set and
    // there is nothing to enumerate.
    if (session.agent === "codex") return aborted(0)

    const t0 = Date.now()
    const { cached, result } = await commandLister.list(session.cwd, { force: body.force === true })
    if (cached) return Response.json({ ok: true, key: session.key, cached: true, commands: result.commands })

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const n = result.commands.length
    if (result.status === "ok" && n > 0) {
      companionLog(`${cyan}commands${reset} full list → ${n} in ${elapsed}s (${result.rowsPerPage} rows/page) off-pane for ${who}`)
      return Response.json({ ok: true, key: session.key, cached: false, commands: result.commands })
    }
    if (result.status === "incomplete" && n > 0) {
      companionLog(`${red}commands${reset} full list INCOMPLETE — ${n} in ${elapsed}s (${result.rowsPerPage} rows/page) off-pane for ${who}; not cached`)
      return Response.json({ ok: true, key: session.key, cached: false, incomplete: true, commands: result.commands })
    }
    const why = result.status === "wizard"
      ? `hidden claude stopped at a setup dialog in ${session.cwd}`
      : result.status === "pending"
        ? "still enumerating — answering retry, the run caches when it lands"
        : `${result.status}${result.detail ? `: ${result.detail}` : ""}`
    companionLog(`${red}commands${reset} full list aborted after ${n} in ${elapsed}s off-pane for ${who} (${why}); not cached`)
    return aborted(n)
  }

  return null
}
