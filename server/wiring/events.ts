import { broadcast } from "../state"
import { onApprovalRequest, onApprovalExpired } from "../lib/pty-manager"
import { onQuestionRequest, onQuestionExpired } from "../lib/questions"
import { onFeed, onFeedReset, onActivity, type FeedEvent } from "../lib/activity"
import { summarize } from "../lib/tool-format"
import { apnsConfigured } from "../lib/apns"
import { pushToAll } from "../lib/push"
import { onSessions, setTitleResolver, type Session } from "../lib/sessions"
import { resolveTitle } from "../lib/session-titles"
import { projectLabelFor, agentTitle, subtitleFor } from "../lib/hook-common"
import { reconcileDispatch } from "./orchestrator"

// Event wiring: every lib store's listener → WS frame (+ push where the phone
// must be interrupted). One onSessions listener does the `sessions` frame and
// then reconcileDispatch, so a worker's `orchestrator_task` never precedes the
// `sessions` frame that introduced it. Registered at import time.

onApprovalRequest((req) => {
  broadcast({
    type: "approval",
    id: req.id,
    agent: req.agent ?? "claude",
    tool: req.tool,
    input: req.input,
    sessionId: req.sessionId,
    cwd: req.cwd,
  })
  // Approval = interruptive, time-sensitive. Blocks Claude until answered.
  if (apnsConfigured()) {
    const project = projectLabelFor(req.cwd)
    const summary = summarize(req.tool, req.input)
    void pushToAll({
      // Title surfaces "which project is asking + what it wants" — that's
      // the disambiguator when you've got two Claudes running. iOS already
      // prepends the app name ("Claude Companion") so we don't repeat it.
      title: project ? `${project} · ${req.tool}` : `${agentTitle(req.agent ?? "claude")} · ${req.tool}`,
      // Subtitle goes to a path-shortened preview for path-tools so the
      // banner shows "src/foo.ts" instead of the full /Users/.../path.
      subtitle: subtitleFor(req.tool, summary),
      body: summary.slice(0, 220) || req.tool,
      category: "approval",
      threadId: req.cwd || "approval",
      userInfo: { approvalId: req.id, sessionId: req.sessionId, cwd: req.cwd },
    }).catch(() => { /* silent — don't let push failure break the hook */ })
  }
})

onApprovalExpired((id) => {
  // Tell every connected client the approval expired before the user
  // could decide. Use the existing `resolved` frame (clients already
  // know how to dequeue and flip verdict on it) with a third decision
  // value so the row badge can read "EXPIRED" instead of OK/DENY.
  broadcast({ type: "resolved", id, decision: "expired" })
})

onQuestionRequest((req) => {
  broadcast({
    type: "question",
    id: req.id,
    agent: req.agent ?? "claude",
    sessionId: req.sessionId,
    cwd: req.cwd,
    questions: req.questions,
  })
  // Same urgency tier as approvals — Claude is blocked until the phone
  // answers. The push title carries the first question's text so a glance
  // at the lock screen shows what's being asked.
  if (apnsConfigured()) {
    const project = projectLabelFor(req.cwd)
    const first = req.questions[0]
    const headerLabel = first?.header || "ask"
    const agent = req.agent ?? "claude"
    const body = first?.question || `${agentTitle(agent)} is asking a question`
    void pushToAll({
      title: project ? `${project} · ${headerLabel}` : `${agentTitle(agent)} · ${headerLabel}`,
      body: body.slice(0, 220),
      category: "question",
      threadId: req.cwd || "question",
      userInfo: { questionId: req.id, sessionId: req.sessionId, cwd: req.cwd },
    }).catch(() => { /* silent — don't let push failure break the hook */ })
  }
})

onQuestionExpired((id) => {
  // Mirrors approval expiry — phones know how to dequeue on `resolved`.
  broadcast({ type: "resolved", id, decision: "expired" })
})

onFeed((ev: FeedEvent) => {
  broadcast({ type: "event", event: ev })
})

onFeedReset((ids: string[]) => {
  broadcast({ type: "feed_pruned", ids })
})

onActivity((activity) => {
  broadcast({ type: "activity", activity })
})

onSessions((sessions: Session[]) => {
  broadcast({ type: "sessions", sessions })
  reconcileDispatch(sessions)
})

// Sessions that arrive without a title (session-start hook, ps discovery,
// transcript rehydrate) get one from the stored table or the transcript.
setTitleResolver((s) => resolveTitle(s.cwd, s.sessionId))
