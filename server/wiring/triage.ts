import type { Database } from "bun:sqlite"
import type { BodySnapshot } from "../lib/body"
import { type DispatchTask, type WriteOutcome, cancelDispatchTask, getDispatchTask, requeueTask, unblockTask } from "../lib/dispatch-tasks"
import { type InvestigationStore, isProblemState } from "../lib/body-investigate"
import type { ConsiderInput, RequestOutcome } from "../lib/body-investigate-engine"
import { systemOne } from "../lib/jev"
import { companionLog } from "../lib/log"
import { runBrainCall } from "../lib/orchestrator-brain"
import { appendTurn, getTask, listProposals } from "../lib/orchestrator-chat"
import { getChannel } from "../lib/orchestrator-channels"
import { db } from "../lib/orchestrator-db"
import { type Phrase, type ResolvingItem, type Severity, type SourceItem, type TriageOption, approvalSummary, clip, phrasePrompt } from "../lib/triage"
import { type ExecOutcome, type TriageEngine, type TriageResolverHook, createTriageEngine } from "../lib/triage-engine"
import { type GhFn, type PrReadiness, closePr, holdReason, mergePr, prReadiness, realGh } from "../lib/triage-pr"
import { type ApprovedPr, type BodyLookup, bodySources, prApprovals, prSources, proposalSource, queryPrRows, taskSource, taskSources } from "../lib/triage-sources"
import { type TriageStore, createTriageStore } from "../lib/triage-store"
import type { TripTriage } from "../lib/trip-triage"
import { type MyTaskTriage, createMyTaskTriage } from "../lib/mytask-triage"
import { tursoExec, tursoQuery } from "../lib/turso"
import { HOST_INFO, broadcast as wsBroadcast } from "../state"
import { bodySnapshot } from "./body"
import { bodyFixStore, bodyInvestigator, investigationStore } from "./body-investigate"
import { type DispatchWiring, dispatchWiring, onDispatchPolled } from "./dispatch"
import { onTaskEmitted, orchEmit, setTriageDigest, vetoAuto, writeCtx } from "./orchestrator"
import { approveProposal, rejectProposal } from "./proposals"
import { type LiveResolver, type ResolverLiveOpts, createLiveResolver, repoMapSelfCheck, startResolverDigest } from "./resolver"
import { ownsTrips, tripsLive } from "./trips"

// Brain triage, live instance (docs/orchestrator-triage-api.md): collectors
// over the poller snapshot, local proposals, Turso PR rows and the Body
// investigation store; one lean sonnet call per new/changed item; Jev for
// severity; every option executed through the existing guarded paths.

export const PR_ROWS_TTL_MS = 60_000
/** A PR card's mergeable state is re-read from GitHub at most this often (stale "safe to merge" cards). */
export const PR_READY_TTL_MS = 2 * 60_000
export const JEV_MIN_CONF = 0.7
const TRIAGE_MODEL = process.env.COMPANION_TRIAGE_MODEL || "sonnet"

export interface LiveTriageOpts {
  dispatch?: DispatchWiring
  db?: Database
  store?: TriageStore
  gh?: GhFn
  /** Raw model text for a prompt; default = the lean `claude -p` (never under `bun test`). */
  model?: (prompt: string) => Promise<string | null>
  /** Severity pre-classifier; default = Jev, off with COMPANION_TRIAGE_JEV=0. */
  severity?: (src: SourceItem, phrase: Phrase) => Promise<Severity | null>
  investigations?: () => InvestigationStore
  consider?: (input: ConsiderInput) => Promise<RequestOutcome>
  body?: BodySnapshot
  /** Trip cards (source `trip`); default = the live travel log on the store host, none elsewhere. */
  trips?: Pick<TripTriage, "collect" | "current" | "execute"> | null
  /** Overdue cards for Jeremie's own tasks (source `mytask`); default = live on the store host, none elsewhere. */
  mytasks?: Pick<MyTaskTriage, "collect" | "current" | "execute"> | null
  broadcast?: (frame: Record<string, unknown>) => void
  now?: () => number
  /** The Opus resolver; default = the live one on the store host (never under `bun test`), null = off. */
  resolver?: TriageResolverHook | null
  /** Build the live resolver anyway (tests), with seam overrides (e.g. a mock model). */
  resolverLive?: ResolverLiveOpts
}

