import type { A2UIEngineDeps } from "../lib/a2ui"
import { executeA2UIMacro, handleA2UIAction } from "../lib/a2ui-macros"
import { checkBearer, unauthorized } from "../lib/auth"
import { BRAIN_AGENT, BRAIN_THREAD, LEAD_PREFIX, brainEnabled, brainText, leadSlug } from "../lib/brain"
import { runBrainLoadSkill } from "../lib/brain-turn-harness"
import { latestRows, rowsSince } from "../lib/brain-trace"
import type { Gemini4StreamTransport } from "../lib/gemini4-orchestrator-client"
import { analyseLink } from "../lib/link-media"
import { companionLog } from "../lib/log"
import { searchThread } from "../lib/orchestrator-chat"
import type { OutboundSender, OutboundStore } from "../lib/outbound"
import { type Session, listSessions } from "../lib/sessions"
import type { GhFn } from "../lib/triage-pr"
import { clientOrigin, peerOf } from "../lib/vault-guard"
import { REPO_NAME_RE, TASK_ID_RE } from "../lib/worker-invocation"
import type { WorkerMcpHandler } from "../lib/worker-mcp"
import { type BrainWiring, brainWiring, getBrainDeliver } from "../wiring/brain"
import { addBrainHandoff } from "../wiring/brain-handoff"
import { createBrainSseTurnResponse, executeAtomicBrainDispatch } from "../wiring/brain-propose"
import { addBrainTodo } from "../wiring/brain-todo"
import { REASON_MAX, closeDeadPr } from "../wiring/brain-pr-close"
import { mergeAgentPr } from "../wiring/brain-pr-merge"
import { resolveAgentPrConflicts } from "../wiring/brain-pr-resolve-conflicts"
import { updateAgentPr } from "../wiring/brain-pr-update-branch"
import { TASK_REF, cancelAgentTask } from "../wiring/brain-task-cancel"
import { type BrainLead, brainLead, leadCheckout, relayToBrainThread } from "../wiring/brain-lead"
import { type DeployResult, autoDeploy, isDeployRepo } from "../wiring/auto-deploy"
import { type BrainWorkers, brainWorkers } from "../wiring/brain-workers"

// brain-v2 routes (docs/brain-api.md):
//   GET  /api/brain                       → {ok, brain: {state, sessionKey, since, restarts, host}}
//   GET  /api/brain/trace?since=<seq>     → {ok, rows: TraceRow[]}
//   POST /api/brain/pause|resume|restart  → {ok, brain}; restart while paused → 409 paused
//   POST /hooks/brain/propose             → bin/propose: {title, prompt, noteId, agent?, reasoning, sourceTurnId, handoff?}
//   POST /hooks/brain/dispatch            → bin/dispatch: atomic local handoff + worker MCP dispatch_task
//   POST /hooks/brain/thread              → bin/thread: {q, limit?} → {ok, turns: [{id, role, at, text}]} (brain thread, newest first)
//   POST /hooks/brain/lead                → bin/lead: {repo} → {ok, name, state} (docs/brain-api.md § Repo leads)
//   POST /hooks/brain/todo                → bin/todo: {text, noteId, due?, sourceTurnId} → {ok, taskId, replay} (a to-do for Jeremie)
//   POST /hooks/brain/sessions            → bin/sessions: {op:"list"} → {ok, sessions, mode}; {op:"close", workspaceId}
//   POST /hooks/brain/pr-close            → bin/pr-close: {repo, pr, reason} → {ok, closed, url, evidence} (dead dispatch/* PRs only)
//   POST /hooks/brain/pr-merge            → bin/pr-merge: {repo, pr, reason} → {ok, merged, url, head} (routine dispatch/* PRs only)
//   POST /hooks/brain/pr-update-branch    → bin/pr-update-branch: {repo, pr, reason} → {ok, updated, url, head} (stale dispatch/* PRs only)
//   POST /hooks/brain/pr-resolve-conflicts → {repo, pr, reason} → {ok, dispatched, taskId, url, branch, head} (conflicting dispatch/* PRs only)
//   POST /hooks/brain/task-cancel         → bin/task-cancel: {task, reason} → {ok, cancelled, from, pr?, prState?, note?} (queued, blocked, failed tasks the brain proposed)
//   POST /hooks/brain/deploy              → bin/deploy: {repo, reason} → {ok, result, from, to} (claude-companion | claude-config, ff-only)
//   POST /hooks/brain/media               → bin/media: {url} → {ok, kind, meta, palette, transcript, frames, contactSheet} | {ok:false, error, reason}
//   POST /hooks/brain/load-skill          → bin/load-skill: {skillId} → {ok, skillId, content, output}
//   GET  /api/brain/workers               → {ok, mode, sessions, foreign} (the reaper's dry run; never names foreign workspaces)
//   POST /api/brain/stream                → SSE stream (`thinking_delta` | `tool_start` | `tool_result_summary` | `text_delta` | `done`)
// /api/* is Bearer-gated by companion-server.ts; checked here too. The propose
// hook is loopback only (a tailscale-serve hop is refused), and must carry the
// brain session's pid with X-Companion-Task-Id: brain.

