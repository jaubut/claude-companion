import type { ServerWebSocket } from "bun"
import {
  addApprovalRequest,
  resolveApproval,
  getPending,
  onApprovalRequest,
  onApprovalExpired,
} from "./lib/pty-manager"
import {
  addQuestionRequest,
  resolveQuestion,
  getPendingQuestions,
  onQuestionRequest,
  onQuestionExpired,
  isQuestionTool,
  parseQuestionInput,
  type QuestionAnswer,
  type QuestionItem,
} from "./lib/questions"
import { judgeWithBranchContext } from "./lib/branch-guard"
import { injectText, injectKeySequence, type InjectTarget, type KeySeqStep } from "./lib/keyboard-inject"
import { spawnCompanionSession, type SpawnAgent, type SpawnResult } from "./lib/spawn-session"
import { isSuperAuto, setSuperAuto, isCatastrophic } from "./lib/super-auto"
import { recordAllow, listLearned, forgetLearned, clearLearned } from "./lib/learned-allow"
import {
  recordSession,
  removeSessionByCwd,
  removeSessionByTty,
  resolveSession,
  listSessions,
  onSessions,
  metaFromHeaders,
  type Session,
} from "./lib/sessions"
import {
  recordToolStart,
  recordToolEnd,
  recordUserPrompt,
  recordTurnEnd,
  forgetSession,
  getFeed,
  getActivity,
  onFeed,
  onActivity,
  onFeedReset,
  summarize,
  type FeedEvent,
  type Verdict,
} from "./lib/activity"
import { registerToken, removeToken, tokenCount, listTokens, type ApnsEnv } from "./lib/push-tokens"
import { apnsConfigured } from "./lib/apns"
import { pushToAll } from "./lib/push"
import { checkBearer, unauthorized } from "./lib/auth"
import {
  appendTurn as orchAppendTurn,
  getThread,
  createTask,
  createProposal,
  getTask,
  setTaskSpawn,
  bindTaskSession,
  setTaskStatus,
  matchUnboundTaskByCwd,
  findRunningTaskByCwd,
  listTasks,
  type Turn as OrchTurn,
  type Task as OrchTask,
} from "./lib/orchestrator-chat"
import { decide as brainDecide } from "./lib/orchestrator-brain"

interface WsData {
  id: string
}

const clients = new Set<ServerWebSocket<WsData>>()
let waitingForInput = false
let waitingCwd = ""
let waitingKey = ""

function agentFromHeaders(headers: Headers): SpawnAgent {
  return headers.get("x-companion-agent") === "codex" ? "codex" : "claude"
}

function agentTitle(agent: SpawnAgent): string {
  return agent === "codex" ? "Codex" : "Claude"
}

function cwdFromPayload(payloadCwd: string | undefined, headers: Headers): string {
  return payloadCwd || headers.get("x-companion-cwd") || ""
}

function hookDecisionResponse(
  agent: SpawnAgent,
  eventName: "PreToolUse" | "PermissionRequest",
  decision: "allow" | "deny",
  reason: string,
): Response {
  if (agent === "codex") {
    // Codex hook compatibility: empty stdout continues; blocking is explicit.
    if (decision === "allow") return new Response("")
    return Response.json({ decision: "block", reason })
  }
  if (eventName === "PermissionRequest") {
    return Response.json({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: decision },
      },
    })
  }
  return Response.json({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  })
}

function broadcast(data: Record<string, unknown>): void {
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    try { ws.send(msg) } catch { /* dead client */ }
  }
}

// Orchestrator single-thread (PRJ-OR1T): push every new thread turn to all
// clients so the one always-open chat stays live on every device.
function orchEmit(turn: OrchTurn): void {
  broadcast({ type: "orchestrator", turn })
}

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

// "claude-companion", "tls-dashboard-v2", or undefined when cwd is the
// user's home dir (the default `cwd.split('/').pop()` would return the
// macOS username which is meaningless project context). Empty cwds also
// yield undefined so the title falls back to just the tool name.
function projectLabelFor(cwd: string): string | undefined {
  if (!cwd) return undefined
  const home = process.env.HOME ?? ""
  if (home && cwd === home) return undefined
  const last = cwd.split("/").pop()
  return last && last.length > 0 ? last : undefined
}