function defaultModel(prompt: string): Promise<string | null> {
  if (process.env.NODE_ENV === "test") return Promise.resolve(null)
  return runBrainCall(TRIAGE_MODEL, prompt)
}

async function jevSeverity(src: SourceItem, phrase: Phrase): Promise<Severity | null> {
  if (src.source === "trip" || src.source === "mytask") return null
  if (process.env.COMPANION_TRIAGE_JEV?.trim() === "0" || process.env.NODE_ENV === "test") return null
  const out = await systemOne(
    { source: src.source, title: src.title, project: src.project, problem: phrase.problem, facts: src.facts },
    {
      severity: {
        type: "choice",
        instructions: "How soon must Jeremie (a one-person studio owner) act on this item from his work queue?",
        criteria: {
          urgent: "something is broken for a client or in production, money or a deadline is at stake, or a security fix waits",
          normal: "ordinary work waiting for a decision",
          low: "can wait days; housekeeping or an internal nice-to-have",
        },
      },
    },
  )
  if (!out.ok) return null
  const a = out.answers.severity
  return a?.type === "choice" && a.confidence >= JEV_MIN_CONF && (a.choice === "urgent" || a.choice === "normal" || a.choice === "low") ? a.choice : null
}

/** `by` = who acted: "triage" (Jeremie's tap) or "Opus" (the resolver). */
export function actionTurn(kind: string, t: DispatchTask, answer: string | null, by = "triage"): string {
  const who = `[${t.id.slice(0, 8)}] ${t.agent ?? "agent"} — ${t.title}`
  if (by === "Opus") {
    if (kind === "cancel") return `🤖 Opus cancelled ${who}`
    if (kind === "requeue") return `🤖 Opus requeued ${who}`
    return `🤖 Opus answered ${who}\nAnswer: ${(answer ?? "").slice(0, 500)}`
  }
  if (kind === "cancel") return `cancelled ${who} (${by})`
  if (kind === "requeue") return `requeued ${who} (${by})`
  return `unblocked ${who} (${by})\nAnswer: ${(answer ?? "").slice(0, 500)}`
}