const TURN_ID = /^[\w:-]{1,64}$/
const TITLE_MAX = 200
const PROMPT_MAX = 20_000
const NOTE_ID_MAX = 300
const REASONING_MAX = 2_000
const QUERY_MAX = 200
const SEARCH_LIMIT_MAX = 50
/** Per turn in a search answer: enough to recall, short enough for a tool result. */
const SEARCH_TEXT_MAX = 1_000
const TODO_MAX = 300
const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface BrainRouteDeps {
  wiring: BrainWiring
  todo?: typeof addBrainTodo
  handoff?: typeof addBrainHandoff
  sessions: () => Session[]
  enabled: () => boolean
  /** The brain-workers reaper (default: the real one). */
  workers?: BrainWorkers
  /** The dead-PR close (default: the real one, gh + notes DB). */
  prClose?: typeof closeDeadPr
  /** The routine-PR merge (default: the real one, gh + notes DB). */
  prMerge?: typeof mergeAgentPr
  /** The stale-PR update (default: the real one, gh + notes DB). */
  prUpdate?: typeof updateAgentPr
  /** The conflict-resolver dispatch (default: the real one, gh + notes DB + worker supervisor). */
  prResolve?: typeof resolveAgentPrConflicts
  /** The task cancel (default: the real one, notes DB + the proposal store). */
  taskCancel?: typeof cancelAgentTask
  /** bin/deploy (default: the brain host's auto-deployer; null = not running here). */
  deploy?: ((repo: string) => Promise<DeployResult>) | null
  /** bin/lead (default: the real one). */
  lead?: BrainLead
  /** Whether this host has a checkout for a lead repo (default: wiring/brain-lead.ts). */
  checkout?: (repo: string) => boolean
  /** bin/media (default: the real fetch + analyse, lib/link-media.ts). */
  media?: typeof analyseLink
  /** Session message injector for `bin/sessions send` (default: wiring/brain.ts getBrainDeliver). */
  deliverSession?: ((text: string, key: string) => Promise<Response>) | null
  /** GitHub CLI runner for `bin/ui pr` and `pr.refresh` (default: realGh). */
  gh?: GhFn
  /** Outbound store seam for `bin/ui email` and `email.confirm`/`email.cancel` (default: outboundStore; null = dryRun). */
  outbound?: OutboundStore | (() => OutboundStore) | null
  /** Email sender seam for `email.confirm` (default: gmailSender). */
  emailSender?: OutboundSender
  /** Persistence + broadcast seam for A2UI surface tests. */
  a2uiEngine?: A2UIEngineDeps
  /** Worker MCP handler for atomic `/hooks/brain/dispatch` (default: workerMcp). */
  workerMcp?: WorkerMcpHandler
  /** Stage 2 dynamic skill loader seam for `bin/load-skill` (`POST /hooks/brain/load-skill`). */
  loadSkill?: typeof runBrainLoadSkill
  /** Gemini 4 SSE stream transport seam for `POST /api/brain/stream`. */
  streamTransport?: Gemini4StreamTransport
}

