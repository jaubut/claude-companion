import { companionLog } from "./lib/log"
import type { ServerWebSocket, WebSocketHandler } from "bun"
import { resolveApproval, getPending } from "./lib/pty-manager"
import { resolveQuestion, getPendingQuestions, type QuestionAnswer } from "./lib/questions"
import { deliveryFailedHint, injectConfirmed } from "./lib/submit-confirm"
import { injectRefusal } from "./lib/inject-guard"
import { handleKeyCommand, isKeyCommand } from "./lib/secret-store"
import { isSuperAuto } from "./lib/super-auto"
import { clearWaitingForTarget, resolveSession, listSessions, waitingSummary } from "./lib/sessions"
import { getActivity, listActivities } from "./lib/activity"
import { getFeed } from "./lib/feed"
import { clients, broadcast, describeClient, HOST_INFO, type WsData } from "./state"
import { dialogWatcher, openDialogFor, paneSnapshotFor, paneWidthFor, yieldPaneForInject } from "./wiring/dialogs"
import { announceWaiting } from "./wiring/waiting"

// WebSocket handlers: on open, send the init frame, then replay pending
// approvals/questions; on message, approve/deny/answer/input/ping; on close,
// drop the client. Same frames and log lines as before the split.
export const websocket: WebSocketHandler<WsData> = {
  open(ws) {
    clients.add(ws)
    companionLog(`\x1b[2mws open ${describeClient("ws", ws.data.client)} (${clients.size} client${clients.size === 1 ? "" : "s"})\x1b[0m`)

    const pendingList = getPending()

    // init FIRST, replays after: iOS treats init as "this host resynced" and
    // drops every approval/question it holds from the host (resetHostState).
    // Replaying before init meant a phone reconnecting mid-question (push
    // tap from the background) got the question and wiped it a frame later.
    ws.send(JSON.stringify({
      type: "init",
      pending: pendingList.length,
      ...waitingSummary(),
      activity: getActivity(),
      activities: listActivities(),
      feed: getFeed(),
      sessions: listSessions(),
      superAuto: isSuperAuto(),
      dialogs: dialogWatcher.current(),
      host: HOST_INFO,
    }))
    for (const req of pendingList) {
      ws.send(JSON.stringify({
        type: "approval",
        id: req.id,
        agent: req.agent ?? "claude",
        tool: req.tool,
        input: req.input,
        sessionId: req.sessionId,
        cwd: req.cwd,
        ...(req.reason ? { reason: req.reason } : {}),
      }))
    }

    // Replay any pending questions too — without this, a phone that
    // reconnects mid-question would stay blank until Claude asks
    // something new.
    for (const q of getPendingQuestions()) {
      ws.send(JSON.stringify({
        type: "question",
        id: q.id,
        agent: q.agent ?? "claude",
        sessionId: q.sessionId,
        cwd: q.cwd,
        questions: q.questions,
      }))
    }
  },
  async message(ws, raw) {
    let msg: {
      type: string
      id?: string
      text?: string
      key?: string
      cwd?: string
      answers?: Array<{ selected?: string[]; otherText?: string }>
    }
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString())
    } catch { return }

    switch (msg.type) {
      case "approve":
      case "deny":
        if (msg.id) {
          const decision = msg.type === "approve" ? "allow" : "deny"
          const ok = resolveApproval(msg.id, decision, { device: ws.data.client?.device })
          logResolve(ws, "approval", msg.id, decision, ok)
          // Only a decision that actually reached a waiting hook is announced.
          // A late/duplicate one (already expired, answered elsewhere, or
          // decided on another phone) tells only its sender, so no phone
          // shows OK/DENY for something that never happened.
          if (ok) broadcast({ type: "resolved", id: msg.id, decision })
          else resolveFailed(ws, msg.id)
        }
        break
      case "answer":
        if (msg.id && Array.isArray(msg.answers) && msg.answers.length > 0) {
          const answers: QuestionAnswer[] = msg.answers.map((a) => ({
            selected: Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === "string") : [],
            otherText: typeof a.otherText === "string" ? a.otherText : undefined,
          }))
          const ok = resolveQuestion(msg.id, answers, { device: ws.data.client?.device })
          logResolve(ws, "question", msg.id, "answered", ok)
          if (ok) broadcast({ type: "resolved", id: msg.id, decision: "answered" })
          else resolveFailed(ws, msg.id)
        }
        break
      case "input":
        if (msg.text?.trim()) {
          // `/key NAME value` goes to secrets.env, never into the pane or a log —
          // only on a socket that passed the vault's bar at upgrade (trusted
          // network + header bearer). Refused = reported, never injected.
          if (isKeyCommand(msg.text) && !ws.data.keyGate?.allowed) {
            const refusal = ws.data.keyGate?.refusal ?? { status: 403, error: "forbidden_network", message: "/key refusé. Rien enregistré." }
            companionLog(`ws /key refused — ${refusal.error} peer=${ws.data.keyGate?.origin.peer ?? "?"}`)
            try { ws.send(JSON.stringify({ type: "key_saved", key: msg.key, cwd: msg.cwd, ok: false, ...refusal })) } catch { /* ignore */ }
            break
          }
          const keyed = isKeyCommand(msg.text) ? await handleKeyCommand(msg.text, ws.data.keyGate?.origin) : null
          if (keyed) {
            companionLog(`ws /key ${keyed.name ?? "?"} → ${keyed.ok ? "saved" : keyed.error}`)
            try { ws.send(JSON.stringify({ type: "key_saved", key: msg.key, cwd: msg.cwd, ...keyed })) } catch { /* ignore */ }
            break
          }
          const lookup = msg.key || msg.cwd || ""
          const target = lookup ? resolveSession(lookup) : null
          const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
          const tag = target?.tty ? ` → ${target.label || target.key} (${target.tty})` : lookup ? ` → ${lookup} [unresolved]` : " → frontmost"
          companionLog(`${cyan}ws inject${reset}${tag} "${msg.text.slice(0, 60)}"`)
          // Our own /help scrape never refuses a user's message: abort it and
          // take the pane back first (same as POST /api/inject). A pane we
          // could not take back is `busy_flow`, not a blind send-keys — the
          // scrape's modal may still be up and the watcher is still skipping
          // that session, so the dialog check below would wave it through.
          const paneFree = await yieldPaneForInject(target)
          // Same three refusals as POST /api/inject, same order, one decision
          // (see lib/inject-guard.ts) — including the dialog check both paths
          // were missing: with a dialog open, send-keys answers the dialog
          // instead of reaching the input box.
          const refusal = injectRefusal({
            lookup, target, paneFree,
            dialog: paneFree ? await openDialogFor(target) : null,
            pane: paneFree ? await paneSnapshotFor(target) : undefined,
            paneWidth: paneFree ? await paneWidthFor(target) : undefined,
          })
          if (refusal) {
            const why = refusal.error === "target_gone" ? `${lookup} not registered`
              : refusal.error === "target_idle" ? `${target?.label || target?.key} has no tty`
              : refusal.error === "busy_flow" ? `${target?.label || target?.key} pane still held by a companion flow`
              : refusal.error === "pane_too_narrow" ? `${target?.label || target?.key} pane only ${refusal.width} cols wide — input box can't be verified`
              : refusal.error === "pane_not_ready" ? `${target?.label || target?.key} pane not at an empty prompt (${refusal.reason}) — ${JSON.stringify(refusal.excerpt?.slice(-160) ?? "")}`
              : `${target?.label || target?.key} has a dialog open — "${refusal.dialog?.title || "(untitled)"}"`
            companionLog(`${red}ws inject refused${reset} — ${why}`)
            try {
              ws.send(JSON.stringify({
                type: "inject_error",
                error: refusal.error,
                key: msg.key,
                cwd: msg.cwd,
                dialog: refusal.dialog,
                reason: refusal.reason,
                excerpt: refusal.excerpt,
                width: refusal.width,
              }))
            } catch { /* ignore */ }
            break
          }
          // `target` is exactly what the client addressed (null when it sent
          // neither key nor cwd), so this never clears a bystander — and only
          // its turn-end reason, since typed text answers nothing else.
          const { cleared } = clearWaitingForTarget(target, "turn-end")
          announceWaiting(cleared)
          const res = await injectConfirmed(msg.text.trim(), target ?? undefined)
          if (!res.ok && res.error === "not_submitted") {
            // Every client, so whichever phone shows the bubble marks it undelivered.
            broadcast({ type: "inject_error", error: "not_submitted", key: target?.key ?? msg.key, cwd: target?.cwd ?? msg.cwd, text: msg.text.trim(), excerpt: res.excerpt })
          } else if (!res.ok) {
            const hint = deliveryFailedHint()
            companionLog(`${red}ws inject failed${reset} — delivery failed (${hint})`)
            // `error` stays the code shipped iOS builds switch on; `hint` is additive.
            try { ws.send(JSON.stringify({ type: "inject_error", error: "osascript_failed", hint })) } catch { /* ignore */ }
          }
        }
        break
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }))
        break
    }
  },
  close(ws, code) {
    clients.delete(ws)
    companionLog(`\x1b[2mws close ${describeClient("ws", ws.data.client)} code=${code} (${clients.size} left)\x1b[0m`)
  },
}

// `resolve_failed` goes to the requesting client only: the id is no longer
// pending (expired, ended elsewhere, or already decided).
function resolveFailed(ws: ServerWebSocket<WsData>, id: string): void {
  try { ws.send(JSON.stringify({ type: "resolve_failed", id, reason: "gone" })) } catch { /* ignore */ }
}

function logResolve(ws: ServerWebSocket<WsData>, what: "approval" | "question", id: string, decision: string, ok: boolean): void {
  const tag = ok ? "\x1b[36mresolve\x1b[0m" : "\x1b[33mresolve failed (gone)\x1b[0m"
  companionLog(`${tag} ${what} ${id.slice(0, 8)} → ${decision} ${describeClient("ws", ws.data.client)}`)
}