// Translate the phone's structured answers into the keystroke sequence
// that drives Claude Code's interactive AskUserQuestion picker. The picker
// is an Ink TUI: arrow keys to navigate, Space to toggle in multi-select,
// Enter to confirm. "Other" is auto-appended by the harness as the last
// option; selecting it opens a text input that we type into and submit
// with Enter.
function buildKeystrokeSequence(questions: QuestionItem[], answers: QuestionAnswer[]): KeySeqStep[] {
  const steps: KeySeqStep[] = []
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!
    const a = answers[qi] ?? { selected: [] }

    if (qi > 0) {
      // Inter-question gap — let the harness mount the next picker
      // before we start arrowing through it.
      steps.push({ kind: "wait", ms: 250 })
    }

    if (q.multiSelect) {
      // Walk options 0..N. For each option whose label is in `selected`,
      // hit Space while the cursor sits on it. Track cursor position so
      // we only emit the Down keys we actually need between toggles.
      let cursor = 0
      for (let oi = 0; oi < q.options.length; oi++) {
        const label = q.options[oi]!.label
        if (!a.selected.includes(label)) continue
        while (cursor < oi) {
          steps.push({ kind: "key", name: "Down" })
          cursor++
        }
        steps.push({ kind: "key", name: "Space" })
      }
      steps.push({ kind: "key", name: "Enter" })
      continue
    }

    // Single-select: locate the picked option's index. "Other" lives at
    // index q.options.length (auto-added by the harness, not in the
    // options[] array) — detect it by either the literal label "Other"
    // or by a non-empty otherText.
    const picked = a.selected[0] ?? ""
    let targetIdx = q.options.findIndex((o) => o.label === picked)
    const isOther = a.otherText !== undefined || picked === "Other" || picked === ""
    if (targetIdx < 0 && isOther) {
      targetIdx = q.options.length  // "Other" sits one past the last option
    }
    if (targetIdx < 0) targetIdx = 0  // last-resort fallback — pick first option

    for (let i = 0; i < targetIdx; i++) steps.push({ kind: "key", name: "Down" })
    steps.push({ kind: "key", name: "Enter" })

    if (isOther && (a.otherText ?? "").length > 0) {
      // Picker now shows a text input — wait briefly for it to mount,
      // type the custom text, submit with Enter.
      steps.push({ kind: "wait", ms: 150 })
      steps.push({ kind: "text", text: a.otherText! })
      steps.push({ kind: "key", name: "Enter" })
    }
  }
  return steps
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

function subtitleFor(tool: string, summary: string): string | undefined {
  if (!summary) return undefined
  // Path-based tools: show the basename so the banner doesn't waste space
  // on /Users/<long>/path/to/. The full path stays in the body.
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "Read") {
    const base = summary.split("/").pop()
    if (base && base.length > 0 && base !== summary) return base
    return undefined
  }
  // Bash / Grep / etc — already concise, no value in showing the same
  // string twice across subtitle and body.
  return undefined
}

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

async function capturePane(sessionName: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["tmux", "capture-pane", "-t", sessionName, "-p"], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(p.stdout).text()
    return (await p.exited) === 0 ? out : null
  } catch {
    return null
  }
}

// A freshly-spawned Claude renders its boot screen (welcome box + the input
// frame + the auto-mode/shortcuts footer) only once the TUI is ready to accept
// keystrokes. ps-discovery surfaces the process seconds earlier, and keys sent
// before the box is up are silently dropped. Gate on these markers.
function paneInputReady(pane: string): boolean {
  return /Welcome back|auto mode|for shortcuts|to interrupt/.test(pane)
}

// Onboarding dialogs (new-MCP-server enable, folder-trust) overlay the input box
// AFTER the welcome/footer renders — so paneInputReady alone is fooled and the
// prompt lands on the dialog. Detect them and Escape to dismiss before sending.
function paneHasDialog(pane: string): boolean {
  return /new MCP servers found|wish to enable|Do you trust|Select any you wish|enable this MCP/i.test(pane)
}

// Deliver a dispatched prompt straight to the worker's tmux session by name.
// We spawned it (cc-<name>), so send-keys -t <session> hits its active pane no
// matter how the session surfaced in the registry. This is the reliable path: a
// tmux-wrapped worker discovered via ps has no tmuxPane recorded and its client
// tty has no Terminal tab, so AppleScript/tty inject fails ("no tab for tty").
// tmux send-keys does not care — it just needs the TUI to be input-ready first.
async function sendToTmux(sessionName: string, text: string): Promise<void> {
  let ready = false
  for (let i = 0; i < 30; i++) {
    const pane = await capturePane(sessionName)
    if (pane === null) return // worker session gone
    if (paneHasDialog(pane)) {
      // Dismiss the onboarding dialog (Escape = reject MCP enable / decline
      // trust), then keep polling for the real input box.
      await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "Escape"], { stdout: "ignore", stderr: "ignore" }).exited
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    if (paneInputReady(pane)) { ready = true; break }
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!ready) {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"
    process.stderr.write(`${dim}[companion]${reset} ${red}orchestrator → tmux timeout${reset} ${sessionName} never became input-ready\n`)
    return
  }
  try {
    await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "-l", text], { stdout: "ignore", stderr: "ignore" }).exited
    await new Promise((r) => setTimeout(r, 300))
    await Bun.spawn(["tmux", "send-keys", "-t", sessionName, "Enter"], { stdout: "ignore", stderr: "ignore" }).exited
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
    process.stderr.write(`${dim}[companion]${reset} ${cyan}orchestrator → tmux${reset} ${sessionName} "${text.slice(0, 50)}"\n`)
  } catch { /* worker session gone */ }
}