export function createLiveTriage(opts: LiveTriageOpts = {}): TriageEngine {
  const dispatch = opts.dispatch ?? dispatchWiring
  const store = opts.store ?? createTriageStore(opts.db ?? db)
  const gh = opts.gh ?? realGh
  const model = opts.model ?? defaultModel
  const investigations = opts.investigations ?? investigationStore
  const consider = opts.consider ?? ((input: ConsiderInput) => bodyInvestigator().consider(input))
  const body = opts.body ?? bodySnapshot
  const now = opts.now ?? Date.now
  const trips = opts.trips !== undefined ? opts.trips : ownsTrips() && process.env.NODE_ENV !== "test" ? tripsLive().triage : null
  const mytasks = opts.mytasks !== undefined ? opts.mytasks
    : ownsTrips() && process.env.NODE_ENV !== "test" ? createMyTaskTriage({ query: tursoQuery, exec: tursoExec, log: companionLog, onWrite: () => wsBroadcast({ type: "tasks_changed", why: "triage" }) }) : null
  let prCache: { at: number; items: SourceItem[] } | null = null
  let approved: ResolvingItem[] = []
  const readyCache = new Map<string, { at: number; ready: PrReadiness | null }>()

  async function readyOf(url: string): Promise<PrReadiness | null> {
    const hit = readyCache.get(url)
    if (hit && now() - hit.at < PR_READY_TTL_MS) return hit.ready
    const ready = await prReadiness(gh, url).catch(() => null)
    readyCache.set(url, { at: now(), ready })
    return ready
  }

  /** The card carries GitHub's mergeable state now (facts only: the item version does not move). */
  async function withReadiness(src: SourceItem): Promise<SourceItem> {
    if (src.ref.source !== "pr") return src
    const ready = await readyOf(src.ref.prUrl)
    if (!ready) return src
    const hold = holdReason(ready)
    const mergeable = hold === "conflict" ? "CONFLICTING" : ready.mergeable
    return { ...src, facts: { ...src.facts, ...(mergeable ? { mergeable } : {}), ...(ready.checks !== "none" ? { checks: ready.checks } : {}) } }
  }

  async function approvedRow(a: ApprovedPr): Promise<ResolvingItem> {
    const ready = await readyOf(a.url)
    const reason = ready ? holdReason(ready) : a.reason
    const summary = approvalSummary(reason)
    return {
      id: a.id, source: "pr", title: clip(`${summary} · ${a.title}`, 120), project: a.project,
      resolver: { status: "queued", summary, model: "pr-shepherd", finishedAt: null },
      approval: { state: "approved_pending", reason, approvedAt: a.approvedAt, approvedHeadSha: a.approvedHeadSha },
    }
  }

  async function prItems(fresh = false): Promise<SourceItem[]> {
    if (!fresh && prCache && now() - prCache.at < PR_ROWS_TTL_MS) return prCache.items
    try {
      const rows = await queryPrRows(dispatch.query, await dispatch.columns())
      const items = await Promise.all(prSources(rows, now()).map(withReadiness))
      approved = await Promise.all(prApprovals(rows, now()).map(approvedRow))
      prCache = { at: now(), items }
      return items
    } catch (err) {
      if (fresh) throw err
      companionLog(`[triage] PR rows unavailable (${(err as Error)?.message ?? "error"}) — keeping the last list`)
      return prCache?.items ?? []
    }
  }

  async function bodyLookup(): Promise<BodyLookup> {
    const snap = await body.get().catch(() => null)
    const byId = new Map((snap?.components ?? []).map((c) => [c.id, c]))
    return {
      isProblem: (id) => (byId.has(id) ? isProblemState(byId.get(id)!.state) : null),
      criticality: (id) => (byId.get(id)?.criticality == null ? null : String(byId.get(id)!.criticality)),
    }
  }

  function proposalItem(taskId: string): SourceItem | null {
    const t = getTask(taskId)
    if (!t) return null
    const ch = getChannel(t.threadId)
    return proposalSource(t, { channelName: ch?.name ?? null, project: ch?.noteTitle ?? null, macFix: bodyFixStore.card(t.taskId)?.host === "mac" })
  }

  async function collect(): Promise<SourceItem[]> {
    const tasks = taskSources(dispatch.snapshot() ?? [], (t) => dispatch.threadIdFor(t))
    const proposals = listProposals().map((t) => proposalItem(t.taskId)).filter((s): s is SourceItem => !!s)
    const [prs, lookup, tripItems, mine] = await Promise.all([
      prItems(), bodyLookup(), trips ? trips.collect() : Promise.resolve([]), mytasks ? mytasks.collect() : Promise.resolve([]),
    ])
    return [...tasks, ...proposals, ...prs, ...bodySources(investigations(), now(), lookup), ...tripItems, ...mine]
  }

  async function current(src: SourceItem): Promise<SourceItem | null> {
    const ref = src.ref
    if (ref.source === "task") {
      const found = await getDispatchTask(dispatch.query, await dispatch.columns(), ref.taskId)
      if (!found) return null
      if (found.task.updatedAtRaw !== dispatch.cached(ref.taskId)?.updatedAtRaw) dispatch.applyLocal(found.task)
      return taskSource(found.task, dispatch.threadIdFor(found.task))
    }
    if (ref.source === "proposal") return proposalItem(ref.taskId)
    if (ref.source === "pr") return (await prItems(true)).find((p) => p.refId === src.refId) ?? null
    if (ref.source === "trip") return trips ? trips.current(src) : null
    if (ref.source === "mytask") return mytasks ? mytasks.current(src) : null
    return bodySources(investigations(), now(), await bodyLookup()).find((b) => b.refId === src.refId) ?? null
  }

  async function phrase(src: SourceItem): Promise<string | null> {
    if (src.source === "trip" || src.source === "mytask") return null // deterministic card (lib/triage.ts), no model call
    let item = src
    if (src.ref.source === "task") {
      const found = await getDispatchTask(dispatch.query, await dispatch.columns(), src.ref.taskId).catch(() => null)
      if (found?.description) item = { ...src, facts: { ...src.facts, description: clip(found.description, 1500) } }
    }
    return model(phrasePrompt(item))
  }

  async function taskWrite(kind: "answer" | "requeue" | "cancel", src: SourceItem, text: string | null, by: string): Promise<ExecOutcome> {
    if (src.ref.source !== "task") return { kind: "error", status: 400, error: "wrong_source" }
    const ctx = await writeCtx(dispatch, src.ref.channel)
    const out: WriteOutcome = kind === "cancel" ? await cancelDispatchTask(ctx, src.ref.taskId)
      : kind === "requeue" ? await requeueTask(ctx, src.ref.taskId)
      : await unblockTask(ctx, src.ref.taskId, text ?? "")
    if (!out.ok) {
      if (out.error !== "no_such_task") dispatch.applyLocal(out.task)
      return { kind: "stale", reason: out.error }
    }
    dispatch.applyLocal(out.task)
    const channelId = dispatch.threadIdFor(out.task)
    orchEmit(appendTurn("orchestrator", actionTurn(kind, out.task, text, by), out.task.id, channelId))
    if (kind === "cancel") vetoAuto(channelId)
    return { kind: "done", detail: { dispatchStatus: out.task.status } }
  }

  async function proposalAction(src: SourceItem, option: TriageOption): Promise<ExecOutcome> {
    if (src.ref.source !== "proposal") return { kind: "error", status: 400, error: "wrong_source" }
    const task = getTask(src.ref.taskId)
    if (!task || task.status !== "proposed") return { kind: "stale" }
    const mode = option.action.kind === "approve" ? option.action.mode : undefined
    const res = option.action.kind === "approve" ? await approveProposal(task, { mode }, dispatch) : rejectProposal(task, dispatch)
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok && json.ok !== false) return { kind: "done", detail: json }
    if (res.status === 409) return { kind: "stale", reason: String(json.error ?? "") }
    const { ok: _ok, error, ...extra } = json
    return { kind: "error", status: res.status, error: String(error ?? "approve_failed"), extra }
  }

  async function requeueBody(src: SourceItem): Promise<ExecOutcome> {
    if (src.ref.source !== "body") return { kind: "error", status: 400, error: "wrong_source" }
    const out = await consider({ componentId: src.ref.componentId, trigger: "manual", force: true })
    if (out.status === "started" || out.status === "forwarded" || out.status === "pending_host") return { kind: "done", detail: { investigation: out.status, id: out.id ?? null } }
    if (out.status === "duplicate") return { kind: "stale", reason: "an investigation is already running" }
    return { kind: "error", status: 409, error: `investigation_${out.status}`, extra: out.reason ? { reason: out.reason } : {} }
  }

  async function prAction(src: SourceItem, kind: "merge" | "close_pr", by: string): Promise<ExecOutcome> {
    if (src.ref.source !== "pr") return { kind: "error", status: 400, error: "wrong_source" }
    const target = { taskId: src.ref.taskId, prUrl: src.ref.prUrl, number: src.ref.number }
    const deps = { gh, exec: dispatch.exec, host: HOST_INFO.name }
    const out = kind === "merge" ? await mergePr(deps, target) : await closePr(deps, target)
    if (out.kind === "queued") {
      prCache = null
      readyCache.delete(target.prUrl)
      const cached = dispatch.cached(target.taskId)
      const channelId = cached ? dispatch.threadIdFor(cached) : "general"
      const reason = (out.detail.reason as Parameters<typeof approvalSummary>[0]) ?? null
      orchEmit(appendTurn("orchestrator", `${by === "Opus" ? "🤖 Opus " : ""}approved the merge of ${src.ref.repo}#${target.number} (${by}) — ${approvalSummary(reason).replace(/^Approved — /, "")}\n${target.prUrl}`, target.taskId, channelId))
    }
    if (out.kind === "done") {
      prCache = null
      const cached = dispatch.cached(target.taskId)
      const channelId = cached ? dispatch.threadIdFor(cached) : "general"
      orchEmit(appendTurn("orchestrator", `${by === "Opus" ? "🤖 Opus " : ""}${kind === "merge" ? "merged" : "closed"} ${src.ref.repo}#${target.number}${by === "Opus" ? "" : ` (${by})`}\n${target.prUrl}`, target.taskId, channelId))
      void dispatch.poll()
    }
    return out
  }

  async function execute(src: SourceItem, option: TriageOption, text: string | null, by = "triage"): Promise<ExecOutcome> {
    const a = option.action
    switch (a.kind) {
      case "answer": return taskWrite("answer", src, a.text, by)
      case "answer_custom": return taskWrite("answer", src, text, by)
      case "requeue": return src.ref.source === "body" ? requeueBody(src) : taskWrite("requeue", src, null, by)
      case "cancel": return taskWrite("cancel", src, null, by)
      case "approve":
        if (src.ref.source === "mytask") return mytasks ? mytasks.execute(src, option) : { kind: "error", status: 400, error: "wrong_source" }
        return proposalAction(src, option)
      case "reject": return proposalAction(src, option)
      case "merge":
      case "close_pr": return prAction(src, a.kind, by)
      case "open_url": return { kind: "done", detail: { url: a.url } }
      case "snooze": return { kind: "done" }
      case "classify":
      case "classify_custom": return trips ? trips.execute(src, option, text) : { kind: "error", status: 400, error: "wrong_source" }
      case "ask_opus": return { kind: "error", status: 409, error: "resolver_disabled" } // the engine handles it before execute
    }
  }

  let engine: TriageEngine | null = null
  // A finished run re-collects (its action moved the source); a start only re-renders.
  const onChange = (finished: boolean) => void (finished ? engine?.refresh() : engine?.render())
  let resolver: TriageResolverHook | null = opts.resolver ?? null
  if (opts.resolverLive) {
    resolver = createLiveResolver({ dispatch, gh, execute, onChange, ...opts.resolverLive }).engine
  } else if (opts.resolver === undefined && ownsTrips() && process.env.NODE_ENV !== "test") {
    liveResolver = createLiveResolver({ dispatch, gh, execute, onChange })
    resolver = liveResolver.engine
  }
  engine = createTriageEngine({
    collect, current, phrase, execute, store, resolver,
    severity: opts.severity ?? jevSeverity,
    pending: () => approved,
    broadcast: opts.broadcast ?? wsBroadcast,
    now, log: companionLog,
  })
  return engine
}

