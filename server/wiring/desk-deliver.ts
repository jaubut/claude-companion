import { basename } from "node:path"
import { AGY_BRAIN_PANE, deliverHeadlessAgyBrainTurn, deliverHeadlessAgyTurn, ensureHeadlessAgySession } from "../lib/agy-feed"
import { headlessBrainRunner } from "./brain"
import { workerSupervisor } from "./worker-mcp"
import { companionLog } from "../lib/log"
import { deliveryFailedHint, echoPromptOnInject, injectConfirmed } from "../lib/submit-confirm"
import { injectRefusal } from "../lib/inject-guard"
import { type Session, clearSessionWaiting, clearWaitingForTarget, getSessionByKey, listSessions, resolveSession, setPidDeadAdopter } from "../lib/sessions"
import { clearExternalSessionActivity, recordUserPrompt } from "../lib/activity"
import { cancelApprovalsFor } from "../lib/pty-manager"
import { cancelQuestionsFor } from "../lib/questions"
import { commandCatalog } from "../lib/command-catalog"
import { createDeskRunner, deskEnabled, isDeskRow } from "../lib/desk-runner"
import { sweepDeskOrphanQuestion } from "../lib/orphan-question"
import { broadcast } from "../state"
import { openDialogFor, paneWidthFor, screenSnapshotFor, yieldPaneForInject } from "./dialogs"
import { announceWaiting } from "./waiting"

// The one inject path (POST /api/inject, ws `input`, Canvas sends, the spawn
// seed, orphan answers, auto-compact): refusals, waiting-badge clear, then the
// delivery. headless-desk P1: with COMPANION_DESK_HEADLESS=1 a claude/codex
// session gets a desk turn (lib/desk-runner.ts) instead of keystrokes; the
// brain / worker / agy branches are unchanged; flag off = the pane path as before.

export const deskRunner = createDeskRunner({
  broadcast,
  onLine: (cwd, line) => commandCatalog.noteLine(cwd, line),
  onTurnExit: (sid) => sweepDeskOrphan(sid),
  log: (line) => companionLog(`\x1b[36m${line}\x1b[0m`),
})

function sweepDeskOrphan(sid: string): void {
  const s = listSessions().find((x) => x.sessionId === sid && isDeskRow(x))
  if (s) sweepDeskOrphanQuestion(s, (text) => deskRunner.send({ sid, agent: s.agent, cwd: s.cwd, text }))
}

// Boot (not under `bun test`): restore leases + rows, re-raise questions a
// restart orphaned, and hand a closed terminal's chat to the desk.
if (deskEnabled() && process.env.NODE_ENV !== "test") {
  deskRunner.restore()
  for (const s of listSessions()) if (isDeskRow(s) && !deskRunner.running(s.sessionId)) sweepDeskOrphan(s.sessionId)
  setPidDeadAdopter((s) => { deskRunner.adopt(s); return true })
}

function deskResponse(r: ReturnType<typeof deskRunner.send>, key?: string, cwd?: string): Response {
  if (r.ok) return Response.json({ ok: true, confirmed: true, ...(r.queued ? { queued: true } : {}) })
  return Response.json({ ok: false, error: r.error, key, cwd }, { status: r.status })
}

// Stop: kill the desk (or brain) turn, end its questions, close its approvals,
// clear its pill and waiting badges. Idempotent; false = nothing was running.
export async function interruptSession(s: Session): Promise<boolean> {
  let stopped = false
  if (isDeskRow(s)) stopped = deskRunner.interrupt(s.sessionId)
  else if (s.herdrPane === "headless:brain") { await headlessBrainRunner.interrupt(); stopped = true }
  cancelQuestionsFor({ sessionKey: s.key, sessionId: s.sessionId }, "expired", "interrupt")
  cancelApprovalsFor({ sessionKey: s.key, sessionId: s.sessionId }, "elsewhere", "interrupt")
  clearExternalSessionActivity({ cwd: s.cwd, sessionId: s.sessionId, tty: s.tty, sessionKey: s.key })
  if (clearSessionWaiting(s.key)) announceWaiting(getSessionByKey(s.key))
  return stopped
}

/**
 * The guarded delivery behind POST /api/inject (refusals, waiting-badge clear,
 * submit confirmation). Also the canvas Context-edge send (wiring/canvas.ts),
 * so a canvas prompt passes the exact same inject guards as a phone prompt.
 */
