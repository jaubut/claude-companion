import type { SpawnAgent } from "../lib/spawn-session"
import { addApprovalRequest } from "../lib/pty-manager"
import {
  type QuestionAnswer,
  type QuestionItem,
  addQuestionRequest,
  isQuestionTool,
  markQuestionAnswered,
  parseQuestionInput,
  questionDedupeKey,
  wasQuestionAnswered,
} from "../lib/questions"
import { judgeWithBranchContext } from "../lib/branch-guard"
import { type InjectTarget, withPickerIO } from "../lib/keyboard-inject"
import { driveQuestionPicker } from "../lib/question-driver"
import { rememberTitle, titleFromPrompt } from "../lib/session-titles"
import { isCatastrophic, isSuperAuto } from "../lib/super-auto"
import { recordAllow } from "../lib/learned-allow"
import {
  type Session,
  metaFromHeaders,
  onSessions,
  recordSession,
  removeSessionByCwd,
  removeSessionByTty,
  setSessionTitle,
} from "../lib/sessions"
import {
  type Verdict,
  forgetSession,
  recordToolEnd,
  recordToolStart,
  recordTurnEnd,
  recordUserPrompt,
} from "../lib/activity"
import { summarize } from "../lib/tool-format"
import { apnsConfigured } from "../lib/apns"
import { pushToAll } from "../lib/push"
import { broadcast, clearWaiting, getWaiting, setWaiting } from "../state"
import {
  agentFromHeaders,
  agentTitle,
  cwdFromPayload,
  hookDecisionResponse,
  projectLabelFor,
} from "../lib/hook-common"
import { emitTask, orchEmit, workerQueue } from "../wiring/orchestrator"
import { appendTurn as orchAppendTurn, findRunningTaskByCwd, setTaskStatus } from "../lib/orchestrator-chat"

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

// Drive the terminal picker with the phone's answers. Fire-and-forget after
// the hook returns allow: the driver waits for the picker to actually mount
// (pane-driven, see question-driver.ts) instead of guessing a delay, then
// verifies the "User answered" confirmation. Logged either way.
function driveAnswer(target: InjectTarget, questions: QuestionItem[], answers: QuestionAnswer[]): void {
  const dim = "\x1b[2m"; const reset = "\x1b[0m"; const green = "\x1b[32m"; const red = "\x1b[31m"; const cyan = "\x1b[36m"
  void withPickerIO(target, async (io, via) => {
    const r = await driveQuestionPicker(io, questions, answers)
    if (r.ok) {
      process.stderr.write(`${dim}[companion]${reset} ${green}picker driven${reset} → ${cyan}${via}${reset} ${dim}(${questions.length} question${questions.length === 1 ? "" : "s"}${r.reason ? `, ${r.reason}` : ""})${reset}\n`)
    } else {
      process.stderr.write(`${dim}[companion]${reset} ${red}picker drive failed${reset} → ${via} — ${r.reason}\n`)
    }
    return r.ok
  }).then((res) => {
    if (res === null) {
      process.stderr.write(`${dim}[companion]${reset} ${red}picker drive refused${reset} — no tmux pane or tty target\n`)
    }
  }).catch(() => { /* logged above */ })
}

function questionInjectTarget(session: Session | null, headerMeta: Partial<Session>): InjectTarget {
  return {
    tmuxPane: session?.tmuxPane || headerMeta.tmuxPane || "",
    tty: session?.tty || headerMeta.tty || "",
    termProgram: session?.termProgram || headerMeta.termProgram || "",
    iTermSessionId: session?.iTermSessionId || headerMeta.iTermSessionId || "",
  }
}

function hasQuestionInjectTarget(target: InjectTarget): boolean {
  return !!(target.tmuxPane || target.tty)
}

