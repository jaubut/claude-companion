import type { ServerWebSocket } from "bun"
import {
  addApprovalRequest,
  resolveApproval,
  getPending,
  onApprovalRequest,
  onApprovalExpired,
} from "./lib/pty-manager"
import { judgeWithBranchContext } from "./lib/branch-guard"
import { injectText } from "./lib/keyboard-inject"
import { spawnClaudeSession } from "./lib/spawn-session"
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
  summarize,
  type FeedEvent,
  type Verdict,
} from "./lib/activity"
import { registerToken, removeToken, tokenCount, listTokens, type ApnsEnv } from "./lib/push-tokens"
import { apnsConfigured } from "./lib/apns"
import { pushToAll } from "./lib/push"
import { checkBearer, unauthorized } from "./lib/auth"

interface WsData {
  id: string
}

const clients = new Set<ServerWebSocket<WsData>>()
let waitingForInput = false
let waitingCwd = ""
let waitingKey = ""

function broadcast(data: Record<string, unknown>): void {
  const msg = JSON.stringify(data)
  for (const ws of clients) {
    try { ws.send(msg) } catch { /* dead client */ }
  }
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
      title: project ? `${project} · ${req.tool}` : req.tool,
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

onFeed((ev: FeedEvent) => {
  broadcast({ type: "event", event: ev })
})

onActivity((activity) => {
  broadcast({ type: "activity", activity })
})

onSessions((sessions: Session[]) => {
  broadcast({ type: "sessions", sessions })
})

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
        const cwd = body.cwd ?? ""
        const headerMeta = metaFromHeaders(req.headers)
        const tty = headerMeta.tty ?? ""

        if (cwd) {
          recordSession({ cwd, sessionId, ...headerMeta })
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
          return Response.json({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: decision,
              permissionDecisionReason: "Approved via Claude Companion (SUPER)",
            },
          })
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
          decision = await addApprovalRequest({ sessionId, tool, input, cwd })
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

        return Response.json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: decision === "allow"
              ? "Approved via Claude Companion"
              : "Denied via Claude Companion",
          },
        })
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
        const cwd = body.cwd ?? ""
        const headerMeta = metaFromHeaders(req.headers)

        if (cwd) {
          recordSession({ cwd, sessionId: body.session_id ?? "", ...headerMeta })
        }

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
        const cwd = body.cwd ?? ""
        const headerMeta = metaFromHeaders(req.headers)
        if (cwd) {
          recordSession({ cwd, sessionId: body.session_id ?? "", ...headerMeta })
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
        const promptKey = headerMeta.tty ? `tty:${headerMeta.tty}` : ""
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
        const cwd = body.cwd ?? ""
        const headerMeta = metaFromHeaders(req.headers)
        const tty = headerMeta.tty ?? ""

        if (cwd) {
          recordSession({ cwd, sessionId, ...headerMeta })
        }

        const dim = "\x1b[2m"
        const reset = "\x1b[0m"
        const yellow = "\x1b[33m"
        const cyan = "\x1b[36m"

        process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}permission${reset} ${tool} ${dim}${summarize(tool, input)}${reset}\n`)

        recordToolStart({ tool, input, summary: summarize(tool, input), verdict: "pending", cwd, sessionId, tty })
        const decision = await addApprovalRequest({ sessionId, tool, input, cwd })

        const green = "\x1b[32m"
        const red = "\x1b[31m"
        const decisionColor = decision === "allow" ? green : red
        process.stderr.write(`${dim}[companion]${reset} ${decisionColor}${decision}${reset} ← permission\n`)

        // Same learning hook as the PreToolUse path — phone-allowed shapes
        // get remembered so the next ask doesn't roundtrip.
        if (decision === "allow") {
          recordAllow(tool, input)
        }

        return Response.json({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: decision },
          },
        })
      }

      // ── Stop hook — Claude finished its turn, waiting for user input ──
      if (url.pathname === "/hooks/stop" && req.method === "POST") {
        const body = await req.json() as {
          session_id?: string
          cwd?: string
          transcript_path?: string
          stop_hook_active?: boolean
        }

        const cwd = body.cwd ?? ""
        const headerMeta = metaFromHeaders(req.headers)
        let session: Session | null = null
        if (cwd) {
          session = recordSession({ cwd, sessionId: body.session_id ?? "", ...headerMeta })
        }

        const lastMessage = await extractLastAssistantMessage(body.transcript_path)

        recordTurnEnd({
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
            title: project ? `${project} · waiting` : "Claude is waiting",
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
        const body = await req.json() as { category?: "approval" | "waiting_input"; body?: string }
        const category = body.category === "waiting_input" ? "waiting_input" : "approval"
        const result = await pushToAll({
          title: category === "approval" ? "Approval needed (test)" : "Claude is waiting (test)",
          body: body.body || (category === "approval" ? "Bash: echo hello" : "Tap to respond"),
          category,
          userInfo: category === "approval"
            ? { approvalId: "test-" + Date.now(), sessionId: "test", cwd: "" }
            : { cwd: "", sessionId: "test", key: "" },
        })
        return Response.json({ ok: true, ...result })
      }

      // ── Inject text from phone into terminal ──
      if (url.pathname === "/api/inject" && req.method === "POST") {
        const { text, key, cwd } = await req.json() as { text: string; key?: string; cwd?: string }
        if (!text?.trim()) return Response.json({ ok: false, error: "empty" }, { status: 400 })

        const lookup = key || cwd || ""
        const target = lookup ? resolveSession(lookup) : null

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

      // ── Spawn a fresh Claude session from the phone ──
      if (url.pathname === "/api/spawn-session" && req.method === "POST") {
        const body = await req.json() as { cwd?: string; app?: "terminal" | "iterm" | "auto" }
        const cwd = (body.cwd ?? "").trim()
        if (!cwd) return Response.json({ ok: false, error: "cwd required" }, { status: 400 })

        const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
        process.stderr.write(`${dim}[companion]${reset} ${cyan}spawn${reset} claude in ${cwd}\n`)

        const result = await spawnClaudeSession({ cwd, app: body.app })
        if (!result.ok) {
          process.stderr.write(`${dim}[companion]${reset} ${red}spawn failed${reset} — ${result.error}\n`)
          return Response.json({ ok: false, error: result.error }, { status: 400 })
        }
        return Response.json({ ok: true, app: result.app, cwd })
      }

      // ── Hook endpoint — SessionStart — register on startup/resume/clear/compact
      // so idle Claude sessions are visible to the phone picker from the moment
      // they open, without waiting for the user to trigger a tool-call hook.
      if (url.pathname === "/hooks/session-start" && req.method === "POST") {
        const body = await req.json() as { cwd?: string; session_id?: string; source?: string }
        const cwd = body.cwd ?? ""
        if (cwd) {
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
        const cwd = body.cwd ?? ""
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
            tool: req.tool,
            input: req.input,
            sessionId: req.sessionId,
            cwd: req.cwd,
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
        let msg: { type: string; id?: string; text?: string; key?: string; cwd?: string }
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
