import { companionLog } from "../lib/log"
import { ESC_SETTLE_MS } from "../lib/command-list"
import type { Dialog } from "../lib/dialogs"
import { gatedTmux, type PaneRef } from "../lib/key-gate"
import { choicesFrom, isModelPicker, openRefusal, setKeys, type ModelScope } from "../lib/model-control"
import { resolveSession } from "../lib/sessions"
import { dialogWatcher } from "../wiring/dialogs"

// Model control routes (PRJ-OR1T Phase 14, gap-table A1·A2·A3).
//
// Two calls: `open` puts the picker up and hands back the real list, `set`
// drives it. Both go through the tmux pane the same way lib/dialogs.ts already
// does; see lib/model-control.ts for why the picker is driven rather than
// `/model <id>` sent as text.

// How long to wait for the pane to reach the state we asked for, and how often
// to re-read while waiting.
//
// A single fixed sleep was not enough, and prod verify is what caught it: at
// 450ms /api/model/open returned not_a_picker against a session whose picker
// was in fact on screen. The reason is dialog-watch's cheap gate — it only
// captures a pane when Claude Code's ~/.claude/sessions/<pid>.json says
// status "waiting", and that file has its own update cadence. Land the check
// before the file flips and the watcher reports no dialog at all. Polling
// removes the guess: we ask repeatedly until the pane agrees or we give up.
const SETTLE_TIMEOUT_MS = 3_000
const SETTLE_POLL_MS = 250
const KEY_GAP_MS = 40        // same gap /api/dialog/pick uses between keys

// One flow per session at a time. Two phones (or a phone and a retry) driving
// one picker would interleave arrow keys and land on the wrong row — the keys
// are relative to wherever the cursor currently sits.
const inFlight = new Set<string>()