// One AskUserQuestion / request_user_input fast path for both hook events.
// Treat agent questions as structured phone prompts, not binary approval
// gates: route to the phone with question + options, then drive the local
// terminal picker after the user answers remotely. Claude Code can fire BOTH
// PreToolUse and PermissionRequest for one call — whichever hook got here
// first asked the phone and is driving the picker; the sibling just allows.
// Returns a Response when the question was handled (already answered,
// answered now, or expired), null to fall through to the generic approval
// card (parse failed / no live terminal target) so the Mac flow still works.
async function questionFastPath(p: {
  agent: SpawnAgent
  eventName: "PreToolUse" | "PermissionRequest"
  tool: string
  input: Record<string, unknown>
  sessionId: string
  cwd: string
  tty: string
  session: Session | null
  headerMeta: Partial<Session>
}): Promise<Response | null> {
  if (!isQuestionTool(p.tool)) return null
  const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"; const cyan = "\x1b[36m"; const green = "\x1b[32m"; const red = "\x1b[31m"
  const questions = parseQuestionInput(p.input)
  const answerTarget = questionInjectTarget(p.session, p.headerMeta)
  if (questions && hasQuestionInjectTarget(answerTarget)) {
    const dedupeKey = questionDedupeKey(p.sessionId, p.cwd, questions)
    if (wasQuestionAnswered(dedupeKey)) {
      process.stderr.write(`${dim}[companion]${reset} ${dim}question already answered — allow (${p.eventName})${reset}\n`)
      return hookDecisionResponse(p.agent, p.eventName, "allow", "Answered via Claude Companion")
    }
    process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}question${reset} ${dim}${questions[0]?.question.slice(0, 80) ?? ""}${reset}\n`)
    recordToolStart({ tool: p.tool, input: p.input, summary: summarize(p.tool, p.input), verdict: "pending", cwd: p.cwd, sessionId: p.sessionId, tty: p.tty })
    const answers = await addQuestionRequest({ agent: p.agent, sessionId: p.sessionId, cwd: p.cwd, questions })

    if (answers.length === 0) {
      // Expired or otherwise no answer — deny so Claude doesn't sit on an
      // open picker that nobody is going to drive.
      process.stderr.write(`${dim}[companion]${reset} ${red}question expired${reset} ← phone\n`)
      return hookDecisionResponse(p.agent, p.eventName, "deny", "User did not answer in time")
    }

    process.stderr.write(`${dim}[companion]${reset} ${green}answered${reset} ← phone (${answers.length} answer${answers.length === 1 ? "" : "s"})\n`)
    markQuestionAnswered(dedupeKey)
    // The driver waits for the picker to mount, so it can start now even
    // though the harness only opens the picker after our allow.
    driveAnswer(answerTarget, questions, answers)
    return hookDecisionResponse(p.agent, p.eventName, "allow", "Answered via Claude Companion")
  }
  process.stderr.write(`${dim}[companion]${reset} ${yellow}question fallback${reset} — ${questions ? "no live terminal target" : "could not parse questions"}\n`)
  return null
}

export async function handleHookRoute(req: Request, url: URL): Promise<Response | null> {
  // ── Hook endpoint — PreToolUse ──
  if (url.pathname === "/hooks/pre-tool-use" && req.method === "POST") {
    const body = await req.json() as {
      session_id?: string
      tool_name?: string
      tool_input?: Record<string, unknown>
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

    if (getWaiting().waitingForInput) {
      clearWaiting()
      broadcast({ type: "waiting_input", waiting: false })
    }

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
      process.stderr.write(`${dim}[companion]${reset} \x1b[35msuper-allow\x1b[0m ${tool} ${dim}${summarize(tool, input)}${reset}\n`)
      recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd, sessionId, tty })
      return hookDecisionResponse(agent, "PreToolUse", decision, "Approved via Claude Companion (SUPER)")
    }

    const verdictJudge = await judgeWithBranchContext(tool, input, cwd)

    if (verdictJudge === "allow") {
      decision = "allow"
      verdict = "auto-allow"
      process.stderr.write(`${dim}[companion]${reset} ${green}auto-allow${reset} ${tool} ${dim}${summarize(tool, input)}${reset}\n`)
      recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd, sessionId, tty })
    } else if (verdictJudge === "deny") {
      decision = "deny"
      verdict = "auto-deny"
      process.stderr.write(`${dim}[companion]${reset} ${red}auto-deny${reset} ${tool} ${dim}${summarize(tool, input)}${reset}\n`)
      recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd, sessionId, tty })
    } else {
      verdict = "pending"
      process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}${tool}${reset} ${dim}${summarize(tool, input)}${reset}\n`)
      recordToolStart({ tool, input, summary: summarize(tool, input), verdict, cwd, sessionId, tty })
      decision = await addApprovalRequest({ agent, sessionId, tool, input, cwd })
      const decisionColor = decision === "allow" ? green : red
      process.stderr.write(`${dim}[companion]${reset} ${decisionColor}${decision}${reset} ← phone\n`)
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

    recordToolEnd({
      tool,
      input,
      toolResponse: body.tool_response,
      transcriptPath: body.transcript_path,
      cwd,
      sessionId: body.session_id ?? "",
      tty: headerMeta.tty ?? "",
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
      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const yellow = "\x1b[33m"
      const promptText = (body.prompt ?? "").trim()
      const tag = promptText
        ? `${cyan}user-prompt${reset} "${promptText.slice(0, 60)}${promptText.length > 60 ? "…" : ""}"`
        : `${yellow}user-prompt EMPTY${reset}`
      process.stderr.write(`${dim}[companion]${reset} ${tag} tty=${headerMeta.tty || "?"} sid=${(body.session_id ?? "").slice(0, 8) || "?"}\n`)
    }
    const session = cwd
      ? recordSession({ cwd, sessionId: body.session_id ?? "", ...headerMeta })
      : null
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
    {
      const handled = await questionFastPath({ agent, eventName: "PreToolUse", tool, input, sessionId, cwd, tty, session, headerMeta })
      if (handled) return handled
    }

    process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}permission${reset} ${tool} ${dim}${summarize(tool, input)}${reset}\n`)

    recordToolStart({ tool, input, summary: summarize(tool, input), verdict: "pending", cwd, sessionId, tty })
    const decision = await addApprovalRequest({ agent, sessionId, tool, input, cwd })

    const green = "\x1b[32m"
    const red = "\x1b[31m"
    const decisionColor = decision === "allow" ? green : red
    process.stderr.write(`${dim}[companion]${reset} ${decisionColor}${decision}${reset} ← permission\n`)

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

    const lastMessage = (body.last_assistant_message ?? "").trim()
      || await extractLastAssistantMessage(body.transcript_path)

    // Orchestrator (PRJ-OR1T): if this turn-end belongs to a dispatched
    // worker (matched by cwd — stable across registration paths), capture its
    // first reply back into the single thread tagged by task, and close the
    // task so later turn-ends don't re-report.
    if (cwd) {
      const task = findRunningTaskByCwd(cwd)
      if (task) {
        setTaskStatus(task.taskId, "done")
        emitTask(task.taskId)
        orchEmit(orchAppendTurn("worker", lastMessage || "(no output)", task.taskId, task.threadId))
        void workerQueue.drain() // slot freed
        const dim = "\x1b[2m"; const reset = "\x1b[0m"; const green = "\x1b[32m"
        process.stderr.write(`${dim}[companion]${reset} ${green}orchestrator reply${reset} [${task.taskId}] → thread\n`)
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
    })

    setWaiting(cwd, session?.key ?? "")
    const dim = "\x1b[2m"
    const reset = "\x1b[0m"
    const magenta = "\x1b[35m"
    process.stderr.write(`${dim}[companion]${reset} ${magenta}waiting for input${reset} — phone can respond\n`)

    broadcast({
      type: "waiting_input",
      waiting: true,
      // Intentionally NOT broadcasting `lastMessage` here — the full
      // assistant text already streamed via assistant_text events
      // during the turn (and via the just-fired recordTurnEnd's
      // transcript delta read). Including a truncated tail used to
      // produce a duplicate, chopped copy in the iOS feed beside the
      // full reply. lastMessage is still used for the push body
      // below where a 220-char preview is what we want.
      cwd,
      key: getWaiting().waitingKey,
    })
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
        userInfo: { cwd, sessionId: body.session_id ?? "", key: getWaiting().waitingKey },
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
    if (cwd) {
      // recordSession fires onSessions → reconcileDispatch binds this worker
      // to its dispatch task and sends the prompt. No inline binding needed.
      recordSession({ cwd, sessionId: body.session_id ?? "", ...metaFromHeaders(req.headers) })
      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
      process.stderr.write(`${dim}[companion]${reset} ${cyan}session start${reset} ${cwd.split("/").pop()} ${dim}(${body.source ?? "-"})${reset}\n`)
    }
    return Response.json({ ok: true })
  }

  // ── Hook endpoint — SessionEnd — remove from registry immediately ──
  // Prefer tty from the header when available so we don't nuke a sibling
  // session that happens to share the same cwd. Cwd-wholesale removal is
  // the last-resort fallback for hooks that couldn't resolve a tty.
  if (url.pathname === "/hooks/session-end" && req.method === "POST") {
    const body = await req.json() as { cwd?: string; session_id?: string; reason?: string }
    const cwd = cwdFromPayload(body.cwd, req.headers)
    const headerMeta = metaFromHeaders(req.headers)
    const tty = headerMeta.tty ?? ""
    let removed = false
    if (tty) {
      removed = removeSessionByTty(tty)
    }
    if (!removed && cwd) {
      removed = removeSessionByCwd(cwd)
    }
    forgetSession({ tty, sessionId: body.session_id, cwd })
    if (removed) {
      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const magenta = "\x1b[35m"
      const label = tty || (cwd ? cwd.split("/").pop() : "?")
      process.stderr.write(`${dim}[companion]${reset} ${magenta}session end${reset} ${label} ${dim}(${body.reason ?? "-"})${reset}\n`)
    }
    return Response.json({ ok: true })
  }
  return null
}