// Orchestrator (PRJ-OR1T): when a worker session appears for a dispatched task's
// cwd, bind it and fire the queued prompt into its tmux session. Driven off
// onSessions so it catches the worker no matter how it registered — session-start
// hook, ps discovery, or rehydrate (the session-start hook alone is unreliable; a
// spawned worker often surfaces via ps-scan first). Idempotent: matchUnbound…
// only returns still-dispatched, unbound tasks, so a bound task is never re-fired.
function reconcileDispatch(sessions: Session[]): void {
  for (const s of sessions) {
    if (!s.cwd) continue
    const pending = matchUnboundTaskByCwd(s.cwd)
    if (!pending) continue
    bindTaskSession(pending.taskId, s.key || s.cwd)
    orchEmit(orchAppendTurn("orchestrator", `[${pending.taskId}] worker live — sending prompt`, pending.taskId))
    const { tmuxSession, prompt } = pending
    // sendToTmux self-paces: it polls the pane until the TUI is input-ready
    // before send-keys, so binding the instant ps-discovery sees the worker is
    // fine — the prompt won't land until Claude can actually receive it.
    if (tmuxSession) void sendToTmux(tmuxSession, prompt)
  }
}

onSessions((sessions: Session[]) => {
  broadcast({ type: "sessions", sessions })
  reconcileDispatch(sessions)
})

// ── Orchestrator brain (PRJ-OR1T Phase 2): propose-confirm dispatch ──

// Project directories the brain may dispatch into: cwds of live registered
// sessions, deduped. Keeps proposals grounded in real, currently-open projects.
function candidateCwds(): string[] {
  return [...new Set(listSessions().map((s) => s.cwd).filter(Boolean))]
}

