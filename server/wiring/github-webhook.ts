import {
  type GithubIssueDispatch,
  allowedWebhookActors,
  allowedWebhookOwners,
  buildGithubIssuePrompt,
  parseGithubWebhookEvent,
} from "../lib/github-webhook"
import { BRAIN_THREAD } from "../lib/brain"
import { approveUrl } from "../lib/dispatch-tasks"
import { createGithubWebhookStore, type GithubWebhookJob, type GithubWebhookStore } from "../lib/github-webhook-store"
import { db } from "../lib/orchestrator-db"
import { appendTurn } from "../lib/orchestrator-chat"
import { companionLog } from "../lib/log"
import { type GhFn, realGh } from "../lib/triage-pr"
import type { SupervisedTaskSnapshot } from "../lib/worker-supervisor"
import { HOST_INFO } from "../state"
import { workerMcp, workerSupervisor } from "./worker-mcp"
import { defaultGithubWebhookTasks } from "./github-webhook-tasks"
import { orchEmit } from "./orchestrator"

const PR_CAP = 3

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
  listHostTasks?: (host: string) => Promise<SupervisedTaskSnapshot[]>
  callMcpDispatch?: (args: Record<string, unknown>) => Promise<McpToolOutcome>
  allowedOwners?: ReadonlySet<string>
  allowedActors?: ReadonlySet<string>
  store?: GithubWebhookStore
  tasks?: ReturnType<typeof defaultGithubWebhookTasks>
  brainReceipt?: (text: string, taskId: string) => void
  autoDrain?: boolean
}

