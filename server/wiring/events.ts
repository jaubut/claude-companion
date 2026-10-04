import { hostname } from "node:os"
import { broadcast } from "../state"
import { onApprovalRequest, onApprovalExpired, onApprovalResolved } from "../lib/pty-manager"
import { onQuestionRequest, onQuestionExpired, onQuestionResolved } from "../lib/questions"
import { onActivity, reconcileActivityLiveness, type Activity } from "../lib/activity"
import { onFeed, onFeedReset, type FeedEvent } from "../lib/feed"
import { summarize } from "../lib/tool-format"
import { apnsConfigured } from "../lib/apns"
import { pushToAll } from "../lib/push"
import { onSessions, setSessionModel, setTitleResolver, type Session } from "../lib/sessions"
import { resolveTitle, transcriptPath } from "../lib/session-titles"
import { modelForIdentity, modelFromTranscript } from "../lib/transcript"
import { projectLabelFor, agentTitle, subtitleFor } from "../lib/hook-common"
import { reconcileDispatch } from "./orchestrator"
import { markWaiting, unmarkWaiting } from "./waiting"
import {
  type HistoryItem,
  answersPatch,
  approvalEntry,
  onApprovalHistory,
  questionEndState,
  questionEntry,
  recordOutcome,
  recordPending,
} from "../lib/approval-history"
import { createAutoFrameThrottle, onAutoHistoryFlush, startAutoHistoryRetention } from "../lib/approval-history-auto"
import { companionLog } from "../lib/log"

// Event wiring: every lib store's listener → WS frame (+ push where the phone
// must be interrupted). One onSessions listener does the `sessions` frame and
// then reconcileDispatch, so a worker's `orchestrator_task` never precedes the
// `sessions` frame that introduced it. Registered at import time.
//
// It also joins the approval/question lifecycles to the session's waiting state
// (PRJ-OR1T Phase 11) — here and not in the routes, because the expiry timers
// live inside the libs where a route could never clear the flag.

// The approval history (lib/approval-history.ts) is a record, never a gate: a
// sqlite error is logged and the approval / question flow carries on.
function history(what: string, write: () => unknown): void {
  try { write() } catch (err) { companionLog(`\x1b[31mapproval history ${what} failed\x1b[0m — ${(err as Error).message}`) }
}

onApprovalRequest((req) => {
  history("insert", () => recordPending(approvalEntry(req)))
  broadcast({
    type: "approval",
    id: req.id,
    agent: req.agent ?? "claude",
    tool: req.tool,
    input: req.input,
    sessionId: req.sessionId,
    cwd: req.cwd,
    ...(req.reason ? { reason: req.reason } : {}),
  })
  markWaiting(req.sessionKey, "approval", req.id)
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
      collapseId: req.id,
      userInfo: { approvalId: req.id, sessionId: req.sessionId, cwd: req.cwd, host: hostname() },
    }).catch(() => { /* silent — don't let push failure break the hook */ })
  }
})

onApprovalExpired((req, decision, via) => {
  // Tell every connected client the approval ended with no decision: it
  // "expired" before the user could decide, or it was answered / dropped
  // "elsewhere" (terminal, hook gone, turn ended). Same `resolved` frame the
  // clients already dequeue on; the row badge reads EXPIRED / ELSEWHERE.
  broadcast({ type: "resolved", id: req.id, decision })
  unmarkWaiting(req.sessionKey, "approval", req.id)
  history("update", () => recordOutcome(req.id, decision, via))
})

// Deliberately does NOT broadcast `resolved`: ws.ts and routes/api.ts already
// send it on every decision path, and a second frame double-dequeues on iOS.
onApprovalResolved((req, decision, by) => {
  unmarkWaiting(req.sessionKey, "approval", req.id)
  history("update", () => recordOutcome(req.id, decision === "allow" ? "allowed" : "denied", "phone", { device: by.device }))
})

