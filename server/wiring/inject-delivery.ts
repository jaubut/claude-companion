import { basename } from "node:path"
import { deliverHeadlessAgyTurn } from "../lib/agy-feed"
import { headlessBrainRunner } from "./brain"
import { workerSupervisor } from "./worker-mcp"
import { companionLog } from "../lib/log"
import { deliveryFailedHint, echoPromptOnInject, injectConfirmed } from "../lib/submit-confirm"
import { injectRefusal } from "../lib/inject-guard"
import { clearWaitingForTarget, getSessionByKey, listSessions, resolveSession } from "../lib/sessions"
import { recordUserPrompt } from "../lib/activity"
import { broadcast } from "../state"
import { openDialogFor, paneWidthFor, screenSnapshotFor, yieldPaneForInject } from "./dialogs"
import { announceWaiting } from "./waiting"

/**
 * The guarded delivery behind POST /api/inject (refusals, waiting-badge clear,
 * submit confirmation). Also the canvas Context-edge send (wiring/canvas.ts),
 * so a canvas prompt passes the exact same inject guards as a phone prompt.
 */
export async function deliverInject(text: string, key?: string, cwd?: string, boundSid?: string, canDeliver?: () => boolean): Promise<Response> {
  const lookup = key || cwd || ""
  let target = lookup ? resolveSession(lookup) : null
  // The target the caller actually named, captured before the fallback below
  // reassigns `target`. Only this one may have its waiting badge cleared:
  // the fallback is a delivery convenience and picks whichever session was
  // active last, which is not the session the text was addressed to.
  const explicit = target

  // No explicit target: pick the most-recently-active registered
  // session as "frontmost". On Linux this is the only sane fallback —
  // the legacy pbcopy + Cmd+V path is macOS-only and ENOENTs on Bun
  // under Linux. On macOS this is also a safer default than blind
  // System Events paste into whatever app happens to be frontmost
  // (Cursor, Safari, anything). Caller that truly wants the
  // System-Events fallback can still send key="" + cwd="" on a
  // server with no registered sessions; injectText handles that.
  if (!lookup) {
    const recent = listSessions().find(s => !!s.tty || s.herdrPane?.startsWith("headless:"))
    if (recent) target = recent
  }

  // Headless session delivery (BKM-Q24R): brain, Inverted MCP workers, and headless Antigravity conversations.
  if (target?.herdrPane?.startsWith("headless:")) {
    if (boundSid && target.sessionId !== boundSid) {
      return Response.json({ ok: false, error: "target_changed", key, cwd }, { status: 409 })
    }
    if (canDeliver && !canDeliver()) {
      return Response.json({ ok: false, error: "target_changed", key, cwd }, { status: 409 })
    }
    const { cleared } = clearWaitingForTarget(explicit, "turn-end")
    announceWaiting(cleared)
    recordUserPrompt({
      text,
      cwd: target.cwd,
      sessionId: target.sessionId,
      tty: target.tty,
      sessionKey: target.key,
    })
    if (target.herdrPane === "headless:brain") {
      const r = await headlessBrainRunner.deliver(text)
      if (!r.ok) return r
      return Response.json({ ok: true, confirmed: true })
    }
    if (target.herdrPane.startsWith("headless:worker:")) {
      const taskId = target.taskId || target.herdrPane.slice("headless:worker:".length)
      const existing = workerSupervisor.getTask(taskId)
      const dispatched = await workerSupervisor.dispatchTask({
        taskId,
        repo: existing?.repo || basename(target.cwd),
        title: existing?.title || target.title || taskId,
        prompt: text,
        mode: "auto",
        family: existing?.family ?? (target.agent === "codex" || target.agent === "gemini" ? target.agent : "claude"),
        model: (target.model || existing?.model) ?? undefined,
      })
      if (!dispatched.ok) {
        return Response.json({ ok: false, error: dispatched.error ?? "deliver_failed", key, cwd }, { status: 409 })
      }
      return Response.json({ ok: true, confirmed: true })
    }
    if (target.herdrPane.startsWith("headless:agy:")) {
      const ok = deliverHeadlessAgyTurn({
        sessionId: target.sessionId,
        cwd: target.cwd,
        prompt: text,
      })
      return Response.json(ok ? { ok: true, confirmed: true } : { ok: false, error: "deliver_failed" }, { status: ok ? 200 : 500 })
    }
  }

  // A dialog the COMPANION opened (the /help command scrape) is ours to
  // close, not the user's problem — stop it and take the pane back before
  // the refusal check even looks. If we could NOT take it back, the pane is
  // in an unknown state (the scrape may still have its modal up and the
  // watcher is still skipping that session, so the dialog check below would
  // pass on a stale null): it is a `busy_flow` refusal below, not a blind
  // send-keys.
  const paneFree = await yieldPaneForInject(target)

  // Refuse before clearing any waiting reason (see lib/inject-guard.ts):
  // target not registered, no live tty, or a dialog in the way. A dialog is
  // modal in the pane — typing into one answers it instead of reaching the
  // input box — so it is a refusal, not a delivery problem.
  // With the pane still held there is nothing to learn from the watcher —
  // it is skipping that session for the duration of the flow.
  // Last, the pane itself: an input box that is on screen and empty, or a
  // refusal (pane_not_ready) — the agents panel, the shortcuts overlay and a
  // late /help take keys without ever becoming a Dialog.
  const refusal = injectRefusal({
    lookup, target, paneFree,
    dialog: paneFree ? await openDialogFor(target) : null,
    pane: paneFree ? await screenSnapshotFor(target) : undefined,
    paneWidth: paneFree ? await paneWidthFor(target) : undefined,
  })
  if (refusal) {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"
    // label is often empty (a session with no resolved title), so fall back
    // to the key — an unnamed refusal reads as "inject refused — has a
    // dialog open", which names nothing.
    const who = target?.label || target?.key || lookup
    const why = refusal.error === "target_gone" ? `target ${lookup} not registered`
      : refusal.error === "target_idle" ? `target ${who} has no live tty`
      : refusal.error === "busy_flow" ? `${who} pane still held by a companion flow`
      : refusal.error === "pane_too_narrow" ? `${who} pane only ${refusal.width} cols wide — input box can't be verified`
      : refusal.error === "pane_not_ready" ? `${who} pane not at an empty prompt (${refusal.reason}) — ${JSON.stringify(refusal.excerpt?.slice(-160) ?? "")}`
      : `${who} has a dialog open — "${refusal.dialog?.title || "(untitled)"}"`
    companionLog(`${red}inject refused${reset} — ${why}`)
    // 409 for the dialog and for a pane we could not take back: the request
    // is fine and the target is alive, it just can't accept text yet. 410
    // stays the "this target is gone" code the phone already maps to a
    // re-pin prompt.
    const status = refusal.error === "dialog_open" || refusal.error === "busy_flow" || refusal.error === "pane_not_ready" || refusal.error === "pane_too_narrow" ? 409 : 410
    return Response.json({
      ok: false, error: refusal.error, key, cwd, dialog: refusal.dialog, reason: refusal.reason, excerpt: refusal.excerpt, width: refusal.width,
    }, { status })
  }

  const dim = "\x1b[2m"
  const reset = "\x1b[0m"
  const cyan = "\x1b[36m"
  const tag = target ? ` → ${target.label || target.key}` : " → frontmost"
  companionLog(`${cyan}injecting${reset}${tag} "${text.slice(0, 60)}"`)

  // Clear only what the caller named, and only its turn-end reason: typed
  // text answers neither a pending approval nor an open dialog. With no
  // explicit target and more than one session waiting on a turn-end, clear
  // nothing rather than blank the wrong badge.
  const { cleared, refused } = clearWaitingForTarget(explicit, "turn-end")
  announceWaiting(cleared)
  if (!cleared && refused > 0) {
    companionLog(`\x1b[33minject: ${refused} sessions waiting, no target — cleared none\x1b[0m`)
  }

  const res = await injectConfirmed(text, target ?? undefined, undefined, boundSid === undefined ? canDeliver : () => !!boundSid && getSessionByKey(key ?? "")?.sessionId === boundSid && (canDeliver?.() ?? true))
  if (!res.ok && res.error === "target_changed") return Response.json({ ok: false, error: res.error, key, cwd }, { status: 409 })
  if (!res.ok && res.error === "pane_not_ready") {
    // herdr refused it (agent_blocked): same 409 as the pre-inject refusal.
    companionLog(`\x1b[31minject refused\x1b[0m — ${target?.label || target?.key} herdr agent blocked`)
    return Response.json({ ok: false, error: res.error, key, cwd, reason: res.reason, excerpt: res.excerpt }, { status: 409 })
  }
  if (!res.ok && res.error === "not_submitted") {
    // Typed but never submitted (no UserPromptSubmit after Enter + one
    // retry). Tell every client so the bubble is marked undelivered, and
    // answer 409 like the other "target alive, text not accepted" cases.
    broadcast({ type: "inject_error", error: "not_submitted", key: target?.key ?? key, cwd: target?.cwd ?? cwd, text, excerpt: res.excerpt })
    return Response.json({ ok: false, error: "not_submitted", excerpt: res.excerpt, key, cwd }, { status: 409 })
  }
  const ok = res.ok
  if (!ok) {
    companionLog(`\x1b[31minject failed\x1b[0m — delivery failed (${deliveryFailedHint()})`)
  } else if (target && echoPromptOnInject(res)) {
    // Unconfirmable delivery only (see echoPromptOnInject): the hook is
    // the source of truth everywhere it can be observed.
    recordUserPrompt({
      text,
      cwd: target.cwd,
      sessionId: target.sessionId,
      tty: target.tty,
      sessionKey: target.key,
    })
  }
  return Response.json(res.ok
    ? { ok, confirmed: res.confirmed, ...(res.queued ? { queued: true } : {}), ...(res.command ? { command: true } : {}) }
    : { ok, error: "deliver_failed", hint: deliveryFailedHint() })
}