export type GithubWebhookResult =
  | { ok: true; status: "ping"; hookId: number | null; repo: string | null }
  | { ok: true; status: "duplicate_delivery"; deliveryId: string }
  | { ok: true; status: "ignored"; reason: string; repo?: string; issueNumber?: number }
  | { ok: true; status: "queued" | "already_dispatched"; taskId: string; repo: string; issueNumber: number; link: string }
  | { ok: false; status: "dispatch_failed"; httpStatus: number; error: string; taskId: string }

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
  const store = deps.store ?? createGithubWebhookStore(db)
  const tasks = deps.tasks ?? defaultGithubWebhookTasks(localHost, env)
  const listLocalTasks = deps.listLocalTasks ?? (() => workerSupervisor.listTasks())
  const callMcpDispatch = deps.callMcpDispatch ?? defaultCallMcpDispatch
  const brainReceipt = deps.brainReceipt ?? ((text: string, id: string) => {
    if (!db.query("SELECT 1 FROM orchestrator_turns WHERE thread_id = ? AND task_id = ? AND text = ?").get(BRAIN_THREAD, id, text)) {
      orchEmit(appendTurn("orchestrator", text, id, BRAIN_THREAD))
    }
  })
  const listHostTasks = deps.listHostTasks ?? (async (host: string) => {
    if (host === "local" || host === localHost) return listLocalTasks()
    const rpc = await workerMcp.callTool(1, "list_tasks", { host })
    const data = (rpc.result as { structuredContent?: { ok?: boolean; tasks?: SupervisedTaskSnapshot[] } } | undefined)?.structuredContent
    if (!data?.ok || !Array.isArray(data.tasks)) throw new Error("peer_status_unavailable")
    return data.tasks
  })
  const hostOf = (req: GithubIssueDispatch): string => req.targetHost === "auto" ? env.COMPANION_WEBHOOK_DEFAULT_HOST?.trim() || "local" : req.targetHost
  let draining: Promise<void> | null = null

  async function receipts(job: GithubWebhookJob): Promise<void> {
    const { req, taskId, state, reason, generation } = job
    const link = approveUrl(taskId)
    const text = `GitHub issue ${req.repoFull}#${req.issueNumber}: ${state} (${reason}). TASK ${taskId} — ${link} — ${req.url} (dispatch ${generation})`
    if (!job.brainReceipt) { brainReceipt(text, taskId); store.brainReceipt(taskId) }
    if (job.issueReceipt) return
    const marker = `<!-- companion:${taskId}:${generation}:${state} -->`
    const found = await gh(["api", `repos/${req.repoFull}/issues/${req.issueNumber}/comments`, "--paginate", "--jq", `.[] | select(.body | contains("${marker}")) | .id`])
    if (found.code !== 0) throw new Error("issue_comment_lookup_failed")
    if (!found.stdout.trim()) {
      const comment = `${marker}\nBuilder ${state} (${reason}). Task [${taskId}](${link}).`
      const out = await gh(["issue", "comment", String(req.issueNumber), "--repo", req.repoFull, "--body", comment])
      if (out.code !== 0) throw new Error("issue_comment_failed")
    }
    store.issueReceipt(taskId)
  }

  async function dispatch(job: GithubWebhookJob): Promise<void> {
    const req = job.req
    const host = hostOf(req)
    const snapshots = await listHostTasks(host)
    const existing = snapshots.find((t) => t.taskId === req.taskId)
    if (existing && (existing.status === "running" || !req.forceRedispatch || job.state !== "queued")) {
      store.state(req.taskId, "dispatched", `worker_${existing.status}`)
      return
    }
    if (job.state !== "queued") {
      // A lost response can hide a started worker. Never repeat it or fall back to a different host.
      if (job.state === "starting") store.state(req.taskId, "uncertain", "dispatch_acceptance_unknown")
      return
    }
    const prepared = await tasks.prepare(req)
    if (prepared.settled) { store.state(req.taskId, "dispatched", "task_already_started"); return }
    const prs = await gh(["pr", "list", "--repo", req.repoFull, "--state", "open", "--limit", "100", "--json", "headRefName"])
    if (prs.code !== 0) throw new Error("pr_capacity_unavailable")
    let raw: unknown
    try { raw = JSON.parse(prs.stdout) } catch { throw new Error("pr_capacity_unavailable") }
    if (!Array.isArray(raw) || raw.some((p: unknown) => !p || typeof p !== "object" || !("headRefName" in p) || typeof p.headRefName !== "string")) throw new Error("pr_capacity_unavailable")
    const branches = new Set((raw as Array<{ headRefName: string }>).map((p) => p.headRefName))
    const reserved = new Set([...snapshots, ...listLocalTasks()].filter((t) => t.repo.toLowerCase() === req.repo.toLowerCase() && t.status === "running" && !branches.has(t.branch)).map((t) => t.taskId))
    for (const pending of store.jobs()) if (pending.req.repoFull === req.repoFull && ["starting", "uncertain"].includes(pending.state) && !branches.has(`dispatch/${pending.taskId}`)) reserved.add(pending.taskId)
    if (raw.length + reserved.size >= PR_CAP && !branches.has(`dispatch/${req.taskId}`)) {
      store.state(req.taskId, "queued", "pr_cap")
      return
    }
    // Commit intent before any worker call; a crash here is conservative (uncertain), never a second start.
    store.state(req.taskId, "starting", "dispatching")
    if (!await tasks.start(req.taskId)) { store.state(req.taskId, "dispatched", "task_already_started"); return }
    const out = await callMcpDispatch({ task_id: req.taskId, repo: req.repo, prompt: buildGithubIssuePrompt(req),
      title: `[repo:${req.repo}] Issue #${req.issueNumber}`, family: req.family,
      ...(req.model ? { model: req.model } : {}), mode: "auto", host, claim: prepared.claim, require_claim: true })
    if (!out.ok) {
      if (out.status === 409 && ["task_already_running", "task_dispatch_in_progress"].includes(out.error ?? "")) {
        store.state(req.taskId, "dispatched", "worker_already_running")
      } else if (out.status && out.status >= 400 && out.status < 600) {
        // A supervisor refusal explicitly means no worker was started. Transport failures have no status here.
        await tasks.defer(req.taskId)
        store.state(req.taskId, "queued", "worker_refused")
      } else {
        store.state(req.taskId, "uncertain", "dispatch_acceptance_unknown")
      }
      return
    }
    store.state(req.taskId, "dispatched", `worker_on_${out.host ?? host}`)
    log(`[github-webhook] dispatched ${req.taskId} for ${req.repoFull}#${req.issueNumber}`)
  }

  function drain(): Promise<void> {
    if (draining) return draining
    draining = (async () => {
      for (const job of store.jobs()) {
        try {
          if (job.state !== "dispatched") await dispatch(job)
        } catch {
          const current = store.get(job.taskId)!
          store.state(job.taskId, current.state === "starting" ? "uncertain" : current.state, current.state === "starting" ? "dispatch_acceptance_unknown" : "dependency_unavailable")
          log(`[github-webhook] deferred ${job.taskId}: ${store.get(job.taskId)!.reason}`)
        }
        try { await receipts(store.get(job.taskId)!) } catch { log(`[github-webhook] receipt pending for ${job.taskId}`) }
      }
    })().finally(() => { draining = null })
    return draining
  }

  return {
    drain,
    async handleEvent(eventName: string | null, deliveryId: string | null, payload: unknown): Promise<GithubWebhookResult> {
      const cleanDelivery = deliveryId?.trim()
      if (!cleanDelivery || cleanDelivery.length > 200) return { ok: false, status: "dispatch_failed", httpStatus: 400, error: "delivery_id_required", taskId: "" }
      const parsed = parseGithubWebhookEvent(eventName, payload, {
        allowedOwners: deps.allowedOwners ?? allowedWebhookOwners(env), allowedActors: deps.allowedActors ?? allowedWebhookActors(env),
      })
      const accepted = store.accept(cleanDelivery, parsed.kind === "dispatch" ? parsed.req : undefined)
      if (accepted === "duplicate_delivery") return { ok: true, status: accepted, deliveryId: cleanDelivery }
      if (parsed.kind === "ping") {
        log(`[github-webhook] ping received${parsed.repo ? ` for ${parsed.repo}` : ""}`)
        return { ok: true, status: "ping", hookId: parsed.hookId, repo: parsed.repo }
      }
      if (parsed.kind === "ignored") {
        log(`[github-webhook] ignored ${parsed.repo ?? "event"}#${parsed.issueNumber ?? ""}: ${parsed.reason}`)
        return { ok: true, status: "ignored", reason: parsed.reason, ...(parsed.repo ? { repo: parsed.repo } : {}), ...(parsed.issueNumber ? { issueNumber: parsed.issueNumber } : {}) }
      }
      if (deps.autoDrain !== false) void drain().catch(() => log("[github-webhook] queue drain failed"))
      return { ok: true, status: accepted === "queued" ? "queued" : "already_dispatched", taskId: parsed.req.taskId,
        repo: parsed.req.repoFull, issueNumber: parsed.req.issueNumber, link: approveUrl(parsed.req.taskId) }
    },
  }
}

export type GithubWebhookDispatcher = ReturnType<typeof createGithubWebhookDispatcher>
export const githubWebhookDispatcher = createGithubWebhookDispatcher()

export function startGithubWebhookQueue(): void {
  if (process.env.NODE_ENV === "test") return
  const tick = () => void githubWebhookDispatcher.drain().catch(() => companionLog("[github-webhook] queue drain failed"))
  tick()
  setInterval(tick, 15_000).unref()
}