// Spawn a worker for an approved proposal and record its tmux session so
// reconcileDispatch delivers the prompt. The task stays 'proposed' (which
// reconcile ignores) until setTaskSpawn flips it to 'dispatched' AFTER the tmux
// session exists — so a worker is never bound before we know where to send.
async function executeDispatch(task: OrchTask): Promise<{ ok: boolean; error?: string }> {
  const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
  let result: SpawnResult
  try {
    result = await spawnCompanionSession({ cwd: task.cwd, agent: "claude" })
  } catch (err) {
    setTaskStatus(task.taskId, "error")
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${dim}[companion]${reset} ${red}dispatch crashed${reset} [${task.taskId}] — ${message}\n`)
    return { ok: false, error: message }
  }
  if (!result.ok) {
    setTaskStatus(task.taskId, "error")
    process.stderr.write(`${dim}[companion]${reset} ${red}dispatch failed${reset} [${task.taskId}] — ${result.error}\n`)
    return { ok: false, error: result.error }
  }
  setTaskSpawn(task.taskId, result.sessionName ?? null)
  process.stderr.write(`${dim}[companion]${reset} ${cyan}orchestrator dispatch${reset} [${task.taskId}] → ${task.cwd} ${dim}(tmux ${result.sessionName ?? "?"})${reset}\n`)
  orchEmit(orchAppendTurn("orchestrator", `approved [${task.taskId}] — worker dispatched`, task.taskId))
  return { ok: true }
}

// Run the brain on a user message: answer inline (chat) or stage a dispatch
// proposal for one-tap approval. Fire-and-forget — never blocks /send. Falls back
// to a soft note on any model failure so the thread never wedges.
async function runBrain(userText: string): Promise<void> {
  let decision
  try {
    decision = await brainDecide(getThread(), userText, candidateCwds())
  } catch {
    decision = null
  }
  if (!decision) {
    orchEmit(orchAppendTurn("orchestrator", "I couldn't process that — try rephrasing?"))
    return
  }
  if (decision.kind === "chat") {
    orchEmit(orchAppendTurn("orchestrator", decision.text))
    return
  }
  const task = createProposal(decision.prompt, decision.cwd, decision.reasoning)
  orchEmit(orchAppendTurn(
    "orchestrator",
    `Proposal [${task.taskId}] — dispatch a worker in ${decision.cwd}\nWhy: ${decision.reasoning}\nTask: ${decision.prompt}\nApprove to run.`,
    task.taskId,
  ))
  broadcast({ type: "orchestrator_proposal", task })
}

export function createCompanionServer(port: number) {
  const server = Bun.serve<WsData>({
    port,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url)

      // ── Auth gate ──
      // Hooks endpoints are called by local Claude Code shell scripts on the
      // same machine, so we exempt them from auth (those scripts can't
      // easily carry credentials and the surface is loopback-only by
      // convention). Static asset paths are also open so the PWA can load
      // its bundle before authenticating. Everything else — /ws, /api/* —
      // requires a valid Bearer token. Without this gate any device on the
      // LAN could hit /api/inject and paste arbitrary keystrokes.
      const isHookCall = url.pathname.startsWith("/hooks/")
      const isHealth = url.pathname === "/health"
      const isStateMutation = url.pathname === "/ws" || url.pathname.startsWith("/api/")
      if (isStateMutation && !isHookCall && !isHealth && !checkBearer(req)) {
        return unauthorized()
      }

      // ── Public liveness probe ──
      // Used by the hook scripts to skip the 300s wait when the server is
      // down. Returns nothing sensitive — just confirms the port is alive.
      if (url.pathname === "/health") {
        return Response.json({ ok: true })
      }

      // ── WebSocket upgrade ──
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID() },
        })
        if (upgraded) return undefined
        return new Response("WebSocket upgrade failed", { status: 500 })
      }

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

        if (waitingForInput) {
          waitingForInput = false
          waitingCwd = ""
          waitingKey = ""
          broadcast({ type: "waiting_input", waiting: false })
        }

        const dim = "\x1b[2m"
        const reset = "\x1b[0m"
        const green = "\x1b[32m"
        const red = "\x1b[31m"
        const yellow = "\x1b[33m"
        const cyan = "\x1b[36m"

        // ── AskUserQuestion / request_user_input fast path ─────────────
        // Treat agent questions as structured phone prompts, not binary
        // approval gates. Routes to phone with question + options, then
        // drives the local terminal picker after the user answers remotely.
        if (isQuestionTool(tool)) {
          const questions = parseQuestionInput(input)
          const answerTarget = questionInjectTarget(session, headerMeta)
          if (questions && hasQuestionInjectTarget(answerTarget)) {
            process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}question${reset} ${dim}${questions[0]?.question.slice(0, 80) ?? ""}${reset}\n`)
            recordToolStart({ tool, input, summary: summarize(tool, input), verdict: "pending", cwd, sessionId, tty })
            const answers = await addQuestionRequest({ agent, sessionId, cwd, questions })

            if (answers.length === 0) {
              // Expired or otherwise no answer — deny so Claude doesn't
              // sit on an open picker that nobody is going to drive.
              process.stderr.write(`${dim}[companion]${reset} ${red}question expired${reset} ← phone\n`)
              return hookDecisionResponse(agent, "PreToolUse", "deny", "User did not answer in time")
            }

            process.stderr.write(`${dim}[companion]${reset} ${green}answered${reset} ← phone (${answers.length} answer${answers.length === 1 ? "" : "s"})\n`)

            // Schedule the keystroke drive AFTER we return allow. The
            // harness only opens its picker once it sees our allow, so
            // the inject has to land slightly later. 500ms gives Ink
            // time to mount and start listening for input — enough on a
            // typical Mac, conservative enough that it's not racing.
            const steps = buildKeystrokeSequence(questions, answers)
            queueMicrotask(() => {
              setTimeout(() => {
                void injectKeySequence(steps, answerTarget).catch(() => { /* logged inside */ })
              }, 500)
            })

            return hookDecisionResponse(agent, "PreToolUse", "allow", "Answered via Claude Companion")
          }
          // Either parse failed or we don't have a live terminal target to
          // drive. Fall through to the generic card so the Mac flow still
          // works instead of swallowing the question.
          process.stderr.write(`${dim}[companion]${reset} ${yellow}question fallback${reset} — ${questions ? "no live terminal target" : "could not parse questions"}\n`)
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
        // Same logic as the PreToolUse fast path, just with the
        // PermissionRequest response shape ({behavior:"allow"} instead
        // of permissionDecision). Claude Code currently fires permission-
        // request for AskUserQuestion; Codex may use request_user_input.
        if (isQuestionTool(tool)) {
          const questions = parseQuestionInput(input)
          const answerTarget = questionInjectTarget(session, headerMeta)
          if (questions && hasQuestionInjectTarget(answerTarget)) {
            process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}question${reset} ${dim}${questions[0]?.question.slice(0, 80) ?? ""}${reset}\n`)
            recordToolStart({ tool, input, summary: summarize(tool, input), verdict: "pending", cwd, sessionId, tty })
            const answers = await addQuestionRequest({ agent, sessionId, cwd, questions })

            const greenFP = "\x1b[32m"; const redFP = "\x1b[31m"
            if (answers.length === 0) {
              process.stderr.write(`${dim}[companion]${reset} ${redFP}question expired${reset} ← phone\n`)
              return hookDecisionResponse(agent, "PermissionRequest", "deny", "User did not answer in time")
            }

            process.stderr.write(`${dim}[companion]${reset} ${greenFP}answered${reset} ← phone (${answers.length} answer${answers.length === 1 ? "" : "s"})\n`)

            const steps = buildKeystrokeSequence(questions, answers)
            queueMicrotask(() => {
              setTimeout(() => {
                void injectKeySequence(steps, answerTarget).catch(() => { /* logged inside */ })
              }, 500)
            })

            return hookDecisionResponse(agent, "PermissionRequest", "allow", "Answered via Claude Companion")
          }
          process.stderr.write(`${dim}[companion]${reset} ${yellow}question fallback${reset} — ${questions ? "no live terminal target" : "could not parse questions"}\n`)
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
            orchEmit(orchAppendTurn("worker", lastMessage || "(no output)", task.taskId))
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

        waitingForInput = true
        waitingCwd = cwd
        waitingKey = session?.key ?? ""
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
          key: waitingKey,
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
            userInfo: { cwd, sessionId: body.session_id ?? "", key: waitingKey },
          }).catch(() => { /* silent */ })
        }
        return Response.json({})
      }

      // ── Approval resolve (HTTP — for iOS notification actions) ──
      // The WebSocket route does the same thing for PWA clients, but iOS
      // notification-action handlers have ~30s of background runtime and a
      // single POST is faster + cheaper than negotiating a WS.
      if (url.pathname === "/api/resolve" && req.method === "POST") {
        const body = await req.json() as { id?: string; decision?: "allow" | "deny" }
        const id = (body.id ?? "").trim()
        const decision = body.decision
        if (!id || (decision !== "allow" && decision !== "deny")) {
          return Response.json({ ok: false, error: "invalid-args" }, { status: 400 })
        }
        const ok = resolveApproval(id, decision)
        if (ok) broadcast({ type: "resolved", id, decision })
        return Response.json({ ok })
      }

      // ── AskUserQuestion answer (HTTP) ──
      // Counterpart to /api/resolve, but for the structured-question flow.
      // Body: { id, answers: [{selected: string[], otherText?}] } — one
      // entry per question, in order. Resolves the pending question; the
      // PreToolUse hook handler then drives the local picker via tmux.
      if (url.pathname === "/api/answer" && req.method === "POST") {
        const body = await req.json() as {
          id?: string
          answers?: Array<{ selected?: string[]; otherText?: string }>
        }
        const id = (body.id ?? "").trim()
        const rawAnswers = body.answers
        if (!id || !Array.isArray(rawAnswers) || rawAnswers.length === 0) {
          return Response.json({ ok: false, error: "invalid-args" }, { status: 400 })
        }
        const answers: QuestionAnswer[] = rawAnswers.map((a) => ({
          selected: Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === "string") : [],
          otherText: typeof a.otherText === "string" ? a.otherText : undefined,
        }))
        const ok = resolveQuestion(id, answers)
        if (ok) broadcast({ type: "resolved", id, decision: "answered" })
        return Response.json({ ok })
      }

      // ── Device token registration (iOS companion app) ──
      if (url.pathname === "/api/register-token" && req.method === "POST") {
        const body = await req.json() as {
          token?: string
          environment?: ApnsEnv
          device_name?: string
        }
        const token = (body.token ?? "").trim()
        if (!token || !/^[A-Fa-f0-9]{32,200}$/.test(token)) {
          return Response.json({ ok: false, error: "invalid-token" }, { status: 400 })
        }
        const env: ApnsEnv = body.environment === "production" ? "production" : "sandbox"
        registerToken(token, env, body.device_name)
        const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
        process.stderr.write(`${dim}[companion]${reset} ${cyan}push token registered${reset} env=${env}${body.device_name ? ` name=${body.device_name}` : ""} total=${tokenCount()}\n`)
        return Response.json({ ok: true, configured: apnsConfigured(), total: tokenCount() })
      }
      if (url.pathname === "/api/register-token" && req.method === "DELETE") {
        const body = await req.json() as { token?: string }
        const token = (body.token ?? "").trim()
        if (!token) return Response.json({ ok: false, error: "missing-token" }, { status: 400 })
        removeToken(token)
        return Response.json({ ok: true, total: tokenCount() })
      }

      // ── Push debug — list devices + fire a synthetic push ──
      if (url.pathname === "/api/push/tokens" && req.method === "GET") {
        const tokens = listTokens().map(t => ({
          token: t.token.slice(0, 8) + "…" + t.token.slice(-4),  // masked
          environment: t.environment,
          deviceName: t.deviceName,
        }))
        return Response.json({ configured: apnsConfigured(), count: tokens.length, tokens })
      }
      if (url.pathname === "/api/push/test" && req.method === "POST") {
        const body = await req.json() as { category?: "approval" | "question" | "waiting_input"; body?: string }
        const category = body.category === "waiting_input"
          ? "waiting_input"
          : body.category === "question"
            ? "question"
            : "approval"
        const result = await pushToAll({
          title: category === "waiting_input"
            ? "Claude is waiting (test)"
            : category === "question"
              ? "Question asked (test)"
              : "Approval needed (test)",
          body: body.body || (category === "approval" ? "Bash: echo hello" : "Tap to respond"),
          category,
          userInfo: category === "approval"
            ? { approvalId: "test-" + Date.now(), sessionId: "test", cwd: "" }
            : category === "question"
              ? { questionId: "test-" + Date.now(), sessionId: "test", cwd: "" }
              : { cwd: "", sessionId: "test", key: "" },
        })
        return Response.json({ ok: true, ...result })
      }

      // ── Generic broadcast — for scheduled briefings, system updates ──
      // Used by cron jobs (e.g. `/today` daily push) to fan out a banner
      // to every registered device. category="briefing" keeps these
      // semantically distinct from approval / waiting_input flows.
      if (url.pathname === "/api/push/broadcast" && req.method === "POST") {
        const body = await req.json() as {
          title?: string
          subtitle?: string
          body?: string
          category?: "approval" | "waiting_input" | "briefing"
          threadId?: string
          userInfo?: Record<string, string>
        }
        const title = (body.title ?? "").trim()
        const text = (body.body ?? "").trim()
        if (!title || !text) {
          return Response.json({ ok: false, error: "title-and-body-required" }, { status: 400 })
        }
        const category = body.category ?? "briefing"
        const result = await pushToAll({
          title,
          subtitle: body.subtitle,
          body: text,
          category,
          threadId: body.threadId,
          userInfo: body.userInfo ?? {},
        })
        const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
        process.stderr.write(`${dim}[companion]${reset} ${cyan}broadcast${reset} cat=${category} sent=${result.sent}/${result.total} title="${title.slice(0, 40)}"\n`)
        return Response.json({ ok: true, ...result })
      }

      // ── Inject text from phone into terminal ──
      if (url.pathname === "/api/inject" && req.method === "POST") {
        const { text, key, cwd } = await req.json() as { text: string; key?: string; cwd?: string }
        if (!text?.trim()) return Response.json({ ok: false, error: "empty" }, { status: 400 })

        const lookup = key || cwd || ""
        let target = lookup ? resolveSession(lookup) : null

        // No explicit target: pick the most-recently-active registered
        // session as "frontmost". On Linux this is the only sane fallback —
        // the legacy pbcopy + Cmd+V path is macOS-only and ENOENTs on Bun
        // under Linux. On macOS this is also a safer default than blind
        // System Events paste into whatever app happens to be frontmost
        // (Cursor, Safari, anything). Caller that truly wants the
        // System-Events fallback can still send key="" + cwd="" on a
        // server with no registered sessions; injectText handles that.
        if (!lookup) {
          const recent = listSessions().find(s => !!s.tty)
          if (recent) target = recent
        }

        // If the caller asked for a specific target and we don't have it
        // registered, refuse rather than silently pasting into the frontmost
        // macOS app.
        if (lookup && !target) {
          const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"
          process.stderr.write(`${dim}[companion]${reset} ${red}inject refused${reset} — target ${lookup} not registered\n`)
          return Response.json({ ok: false, error: "target_gone", key, cwd }, { status: 410 })
        }
        // A resolved session without a tty (e.g. rehydrated from a transcript
        // but nothing live has fired a hook) can't be focused, so paste would
        // land on whatever macOS app is frontmost. Reject with the same signal
        // the phone already knows how to render.
        if (target && !target.tty) {
          const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"
          process.stderr.write(`${dim}[companion]${reset} ${red}inject refused${reset} — target ${target.label} has no live tty\n`)
          return Response.json({ ok: false, error: "target_idle", key, cwd }, { status: 410 })
        }

        const dim = "\x1b[2m"
        const reset = "\x1b[0m"
        const cyan = "\x1b[36m"
        const tag = target?.label ? ` → ${target.label}` : " → frontmost"
        process.stderr.write(`${dim}[companion]${reset} ${cyan}injecting${reset}${tag} "${text.slice(0, 60)}"\n`)

        waitingForInput = false
        waitingCwd = ""
        waitingKey = ""
        broadcast({ type: "waiting_input", waiting: false })

        const ok = await injectText(text, target ?? undefined)
        if (!ok) {
          process.stderr.write(`${dim}[companion]${reset} \x1b[31minject failed\x1b[0m — osascript rejected (Accessibility permission?)\n`)
        } else if (target) {
          // Speculative fix for issue #8: phone-originated prompts weren't
          // appearing in the iOS conversation feed. Hypothesis: synthetic
          // keystrokes (tmux send-keys / osascript do script) don't always
          // trigger Claude Code's UserPromptSubmit hook the same way a real
          // keypress does, so the hook never POSTs to /hooks/user-prompt-submit.
          //
          // Record the user_prompt event ourselves on successful inject. If
          // the Mac-side hook ALSO fires later, the iOS Snapshot.append
          // dedup catches identical consecutive same-role text, so the
          // double-record is harmless.
          recordUserPrompt({
            text,
            cwd: target.cwd,
            sessionId: target.sessionId,
            tty: target.tty,
          })
        }
        return Response.json({ ok })
      }

      // ── Learned-allow management ──
      // List, forget, or wipe the patterns the phone has approved at least
      // once. These auto-allow next time without bothering the phone.
      if (url.pathname === "/api/learned" && req.method === "GET") {
        return Response.json({ entries: listLearned() })
      }
      if (url.pathname === "/api/learned" && req.method === "DELETE") {
        const body = await req.json().catch(() => ({})) as { tool?: string }
        const removed = clearLearned(body.tool)
        const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"
        process.stderr.write(`${dim}[companion]${reset} ${yellow}learned cleared${reset} ${body.tool ?? "all"} (${removed} entries)\n`)
        return Response.json({ ok: true, removed })
      }
      if (url.pathname.startsWith("/api/learned/") && req.method === "DELETE") {
        const pattern = decodeURIComponent(url.pathname.slice("/api/learned/".length))
        const ok = forgetLearned(pattern)
        return Response.json({ ok, pattern })
      }

      // ── SUPER auto-approve toggle ──
      if (url.pathname === "/api/super-auto" && req.method === "GET") {
        return Response.json({ enabled: isSuperAuto() })
      }
      if (url.pathname === "/api/super-auto" && req.method === "POST") {
        const body = await req.json() as { enabled?: boolean }
        const next = setSuperAuto(!!body.enabled)
        const dim = "\x1b[2m"; const reset = "\x1b[0m"; const purple = "\x1b[35m"
        process.stderr.write(`${dim}[companion]${reset} ${purple}super-auto${reset} ${next ? "ON" : "off"}\n`)
        broadcast({ type: "super_auto", enabled: next })
        return Response.json({ ok: true, enabled: next })
      }

      // ── Spawn a fresh Claude/Codex session from the phone ──
      if (url.pathname === "/api/spawn-session" && req.method === "POST") {
        const body = await req.json() as { cwd?: string; app?: "terminal" | "iterm" | "auto"; agent?: SpawnAgent }
        const cwd = (body.cwd ?? "").trim()
        if (!cwd) return Response.json({ ok: false, error: "cwd required" }, { status: 400 })
        const agent: SpawnAgent = body.agent === "codex" ? "codex" : "claude"

        const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
        process.stderr.write(`${dim}[companion]${reset} ${cyan}spawn${reset} ${agent} in ${cwd}\n`)

        let result: SpawnResult
        try {
          result = await spawnCompanionSession({ cwd, app: body.app, agent })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`${dim}[companion]${reset} ${red}spawn crashed${reset} — ${message}\n`)
          return Response.json({ ok: false, error: message || "spawn crashed" }, { status: 500 })
        }
        if (!result.ok) {
          process.stderr.write(`${dim}[companion]${reset} ${red}spawn failed${reset} — ${result.error}\n`)
          return Response.json({ ok: false, error: result.error }, { status: 400 })
        }
        return Response.json({ ok: true, app: result.app, cwd, agent })
      }

      // ── Orchestrator single-thread: chat + worker dispatch (PRJ-OR1T Phase 1) ──
      // One always-open thread per host. /send records a user message; /dispatch
      // spawns a worker bound to this thread (its turn-end reports back tagged by
      // task, via the session-start + stop hooks above); /thread reads it all.
      if (url.pathname === "/api/orchestrator/thread" && req.method === "GET") {
        return Response.json({ turns: getThread(), tasks: listTasks() })
      }
      if (url.pathname === "/api/orchestrator/send" && req.method === "POST") {
        const { text } = await req.json() as { text?: string }
        if (!text?.trim()) return Response.json({ ok: false, error: "empty" }, { status: 400 })
        const turn = orchAppendTurn("user", text.trim())
        orchEmit(turn)
        // Brain decides chat-vs-dispatch async; the user message is already
        // recorded, so /send returns instantly and the reply/proposal streams in.
        void runBrain(text.trim())
        return Response.json({ ok: true, turn })
      }
      if (url.pathname === "/api/orchestrator/dispatch" && req.method === "POST") {
        const { prompt, cwd } = await req.json() as { prompt?: string; cwd?: string }
        if (!prompt?.trim()) return Response.json({ ok: false, error: "prompt required" }, { status: 400 })
        const wd = (cwd ?? "").trim()
        if (!wd) return Response.json({ ok: false, error: "cwd required" }, { status: 400 })

        const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
        // Spawn first so we can record the worker's tmux session name on the
        // task — that's how the prompt is delivered (send-keys -t <session>).
        let result: SpawnResult
        try {
          result = await spawnCompanionSession({ cwd: wd, agent: "claude" })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`${dim}[companion]${reset} ${red}dispatch crashed${reset} — ${message}\n`)
          return Response.json({ ok: false, error: message || "spawn crashed" }, { status: 500 })
        }
        if (!result.ok) {
          process.stderr.write(`${dim}[companion]${reset} ${red}dispatch failed${reset} — ${result.error}\n`)
          return Response.json({ ok: false, error: result.error }, { status: 400 })
        }
        const task = createTask(prompt.trim(), wd, result.sessionName ?? null)
        process.stderr.write(`${dim}[companion]${reset} ${cyan}orchestrator dispatch${reset} [${task.taskId}] → ${wd} ${dim}(tmux ${result.sessionName ?? "?"})${reset}\n`)
        orchEmit(orchAppendTurn("orchestrator", `dispatched [${task.taskId}]: ${prompt.trim()}`, task.taskId))
        return Response.json({ ok: true, taskId: task.taskId, app: result.app })
      }

      // Approve or reject a brain proposal (Phase 2). POST .../proposal/<id>/approve
      // spawns the worker; .../<id>/reject drops it. Only a 'proposed' task is valid.
      if (url.pathname.startsWith("/api/orchestrator/proposal/") && req.method === "POST") {
        const [taskId, action] = url.pathname.slice("/api/orchestrator/proposal/".length).split("/")
        if (!taskId) return Response.json({ ok: false, error: "no such proposal" }, { status: 404 })
        const task = getTask(taskId)
        if (!task) return Response.json({ ok: false, error: "no such proposal" }, { status: 404 })
        if (task.status !== "proposed") {
          return Response.json({ ok: false, error: `not proposable (status ${task.status})` }, { status: 409 })
        }
        if (action === "reject") {
          setTaskStatus(taskId, "rejected")
          orchEmit(orchAppendTurn("orchestrator", `rejected [${taskId}] — not dispatched`, taskId))
          return Response.json({ ok: true, taskId, status: "rejected" })
        }
        if (action === "approve") {
          const r = await executeDispatch(task)
          if (!r.ok) return Response.json({ ok: false, error: r.error, taskId }, { status: 500 })
          return Response.json({ ok: true, taskId, status: "dispatched" })
        }
        return Response.json({ ok: false, error: "unknown action" }, { status: 400 })
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

      // ── Status endpoint ──
      if (url.pathname === "/api/status") {
        return Response.json({
          pending: getPending().length,
          clients: clients.size,
          waitingForInput,
          waitingCwd,
          waitingKey,
          sessions: listSessions(),
        })
      }

      // ── Debug: dump current feed ──
      if (url.pathname === "/api/feed") {
        return Response.json({
          activity: getActivity(),
          feed: getFeed(),
          sessions: listSessions(),
        })
      }

      // ── Serve static files ──
      // Cache strategy:
      //   - index.html → no-cache. WKWebView heuristically caches HTML
      //     otherwise, which pins the page to a stale bundle hash and means
      //     server fixes never reach the phone until the user manually
      //     reinstalls. Always revalidate.
      //   - /assets/* → immutable, 1 year. Vite content-hashes filenames so
      //     a different bundle gets a different URL anyway.
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname
      const file = Bun.file(`${import.meta.dir}/../client/dist${filePath}`)
      if (await file.exists()) {
        const isHtml = filePath.endsWith(".html") || filePath === "/index.html"
        const isHashedAsset = filePath.startsWith("/assets/")
        const headers: Record<string, string> = {}
        if (isHtml) headers["Cache-Control"] = "no-cache"
        else if (isHashedAsset) headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return new Response(file, { headers })
      }
      // SPA fallback
      const index = Bun.file(`${import.meta.dir}/../client/dist/index.html`)
      if (await index.exists()) {
        return new Response(index, { headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" } })
      }
      return new Response("Not found", { status: 404 })
    },
    websocket: {
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
          waitingForInput,
          waitingCwd,
          waitingKey,
          activity: getActivity(),
          feed: getFeed(),
          sessions: listSessions(),
          superAuto: isSuperAuto(),
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
              waitingForInput = false
              waitingCwd = ""
              waitingKey = ""
              broadcast({ type: "waiting_input", waiting: false })
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
    },
  })

  return server
}