const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status })
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null)

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.json() as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Only the supervised brain session may propose: loopback peer, brain task header, its pid, its session id. */
function proposeRefusal(req: Request, deps: BrainRouteDeps): Response | null {
  const origin = clientOrigin(req, peerOf(req))
  if (origin.transport !== "loopback") return fail(403, "forbidden")
  if (req.headers.get("x-companion-task-id") !== BRAIN_AGENT) return fail(403, "forbidden")
  const pid = req.headers.get("x-companion-pid")?.trim() ?? ""
  const st = deps.wiring.status()
  if (!pid || !st.sessionKey) return fail(403, "forbidden")
  const s = deps.sessions().find((x) => x.key === st.sessionKey)
  const brain = deps.sessions().find((x) => x.pid === pid)
  if (!s || !brain || brain.key !== s.key || brain.sessionId !== s.sessionId || brain.taskId !== BRAIN_AGENT) return fail(403, "forbidden")
  return null
}

async function propose(req: Request, deps: BrainRouteDeps, forceDispatch = false): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) {
    companionLog(`[brain] propose refused (peer=${peerOf(req) ?? "?"})`)
    return refused
  }
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const noteId = str(body.noteId, NOTE_ID_MAX)
  if (!noteId) return fail(422, "no_project")
  const prompt = str(body.prompt, PROMPT_MAX)
  if (!prompt) return fail(400, "prompt required")
  const sourceTurnId = typeof body.sourceTurnId === "string" && TURN_ID.test(body.sourceTurnId) ? body.sourceTurnId : null
  if (!sourceTurnId) return fail(400, "sourceTurnId required")
  const rawTaskId = typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : undefined
  if (rawTaskId !== undefined && !TASK_ID_RE.test(rawTaskId)) return fail(400, "invalid_task_id")
  const title = str(body.title, TITLE_MAX) ?? prompt.split("\n")[0]!.slice(0, TITLE_MAX)
  const agent = body.agent === undefined || body.agent === null ? null : str(body.agent, 64)
  if (body.agent !== undefined && body.agent !== null && !agent) return fail(400, "unknown_agent")
  const reasoning = str(body.reasoning, REASONING_MAX) ?? ""
  if (forceDispatch || body.dispatch === true) {
    deps.wiring.noteSideEffect?.("dispatch")
    return executeAtomicBrainDispatch(
      body,
      { noteId, prompt, sourceTurnId, title, reasoning, taskId: rawTaskId },
      { handoff: deps.handoff, workerMcp: deps.workerMcp },
    )
  }
  if (body.handoff === true) {
    deps.wiring.noteSideEffect?.("propose:handoff")
    // A bad or missing repo files the row without a claim, never a refusal: the handoff itself must not be blocked.
    const repo = typeof body.repo === "string" && REPO_NAME_RE.test(body.repo.trim()) ? body.repo.trim().toLowerCase() : undefined
    const out = await (deps.handoff ?? addBrainHandoff)({
      title,
      prompt,
      noteId,
      reasoning,
      sourceTurnId,
      ...(repo ? { repo } : {}),
      ...(rawTaskId ? { taskId: rawTaskId } : {}),
    })
    return Response.json(out.body, {
      status: out.status,
      headers: out.body.replay ? { "Idempotent-Replayed": "true" } : undefined,
    })
  }
  deps.wiring.noteSideEffect?.("propose")
  const out = await deps.wiring.propose({ title, prompt, noteId, agent, reasoning, sourceTurnId, ...(rawTaskId ? { taskId: rawTaskId } : {}) })
  return Response.json(out.body, {
    status: out.status,
    headers: out.body.replay ? { "Idempotent-Replayed": "true" } : undefined,
  })
}