export async function deliverInject(text: string, key?: string, cwd?: string, boundSid?: string, canDeliver?: () => boolean, idemKey?: string): Promise<Response> {
  const lookup = key || cwd || ""
  const desk = deskEnabled()
  if (!lookup && desk) return Response.json({ ok: false, error: "no_target" }, { status: 410 })
  let target = lookup ? (resolveSession(lookup) ?? ensureHeadlessAgySession(lookup, cwd)) : null
  const explicit = target
  if (!lookup) {
    // Never a headless worker: a just-finished one is the most recent session, and an untargeted inject would resume it.
    const recent = listSessions().find(s => !!s.tty || (s.herdrPane?.startsWith("headless:") && !s.herdrPane.startsWith("headless:worker:")))
    if (recent) target = recent
  }

  // A desk row, or (flag on) any claude/codex session: a headless desk turn, never keystrokes.
  if (target && (isDeskRow(target) || (desk && !target.herdrPane?.startsWith("headless:")))) {
    if ((boundSid && target.sessionId !== boundSid) || (canDeliver && !canDeliver())) {
      return Response.json({ ok: false, error: "target_changed", key, cwd }, { status: 409 })
    }
    // A queued send is pinned to this sid by its lease; Canvas's claim is re-checked at dequeue.
    const r = deskRunner.send({ sid: target.sessionId, agent: target.agent, cwd: target.cwd, text, idemKey, guard: canDeliver })
    if (r.ok) announceWaiting(clearWaitingForTarget(explicit ?? target, "turn-end").cleared)
    else companionLog(`\x1b[31minject refused\x1b[0m — ${target.label || target.key}: ${r.error}`)
    return deskResponse(r, key, cwd)
  }

  // Headless session delivery (BKM-Q24R): brain, Inverted MCP workers, and headless Antigravity conversations.
  if (target?.herdrPane?.startsWith("headless:")) {
    if ((boundSid && target.sessionId !== boundSid) || (canDeliver && !canDeliver())) {
      return Response.json({ ok: false, error: "target_changed", key, cwd }, { status: 409 })
    }
    const { cleared } = clearWaitingForTarget(explicit, "turn-end")
    announceWaiting(cleared)
    if (target.herdrPane === AGY_BRAIN_PANE) {
      const ok = deliverHeadlessAgyBrainTurn({ prompt: text, cwd: target.cwd, model: target.model })
      return Response.json(ok ? { ok: true, confirmed: true } : { ok: false, error: "deliver_failed" }, { status: ok ? 200 : 500 })
    }
    if (target.herdrPane.startsWith("headless:agy:")) {
      const ok = deliverHeadlessAgyTurn({ sessionId: target.sessionId, cwd: target.cwd, prompt: text, model: target.model })
      return Response.json(ok ? { ok: true, confirmed: true } : { ok: false, error: "deliver_failed" }, { status: ok ? 200 : 500 })
    }
    recordUserPrompt({ text, cwd: target.cwd, sessionId: target.sessionId, tty: target.tty, sessionKey: target.key })
    if (target.herdrPane === "headless:brain") {
      const r = await headlessBrainRunner.deliver(text)
      return r.ok ? Response.json({ ok: true, confirmed: true }) : r
    }
    if (target.herdrPane.startsWith("headless:worker:")) {
      const taskId = target.taskId || target.herdrPane.slice("headless:worker:".length)
      const existing = workerSupervisor.getTask(taskId)
      const dispatched = await workerSupervisor.dispatchTask({
        taskId, repo: existing?.repo || basename(target.cwd), title: existing?.title || target.title || taskId,
        // A known task keeps its recorded family+model (a picked one stays pinned past retry escalation); the session's model is a display value (picker changes go through setTaskModel).
        prompt: text, mode: "auto",
        ...(existing ? {} : { family: target.agent === "codex" || target.agent === "gemini" ? target.agent : "claude", model: target.model || undefined }),
        inheritClaim: true, // Jeremie's own channel (Bearer): his follow-up resumes a bound task with its stored claim
      })
      return dispatched.ok
        ? Response.json({ ok: true, confirmed: true })
        : Response.json({ ok: false, error: dispatched.error ?? "deliver_failed", key, cwd }, { status: 409 })
    }
  }

  const paneFree = await yieldPaneForInject(target)
  const refusal = injectRefusal({
    lookup, target, paneFree,
    dialog: paneFree ? await openDialogFor(target) : null,
    pane: paneFree ? await screenSnapshotFor(target) : undefined,
    paneWidth: paneFree ? await paneWidthFor(target) : undefined,
  })
  if (refusal) {
    const reset = "\x1b[0m"; const red = "\x1b[31m"
    const who = target?.label || target?.key || lookup
    const why = refusal.error === "target_gone" ? `target ${lookup} not registered`
      : refusal.error === "target_idle" ? `target ${who} has no live tty`
      : refusal.error === "busy_flow" ? `${who} pane still held by a companion flow`
      : refusal.error === "pane_too_narrow" ? `${who} pane only ${refusal.width} cols wide — input box can't be verified`
      : refusal.error === "pane_not_ready" ? `${who} pane not at an empty prompt (${refusal.reason}) — ${JSON.stringify(refusal.excerpt?.slice(-160) ?? "")}`
      : `${who} has a dialog open — "${refusal.dialog?.title || "(untitled)"}"`
    companionLog(`${red}inject refused${reset} — ${why}`)
    const status = refusal.error === "dialog_open" || refusal.error === "busy_flow" || refusal.error === "pane_not_ready" || refusal.error === "pane_too_narrow" ? 409 : 410
    return Response.json({
      ok: false, error: refusal.error, key, cwd, dialog: refusal.dialog, reason: refusal.reason, excerpt: refusal.excerpt, width: refusal.width,
    }, { status })
  }

  const reset = "\x1b[0m"; const cyan = "\x1b[36m"
  const tag = target ? ` → ${target.label || target.key}` : " → frontmost"
  companionLog(`${cyan}injecting${reset}${tag} "${text.slice(0, 60)}"`)

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
