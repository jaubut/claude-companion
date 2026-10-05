import type { InvestigationResult } from "./body-investigate"
import type { ReadonlyRun } from "./readonly-claude"
import {
  FIX_RUN_MS, type OutcomeNote, type Plan, type ResolverOutput, RESOLVER_CONTEXT_MAX, RETRY_PREFILL, RETRY_RE, TRANSIENT_REASON, cardSummary, decide,
  outcomePhrase, parseResolverOutput, preparedPhrase,
} from "./resolver"
import type { Job, WorkResult } from "./resolver-engine"
import type { FixOutcome } from "./resolver-fix"
import { type ResolverContext, buildResolverPrompt } from "./resolver-prompt"
import { type Phrase, type SourceItem, type TriageAction, clip, fallbackPhrase } from "./triage"
import type { ExecOutcome } from "./triage-engine"

// One resolver run over injected seams (wiring/resolver.ts is the live set):
// gather evidence → ONE read-only Opus analysis → lib/resolver.ts decide() →
// act through the guarded seams (or, in a dry run, only report the plan) →
// resolved (hidden) | prepared (Opus's card) | failed (the normal card).

export type BodyOutcome = { ok: true; result: InvestigationResult } | { ok: false; error: string }

export interface WorkSeams {
  gather(src: SourceItem): Promise<ResolverContext>
  analyze(prompt: string, ctx: ResolverContext, model: string, timeoutMs: number): Promise<ReadonlyRun>
  /** Body: the deeper read-only investigation (local components). */
  investigate(src: SourceItem, model: string, timeoutMs: number): Promise<BodyOutcome>
  /** Body: post the result in #Body (a proposal when it has a fix); returns the proposal id. */
  applyBody(src: SourceItem, result: InvestigationResult, model: string): Promise<string | null>
  /** The triage executor (the guarded paths), `by` names the actor in turns. */
  execute(src: SourceItem, action: TriageAction, by: string): Promise<ExecOutcome>
  comment(src: SourceItem, body: string): Promise<boolean>
  /** `attempt` = the resolver run id: the peer's idempotency key with the item id (a Mac-only repo runs on the Mac). */
  fix(src: SourceItem, ctx: ResolverContext, instructions: string, model: string, timeoutMs: number, attempt?: number): Promise<FixOutcome>
  /** PR: hand it back to the shepherd (`pr:unpark`). */
  unpark(src: SourceItem, reason: string): Promise<void>
  /** Proposal: reject it and file the rescoped one (never resolved again); returns the new proposal id. */
  revise(src: SourceItem, title: string, prompt: string, why: string): Promise<string | null>
  /** agent_activity `resolver:<action>`. */
  record(src: SourceItem, action: string, summary: string, meta: Record<string, unknown>): Promise<void>
  /** An orchestrator turn in the item's channel. */
  turn(src: SourceItem, text: string): void
  /** Loop guard: the trailing run of identical failures of this action on this item (recent), or null. */
  failures?(src: SourceItem, action: string): { count: number; error: string } | null
  /** Loop guard: one attempt of an action (error = null: it went through). */
  attempt?(src: SourceItem, action: string, error: string | null): void
  now(): number
  log(msg: string): void
}

/** What a run decided (the dry-run table and the logs). */
export interface PlanReport {
  src: SourceItem
  out: ResolverOutput | null
  plan: Plan | null
  /** One line: what it did / would do. */
  verdict: string
  error?: string
}

export const BY = "Opus"

const what = (p: Plan): string => (p.kind === "card" ? "prepare a card" : p.action.kind === "answer" ? `answer: "${clip(p.action.text, 120)}"`
  : p.action.kind === "close_pr" ? `close the PR (${p.action.reason})` : p.action.kind === "reject" ? `reject (${p.action.reason})`
    : p.action.kind === "fix" ? `fix run on the PR branch${p.then === "unpark" ? " + hand back to the shepherd" : ", then a card"}`
      : p.action.kind)

