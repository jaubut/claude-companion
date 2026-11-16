import {
  type GithubIssueDispatch,
  type GithubWebhookAction,
  buildGithubIssuePrompt,
  parseGithubWebhookEvent,
} from "../lib/github-webhook"
import { companionLog } from "../lib/log"
import { type GhFn, realGh } from "../lib/triage-pr"
import type { DispatchTaskInput, SupervisedTaskSnapshot } from "../lib/worker-supervisor"
import { HOST_INFO } from "../state"
import { workerMcp, workerSupervisor } from "./worker-mcp"

const MAX_RECENT_DELIVERIES = 500

export interface McpToolOutcome {
  ok: boolean
  host?: string
  task?: SupervisedTaskSnapshot
  error?: string
  status?: number
}

export interface GithubWebhookDispatcherDeps {
  localHost?: string
  env?: NodeJS.ProcessEnv
  gh?: GhFn
  log?: (msg: string) => void
  listLocalTasks?: () => SupervisedTaskSnapshot[]
  dispatchLocal?: (input: DispatchTaskInput) => Promise<{ ok: true; task: SupervisedTaskSnapshot } | { ok: false; status: number; error: string }>
  callMcpDispatch?: (args: Record<string, unknown>) => Promise<McpToolOutcome>
  allowedOwners?: ReadonlySet<string>
  commentOnIssue?: boolean
}

export type GithubWebhookResult =
  | { ok: true; status: "ping"; hookId: number | null; repo: string | null }
  | { ok: true; status: "duplicate_delivery"; deliveryId: string }
  | { ok: true; status: "ignored"; reason: string; repo?: string; issueNumber?: number }
  | { ok: true; status: "already_running"; taskId: string; repo: string; issueNumber: number; host: string }
  | { ok: true; status: "already_completed"; taskId: string; repo: string; issueNumber: number; prUrl: string | null }
  | {
    ok: true
    status: "dispatched"
    taskId: string
    repo: string
    issueNumber: number
    host: string
    fallbackFrom?: string
    family: string
    model: string | null
    branch: string
  }
  | { ok: false; status: "dispatch_failed"; httpStatus: number; error: string; taskId: string }

function isPeerUnavailableError(err: string | undefined): boolean {
  if (!err) return false
  return err.startsWith("peer_unreachable") || err.startsWith("peer_not_configured") || /^peer_http_5\d\d$/.test(err)
}

async function defaultCallMcpDispatch(args: Record<string, unknown>): Promise<McpToolOutcome> {
  const rpc = await workerMcp.callTool(1, "dispatch_task", args)
  if (rpc.error) return { ok: false, error: rpc.error.message || "rpc_error", status: 500 }
  const res = rpc.result as { structuredContent?: Record<string, unknown> } | undefined
  const sc = res?.structuredContent
  if (!sc) return { ok: false, error: "empty_mcp_result", status: 500 }
  return {
    ok: sc.ok === true,
    host: typeof sc.host === "string" ? sc.host : undefined,
    task: sc.task && typeof sc.task === "object" ? (sc.task as SupervisedTaskSnapshot) : undefined,
    error: typeof sc.error === "string" ? sc.error : undefined,
    status: typeof sc.status === "number" ? sc.status : undefined,
  }
}

