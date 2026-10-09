import { inputLine, parseCommandMenu, suggestRefusal, unstyle } from "../lib/command-menu"
import { companionLog } from "../lib/log"
import { commandLister } from "../lib/command-offpane-cache"
import { beginFlow, endFlow } from "../lib/command-scrape"
import { keyGate, runTmux } from "../lib/key-gate"
import { type Session, resolveSession } from "../lib/sessions"
import { herdrGatedKey, herdrGatedText, herdrPaneOf, realHerdr } from "../lib/herdr"
import { type PaneRef, capturePane, paneKey, paneRefOf, sendKeysArgs } from "../lib/tmux-pane"
import { dialogWatcher } from "../wiring/dialogs"
import { clearIfOurs, finishSuggestProbe } from "../lib/suggest-cleanup"

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
async function gated(gateKey: string, key: string, send: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> {
  try {
    await keyGate.send(gateKey, key, send)
    return true
  } catch {
    return false
  }
}

// The session's pane as this flow drives it: tmux, else herdr. `capture`
// with escapes = the `capture-pane -e` shape (herdr's read is always styled).
interface SuggestPane {
  capture(escapes?: boolean): Promise<string | null>
  key(key: string): Promise<boolean>
  literal(text: string): Promise<boolean>
}

function tmuxSuggestPane(ref: PaneRef): SuggestPane {
  const gk = paneKey(ref.pane, ref.socket)
  return {
    capture: (escapes = false) => capturePane(ref.pane, undefined, { escapes, socket: ref.socket }),
    key: (key) => gated(gk, key, (signal) => runTmux(sendKeysArgs(ref, key), signal)),
    literal: (text) => gated(gk, text, (signal) => runTmux(sendKeysArgs(ref, "-l", text), signal)),
  }
}

// Sends ride the pane's key-gate turn with its abort (herdrGatedKey/Text).
function herdrSuggestPane(pane: string): SuggestPane {
  return {
    capture: async (escapes = false) => {
      const text = await realHerdr.read(pane)
      return text === null || escapes ? text : unstyle(text)
    },
    key: (key) => herdrGatedKey(keyGate, pane, key),
    literal: (text) => herdrGatedText(keyGate, pane, text),
  }
}

function suggestPaneOf(session: Session | null): SuggestPane | null {
  const ref = paneRefOf(session)
  if (ref) return tmuxSuggestPane(ref)
  const herdrPane = herdrPaneOf(session)
  return herdrPane ? herdrSuggestPane(herdrPane) : null
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

    const io = suggestPaneOf(session)
    const typedNow = io ? inputLine(await io.capture(true) ?? "") : null
    const refusal = suggestRefusal(
      session,
      dialogWatcher.current()[session?.key ?? ""],
      typedNow,
      `/${prefix}`,
    )
    if (refusal) return Response.json({ ok: false, ...refusal }, { status: 409 })

    const pane = io!
    if (!beginFlow(session!.key, "suggest")) {
      return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })
    }
    // Once `/prefix` may be in the box, any exit that skips the verified
    // cleanup below releases the pane dirty, never clean by default.
    let typed = false
    try {
      // Always start from a known-empty line: the previous suggestion left its
      // own prefix there, and Escape does not clear it (it closes the menu and
      // keeps the text, which is how an earlier attempt typed "//").
      const who = session!.label || session!.key
      if (!(await clearIfOurs(pane, [`/${prefix}`], who))) {
        return Response.json({ ok: false, error: "input_busy" }, { status: 409 })
      }
      typed = true
      await pane.literal(`/${prefix}`)

      // Poll rather than sleep a fixed amount — the same lesson the model
      // routes learned the hard way: a fixed wait is a guess about a redraw.
      const deadline = Date.now() + SETTLE_TIMEOUT_MS
      let commands: ReturnType<typeof parseCommandMenu> = []
      for (;;) {
        await sleep(SETTLE_POLL_MS)
        const pane2 = await pane.capture()
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
      //
      // The flow ends on what the line reads AFTER the clear (lib/
      // suggest-cleanup.ts): a failed or ineffective C-u releases the pane
      // `clean:false`, so the next inject verifies it instead of typing on
      // top of `/prefix`.
      await finishSuggestProbe(session!.key, pane, [`/${prefix}`], who, sleep)

      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
      companionLog(`${cyan}commands${reset} "/${prefix}" → ${commands.length} on ${session!.label || session!.key}`)
      return Response.json({ ok: true, key: session!.key, prefix, commands })
    } finally {
      // A no-op when finishSuggestProbe already ended the flow.
      endFlow(session!.key, typed ? { clean: false } : {})
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
  // missing claude binary, a claude too old for the throwaway HOME (Linux
  // < 2.1.284 — logged once), or an enumeration still running after 50s (the iOS
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
    // claude too old for the throwaway HOME: the lister already logged it
    // once; answer the same retry-later shape without a line per request.
    if (result.status === "unsupported") return aborted(0)
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