let liveResolver: LiveResolver | null = null

let live: TriageEngine | null = null
/** The wired instance (built on first use). */
export function triageEngine(): TriageEngine {
  live ??= createLiveTriage()
  return live
}

export const TRIAGE_TICK_MS = 60_000

/** Boot (cli.ts): recompute after every dispatch poll, proposal change and minute; feed the brain digest. */
export function startTriage(): () => void {
  const engine = triageEngine()
  repoMapSelfCheck(!!liveResolver)
  const offPoll = onDispatchPolled(() => void engine.refresh())
  const offTask = onTaskEmitted(() => void engine.refresh())
  setTriageDigest(() => engine.digest())
  // A new trip guess or a human answer (phone PATCH included) re-collects at once.
  const t = ownsTrips() ? tripsLive() : null
  const offTrips = t ? [t.triage.onGuess(() => void engine.refresh()), t.service.onChange(() => void engine.refresh())] : []
  const offDigest = liveResolver ? startResolverDigest(liveResolver.store) : () => {}
  const tick = setInterval(() => void engine.refresh(), TRIAGE_TICK_MS)
  ;(tick as unknown as { unref?: () => void }).unref?.()
  void engine.refresh()
  return () => { offPoll(); offTask(); offDigest(); for (const off of offTrips) off(); setTriageDigest(null); clearInterval(tick) }
}