async function thread(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const q = str(body.q, QUERY_MAX)
  if (!q) return fail(400, "q required")
  const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), SEARCH_LIMIT_MAX) : 20
  const turns = searchThread(BRAIN_THREAD, q, limit).map((t) => {
    const text = brainText(t)
    return { id: t.id, role: t.role, at: new Date(t.createdAt).toISOString(), text: text.length > SEARCH_TEXT_MAX ? `${text.slice(0, SEARCH_TEXT_MAX - 1)}…` : text }
  })
  return Response.json({ ok: true, turns })
}

async function todo(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const text = str(body.text, TODO_MAX)
  if (!text) return fail(400, "text required")
  const noteId = str(body.noteId, NOTE_ID_MAX)
  if (!noteId) return fail(422, "no_project")
  const sourceTurnId = typeof body.sourceTurnId === "string" && TURN_ID.test(body.sourceTurnId) ? body.sourceTurnId : null
  if (!sourceTurnId) return fail(400, "sourceTurnId required")
  const due = body.due === undefined || body.due === null || body.due === "" ? null : typeof body.due === "string" && DAY.test(body.due) ? body.due : undefined
  if (due === undefined) return fail(400, "due must be YYYY-MM-DD")
  deps.wiring.noteSideEffect?.("todo")
  const out = await (deps.todo ?? addBrainTodo)({ text, noteId, due, sourceTurnId })
  return Response.json(out.body, { status: out.status })
}

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Verify a loopback lead-<repo> caller for `tell-brain`, `pr-update-branch` and `pr-resolve-conflicts`. */
function leadCallerTaskId(req: Request, deps: BrainRouteDeps): string | null {
  const origin = clientOrigin(req, peerOf(req))
  if (origin.transport !== "loopback") return null
  const taskId = req.headers.get("x-companion-task-id")?.trim() ?? ""
  const pid = req.headers.get("x-companion-pid")?.trim() ?? ""
  if (!taskId.startsWith(LEAD_PREFIX) || !pid) return null
  const sandboxed = req.headers.get("x-companion-sandbox") === "1"
  const found = deps.sessions().find((x) => x.taskId === taskId && (x.pid === pid || sandboxed))
  return found ? taskId : null
}

