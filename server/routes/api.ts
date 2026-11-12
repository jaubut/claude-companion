import { hostname } from "node:os"
import { basename } from "node:path"
import { getPending, resolveApproval } from "../lib/pty-manager"
import { deliverHeadlessAgyTurn } from "../lib/agy-feed"
import { headlessBrainRunner } from "../wiring/brain"
import { workerSupervisor } from "../wiring/worker-mcp"
import { companionLog } from "../lib/log"
import { type QuestionAnswer, resolveQuestion } from "../lib/questions"
import { deliveryFailedHint, echoPromptOnInject, injectConfirmed } from "../lib/submit-confirm"
import { injectRefusal } from "../lib/inject-guard"
import { handleKeyCommand, isKeyCommand } from "../lib/secret-store"
import { keyCommandGate, originLabel } from "../lib/vault-guard"
import { type SpawnAgent, type SpawnResult, ensureFolderTrusted, resolveSpawnCwd, spawnCompanionSession } from "../lib/spawn-session"
import { SESSION_ID_RE, listRecentSessions } from "../lib/recent-sessions"
import { shellNetworkRefusal } from "../lib/terminal-bridge"
import { checkoutForRepo, deliverSeed, parseSeed } from "../lib/spawn-seed"
import { repoEntriesSafe } from "../lib/live-repo"
import { deleteEnded, endedStore, resumeInPane } from "../lib/ended-sessions"
import { herdrGatedKey, herdrGatedText } from "../lib/herdr"
import { keyGate } from "../lib/key-gate"
import { closeShellSession, spawnShellSession, wireSessions } from "../lib/shell-sessions"
import { isSuperAuto, setSuperAuto } from "../lib/super-auto"
import { clearLearned, forgetLearned, listLearned } from "../lib/learned-allow"
import { clearWaitingForTarget, getSessionByKey, listSessions, resolveSession, waitingSummary } from "../lib/sessions"
import { historyFor } from "../lib/transcript-backfill"
import { getActivity, listActivities, recordUserPrompt } from "../lib/activity"
import { getFeed } from "../lib/feed"
import {
  type ApnsEnv,
  listTokens,
  registerToken,
  removeToken,
  tokenCount,
} from "../lib/push-tokens"
import { apnsConfigured } from "../lib/apns"
import { pushToAll } from "../lib/push"
import { HOST_INFO, broadcast, clientInfo, clients, describeClient } from "../state"
import { dialogWatcher, openDialogFor, paneWidthFor, screenSnapshotFor, yieldPaneForInject } from "../wiring/dialogs"
import { announceWaiting } from "../wiring/waiting"
import { detachTerminals } from "../wiring/shell-sessions"
import { withIdempotency } from "../lib/idempotency"
import { checked, isObject, jsonObject } from "../lib/json-body"
import { HISTORY_STATES, getHistoryItem, historyCounts, listHistory, pruneHistory } from "../lib/approval-history"

// Phone-facing API routes: approval resolve, question answer, push tokens,
// push debug, generic broadcast, inject, learned-allow, SUPER toggle, spawn,
// status, feed dump, approval history. Same paths, methods and responses as
// before the split.