export function createResolverWork(seams: WorkSeams, onPlan?: (r: PlanReport) => void) {
  const remaining = (job: Job) => Math.max(1_000, job.deadline - seams.now())
  const late = (job: Job) => seams.now() > job.deadline
  const meta = (job: Job, out: ResolverOutput | null, extra: Record<string, unknown> = {}) => ({
    item: job.run.itemId, model: job.model, autonomy: job.autonomy, ...(job.instruction ? { instruction: job.instruction } : {}),
    ...(out ? { confidence: out.confidence, category: out.category, why: out.why } : {}), ...extra,
  })

  async function prepared(
    job: Job, out: ResolverOutput, sensitive: boolean, reason: string, extra: string[] = [], action = "prepared",
    note: OutcomeNote = { outcome: "planned", headline: "" },
  ): Promise<WorkResult> {
    const src = job.src
    const phrase = outcomePhrase(src, preparedPhrase(src, out, { sensitive }, extra), note)
    // The outcome first: a card after an action never reads as Opus's plan.
    const summary = note.outcome === "planned" ? cardSummary(src, out, sensitive) : note.headline
    if (!job.dryRun) await seams.record(src, `resolver:${action}`, summary, meta(job, out, { reason, outcome: note.outcome }))
    return { kind: "prepared", phrase, summary, action, reason, outcome: note.outcome }
  }

  async function failed(job: Job, summary: string): Promise<WorkResult> {
    if (!job.dryRun) await seams.record(job.src, "resolver:failed", summary, meta(job, null)).catch(() => {})
    return { kind: "failed", summary }
  }

  async function body(job: Job): Promise<WorkResult> {
    const src = job.src
    const res = await seams.investigate(src, job.model, remaining(job))
    if (!res.ok) {
      onPlan?.({ src, out: null, plan: null, verdict: "fall through (investigation failed)", error: res.error })
      return failed(job, `Opus investigation failed: ${res.error}`)
    }
    const r = res.result
    const kind = r.recommendedFix ? "propose" : "explain"
    const summary = clip(`${r.rootCause}${r.recommendedFix ? ` — fix proposed: ${r.recommendedFix.summary}` : ""}`, 200)
    onPlan?.({ src, out: null, plan: null, verdict: `${kind === "propose" ? "post a #Body fix proposal" : "post the explanation in #Body"}: ${summary}` })
    if (job.dryRun) {
      const phrase: Phrase = { ...fallbackPhrase(src), context: clip(`${r.rootCause}\n${r.evidence.join("\n")}`, RESOLVER_CONTEXT_MAX) }
      return { kind: "prepared", phrase, summary: `DRY RUN — would ${kind}: ${summary}` }
    }
    if (late(job)) return failed(job, "deadline passed before acting")
    const proposalId = await seams.applyBody(src, r, job.model)
    await seams.record(src, `resolver:${kind}`, summary, meta(job, null, proposalId ? { proposal: proposalId } : {}))
    return { kind: "resolved", action: kind, summary, outcome: "done" }
  }

  const VERB: Record<string, string> = { fix: "Fix", answer: "Answer", requeue: "Retry", cancel: "Cancel", merge: "Merge", close_pr: "Close", approve: "Approve", reject: "Reject", revise: "Rescope" }

  /** Opus tried and it did not go through: the outcome card (retry offered once; the 2nd identical failure gives up). */
  async function tried(job: Job, out: ResolverOutput, ctx: ResolverContext, a: Extract<Plan, { kind: "act" }>["action"], error: string, headline?: string, extra?: string[]): Promise<WorkResult> {
    seams.attempt?.(job.src, a.kind, error)
    const n = seams.failures?.(job.src, a.kind)
    const gaveUp = !!n && n.count >= 2
    const retry = a.kind === "fix" ? `${RETRY_PREFILL} ${a.instructions}` : `Do it again (${a.kind}); last time: ${clip(error, 200)}`
    const note: OutcomeNote = gaveUp
      ? { outcome: "failed", headline: `Opus tried twice: ${clip(error, 160)}`, gaveUp: true }
      : { outcome: "failed", headline: headline ?? `${VERB[a.kind] ?? a.kind} failed: ${clip(error, 160)}`, retry }
    return prepared(job, out, ctx.sensitive, `${a.kind} failed: ${error}`, extra ?? [`Opus tried to ${a.kind} but it did not go through: ${error}`], "prepared", note)
  }

  /** A fix that never ran for a passing reason (the Mac unreachable): a card, no loop-guard count; the engine re-queues it later. */
  async function transient(job: Job, out: ResolverOutput, ctx: ResolverContext, a: Extract<Plan, { kind: "act" }>["action"], error: string): Promise<WorkResult> {
    const retry = a.kind === "fix" ? `${RETRY_PREFILL} ${a.instructions}` : `Do it again (${a.kind})`
    const note: OutcomeNote = { outcome: "failed", headline: `${VERB[a.kind] ?? a.kind} not run: ${clip(error, 140)}; Opus retries later`, retry }
    return prepared(job, out, ctx.sensitive, `${TRANSIENT_REASON} ${a.kind}: ${error}`, [`Opus could not ${a.kind} yet: ${error}. It will try again later.`], "prepared", note)
  }

  async function act(job: Job, out: ResolverOutput, plan: Extract<Plan, { kind: "act" }>, ctx: ResolverContext): Promise<WorkResult> {
    const src = job.src
    const a = plan.action
    // Loop guard: the same action failed the same way twice → no third identical run (Jeremie's "retry" lifts it).
    const prior = seams.failures?.(src, a.kind)
    if (prior && prior.count >= 2 && !RETRY_RE.test(job.instruction ?? "")) {
      seams.log(`[resolver] ${job.run.itemId}: ${a.kind} not re-run (failed twice: ${prior.error})`)
      return prepared(job, out, ctx.sensitive, `${a.kind} failed twice`, [`Opus tried to ${a.kind} twice; both times: ${prior.error}`], "prepared",
        { outcome: "failed", headline: `Opus tried twice: ${clip(prior.error, 160)}`, gaveUp: true })
    }
    if (a.kind === "fix") {
      const fx = await seams.fix(src, ctx, a.instructions, job.model, FIX_RUN_MS, job.run.id)
      if (fx.kind === "failed" && fx.transient) return transient(job, out, ctx, a, fx.error)
      if (fx.kind === "failed") return tried(job, out, ctx, a, fx.error)
      if (fx.kind === "blocked") return tried(job, out, ctx, a, `blocked: ${fx.reason}`, `Fix blocked: ${clip(fx.reason, 160)}`, [`The fix agent stopped: ${fx.reason}`])
      if (fx.kind === "no_changes") {
        seams.attempt?.(src, a.kind, "the fix run changed nothing")
        const n = seams.failures?.(src, a.kind)
        const note: OutcomeNote = n && n.count >= 2
          ? { outcome: "failed", headline: "Opus tried twice: the fix run changed nothing", gaveUp: true }
          : { outcome: "no_change", headline: `No change needed: ${clip(fx.summary || "the fix run found nothing to change", 160)}` }
        return prepared(job, out, ctx.sensitive, "fix made no change", ["The fix run changed nothing."], "prepared", note)
      }
      seams.attempt?.(src, a.kind, null)
      const sha = fx.sha.slice(0, 8)
      const line = `Opus pushed a fix (${sha}): ${clip(fx.summary, 300)}`
      await seams.comment(src, `🤖 **Opus resolver** — ${line}\n\nWhy: ${clip(out.analysis, 1200)}`)
      seams.turn(src, `🤖 ${line}\n${src.url ?? ""}`.trim())
      const headline = `Fix pushed ${sha}: ${clip(fx.summary, 110)}; CI re-running`
      if (plan.then === "unpark") {
        await seams.unpark(src, `Opus rescue: ${clip(a.instructions, 160)}`)
        const summary = `${headline}, back with the shepherd`
        await seams.record(src, "resolver:fix", summary, meta(job, out, { sha: fx.sha, then: "unpark", outcome: "done" }))
        return { kind: "resolved", action: "fix", summary, outcome: "done" }
      }
      return prepared(job, out, ctx.sensitive, plan.reason, [`${line}. CI re-runs on the new head.`], "fix", { outcome: "done", headline })
    }
    if (a.kind === "revise") {
      const id = await seams.revise(src, a.title, a.prompt, out.summary)
      if (!id) return tried(job, out, ctx, a, "the proposal moved")
      seams.attempt?.(src, a.kind, null)
      const summary = `Opus rescoped the proposal: ${clip(a.title || a.prompt, 120)}`
      await seams.record(src, "resolver:revise", summary, meta(job, out, { proposal: id, outcome: "done" }))
      return { kind: "resolved", action: "revise", summary, outcome: "done" }
    }
    if (a.kind === "close_pr") await seams.comment(src, `🤖 **Opus resolver** — closing this PR: ${a.reason}`)
    const action: TriageAction = a.kind === "answer" ? { kind: "answer", text: a.text } : { kind: a.kind } as TriageAction
    const res = await seams.execute(src, action, BY)
    if (res.kind === "stale") return { kind: "resolved", action: "stale", summary: `already moved${res.reason ? ` (${res.reason})` : ""}`, outcome: "no_change" }
    if (res.kind === "error") return tried(job, out, ctx, a, res.error)
    seams.attempt?.(src, a.kind, null)
    if (res.kind === "queued") {
      // Merge intent: GitHub could not merge yet; the approval is recorded and the PR shepherd lands it.
      const summary = `Opus approved the merge; it lands once ${String(res.detail.reason ?? "GitHub allows it").replace("_", " ")} clears`
      await seams.record(src, `resolver:${a.kind}`, summary, meta(job, out, { reason: plan.reason, outcome: "done", queued: res.detail }))
      return { kind: "resolved", action: a.kind, summary, outcome: "done" }
    }
    const summary = a.kind === "answer" ? `Opus answered: ${clip(a.text, 160)}` : a.kind === "close_pr" ? `Opus closed the PR: ${clip(a.reason, 160)}`
      : a.kind === "reject" ? `Opus rejected it: ${clip(a.reason, 160)}` : `Opus ran ${a.kind}: ${clip(out.summary, 150)}`
    if (a.kind === "reject") seams.turn(src, `🤖 ${summary}`)
    await seams.record(src, `resolver:${a.kind}`, summary, meta(job, out, { reason: plan.reason, outcome: "done" }))
    return { kind: "resolved", action: a.kind, summary, outcome: "done" }
  }

  return async function work(job: Job): Promise<WorkResult> {
    const src = job.src
    if (src.ref.source === "body") return body(job)
    let ctx: ResolverContext
    try {
      ctx = await seams.gather(src)
    } catch (err) {
      return failed(job, `could not gather the evidence: ${(err as Error)?.message ?? err}`)
    }
    const run = await seams.analyze(buildResolverPrompt(src, ctx, job), ctx, job.model, remaining(job))
    if (!run.ok) {
      onPlan?.({ src, out: null, plan: null, verdict: "fall through (Opus run failed)", error: run.error })
      return failed(job, `Opus run failed: ${run.error}`)
    }
    const out = parseResolverOutput(run.text, src)
    if (!out) {
      onPlan?.({ src, out: null, plan: null, verdict: "fall through (unparseable output)", error: "unparseable" })
      return failed(job, "Opus output was not the expected JSON")
    }
    const plan = decide(src, out, { autonomy: job.autonomy, instruction: job.instruction, sensitive: ctx.sensitive, rescuedBefore: ctx.rescuedBefore, repeat: job.repeat })
    onPlan?.({ src, out, plan, verdict: plan.kind === "act" ? `${what(plan)} — ${plan.reason}` : `card — ${plan.reason}` })
    seams.log(`[resolver] ${job.run.itemId}: ${plan.kind === "act" ? what(plan) : "card"} (${plan.reason})`)
    if (job.dryRun) {
      const p = await prepared(job, out, ctx.sensitive, plan.reason)
      return p.kind === "prepared" ? { ...p, summary: `DRY RUN — would ${what(plan)}: ${p.summary}` } : p
    }
    if (plan.kind === "card") return prepared(job, out, ctx.sensitive, plan.reason)
    if (late(job)) return failed(job, "deadline passed before acting")
    return act(job, out, plan, ctx)
  }
}
