import { companionLog } from "../lib/log"
import { type ApprovalMatch, addApprovalRequest, cancelApprovalsFor } from "../lib/pty-manager"
import { cancelQuestionsFor, isQuestionTool, type QuestionEndDecision } from "../lib/questions"
import { questionFastPath } from "../lib/question-hook"
import { judgeWithBranchContextAndReason } from "../lib/branch-guard"
import { rememberTitle, titleFromPrompt } from "../lib/session-titles"
import { noteSessionBoundary, noteUserPromptSubmit } from "../lib/submit-confirm"
import { isCatastrophic, isSuperAuto } from "../lib/super-auto"
import { recordAllow } from "../lib/learned-allow"
import {
  type Session,
  recordSession,
  listSessions,
  removeSessionByKey,
  setSessionTitle,
} from "../lib/sessions"
import { announceKeylessWaiting, markWaiting, unmarkWaiting } from "../wiring/waiting"
import {
  forgetSession,
  recordToolEnd,
  recordToolStart,
  recordTurnEnd,
  recordUserPrompt,
} from "../lib/activity"
import { type Verdict } from "../lib/feed"
import { summarize } from "../lib/tool-format"
import { apnsConfigured } from "../lib/apns"
import { pushToAll } from "../lib/push"
import { broadcast } from "../state"
import {
  agentFromHeaders,
  agentTitle,
  cwdFromPayload,
  hookDecisionResponse,
  hookPassthroughResponse,
  metaFromHeaders,
  projectLabelFor,
  scrapeHookPassthrough,
} from "../lib/hook-common"
import { emitTask, orchEmit, resolveWorkerTask, workerQueue } from "../wiring/orchestrator"
import { appendTurn as orchAppendTurn, setTaskStatus } from "../lib/orchestrator-chat"

// Claude Code hook endpoints (PreToolUse, PostToolUse, UserPromptSubmit,
// PermissionRequest, Stop, SessionStart, SessionEnd) and the helpers only they
// use. Same paths, decisions, responses and log lines as before the split.

function readAssistantAfterLastUser(transcriptPath: string): string | null {
  // Returns the concatenated text of all assistant entries that appear AFTER
  // the most recent user entry in the transcript. Returns null if the file
  // hasn't been flushed with the current turn's assistant message yet — the
  // caller should retry in that case instead of showing the prior turn.
  try {
    const raw = require("node:fs").readFileSync(transcriptPath, "utf8") as string
    const lines = raw.trim().split("\n")
    let lastUserIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!)
        if (entry.type === "user") { lastUserIdx = i; break }
      } catch { /* skip */ }
    }
    if (lastUserIdx < 0) return null  // no user entry at all → nothing reliable

    const chunks: string[] = []
    for (let i = lastUserIdx + 1; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]!)
        if (entry.type !== "assistant") continue
        const content = entry.message?.content
        if (!Array.isArray(content)) continue
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string") chunks.push(b.text)
        }
      } catch { /* skip */ }
    }
    if (chunks.length === 0) return null  // transcript not flushed yet
    return chunks.join("\n")
  } catch {
    return null
  }
}

async function extractLastAssistantMessage(transcriptPath: string | undefined): Promise<string> {
  // Stop hook sometimes fires before the harness finishes flushing the final
  // assistant turn to disk. Retry briefly (up to ~1s) before giving up — a
  // stale "last assistant message" would surface the PRIOR turn's text as the
  // reply to the current user prompt, which is the bug we're fixing.
  if (!transcriptPath) return ""
  const attempts = [0, 80, 160, 320, 500]  // ms between retries
  for (const delay of attempts) {
    if (delay) await new Promise(r => setTimeout(r, delay))
    const out = readAssistantAfterLastUser(transcriptPath)
    if (out !== null) return out
  }
  return ""
}