onQuestionRequest((req) => {
  // A re-ask under the same id (PermissionRequest phase) upserts the one row.
  history("insert", () => recordPending(questionEntry(req)))
  broadcast({
    type: "question",
    id: req.id,
    agent: req.agent ?? "claude",
    sessionId: req.sessionId,
    cwd: req.cwd,
    questions: req.questions,
  })
  markWaiting(req.sessionKey, "question", req.id)
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
      // Same id when the question is re-asked in the PermissionRequest
      // phase (lib/question-hook.ts): the second banner replaces the first.
      collapseId: req.id,
      userInfo: { questionId: req.id, sessionId: req.sessionId, cwd: req.cwd, host: hostname() },
    }).catch(() => { /* silent — don't let push failure break the hook */ })
  }
})

onQuestionExpired((req, decision, via) => {
  // Mirrors approval expiry — phones know how to dequeue on `resolved`.
  // "answered" when the terminal picker answered it (cancelQuestionsFor);
  // both values are ones shipped iOS builds already map.
  broadcast({ type: "resolved", id: req.id, decision })
  unmarkWaiting(req.sessionKey, "question", req.id)
  history("update", () => recordOutcome(req.id, questionEndState(decision), via))
})

// Same rule as onApprovalResolved: the `resolved` frame is already sent.
onQuestionResolved((req, answers, by) => {
  unmarkWaiting(req.sessionKey, "question", req.id)
  history("update", () => recordOutcome(req.id, "answered", "phone", { device: by.device, detailPatch: answersPatch(answers) }))
})

// Every insert / transition, live to the phone's Approvals list. Additive
// frame: `approval` / `question` / `resolved` are unchanged.
onApprovalHistory((item: HistoryItem) => {
  broadcast({ type: "approval_history", item })
})

// Auto rows (SUPER / auto-judge / learned / read-only MCP) are too chatty for a
// frame each: at most one `approval_history_auto` {count, since} per 5 s, so
// the phone can show "N new" and refetch. Retention prunes them daily.
onAutoHistoryFlush(createAutoFrameThrottle((frame) => broadcast({ ...frame })))
startAutoHistoryRetention()

onFeed((ev: FeedEvent) => {
  broadcast({ type: "event", event: ev })
})

onFeedReset((ids: string[]) => {
  broadcast({ type: "feed_pruned", ids })
})

// `activity` is the derived host rollup the shipped clients read; `activities`
// is every live session's pill, most-recent-event first; `key` names the
// session that changed ("" for a heartbeat tick or a clear).
onActivity((activity: Activity | null, activities: Activity[], key: string) => {
  broadcast({ type: "activity", activity, key, activities })
})

// Session keys whose transcript has already been read once for a model.
const modelProbed = new Set<string>()

onSessions((sessions: Session[]) => {
  // Stamp each session with the model off its last assistant message BEFORE
  // the frame goes out (PRJ-OR1T Phase 14). setSessionModel mutates the live
  // record and deliberately does not emit — we are already inside one.
  for (const s of sessions) {
    let model = modelForIdentity({ sessionId: s.sessionId, tty: s.tty, cwd: s.cwd })
    // Nothing in memory: this process has not read a turn for that session, the
    // normal case for every session on a freshly started server. Read the
    // transcript tail once. A session that has genuinely never answered stays
    // blank and is not probed again — the delta reader stamps it when it does.
    if (!model && s.sessionId && !modelProbed.has(s.key)) {
      modelProbed.add(s.key)
      model = modelFromTranscript(transcriptPath(s.cwd, s.sessionId))
    }
    if (model) setSessionModel(s.key, model)
  }
  broadcast({ type: "sessions", sessions })
  reconcileDispatch(sessions)
  // A SIGKILLed terminal fires no session-end hook — this is the only thing
  // that retires its pill. Emits only when it actually clears one.
  reconcileActivityLiveness(sessions)
})

// Sessions that arrive without a title (session-start hook, ps discovery,
// transcript rehydrate) get one from the stored table or the transcript.
setTitleResolver((s) => resolveTitle(s.cwd, s.sessionId))
