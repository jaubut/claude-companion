import { companionLog } from "../lib/log"
import { ESC_SETTLE_MS } from "../lib/command-list"
import { pickKeys } from "../lib/dialogs"
import { gatedTmux, opensChordWindow } from "../lib/key-gate"
import { paneLabel } from "../lib/tmux-argv"
import { resolveSession } from "../lib/sessions"
import { dialogWatcher } from "../wiring/dialogs"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Dialog mirror routes: keys and row picks from the phone into an open
// Claude Code dialog (see wiring/dialogs.ts for the watcher).

export async function handleDialogRoute(req: Request, url: URL): Promise<Response | null> {
  // ── Dialog mirror — keys from the phone into an open Claude Code dialog ──
  // Body: { key, name } where name is Enter | Escape | Up | Down | Left |
  // Right | Tab | Space or one literal character (a digit picks a numbered
  // row, "s" answers a hint like "s to use this session only").
  if (url.pathname === "/api/dialog/key" && req.method === "POST") {
    const body = await req.json() as { key?: string; name?: string }
    const key = (body.key ?? "").trim()
    const name = (body.name ?? "").trim()
    const session = key ? resolveSession(key) : null
    if (!session?.tmuxPane) return Response.json({ ok: false, error: "no tmux pane for session" }, { status: 404 })
    const named = /^(Enter|Escape|Up|Down|Left|Right|Tab|Space)$/.test(name)
    if (!named && [...name].length !== 1) return Response.json({ ok: false, error: "name must be a key name or one character" }, { status: 400 })
    const args = named ? ["send-keys", "-t", session.tmuxPane, name] : ["send-keys", "-t", session.tmuxPane, "-l", name]
    try {
      // Through the shared per-pane gate (lib/key-gate.ts). Escape is a
      // meta-chord PREFIX (ESC_SETTLE_MS, lib/command-list.ts): a key arriving
      // within a few ms of it is read as opt+<key> and swallowed. Holding this
      // response only serialised one client's taps; the gate spaces EVERY
      // sender on the pane — a second phone, /api/model/cancel, the /help
      // close path — behind the Escape's window.
      await gatedTmux(session, name, args)
    } catch {
      return Response.json({ ok: false, error: "tmux send-keys failed" }, { status: 500 })
    }
    // Still hold the response over the window. Every tmux sender waits on the
    // gate now, injects included; this covers the one that cannot — an inject
    // with no tmux pane, typed through osascript on the Mac.
    if (opensChordWindow(name)) await sleep(ESC_SETTLE_MS)
    const reset = "\x1b[0m"; const cyan = "\x1b[36m"
    companionLog(`${cyan}dialog key${reset} ${name} → ${paneLabel(session.tmuxPane, session.tmuxSocket)}`)
    setTimeout(() => void dialogWatcher.refresh(session.key), 350)
    return Response.json({ ok: true })
  }

  // Pick a row: move the cursor onto it with Up/Down from where it sits
  // (arrows work in every list; digits only in the question picker). The
  // phone confirms with Enter or a hint key.
  if (url.pathname === "/api/dialog/pick" && req.method === "POST") {
    const body = await req.json() as { key?: string; index?: number }
    const key = (body.key ?? "").trim()
    const session = key ? resolveSession(key) : null
    if (!session?.tmuxPane) return Response.json({ ok: false, error: "no tmux pane for session" }, { status: 404 })
    const dialog = dialogWatcher.current()[session.key]
    const keys = dialog ? pickKeys(dialog, typeof body.index === "number" ? body.index : -1) : null
    if (!keys) return Response.json({ ok: false, error: "no such row" }, { status: 404 })
    try {
      for (const k of keys) {
        await gatedTmux(session, k, ["send-keys", "-t", session.tmuxPane, k])
        await new Promise((r) => setTimeout(r, 40))
      }
    } catch {
      return Response.json({ ok: false, error: "tmux send-keys failed" }, { status: 500 })
    }
    setTimeout(() => void dialogWatcher.refresh(session.key), 350)
    return Response.json({ ok: true, sent: keys.length })
  }
  return null
}