// A question that is no longer on screen: answered in the terminal picker
// (PostToolUse of the question tool), or the turn / session moved past it.
// Ends it so the phone card clears now, not at the 290 s expiry.
function closeQuestionsFor(sessionId: string | undefined, sessionKey: string | undefined, decision: QuestionEndDecision, why: string): void {
  const n = cancelQuestionsFor({ sessionId, sessionKey }, decision)
  if (n > 0) {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
    companionLog(`${cyan}question closed${reset} ${dim}— ${why} (${n})${reset}`)
  }
}

// The approval twin of closeQuestionsFor: an approval whose hook went away, or
// whose call already ran / whose turn or session ended, is ended "elsewhere" —
// no allow, nothing learned, and the phone card clears now.
function closeApprovalsFor(who: ApprovalMatch, why: string): void {
  const n = cancelApprovalsFor(who, "elsewhere")
  if (n > 0) {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
    companionLog(`${cyan}approval closed${reset} ${dim}— elsewhere: ${why} (${n})${reset}`)
  }
}

export async function handleHookRoute(req: Request, url: URL): Promise<Response | null> {
  // The companion's own hidden /help enumeration claude: drop everything.
  if (url.pathname.startsWith("/hooks/")) {
    const dropped = scrapeHookPassthrough(req.headers)
    if (dropped) return dropped
  }
  // ── Hook endpoint — PreToolUse ──
  if (url.pathname === "/hooks/pre-tool-use" && req.method === "POST") {
    const body = await req.json() as {
      session_id?: string
      tool_name?: string
      tool_input?: Record<string, unknown>
      tool_use_id?: string
      cwd?: string
    }

    const tool = body.tool_name ?? "unknown"
    const input = body.tool_input ?? {}
    const sessionId = body.session_id ?? ""
    const cwd = cwdFromPayload(body.cwd, req.headers)
    const headerMeta = metaFromHeaders(req.headers)
    const agent = agentFromHeaders(req.headers)
    const tty = headerMeta.tty ?? ""

    let session: Session | null = null
    if (cwd) {
      session = recordSession({ cwd, sessionId, ...headerMeta })
    }

    // tmux's clear-on-visit: a tool call clears the turn-end reason of the
    // session that ran it, and nobody else's — and only that reason, since a
    // tool call answers neither a pending approval nor an open dialog.
    // `session` is null whenever the payload had no cwd (see just above).
    if (session) unmarkWaiting(session.key, "turn-end")

    const dim = "\x1b[2m"
    const reset = "\x1b[0m"
    const green = "\x1b[32m"
    const red = "\x1b[31m"
    const yellow = "\x1b[33m"
    const cyan = "\x1b[36m"

    // ── AskUserQuestion / request_user_input fast path ─────────────
    {
      const handled = await questionFastPath({ agent, eventName: "PreToolUse", tool, input, sessionId, cwd, tty, session, headerMeta })
      if (handled) return handled
    }

    let decision: "allow" | "deny"
    let verdict: Verdict

    // SUPER auto-approve mode: every tool call is allowed without phone
    // roundtrip, EXCEPT for the catastrophe denylist (rm -rf /, force-push
    // to main, DROP TABLE, etc). Those still go through the normal flow
    // so the phone stays in the loop on truly destructive ops.
    if (isSuperAuto() && !isCatastrophic(tool, input)) {
      decision = "allow"
      verdict = "auto-allow"
      companionLog(`\x1b[35msuper-allow\x1b[0m ${tool} ${dim}${summarize(tool, input)}${reset}`)
      recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd, sessionId, tty, sessionKey: session?.key ?? "" })
      return hookDecisionResponse(agent, "PreToolUse", decision, "Approved via Claude Companion (SUPER)")
    }

    const { verdict: verdictJudge, reason: judgeReason } = await judgeWithBranchContextAndReason(tool, input, cwd)

    if (verdictJudge === "allow") {
      decision = "allow"
      verdict = "auto-allow"
      companionLog(`${green}auto-allow${reset} ${tool} ${dim}${summarize(tool, input)}${reset}`)
      recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd, sessionId, tty, sessionKey: session?.key ?? "" })
    } else if (verdictJudge === "deny") {
      decision = "deny"
      verdict = "auto-deny"
      companionLog(`${red}auto-deny${reset} ${tool} ${dim}${summarize(tool, input)}${reset}`)
      recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd, sessionId, tty, sessionKey: session?.key ?? "" })
    } else {
      verdict = "pending"
      companionLog(`${yellow}→ phone${reset} ${cyan}${tool}${reset} ${dim}${summarize(tool, input)}${reset}`)
      recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd, sessionId, tty, sessionKey: session?.key ?? "" })
      const outcome = await addApprovalRequest(
        { agent, sessionId, tool, input, cwd, sessionKey: session?.key ?? "", reason: judgeReason, toolUseId: body.tool_use_id },
        { signal: req.signal },
      )
      // No phone decision (window lapsed, or the hook / call went away): NO
      // decision back, so Claude Code falls back to its own terminal prompt.
      // Never an allow, never learned.
      if (outcome === "expired" || outcome === "elsewhere") {
        companionLog(`${yellow}${outcome}${reset} ${dim}— no phone decision, terminal prompt takes it${reset}`)
        return hookPassthroughResponse(agent)
      }
      decision = outcome
      const decisionColor = decision === "allow" ? green : red
      companionLog(`${decisionColor}${decision}${reset} ← phone`)
      // Phone said yes — remember this shape so future identical prompts
      // skip the round-trip. Conservative pattern derivation lives in
      // learned-allow.ts; chained / dangerous shapes are filtered out
      // there. Never learn from "deny".
      if (decision === "allow") {
        recordAllow(tool, input)
      }
    }

    return hookDecisionResponse(
      agent,
      "PreToolUse",
      decision,
      decision === "allow" ? "Approved via Claude Companion" : "Denied via Claude Companion",
    )
  }

  // ── Hook endpoint — PostToolUse ──
  if (url.pathname === "/hooks/post-tool-use" && req.method === "POST") {
    const body = await req.json() as {
      session_id?: string
      tool_name?: string
      tool_input?: Record<string, unknown>
      tool_use_id?: string
      tool_response?: unknown
      transcript_path?: string
      cwd?: string
    }
    const tool = body.tool_name ?? "unknown"
    const input = body.tool_input ?? {}
    const cwd = cwdFromPayload(body.cwd, req.headers)
    const headerMeta = metaFromHeaders(req.headers)

    const session = cwd
      ? recordSession({ cwd, sessionId: body.session_id ?? "", ...headerMeta })
      : null

    if (isQuestionTool(tool)) {
      closeQuestionsFor(body.session_id, session?.key, "answered", "answered at the terminal")
    }
    // The call ran, so any approval still pending for THIS call was answered
    // at the terminal (PermissionRequest dialog). A parallel call of the same
    // tool with other input keeps its card.
    closeApprovalsFor({ sessionId: body.session_id, sessionKey: session?.key, tool, input, toolUseId: body.tool_use_id }, "the call ran (answered at the terminal)")
    recordToolEnd({
      tool,
      input,
      toolResponse: body.tool_response,
      transcriptPath: body.transcript_path,
      cwd,
      sessionId: body.session_id ?? "",
      tty: headerMeta.tty ?? "",
      sessionKey: session?.key ?? "",
    })
    return Response.json({})
  }

  // ── Hook endpoint — UserPromptSubmit ──
  if (url.pathname === "/hooks/user-prompt-submit" && req.method === "POST") {
    const body = await req.json() as {
      session_id?: string
      prompt?: string
      transcript_path?: string
      cwd?: string
    }
    const cwd = cwdFromPayload(body.cwd, req.headers)
    const headerMeta = metaFromHeaders(req.headers)
    // Diagnostic — surfaces hook fires + prompt-field shape so the
    // "phone never sees my own message" bug can be triaged from logs
    // alone. Trim text to keep noise low.
    {
      const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const yellow = "\x1b[33m"
      const promptText = (body.prompt ?? "").trim()
      const tag = promptText
        ? `${cyan}user-prompt${reset} "${promptText.slice(0, 60)}${promptText.length > 60 ? "…" : ""}"`
        : `${yellow}user-prompt EMPTY${reset}`
      companionLog(`${tag} tty=${headerMeta.tty || "?"} sid=${(body.session_id ?? "").slice(0, 8) || "?"}`)
    }
    const session = cwd
      ? recordSession({ cwd, sessionId: body.session_id ?? "", ...headerMeta })
      : null
    // Proof of submission for any phone inject waiting on this session.
    noteUserPromptSubmit({ key: session?.key, sessionId: body.session_id, tty: headerMeta.tty })
    // A new prompt means the picker is gone (e.g. "Chat about this").
    closeQuestionsFor(body.session_id, session?.key, "expired", "new prompt in that session")
    closeApprovalsFor({ sessionId: body.session_id, sessionKey: session?.key }, "new prompt in that session")
    // First real prompt names the chat (persisted by session id so a
    // restart or rediscovery brings the same name back).
    if (session && !session.title) {
      const title = titleFromPrompt(body.prompt ?? "")
      if (title) {
        if (session.sessionId) rememberTitle(session.sessionId, title)
        setSessionTitle(session.key, title)
      }
    }
    recordUserPrompt({
      text: body.prompt ?? "",
      transcriptPath: body.transcript_path,
      cwd,
      sessionId: body.session_id ?? "",
      tty: headerMeta.tty ?? "",
      sessionKey: session?.key ?? "",
    })
    // Mirror the user's prompt to every WS client so the iOS app shows
    // what was typed on the Mac. Without this the phone only sees
    // assistant replies — picking up mid-conversation on mobile would
    // show half the dialogue.
    const promptKey = session?.key ?? ""
    broadcast({
      type: "user_prompt",
      text: body.prompt ?? "",
      key: promptKey,
      cwd,
      sessionId: body.session_id ?? "",
    })
    return Response.json({})
  }

  // ── Permission request hook — multi-choice permission dialogs ──
  if (url.pathname === "/hooks/permission-request" && req.method === "POST") {
    const body = await req.json() as {
      session_id?: string
      tool_name?: string
      tool_input?: Record<string, unknown>
      tool_use_id?: string
      hook_event_name?: string
      cwd?: string
    }

    const tool = body.tool_name ?? "permission"
    const input = body.tool_input ?? {}
    const sessionId = body.session_id ?? ""
    const cwd = cwdFromPayload(body.cwd, req.headers)
    const headerMeta = metaFromHeaders(req.headers)
    const agent = agentFromHeaders(req.headers)
    const tty = headerMeta.tty ?? ""

    let session: Session | null = null
    if (cwd) {
      session = recordSession({ cwd, sessionId, ...headerMeta })
    }

    const dim = "\x1b[2m"
    const reset = "\x1b[0m"
    const yellow = "\x1b[33m"
    const cyan = "\x1b[36m"

    // ── AskUserQuestion / request_user_input fast path ─────────────
    // eventName MUST be PermissionRequest: Claude Code ignores a reply whose
    // hookEventName doesn't match the hook (this passed "PreToolUse" until
    // 2026-09-25, so every phone answer and every expiry deny on this path
    // was silently dropped).
    {
      const handled = await questionFastPath({ agent, eventName: "PermissionRequest", tool, input, sessionId, cwd, tty, session, headerMeta })
      if (handled) return handled
    }

    companionLog(`${yellow}→ phone${reset} ${cyan}permission${reset} ${tool} ${dim}${summarize(tool, input)}${reset}`)

    recordToolStart({ tool, input, summary: summarize(tool, input), verdict: "pending", cwd, sessionId, tty, sessionKey: session?.key ?? "" })
    const outcome = await addApprovalRequest(
      { agent, sessionId, tool, input, cwd, sessionKey: session?.key ?? "", toolUseId: body.tool_use_id },
      { signal: req.signal },
    )
    // Same fail-closed rule as PreToolUse: no phone decision → no decision
    // back (the terminal dialog is already on screen and stays the way in).
    if (outcome === "expired" || outcome === "elsewhere") {
      companionLog(`${yellow}${outcome}${reset} ${dim}← permission — terminal dialog takes it${reset}`)
      return hookPassthroughResponse(agent)
    }
    const decision = outcome

    const green = "\x1b[32m"
    const red = "\x1b[31m"
    const decisionColor = decision === "allow" ? green : red
    companionLog(`${decisionColor}${decision}${reset} ← permission`)

    // Same learning hook as the PreToolUse path — phone-allowed shapes
    // get remembered so the next ask doesn't roundtrip.
    if (decision === "allow") {
      recordAllow(tool, input)
    }

    return hookDecisionResponse(
      agent,
      "PermissionRequest",
      decision,
      decision === "allow" ? "Approved via Claude Companion" : "Denied via Claude Companion",
    )
  }

  // ── Stop hook — Claude finished its turn, waiting for user input ──
  if (url.pathname === "/hooks/stop" && req.method === "POST") {
    const body = await req.json() as {
      session_id?: string
      cwd?: string
      transcript_path?: string
      last_assistant_message?: string
      stop_hook_active?: boolean
    }

    const cwd = cwdFromPayload(body.cwd, req.headers)
    const headerMeta = metaFromHeaders(req.headers)
    const agent = agentFromHeaders(req.headers)
    let session: Session | null = null
    if (cwd) {
      session = recordSession({ cwd, sessionId: body.session_id ?? "", ...headerMeta })
    }

    // The turn ended: no question or approval of it can still be open.
    closeQuestionsFor(body.session_id, session?.key, "expired", "turn ended")
    closeApprovalsFor({ sessionId: body.session_id, sessionKey: session?.key }, "turn ended")

    const lastMessage = (body.last_assistant_message ?? "").trim()
      || await extractLastAssistantMessage(body.transcript_path)

    // Orchestrator (PRJ-OR1T): if this turn-end belongs to a dispatched
    // worker, capture its first reply back into the single thread tagged by
    // task, and close the task so later turn-ends don't re-report. The worker
    // names its own task (X-Companion-Task-Id, issued at dispatch); cwd is only
    // the fallback, and when a cwd holds two running tasks the resolver refuses
    // rather than closing the wrong one — a wrong close would post this reply
    // under a sibling's task and free its WIP slot. It logs its own refusals.
    if (cwd) {
      const task = await resolveWorkerTask("close", {
        taskId: headerMeta.taskId,
        tmuxPane: headerMeta.tmuxPane,
        tmuxSocket: headerMeta.tmuxSocket,
        cwd,
      })
      if (task) {
        setTaskStatus(task.taskId, "done")
        emitTask(task.taskId)
        orchEmit(orchAppendTurn("worker", lastMessage || "(no output)", task.taskId, task.threadId))
        void workerQueue.drain() // slot freed
        const reset = "\x1b[0m"; const green = "\x1b[32m"
        companionLog(`${green}orchestrator reply${reset} [${task.taskId}] → thread`)
      }
    }

    // Fire-and-forget: recordTurnEnd may now poll the transcript for up
    // to ~4s waiting on a late-flushed closing block. Don't await it —
    // the waiting_input broadcast + push below must fire immediately; the
    // closing assistant_text emits on its own whenever the block lands.
    void recordTurnEnd({
      transcriptPath: body.transcript_path,
      finalText: lastMessage,
      cwd,
      sessionId: body.session_id ?? "",
      tty: headerMeta.tty ?? "",
      sessionKey: session?.key ?? "",
    })

    // Waiting now lives on the Session record as one reason among four; the
    // scalars are its projection and wiring/waiting.ts owns the frame. `session`
    // is only assigned when cwd is truthy (see above), and a stop hook with no
    // cwd still sends the legacy keyless frame.
    if (session) markWaiting(session.key, "turn-end")
    else announceKeylessWaiting()
    const reset = "\x1b[0m"
    const magenta = "\x1b[35m"
    companionLog(`${magenta}waiting for input${reset} — phone can respond`)
    // Waiting = passive nudge, no sound. Client should suppress when the
    // PWA/app is already focused on this session (handled on-device).
    if (apnsConfigured()) {
      const project = session?.label || projectLabelFor(cwd)
      void pushToAll({
        // Lead with the project so a glance tells you which Claude is
        // waiting before you read the body.
        title: project ? `${project} · waiting` : `${agentTitle(agent)} is waiting`,
        body: lastMessage.trim().slice(0, 220) || "Tap to respond",
        category: "waiting_input",
        threadId: cwd || "waiting_input",
        userInfo: { cwd, sessionId: body.session_id ?? "", key: session?.key ?? "" },
      }).catch(() => { /* silent */ })
    }
    return Response.json({})
  }


  // ── Hook endpoint — SessionStart — register on startup/resume/clear/compact
  // so idle Claude sessions are visible to the phone picker from the moment
  // they open, without waiting for the user to trigger a tool-call hook.
  if (url.pathname === "/hooks/session-start" && req.method === "POST") {
    const body = await req.json() as { cwd?: string; session_id?: string; source?: string }
    const cwd = cwdFromPayload(body.cwd, req.headers)
    // `/clear` from the phone fires no UserPromptSubmit; this is its proof.
    if (body.source === "clear") {
      const meta = metaFromHeaders(req.headers)
      noteSessionBoundary({ sessionId: body.session_id, tty: meta.tty, pane: meta.tmuxPane })
    }
    if (cwd) {
      // recordSession fires onSessions → reconcileDispatch binds this worker
      // to its dispatch task and sends the prompt. No inline binding needed.
      recordSession({ cwd, sessionId: body.session_id ?? "", ...metaFromHeaders(req.headers) })
      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
      companionLog(`${cyan}session start${reset} ${cwd.split("/").pop()} ${dim}(${body.source ?? "-"})${reset}`)
    }
    return Response.json({ ok: true })
  }

  // ── Hook endpoint — SessionEnd — remove from registry immediately ──
  // Removes ONLY the session that ended: by its session id, else by the agent
  // pid. Never by cwd, tty or tmux pane — those are shared: every Zettlab
  // session lives in ~/work, and a headless `claude -p` run from inside a live
  // session's pane carries that pane's tty/TMUX_PANE, so ending it wiped the
  // live session (or the whole cwd) off the phone.
  if (url.pathname === "/hooks/session-end" && req.method === "POST") {
    const body = await req.json() as { cwd?: string; session_id?: string; reason?: string }
    const cwd = cwdFromPayload(body.cwd, req.headers)
    const headerMeta = metaFromHeaders(req.headers)
    const tty = headerMeta.tty ?? ""
    const tmuxPane = headerMeta.tmuxPane ?? ""
    const sid = body.session_id ?? ""
    const pid = headerMeta.pid ?? ""
    let victims = sid ? listSessions().filter((s) => s.sessionId === sid) : []
    let by = "session_id"
    if (victims.length === 0 && pid) {
      victims = listSessions().filter((s) => s.pid === pid)
      by = "pid"
    }
    const removedKeys = victims.map((s) => s.key).filter((k) => removeSessionByKey(k))
    const removed = removedKeys.length > 0
    {
      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const magenta = "\x1b[35m"
      companionLog(removed
        ? `${magenta}session end${reset} removed ${removedKeys.join(", ")} ${dim}(by ${by}, reason=${body.reason ?? "-"})${reset}`
        : `${magenta}session end${reset} ${dim}no session matched sid=${sid.slice(0, 8) || "?"} pid=${pid || "?"} — nothing removed (reason=${body.reason ?? "-"})${reset}`)
    }
    closeQuestionsFor(body.session_id, undefined, "expired", "session ended")
    closeApprovalsFor({ sessionId: body.session_id }, "session ended")
    forgetSession({ tty, sessionId: body.session_id, cwd })
    // `/exit` (and `/clear`, which ends the old session first) fire no
    // UserPromptSubmit; the session ending is their proof of submission.
    noteSessionBoundary({ sessionId: body.session_id, tty, pane: tmuxPane })
    return Response.json({ ok: true })
  }
  return null
}
