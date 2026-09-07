import { getPending, resolveApproval } from "../lib/pty-manager"
import { type QuestionAnswer, resolveQuestion } from "../lib/questions"
import { injectText } from "../lib/keyboard-inject"
import { type SpawnAgent, type SpawnResult, spawnCompanionSession } from "../lib/spawn-session"
import { isSuperAuto, setSuperAuto } from "../lib/super-auto"
import { clearLearned, forgetLearned, listLearned } from "../lib/learned-allow"
import { listSessions, resolveSession } from "../lib/sessions"
import { getActivity, getFeed, recordUserPrompt } from "../lib/activity"
import {
  type ApnsEnv,
  listTokens,
  registerToken,
  removeToken,
  tokenCount,
} from "../lib/push-tokens"
import { apnsConfigured } from "../lib/apns"
import { pushToAll } from "../lib/push"
import {
  HOST_INFO,
  broadcast,
  clearWaiting,
  clients,
  getWaiting,
} from "../state"
import { dialogWatcher } from "../wiring/dialogs"
import { handleDialogRoute } from "../routes/dialogs"
import { handleOrchestratorRoute } from "../routes/orchestrator"

// Phone-facing API routes: approval resolve, question answer, push tokens,
// push debug, generic broadcast, inject, learned-allow, SUPER toggle, spawn,
// status, feed dump. Same paths, methods and responses as before the split.

export async function handleApiRoute(req: Request, url: URL): Promise<Response | null> {
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

    clearWaiting()
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
    const agent: SpawnAgent =
      body.agent === "codex" || body.agent === "kimi" ? body.agent : "claude"

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

  {
    const handled = await handleOrchestratorRoute(req, url)
    if (handled) return handled
  }

  // ── Status endpoint ──
  if (url.pathname === "/api/status") {
    return Response.json({
      pending: getPending().length,
      clients: clients.size,
      ...getWaiting(),
      sessions: listSessions(),
      dialogs: dialogWatcher.current(),
      host: HOST_INFO,
    })
  }

  {
    const handled = await handleDialogRoute(req, url)
    if (handled) return handled
  }

  // ── Debug: dump current feed ──
  if (url.pathname === "/api/feed") {
    return Response.json({
      activity: getActivity(),
      feed: getFeed(),
      sessions: listSessions(),
    })
  }
  return null
}
