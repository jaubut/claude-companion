import type { WebSocketHandler } from "bun"
import { resolveApproval, getPending } from "./lib/pty-manager"
import { resolveQuestion, getPendingQuestions, type QuestionAnswer } from "./lib/questions"
import { injectText } from "./lib/keyboard-inject"
import { isSuperAuto } from "./lib/super-auto"
import { clearWaitingForTarget, resolveSession, listSessions, waitingSummary } from "./lib/sessions"
import { getActivity } from "./lib/activity"
import { getFeed } from "./lib/feed"
import { clients, broadcast, HOST_INFO, type WsData } from "./state"
import { dialogWatcher } from "./wiring/dialogs"

// WebSocket handlers: on open, replay pending approvals/questions and send the
// init frame; on message, approve/deny/answer/input/ping; on close, drop the
// client. Same frames and log lines as before the split.
export const websocket: WebSocketHandler<WsData> = {
  open(ws) {
    clients.add(ws)

    const pendingList = getPending()
    for (const req of pendingList) {
      ws.send(JSON.stringify({
        type: "approval",
        id: req.id,
        agent: req.agent ?? "claude",
        tool: req.tool,
        input: req.input,
        sessionId: req.sessionId,
        cwd: req.cwd,
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

    ws.send(JSON.stringify({
      type: "init",
      pending: pendingList.length,
      ...waitingSummary(),
      activity: getActivity(),
      feed: getFeed(),
      sessions: listSessions(),
      superAuto: isSuperAuto(),
      dialogs: dialogWatcher.current(),
      host: HOST_INFO,
    }))
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
        if (msg.id) {
          resolveApproval(msg.id, "allow")
          broadcast({ type: "resolved", id: msg.id, decision: "allow" })
        }
        break
      case "deny":
        if (msg.id) {
          resolveApproval(msg.id, "deny")
          broadcast({ type: "resolved", id: msg.id, decision: "deny" })
        }
        break
      case "answer":
        if (msg.id && Array.isArray(msg.answers) && msg.answers.length > 0) {
          const answers: QuestionAnswer[] = msg.answers.map((a) => ({
            selected: Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === "string") : [],
            otherText: typeof a.otherText === "string" ? a.otherText : undefined,
          }))
          if (resolveQuestion(msg.id, answers)) {
            broadcast({ type: "resolved", id: msg.id, decision: "answered" })
          }
        }
        break
      case "input":
        if (msg.text?.trim()) {
          const lookup = msg.key || msg.cwd || ""
          const target = lookup ? resolveSession(lookup) : null
          const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
          const tag = target?.tty ? ` → ${target.label || target.key} (${target.tty})` : lookup ? ` → ${lookup} [unresolved]` : " → frontmost"
          process.stderr.write(`${dim}[companion]${reset} ${cyan}ws inject${reset}${tag} "${msg.text.slice(0, 60)}"\n`)
          if (lookup && !target) {
            process.stderr.write(`${dim}[companion]${reset} ${red}ws inject refused${reset} — ${lookup} not registered\n`)
            try {
              ws.send(JSON.stringify({ type: "inject_error", error: "target_gone", key: msg.key, cwd: msg.cwd }))
            } catch { /* ignore */ }
            break
          }
          if (target && !target.tty) {
            process.stderr.write(`${dim}[companion]${reset} ${red}ws inject refused${reset} — ${target.label || target.key} has no tty\n`)
            try {
              ws.send(JSON.stringify({ type: "inject_error", error: "target_idle", key: msg.key, cwd: msg.cwd }))
            } catch { /* ignore */ }
            break
          }
          // `target` is exactly what the client addressed (null when it sent
          // neither key nor cwd), so this never clears a bystander.
          const { cleared } = clearWaitingForTarget(target)
          if (cleared) {
            broadcast({ type: "waiting_input", waiting: false, key: cleared.key, cwd: cleared.cwd })
          }
          const ok = await injectText(msg.text.trim(), target ?? undefined)
          if (!ok) {
            try { ws.send(JSON.stringify({ type: "inject_error", error: "osascript_failed" })) } catch { /* ignore */ }
          }
        }
        break
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }))
        break
    }
  },
  close(ws) {
    clients.delete(ws)
  },
}