export async function handleApiRoute(req: Request, url: URL): Promise<Response | null> {
  // Approval resolve (HTTP — for iOS notification actions)
  if (url.pathname === "/api/resolve" && req.method === "POST") {
    return withIdempotency(req, "resolve", () => handleResolve(req))
  }

  // AskUserQuestion answer (HTTP)
  if (url.pathname === "/api/answer" && req.method === "POST") {
    return withIdempotency(req, "answer", () => handleAnswer(req))
  }

  // ── Device token registration (iOS companion app) ──
  if (url.pathname === "/api/register-token" && req.method === "POST") {
    const body = checked(await jsonObject<{
      token?: string
      environment?: ApnsEnv
      device_name?: string
    }>(req), { token: "string", device_name: "string" })
    const token = (body.token ?? "").trim()
    if (!token || !/^[A-Fa-f0-9]{32,200}$/.test(token)) {
      return Response.json({ ok: false, error: "invalid-token" }, { status: 400 })
    }
    const env: ApnsEnv = body.environment === "production" ? "production" : "sandbox"
    registerToken(token, env, body.device_name)
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
    companionLog(`${cyan}push token registered${reset} env=${env}${body.device_name ? ` name=${body.device_name}` : ""} total=${tokenCount()}`)
    return Response.json({ ok: true, configured: apnsConfigured(), total: tokenCount() })
  }
  if (url.pathname === "/api/register-token" && req.method === "DELETE") {
    const body = checked(await jsonObject<{ token?: string }>(req), { token: "string" })
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
    const body = await jsonObject<{ category?: "approval" | "question" | "waiting_input"; body?: string }>(req)
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
    const body = checked(await jsonObject<{
      title?: string
      subtitle?: string
      body?: string
      category?: "approval" | "waiting_input" | "briefing"
      threadId?: string
      userInfo?: Record<string, string>
    }>(req), { title: "string", body: "string" })
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
    companionLog(`${cyan}broadcast${reset} cat=${category} sent=${result.sent}/${result.total} title="${title.slice(0, 40)}"`)
    return Response.json({ ok: true, ...result })
  }

  // ── Inject text from phone into terminal ──
  if (url.pathname === "/api/inject" && req.method === "POST") {
    return withIdempotency(req, "inject", () => handleInject(req))
  }

  // ── Learned-allow management ──
  // List, forget, or wipe the patterns the phone has approved at least
  // once. These auto-allow next time without bothering the phone.
  if (url.pathname === "/api/learned" && req.method === "GET") {
    return Response.json({ entries: listLearned() })
  }
  if (url.pathname === "/api/learned" && req.method === "DELETE") {
    const body = checked(await jsonObject<{ tool?: string }>(req, {}), { tool: "string" })
    const removed = clearLearned(body.tool)
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"
    companionLog(`${yellow}learned cleared${reset} ${body.tool ?? "all"} (${removed} entries)`)
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
    const body = checked(await jsonObject<{ enabled?: boolean }>(req), { enabled: "boolean" })
    const next = setSuperAuto(!!body.enabled)
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const purple = "\x1b[35m"
    companionLog(`${purple}super-auto${reset} ${next ? "ON" : "off"}`)
    broadcast({ type: "super_auto", enabled: next })
    return Response.json({ ok: true, enabled: next })
  }

  // ── Spawn a fresh Claude/Codex session (or a plain shell) from the phone ──
  if (url.pathname === "/api/spawn-session" && req.method === "POST") {
    const body = checked(await jsonObject<{ cwd?: string; repo?: unknown; seed?: unknown; app?: string; agent?: SpawnAgent | "shell"; resume?: string }>(req), { cwd: "string" })
    // `repo` (a GitHub / map name) instead of a cwd: this host's checkout, or
    // 409 no_checkout so the phone tries its other host. `seed`: lib/spawn-seed.ts.
    if (body.agent === "shell" && (body.seed !== undefined || body.repo !== undefined)) return Response.json({ ok: false, error: "agent_only" }, { status: 400 })
    const seed = parseSeed(body.seed)
    if (!seed.ok) return Response.json({ ok: false, error: seed.error }, { status: 400 })
    const repo = typeof body.repo === "string" ? body.repo.trim() : ""
    if (body.repo !== undefined && !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return Response.json({ ok: false, error: "bad_repo" }, { status: 400 })
    const fromRepo = repo ? checkoutForRepo(repo, repoEntriesSafe()) : null
    if (repo && !fromRepo) return Response.json({ ok: false, error: "no_checkout", repo }, { status: 409 })
    const cwd = fromRepo ?? (body.cwd ?? "").trim()
    if (!cwd) return Response.json({ ok: false, error: "cwd required" }, { status: 400 })
    if (body.agent === "shell") return shellNetworkRefusal(req) ?? spawnShell(cwd, body.resume)
    const agent: SpawnAgent =
      body.agent === "codex" || body.agent === "kimi" ? body.agent : "claude"

    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"; const red = "\x1b[31m"
    companionLog(`${cyan}spawn${reset} ${agent} in ${cwd}`)

    let result: SpawnResult
    try {
      result = await spawnCompanionSession({ cwd, app: body.app, agent })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      companionLog(`${red}spawn crashed${reset} — ${message}`)
      return Response.json({ ok: false, error: message || "spawn crashed" }, { status: 500 })
    }
    if (!result.ok) {
      companionLog(`${red}spawn failed${reset} — ${result.error}`)
      return Response.json({ ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) }, { status: 400 })
    }
    // Typed in the background once the session registers; only a herdr pane can be matched.
    const seeded = !seed.seed ? undefined : !result.herdrPane ? "unsupported" : "pending"
    if (seed.seed && result.herdrPane) {
      const pane = result.herdrPane, text = seed.seed
      void deliverSeed(pane, text, {
        find: (p) => listSessions().find((s) => s.herdrPane === p),
        inject: async (t, key) => {
          const r = await deliverInject(t, key)
          const j = await r.json().catch(() => ({})) as { error?: string }
          return { ok: r.ok, error: j.error }
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
      }).then((out) => companionLog(`${cyan}spawn seed${reset} ${pane}: ${out}`))
    }
    return Response.json({ ok: true, app: result.app, cwd, agent, ...(seeded ? { seed: seeded } : {}) })
  }

  // ── Resume an ended session in its own herdr pane (lib/ended-sessions.ts) ──
  // {key: "ended:<sessionId>"} → 200 {ok, via:"pane"} once `claude --resume`
  // is typed; the row leaves when the resumed session shows up in the pane.
  // Pane closed meanwhile → a new terminal resuming it (the spawn reply, as
  // for agent "shell", key "shell:…"), under the shell spawn's network rule.
  if (url.pathname === "/api/sessions/resume" && req.method === "POST") {
    const body = await jsonObject<{ key?: unknown }>(req, {})
    const key = typeof body.key === "string" ? body.key : ""
    const ended = endedStore.get(key)
    const r = await resumeInPane(endedStore, key, {
      sendText: (p, t) => herdrGatedText(keyGate, p, t),
      sendKey: (p, k) => herdrGatedKey(keyGate, p, k),
    })
    if (r.ok) {
      companionLog(`\x1b[36mresume\x1b[0m ${ended?.sessionId} typed in herdr pane ${ended?.herdrPane}`)
      return Response.json({ ok: true, via: "pane" })
    }
    if (r.error === "pane_gone" && ended) return shellNetworkRefusal(req) ?? spawnShell(ended.cwd, ended.sessionId)
    const status = { target_gone: 410, bad_resume: 400, pane_gone: 410, pane_busy: 409, send_failed: 502 }[r.error]
    return Response.json({ ok: false, error: r.error }, { status })
  }

  // ── Delete an ended session: close its herdr pane, drop the row ──
  // 200 {ok, closed} | 409 pane_busy (something runs in it) | 410 | 502 close_failed.
  if (url.pathname === "/api/sessions/ended/delete" && req.method === "POST") {
    const body = await jsonObject<{ key?: unknown }>(req, {})
    const key = typeof body.key === "string" ? body.key : ""
    const pane = endedStore.get(key)?.herdrPane
    const r = await deleteEnded(endedStore, key)
    if (r.ok) {
      companionLog(`\x1b[35mended session deleted\x1b[0m ${key}${r.closed ? ` (herdr pane ${pane} closed)` : " (pane already gone)"}`)
      return Response.json(r)
    }
    const status = { target_gone: 410, pane_busy: 409, close_failed: 502 }[r.error]
    return Response.json(r, { status })
  }

  // ── Close a terminal row (lib/shell-sessions.ts closeShellSession) ──
  // {name} → 200 {ok, gone} (gone: it had already exited) | 400 bad_name |
  // 404 unknown_shell (not in the shell list) | 409 claude_running |
  // 409 {code: close_unavailable} (a herdr shell; `error` is the sentence the
  // phone shows, as it shows any code) | 502 kill_failed.
  // The row leaves every client through the shell store's `sessions` broadcast.
  if (url.pathname === "/api/shell/close" && req.method === "POST") {
    const refused = shellNetworkRefusal(req)
    if (refused) return refused
    const body = await jsonObject<{ name?: unknown }>(req, {})
    const name = typeof body.name === "string" ? body.name : ""
    if (!name || name.length > 200) return Response.json({ ok: false, error: "bad_name" }, { status: 400 })
    const r = await closeShellSession(name, listSessions(), detachTerminals)
    if (r.ok) {
      companionLog(`\x1b[35mshell closed\x1b[0m ${name}${r.gone ? " (already gone)" : ""}`)
      return Response.json(r)
    }
    if (r.error === "close_unavailable") return Response.json({ ok: false, error: "Type exit in the shell to close it", code: r.error }, { status: 409 })
    const status = { unknown_shell: 404, claude_running: 409, kill_failed: 502 }[r.error]
    return Response.json(r, { status })
  }

  // ── Recent interactive Claude sessions (terminal: Recent sessions, Resume chip) ──
  // {ok, sessions: [{sessionId, cwd, title, updatedAt}]}, newest first.
  if (url.pathname === "/api/sessions/recent" && req.method === "GET") {
    return Response.json({ ok: true, sessions: await listRecentSessions() })
  }

  // ── A listed session's older chat rows, from its transcript (lib/transcript-backfill.ts) ──
  // {ok, key, events: FeedEvent[]} oldest first; 404 for a key not listed.
  if (url.pathname === "/api/sessions/history" && req.method === "GET") {
    const session = getSessionByKey(url.searchParams.get("key") ?? "")
    if (!session) return Response.json({ ok: false, error: "unknown_session" }, { status: 404 })
    return Response.json({ ok: true, key: session.key, events: await historyFor(session) })
  }

  // ── Approval history (the phone's Approvals tab) ──
  if (url.pathname === "/api/approvals/history" && req.method === "GET") return listApprovalHistory(url)
  if (url.pathname === "/api/approvals/history" && req.method === "DELETE") return pruneApprovalHistory(url)
  if (url.pathname === "/api/approvals/history/stats" && req.method === "GET") return approvalHistoryStats(url)
  if (url.pathname.startsWith("/api/approvals/history/") && req.method === "GET") return approvalHistoryItem(url)

  // ── Status endpoint ──
  if (url.pathname === "/api/status") {
    return Response.json({
      pending: getPending().length,
      clients: clients.size,
      ...waitingSummary(),
      sessions: wireSessions(listSessions()),
      dialogs: dialogWatcher.current(),
      host: HOST_INFO,
    })
  }


  // ── Debug: dump current feed ──
  if (url.pathname === "/api/feed") {
    return Response.json({
      activity: getActivity(),
      activities: listActivities(),
      feed: getFeed(),
      sessions: wireSessions(listSessions()),
    })
  }
  return null
}

// A login shell in a marked herdr pane (lib/shell-sessions.ts). Always herdr,
// whatever `app` says: the phone attaches it through /api/terminal.
// Replies with the session's wire record so the phone can open it at once.
// `resume` (a Claude session id) types `claude --resume <id>` into it.
async function spawnShell(rawCwd: string, resume: unknown): Promise<Response> {
  if (resume !== undefined && (typeof resume !== "string" || !SESSION_ID_RE.test(resume))) {
    return Response.json({ ok: false, error: "bad_resume" }, { status: 400 })
  }
  const cwd = resolveSpawnCwd(rawCwd)
  if ("error" in cwd) return Response.json({ ok: false, error: cwd.error }, { status: 400 })
  companionLog(`\x1b[36mspawn\x1b[0m shell in ${cwd.dir}${resume ? ` resuming ${resume}` : ""}`)
  // The resumed claude must not stop at the folder-trust dialog.
  if (resume) ensureFolderTrusted(cwd.dir)
  const r = await spawnShellSession(cwd.dir, undefined, resume as string | undefined)
  if (!r.ok) {
    companionLog(`\x1b[31mspawn failed\x1b[0m — ${r.error}`)
    return Response.json({ ok: false, error: r.error, ...(r.session && { key: r.session.key, sessionName: r.session.name }) }, { status: 400 })
  }
  return Response.json({ ok: true, app: "herdr", cwd: cwd.dir, agent: "shell", key: r.session.key, sessionName: r.session.name })
}

async function handleResolve(req: Request): Promise<Response> {
  const body = checked(await jsonObject<{ id?: string; decision?: "allow" | "deny" }>(req), { id: "string" })
  const id = (body.id ?? "").trim()
  const decision = body.decision
  if (!id || (decision !== "allow" && decision !== "deny")) {
    return Response.json({ ok: false, error: "invalid-args" }, { status: 400 })
  }
  const ok = resolveApproval(id, decision, { device: clientInfo(req, "").device })
  logResolve(req, "approval", id, decision, ok)
  if (ok) broadcast({ type: "resolved", id, decision })
  return Response.json(ok ? { ok } : { ok, reason: "gone" })
}

// Audit line for every phone decision: what, which id, and where it came from
// (transport, peer address, user-agent, X-Companion-Device). Never the token.
function logResolve(req: Request, what: "approval" | "question", id: string, decision: string, ok: boolean): void {
  const tag = ok ? "\x1b[36mresolve\x1b[0m" : "\x1b[33mresolve failed (gone)\x1b[0m"
  companionLog(`${tag} ${what} ${id.slice(0, 8)} → ${decision} ${describeClient("rest", clientInfo(req, originLabel(req)))}`)
}

async function handleAnswer(req: Request): Promise<Response> {
  const body = checked(await jsonObject<{
    id?: string
    answers?: Array<{ selected?: string[]; otherText?: string }>
  }>(req), { id: "string" })
  const id = (body.id ?? "").trim()
  const rawAnswers = body.answers
  if (!id || !Array.isArray(rawAnswers) || rawAnswers.length === 0 || !rawAnswers.every(isObject)) {
    return Response.json({ ok: false, error: "invalid-args" }, { status: 400 })
  }
  const answers: QuestionAnswer[] = rawAnswers.map((a) => ({
    selected: Array.isArray(a.selected) ? a.selected.filter((s) => typeof s === "string") : [],
    otherText: typeof a.otherText === "string" ? a.otherText : undefined,
  }))
  const ok = resolveQuestion(id, answers, { device: clientInfo(req, "").device })
  logResolve(req, "question", id, "answered", ok)
  if (ok) broadcast({ type: "resolved", id, decision: "answered" })
  return Response.json(ok ? { ok } : { ok, reason: "gone" })
}

// Inject text from phone into terminal.
async function handleInject(req: Request): Promise<Response> {
  const { text, key, cwd } = checked(await jsonObject<{ text: string; key?: string; cwd?: string }>(req), { text: "string", key: "string", cwd: "string" })
  if (!text?.trim()) return Response.json({ ok: false, error: "empty" }, { status: 400 })

  // `/key NAME value` goes to secrets.env, never into the pane or a log —
  // and only from where the vault itself would accept it. A refused /key is
  // still never injected (the value would land in the pane).
  if (isKeyCommand(text)) {
    const gate = keyCommandGate(req)
    if (!gate.allowed) {
      const { status, ...refusal } = gate.refusal ?? { status: 403, error: "forbidden_network", message: "/key refusé. Rien enregistré." }
      companionLog(`/key refused — ${refusal.error} peer=${gate.origin.peer}`)
      return Response.json({ ok: false, ...refusal }, { status })
    }
    const keyed = await handleKeyCommand(text, gate.origin)
    if (keyed) {
      companionLog(`/key ${keyed.name ?? "?"} → ${keyed.ok ? "saved" : keyed.error}`)
      const { status, ...body } = keyed
      return Response.json(body, { status })
    }
  }
  return deliverInject(text, key, cwd)
}

/**
 * The guarded delivery behind POST /api/inject (refusals, waiting-badge clear,
 * submit confirmation). Also the canvas Context-edge send (wiring/canvas.ts),
 * so a canvas prompt passes the exact same inject guards as a phone prompt.
 */
export async function deliverInject(text: string, key?: string, cwd?: string, boundSid?: string, canDeliver?: () => boolean): Promise<Response> {
  const lookup = key || cwd || ""
  let target = lookup ? resolveSession(lookup) : null
  const explicit = target
  if (!lookup) {
    const recent = listSessions().find(s => !!s.tty || s.herdrPane?.startsWith("headless:"))
    if (recent) target = recent
  }

  // Headless session delivery (BKM-Q24R): brain, Inverted MCP workers, and headless Antigravity conversations.
  if (target?.herdrPane?.startsWith("headless:")) {
    if ((boundSid && target.sessionId !== boundSid) || (canDeliver && !canDeliver())) {
      return Response.json({ ok: false, error: "target_changed", key, cwd }, { status: 409 })
    }
    const { cleared } = clearWaitingForTarget(explicit, "turn-end")
    announceWaiting(cleared)
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
        prompt: text, mode: "auto", family: existing?.family ?? (target.agent === "codex" || target.agent === "gemini" ? target.agent : "claude"),
        model: (target.model || existing?.model) ?? undefined,
      })
      return dispatched.ok
        ? Response.json({ ok: true, confirmed: true })
        : Response.json({ ok: false, error: dispatched.error ?? "deliver_failed", key, cwd }, { status: 409 })
    }
    if (target.herdrPane.startsWith("headless:agy:")) {
      const ok = deliverHeadlessAgyTurn({ sessionId: target.sessionId, cwd: target.cwd, prompt: text })
      return Response.json(ok ? { ok: true, confirmed: true } : { ok: false, error: "deliver_failed" }, { status: ok ? 200 : 500 })
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

// Approval history — lib/approval-history.ts. Bearer-gated like every /api route.
//   GET    /api/approvals/history?state=&kind=&q=&limit=&before=
//   GET    /api/approvals/history/stats?since=<iso>
//   GET    /api/approvals/history/:id
//   DELETE /api/approvals/history?before=<iso>   (manual pruning, resolved rows only)
const HISTORY_ITEM_PREFIX = "/api/approvals/history/"
const HISTORY_KINDS = new Set(["approval", "question"])
const HISTORY_FILTERS = new Set<string>([...HISTORY_STATES, "all", "resolved", "auto", "everything"])

function badRequest(error: string): Response {
  return Response.json({ ok: false, error }, { status: 400 })
}

function approvalHistoryItem(url: URL): Response {
  const id = decodeURIComponent(url.pathname.slice(HISTORY_ITEM_PREFIX.length))
  const item = id && !id.includes("/") ? getHistoryItem(id) : null
  return item ? Response.json({ ok: true, item }) : Response.json({ ok: false, error: "not_found" }, { status: 404 })
}

function listApprovalHistory(url: URL): Response {
  const p = url.searchParams
  const state = p.get("state") || "all"
  if (!HISTORY_FILTERS.has(state)) return badRequest("bad_state")
  const kind = p.get("kind") || ""
  if (kind && !HISTORY_KINDS.has(kind)) return badRequest("bad_kind")
  const rawLimit = p.get("limit")
  const limit = rawLimit ? Number(rawLimit) : undefined
  if (limit !== undefined && !Number.isFinite(limit)) return badRequest("bad_limit")
  const { items, next } = listHistory({ state, kind, q: p.get("q") || "", limit, before: p.get("before") || "" })
  return Response.json({ ok: true, host: hostname(), items, next })
}

function approvalHistoryStats(url: URL): Response {
  const raw = url.searchParams.get("since") ?? ""
  const ms = raw ? Date.parse(raw) : NaN
  if (raw && !Number.isFinite(ms)) return badRequest("bad_since")
  return Response.json({ ok: true, counts: historyCounts(raw ? new Date(ms).toISOString() : "") })
}

function pruneApprovalHistory(url: URL): Response {
  const raw = url.searchParams.get("before") ?? ""
  const ms = raw ? Date.parse(raw) : NaN
  if (!Number.isFinite(ms)) return badRequest("bad_before")
  return Response.json({ ok: true, deleted: pruneHistory(new Date(ms).toISOString()) })
}