/** The brain's own workspaces + live session messaging (`list`, `close`, `send`, `tell-brain`). */
async function sessions(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  if (body.op === "tell-brain") {
    const leadTask = leadCallerTaskId(req, deps)
    const brainOk = !proposeRefusal(req, deps)
    if (!leadTask && !brainOk) return fail(403, "forbidden")
    const msg = str(body.message, PROMPT_MAX)
    if (!msg) return fail(400, "message required")
    if (brainOk && !leadTask) deps.wiring.noteSideEffect?.("sessions:tell-brain")
    const sender = leadTask ?? (str(body.sender, 64) ?? BRAIN_AGENT)
    relayToBrainThread(sender, msg)
    return Response.json({ ok: true, relayed: true, sender })
  }
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const workers = deps.workers ?? brainWorkers
  if (body.op === "list") {
    const s = await workers.survey()
    const liveSessions = deps.sessions().map((x) => ({
      key: x.key,
      sessionId: x.sessionId,
      taskId: x.taskId ?? null,
      label: x.label,
      title: x.title ?? null,
      cwd: x.cwd,
      agent: x.agent ?? "claude",
      waiting: !!x.waitingReasons?.length,
    }))
    return Response.json({ ok: true, sessions: s.sessions, mode: s.mode, liveSessions })
  }
  if (body.op === "send") {
    const target = str(body.target, 128)
    const msg = str(body.message, PROMPT_MAX)
    if (!target || !msg) return fail(400, "target and message required")
    const found = deps.sessions().find(
      (x) => x.taskId === target || x.key === target || x.sessionId === target || x.label === target,
    )
    if (!found) return fail(404, "session_not_found")
    const deliver = deps.deliverSession !== undefined ? deps.deliverSession : getBrainDeliver()
    if (!deliver) return fail(503, "deliver_unavailable")
    deps.wiring.noteSideEffect?.("sessions:send")
    const leadNote = found.taskId?.startsWith(LEAD_PREFIX)
      ? "\n(Do not send an ack or progress recap back to brain — only message brain when a PR is ready to merge/close or a real blocker/decision needs Jeremie.)"
      : ""
    const res = await deliver(`[from brain] ${msg}${leadNote}`, found.key)
    const out = await res.json().catch(() => ({})) as Record<string, unknown>
    return Response.json({ ok: res.ok && out.ok === true, target: found.taskId ?? found.label ?? found.key, key: found.key, ...out }, { status: res.ok ? 200 : res.status })
  }
  if (body.op === "close") {
    const ws = typeof body.workspaceId === "string" && WORKSPACE_ID.test(body.workspaceId) ? body.workspaceId : null
    if (!ws) return fail(400, "workspaceId required")
    deps.wiring.noteSideEffect?.("sessions:close")
    const out = await workers.close(ws)
    companionLog(`[brain] sessions close ${ws} → ${out.status} ${String(out.body.error ?? "ok")}`)
    return Response.json(out.body, { status: out.status })
  }
  return fail(400, "unknown_op")
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

/** bin/pr-close, pr-merge, pr-update-branch and pr-resolve-conflicts: the gate (wiring/brain-pr-*.ts) re-checks it all on GitHub and the notes DB. */
async function prAction(req: Request, deps: BrainRouteDeps, op: "pr-close" | "pr-merge" | "pr-update-branch" | "pr-resolve-conflicts"): Promise<Response> {
  const leadTask = op === "pr-update-branch" || op === "pr-resolve-conflicts" ? leadCallerTaskId(req, deps) : null
  const refused = leadTask ? null : proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const repo = typeof body.repo === "string" && REPO.test(body.repo) ? body.repo : null
  if (!repo) return fail(400, "repo must be owner/name")
  if (leadTask && !repo.toLowerCase().endsWith(`/${leadTask.slice(LEAD_PREFIX.length).toLowerCase()}`)) {
    return fail(403, "forbidden")
  }
  const pr = typeof body.pr === "number" && Number.isInteger(body.pr) && body.pr > 0 ? body.pr : null
  if (!pr) return fail(400, "pr must be a PR number")
  const reason = str(body.reason, REASON_MAX)
  if (!reason) return fail(400, `reason required (≤ ${REASON_MAX} chars)`)
  if (!leadTask) deps.wiring.noteSideEffect?.(op)
  const out = op === "pr-merge"
    ? await (deps.prMerge ?? mergeAgentPr)({ repo, pr, reason, signal: req.signal })
    : await (op === "pr-close" ? deps.prClose ?? closeDeadPr : op === "pr-resolve-conflicts" ? deps.prResolve ?? resolveAgentPrConflicts : deps.prUpdate ?? updateAgentPr)({ repo, pr, reason })
  companionLog(`[brain] ${op} ${repo}#${pr} → ${out.status} ${String(out.body.error ?? "ok")}`)
  return Response.json(out.body, { status: out.status })
}

/** bin/task-cancel: the gate (wiring/brain-task-cancel.ts) re-checks it all on the notes DB and the proposal row. */
async function taskCancel(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const task = typeof body.task === "string" && TASK_REF.test(body.task) ? body.task : null
  if (!task) return fail(400, "task must be an id or 8-char prefix")
  const reason = str(body.reason, REASON_MAX)
  if (!reason) return fail(400, `reason required (≤ ${REASON_MAX} chars)`)
  deps.wiring.noteSideEffect?.("task-cancel")
  const out = await (deps.taskCancel ?? cancelAgentTask)({ task, reason })
  companionLog(`[brain] task-cancel ${task.slice(0, 8)} → ${out.status} ${String(out.body.error ?? "ok")}`)
  return Response.json(out.body, { status: out.status })
}

/** bin/lead: the brain finds or starts a repo's lead. */
async function leadOp(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const repo = typeof body.repo === "string" && leadSlug(body.repo) && (deps.checkout ?? leadCheckout)(body.repo) ? body.repo : null
  if (!repo) return fail(404, "no_lead_for_repo")
  deps.wiring.noteSideEffect?.("lead")
  const out = await (deps.lead ?? brainLead).ensure(repo, `${LEAD_PREFIX}${repo}`)
  return Response.json(out, { status: out.ok ? 200 : 502 })
}

/** bin/deploy: the deployer (wiring/auto-deploy.ts) re-checks the repo allowlist and fast-forward itself. */
async function deploy(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  if (!isDeployRepo(body.repo)) return fail(400, "repo must be claude-companion or claude-config")
  const reason = str(body.reason, REASON_MAX)
  if (!reason) return fail(400, `reason required (≤ ${REASON_MAX} chars)`)
  const run = deps.deploy !== undefined ? deps.deploy : autoDeploy()?.deployNow ?? null
  if (!run) return fail(404, "deploy_disabled")
  deps.wiring.noteSideEffect?.("deploy")
  const out = await run(body.repo)
  companionLog(`[brain] deploy ${body.repo} (${reason.slice(0, 80)}) → ${out.ok ? out.result : out.error}`)
  const status = out.ok ? 200 : out.error === "deploy_in_progress" ? 409 : out.error === "repo_not_allowed" ? 400 : ["fetch_failed", "sync_start_failed", "restart_failed", "install_failed"].includes(out.error) ? 502 : 409
  return Response.json(out, { status })
}

const URL_MAX = 2_000

/** bin/media: lib/link-media.ts re-vets the URL (http(s), public host) and does the work. */
async function media(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const url = str(body.url, URL_MAX)
  if (!url) return Response.json({ ok: false, error: "bad_url", reason: "url required" }, { status: 400 })
  const out = await (deps.media ?? analyseLink)(url)
  return Response.json(out.body, { status: out.status })
}

/** bin/ui: server-side A2UI v1.0 macro expansion (`email`, `pr`, `patch`, `custom`). */
async function ui(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  deps.wiring.noteSideEffect?.("ui")
  const out = await executeA2UIMacro(body, {
    gh: deps.gh,
    prMerge: deps.prMerge,
    prClose: deps.prClose,
    deploy: deps.deploy,
    outbound: deps.outbound,
    emailSender: deps.emailSender,
    onUserTurn: (t) => deps.wiring.enqueue(t),
    engine: deps.a2uiEngine,
  })
  return Response.json(out.body, { status: out.status })
}

/** bin/load-skill: Stage 2 dynamic skill retrieval for un-injected skills (`POST /hooks/brain/load-skill`). */
async function loadSkillRoute(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const refused = proposeRefusal(req, deps)
  if (refused) return refused
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const out = (deps.loadSkill ?? runBrainLoadSkill)(body)
  if (!out.ok) return Response.json(out, { status: out.error === "skill_not_found" ? 404 : 400 })
  return Response.json(out, { status: 200 })
}

/** POST /api/brain/a2ui/action: deterministic bidirectional A2UI action router with actionKey idempotency. */
async function a2uiAction(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const out = await handleA2UIAction(body, {
    gh: deps.gh,
    prMerge: deps.prMerge,
    prClose: deps.prClose,
    deploy: deps.deploy,
    outbound: deps.outbound,
    emailSender: deps.emailSender,
    onUserTurn: (t) => deps.wiring.enqueue(t),
    engine: deps.a2uiEngine,
    signal: req.signal,
  })
  return Response.json(out.body, {
    status: out.status,
    headers: out.body.replay ? { "Idempotent-Replayed": "true" } : undefined,
  })
}

async function streamBrainTurn(req: Request, deps: BrainRouteDeps): Promise<Response> {
  const body = await readJson(req)
  if (!body) return fail(400, "bad_json")
  const prompt = str(body.prompt, PROMPT_MAX)
  if (!prompt) return fail(400, "prompt required")
  const sessionId = str(body.sessionId, 128) ?? deps.wiring.status().sessionKey ?? "brain_sse"
  return createBrainSseTurnResponse({ sessionId, prompt, transport: deps.streamTransport, signal: req.signal })
}

export function createBrainRoute(deps: BrainRouteDeps = { wiring: brainWiring, sessions: listSessions, enabled: brainEnabled }) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const p = url.pathname
    if (p === "/hooks/brain/propose") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return propose(req, deps, false)
    }
    if (p === "/hooks/brain/dispatch") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return propose(req, deps, true)
    }
    if (p === "/hooks/brain/thread") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return thread(req, deps)
    }
    if (p === "/hooks/brain/todo") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return todo(req, deps)
    }
    if (p === "/hooks/brain/sessions") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return sessions(req, deps)
    }
    if (p === "/hooks/brain/pr-close") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return prAction(req, deps, "pr-close")
    }
    if (p === "/hooks/brain/pr-merge") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return prAction(req, deps, "pr-merge")
    }
    if (p === "/hooks/brain/pr-update-branch") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return prAction(req, deps, "pr-update-branch")
    }
    if (p === "/hooks/brain/pr-resolve-conflicts") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return prAction(req, deps, "pr-resolve-conflicts")
    }
    if (p === "/hooks/brain/task-cancel") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return taskCancel(req, deps)
    }
    if (p === "/hooks/brain/lead") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return leadOp(req, deps)
    }
    if (p === "/hooks/brain/deploy") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return deploy(req, deps)
    }
    if (p === "/hooks/brain/media") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return media(req, deps)
    }
    if (p === "/hooks/brain/ui") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return ui(req, deps)
    }
    if (p === "/hooks/brain/load-skill") {
      if (req.method !== "POST") return fail(405, "method_not_allowed")
      if (!deps.enabled()) return fail(404, "brain_disabled")
      return loadSkillRoute(req, deps)
    }
    if (p !== "/api/brain" && !p.startsWith("/api/brain/")) return null
    if (!checkBearer(req)) return unauthorized()
    if (!deps.enabled()) return fail(404, "brain_disabled")
    if (p === "/api/brain" && req.method === "GET") return Response.json({ ok: true, brain: deps.wiring.status() })
    if (p === "/api/brain/trace" && req.method === "GET") {
      const raw = url.searchParams.get("since")
      const since = raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null
      return Response.json({ ok: true, rows: since === null || since === 0 ? latestRows() : rowsSince(since) })
    }
    if (p === "/api/brain/workers" && req.method === "GET") {
      const s = await (deps.workers ?? brainWorkers).survey()
      return Response.json({ ok: true, mode: s.mode, sessions: s.sessions, foreign: s.foreign })
    }
    if (req.method !== "POST") return fail(405, "method_not_allowed")
    if (p === "/api/brain/stream") return streamBrainTurn(req, deps)
    if (p === "/api/brain/a2ui/action") return a2uiAction(req, deps)
    if (p === "/api/brain/pause") return Response.json({ ok: true, brain: deps.wiring.pause() })
    if (p === "/api/brain/resume") return Response.json({ ok: true, brain: deps.wiring.resume() })
    if (p === "/api/brain/restart") {
      const st = await deps.wiring.restart()
      return st ? Response.json({ ok: true, brain: st }) : fail(409, "paused")
    }
    return fail(404, "not_found")
  }
}

export const brainRoute = createBrainRoute()