async function sendKey(pane: PaneRef, key: string): Promise<boolean> {
  // A named key goes as-is; a single character goes literal, so "s" is typed
  // rather than interpreted. Same split as /api/dialog/key.
  const named = /^(Enter|Escape|Up|Down|Left|Right|Tab|Space)$/.test(key)
  const args = named ? ["send-keys", "-t", pane.tmuxPane, key] : ["send-keys", "-t", pane.tmuxPane, "-l", key]
  try {
    // Through the shared per-pane gate (lib/key-gate.ts): /api/model/cancel's
    // Escape holds off every other sender for its chord window, and a cancel
    // arriving just after a phone's Escape waits its turn too.
    await gatedTmux(pane, key, args)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Re-read one session's pane until the model picker is present (want=true) or
// gone (want=false), or the timeout runs out. Returns whatever the last read
// saw, so callers report the real state rather than assuming the wait worked.
async function settle(key: string, want: boolean): Promise<Dialog | undefined> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  for (;;) {
    await dialogWatcher.refresh(key)
    const dialog = dialogWatcher.current()[key]
    if (isModelPicker(dialog) === want) return dialog
    if (Date.now() >= deadline) return dialog
    await sleep(SETTLE_POLL_MS)
  }
}

function log(msg: string): void {
  const reset = "\x1b[0m"; const cyan = "\x1b[36m"
  companionLog(`${cyan}model${reset} ${msg}`)
}

export async function handleModelRoute(req: Request, url: URL): Promise<Response | null> {
  // ── Open the picker and return the real model list ──
  // Body: { key }. The list is never cached and never hardcoded: it is
  // whatever Claude Code shows for this account right now (gap-table A3).
  if (url.pathname === "/api/model/open" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { key?: string }
    const key = (body.key ?? "").trim()
    const session = key ? resolveSession(key) : null
    if (key && !session) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })

    const refusal = openRefusal(session, dialogWatcher.current()[session?.key ?? ""])
    if (refusal) {
      log(`open refused — ${refusal.error} (${session?.label || session?.key || key})`)
      return Response.json({ ok: false, ...refusal }, { status: 409 })
    }
    const pane: PaneRef = session!

    if (inFlight.has(session!.key)) {
      return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })
    }
    inFlight.add(session!.key)
    try {
      // Already open (the user opened it, or a previous call left it up):
      // don't send /model again, that would type into the picker.
      let dialog = dialogWatcher.current()[session!.key]
      if (!isModelPicker(dialog)) {
        await sendKey(pane, "/model")  // literal, then Enter
        await sendKey(pane, "Enter")
        dialog = await settle(session!.key, true)
      }
      if (!isModelPicker(dialog)) {
        log(`open failed — no picker on ${session!.label || session!.key}`)
        return Response.json({ ok: false, error: "not_a_picker" }, { status: 409 })
      }
      const choices = choicesFrom(dialog!)
      log(`open → ${choices.length} models on ${session!.label || session!.key}`)
      return Response.json({ ok: true, key: session!.key, choices, hints: dialog!.hints })
    } finally {
      inFlight.delete(session!.key)
    }
  }

  // ── Pick a model ──
  // Body: { key, index, scope }. scope "session" confirms with the picker's
  // "s to use this session only" hint; "default" confirms with Enter, which
  // Claude Code also saves as the new-session default. That distinction is the
  // whole reason this drives the picker instead of sending `/model <id>`.
  if (url.pathname === "/api/model/set" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { key?: string; index?: number; scope?: string }
    const key = (body.key ?? "").trim()
    const index = body.index
    const scope: ModelScope = body.scope === "session" ? "session" : "default"
    if (typeof index !== "number") return Response.json({ ok: false, error: "invalid-args" }, { status: 400 })

    const session = key ? resolveSession(key) : null
    if (!session?.tmuxPane) return Response.json({ ok: false, error: "no_pane" }, { status: 410 })

    if (inFlight.has(session.key)) {
      return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })
    }
    inFlight.add(session.key)
    try {
      // Re-read the pane rather than trusting the list the client was handed:
      // the user may have moved the cursor, or closed and reopened the picker,
      // since /open. The arrow count is relative to where the cursor IS.
      await dialogWatcher.refresh(session.key)
      const dialog = dialogWatcher.current()[session.key]
      if (!isModelPicker(dialog)) {
        log(`set refused — picker not open on ${session.label || session.key}`)
        return Response.json({ ok: false, error: "not_a_picker" }, { status: 409 })
      }

      const keys = setKeys(dialog!, index, scope)
      if (!Array.isArray(keys)) {
        return Response.json({ ok: false, ...keys }, { status: 400 })
      }
      const chosen = choicesFrom(dialog!)[index]
      for (const k of keys) {
        if (!await sendKey(session, k)) {
          return Response.json({ ok: false, error: "send_failed" }, { status: 500 })
        }
        await sleep(KEY_GAP_MS)
      }
      // The picker should be gone now. If it is still up after the wait, the
      // confirm did not take — report that instead of claiming a set that did
      // not happen.
      const after = await settle(session.key, false)
      const settled = !isModelPicker(after)
      log(`set → "${chosen?.text ?? index}" scope=${scope} on ${session.label || session.key}${settled ? "" : " (picker still open)"}`)
      return Response.json({
        ok: settled,
        error: settled ? undefined : "not_settled",
        key: session.key,
        scope,
        chosen: chosen ?? null,
        // What the pane shows now. The session's `model` field only catches up
        // on the next answered turn, so this is the immediate confirmation.
        dialog: settled ? undefined : after,
      }, { status: settled ? 200 : 409 })
    } finally {
      inFlight.delete(session.key)
    }
  }

  // ── Close the picker without choosing ──
  // The phone dismissing its sheet must not leave a modal on the pane: while
  // one is up, inject refuses (Phase 13) and the session looks stuck.
  if (url.pathname === "/api/model/cancel" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { key?: string }
    const key = (body.key ?? "").trim()
    const session = key ? resolveSession(key) : null
    if (!session?.tmuxPane) return Response.json({ ok: false, error: "no_pane" }, { status: 410 })
    const dialog = dialogWatcher.current()[session.key]
    if (!isModelPicker(dialog)) return Response.json({ ok: true, closed: false })
    await sendKey(session, "Escape")
    // Escape is a meta-chord prefix (ESC_SETTLE_MS, lib/command-list.ts): the
    // next byte inside this window is read as opt+<byte>, the Escape never
    // fires, and the picker the caller thinks it just closed is still up. The
    // settle also buys the redraw `settle()` is about to look for — a fixed
    // 40ms gap once reported closed:false on a cancel that had in fact worked.
    await sleep(ESC_SETTLE_MS)
    const after = await settle(session.key, false)
    log(`cancel on ${session.label || session.key}`)
    return Response.json({ ok: true, closed: !isModelPicker(after) })
  }

  return null
}