export function createGithubWebhookDispatcher(deps: GithubWebhookDispatcherDeps = {}) {
  const localHost = deps.localHost ?? (HOST_INFO.name || "local")
  const env = deps.env ?? process.env
  const gh = deps.gh ?? realGh
  const log = deps.log ?? companionLog
  const listLocalTasks = deps.listLocalTasks ?? (() => workerSupervisor.listTasks())
  const dispatchLocal = deps.dispatchLocal ?? ((input: DispatchTaskInput) => workerSupervisor.dispatchTask(input))
  const callMcpDispatch = deps.callMcpDispatch ?? defaultCallMcpDispatch
  const commentEnabled = deps.commentOnIssue ?? true
  const recentDeliveries = new Set<string>()

  function rememberDelivery(id: string | null): void {
    if (!id) return
    if (recentDeliveries.has(id)) recentDeliveries.delete(id)
    recentDeliveries.add(id)
    while (recentDeliveries.size > MAX_RECENT_DELIVERIES) {
      const oldest = recentDeliveries.values().next().value
      if (oldest === undefined) break
      recentDeliveries.delete(oldest)
    }
  }

  function postDispatchComment(req: GithubIssueDispatch, host: string, taskId: string, model: string | null): void {
    if (!commentEnabled) return
    const lines = [
      `Dispatched headless **${req.family}** worker on \`${host}\`.`,
      `- Task ID: \`${taskId}\``,
      `- Branch: \`dispatch/${taskId}\``,
      ...(model ? [`- Model: \`${model}\``] : []),
    ]
    void gh(["issue", "comment", String(req.issueNumber), "--repo", req.repoFull, "--body", lines.join("\n")])
      .then((r) => {
        if (r.code !== 0) log(`[github-webhook] issue comment failed for ${req.repoFull}#${req.issueNumber}: ${r.stderr.slice(0, 160)}`)
      })
      .catch((err) => {
        log(`[github-webhook] issue comment error for ${req.repoFull}#${req.issueNumber}: ${(err as Error)?.message ?? String(err)}`)
      })
  }

  async function dispatch(req: GithubIssueDispatch): Promise<GithubWebhookResult> {
    const existing = listLocalTasks().find((t) => t.taskId === req.taskId && t.repo.toLowerCase() === req.repo.toLowerCase())
    if (existing?.status === "running") {
      return { ok: true, status: "already_running", taskId: req.taskId, repo: req.repoFull, issueNumber: req.issueNumber, host: localHost }
    }
    if (existing?.status === "completed" && existing.prUrl && !req.forceRedispatch) {
      return { ok: true, status: "already_completed", taskId: req.taskId, repo: req.repoFull, issueNumber: req.issueNumber, prUrl: existing.prUrl }
    }

    const defaultEnvHost = env.COMPANION_WEBHOOK_DEFAULT_HOST?.trim().toLowerCase()
    const defaultHost = defaultEnvHost === "zettlab" || defaultEnvHost === "mac" ? defaultEnvHost : "local"
    const requestedHost = req.targetHost === "auto" ? defaultHost : req.targetHost
    const prompt = buildGithubIssuePrompt(req)
    const title = `#${req.issueNumber} ${req.title}`.slice(0, 200)

    let out = await callMcpDispatch({
      task_id: req.taskId,
      repo: req.repo,
      prompt,
      title,
      family: req.family,
      ...(req.model ? { model: req.model } : {}),
      mode: "auto",
      host: requestedHost,
    })

    let fallbackFrom: string | undefined
    if (!out.ok && requestedHost !== "local" && isPeerUnavailableError(out.error)) {
      log(`[github-webhook] peer ${requestedHost} unavailable (${out.error}); falling back to local (${localHost}) for ${req.repoFull}#${req.issueNumber}`)
      fallbackFrom = requestedHost
      const localOut = await dispatchLocal({
        taskId: req.taskId,
        repo: req.repo,
        prompt,
        title,
        family: req.family,
        ...(req.model ? { model: req.model } : {}),
        mode: "auto",
      })
      out = localOut.ok
        ? { ok: true, host: localHost, task: localOut.task }
        : { ok: false, error: localOut.error, status: localOut.status }
    }

    if (!out.ok) {
      if (out.status === 409 && out.error === "task_already_running") {
        return { ok: true, status: "already_running", taskId: req.taskId, repo: req.repoFull, issueNumber: req.issueNumber, host: requestedHost }
      }
      log(`[github-webhook] dispatch failed for ${req.repoFull}#${req.issueNumber}: ${out.error ?? "unknown_error"}`)
      return {
        ok: false,
        status: "dispatch_failed",
        httpStatus: out.status && out.status >= 400 ? out.status : 500,
        error: out.error ?? "dispatch_failed",
        taskId: req.taskId,
      }
    }

    const dispatchedHost = out.host ?? (fallbackFrom ? localHost : requestedHost === "local" ? localHost : requestedHost)
    const model = out.task?.model ?? req.model ?? null
    log(`[github-webhook] dispatched ${req.taskId} for ${req.repoFull}#${req.issueNumber} on ${dispatchedHost} (${req.family})`)
    postDispatchComment(req, dispatchedHost, req.taskId, model)

    return {
      ok: true,
      status: "dispatched",
      taskId: req.taskId,
      repo: req.repoFull,
      issueNumber: req.issueNumber,
      host: dispatchedHost,
      ...(fallbackFrom ? { fallbackFrom } : {}),
      family: req.family,
      model,
      branch: `dispatch/${req.taskId}`,
    }
  }

  return {
    async handleEvent(eventName: string | null, deliveryId: string | null, payload: unknown): Promise<GithubWebhookResult> {
      const cleanDelivery = deliveryId?.trim() || null
      if (cleanDelivery && recentDeliveries.has(cleanDelivery)) {
        return { ok: true, status: "duplicate_delivery", deliveryId: cleanDelivery }
      }

      const parsed: GithubWebhookAction = parseGithubWebhookEvent(eventName, payload, {
        ...(deps.allowedOwners ? { allowedOwners: deps.allowedOwners } : {}),
      })
      if (parsed.kind === "ping") {
        rememberDelivery(cleanDelivery)
        log(`[github-webhook] ping received${parsed.repo ? ` for ${parsed.repo}` : ""}`)
        return { ok: true, status: "ping", hookId: parsed.hookId, repo: parsed.repo }
      }
      if (parsed.kind === "ignored") {
        rememberDelivery(cleanDelivery)
        return { ok: true, status: "ignored", reason: parsed.reason, ...(parsed.repo ? { repo: parsed.repo } : {}), ...(parsed.issueNumber ? { issueNumber: parsed.issueNumber } : {}) }
      }

      const res = await dispatch(parsed.req)
      if (res.ok) rememberDelivery(cleanDelivery)
      return res
    },
  }
}

export type GithubWebhookDispatcher = ReturnType<typeof createGithubWebhookDispatcher>
export const githubWebhookDispatcher = createGithubWebhookDispatcher()
