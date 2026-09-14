import { CLEAR_LINE_KEY, inputLine, parseCommandMenu, suggestRefusal } from "../lib/command-menu"
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

  return null
}
