import type { InvestigationResult } from "./body-investigate"
import type { ReadonlyRun } from "./readonly-claude"
import {
  FIX_RUN_MS, type Plan, type ResolverOutput, RESOLVER_CONTEXT_MAX, cardSummary, decide, parseResolverOutput, preparedPhrase,
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
  fix(src: SourceItem, ctx: ResolverContext, instructions: string, model: string, timeoutMs: number): Promise<FixOutcome>
  /** PR: hand it back to the shepherd (`pr:unpark`). */
  unpark(src: SourceItem, reason: string): Promise<void>
  /** Proposal: reject it and file the rescoped one (never resolved again); returns the new proposal id. */
  revise(src: SourceItem, title: string, prompt: string, why: string): Promise<string | null>
  /** agent_activity `resolver:<action>`. */
  record(src: SourceItem, action: string, summary: string, meta: Record<string, unknown>): Promise<void>
  /** An orchestrator turn in the item's channel. */
  turn(src: SourceItem, text: string): void
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

  async function prepared(job: Job, out: ResolverOutput, sensitive: boolean, reason: string, extra: string[] = [], action = "prepared"): Promise<WorkResult> {
    const src = job.src
    const phrase = preparedPhrase(src, out, { sensitive }, extra)
    const summary = cardSummary(src, out, sensitive)
    if (!job.dryRun) await seams.record(src, `resolver:${action}`, summary, meta(job, out, { reason }))
    return { kind: "prepared", phrase, summary, action, reason }
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
    return { kind: "resolved", action: kind, summary }
  }

  async function act(job: Job, out: ResolverOutput, plan: Extract<Plan, { kind: "act" }>, ctx: ResolverContext): Promise<WorkResult> {
    const src = job.src
    const a = plan.action
    const tried = (detail: string) => prepared(job, out, ctx.sensitive, `${a.kind} failed: ${detail}`, [`Opus tried to ${a.kind} but it did not go through: ${detail}`])
    if (a.kind === "fix") {
      const fx = await seams.fix(src, ctx, a.instructions, job.model, FIX_RUN_MS)
      if (fx.kind === "failed") return tried(fx.error)
      if (fx.kind === "blocked") return prepared(job, out, ctx.sensitive, "fix agent blocked", [`The fix agent stopped: ${fx.reason}`])
      if (fx.kind === "no_changes") return prepared(job, out, ctx.sensitive, "fix made no change", ["The fix run changed nothing."])
      const line = `Opus pushed a fix (${fx.sha.slice(0, 8)}): ${clip(fx.summary, 300)}`
      await seams.comment(src, `🤖 **Opus resolver** — ${line}\n\nWhy: ${clip(out.analysis, 1200)}`)
      seams.turn(src, `🤖 ${line}\n${src.url ?? ""}`.trim())
      if (plan.then === "unpark") {
        await seams.unpark(src, `Opus rescue: ${clip(a.instructions, 160)}`)
        const summary = `Opus pushed a fix and handed the PR back to the shepherd`
        await seams.record(src, "resolver:fix", `${summary}: ${clip(fx.summary, 120)}`, meta(job, out, { sha: fx.sha, then: "unpark" }))
        return { kind: "resolved", action: "fix", summary }
      }
      return prepared(job, out, ctx.sensitive, plan.reason, [`${line}. CI re-runs on the new head.`], "fix")
    }
    if (a.kind === "revise") {
      const id = await seams.revise(src, a.title, a.prompt, out.summary)
      if (!id) return tried("the proposal moved")
      const summary = `Opus rescoped the proposal: ${clip(a.title || a.prompt, 120)}`
      await seams.record(src, "resolver:revise", summary, meta(job, out, { proposal: id }))
      return { kind: "resolved", action: "revise", summary }
    }
    if (a.kind === "close_pr") await seams.comment(src, `🤖 **Opus resolver** — closing this PR: ${a.reason}`)
    const action: TriageAction = a.kind === "answer" ? { kind: "answer", text: a.text } : { kind: a.kind } as TriageAction
    const res = await seams.execute(src, action, BY)
    if (res.kind === "stale") return { kind: "resolved", action: "stale", summary: `already moved${res.reason ? ` (${res.reason})` : ""}` }
    if (res.kind === "error") return tried(res.error)
    const summary = a.kind === "answer" ? `Opus answered: ${clip(a.text, 160)}` : a.kind === "close_pr" ? `Opus closed the PR: ${clip(a.reason, 160)}`
      : a.kind === "reject" ? `Opus rejected it: ${clip(a.reason, 160)}` : `Opus ran ${a.kind} (${plan.reason})`
    if (a.kind === "reject") seams.turn(src, `🤖 ${summary}`)
    await seams.record(src, `resolver:${a.kind}`, summary, meta(job, out, { reason: plan.reason }))
    return { kind: "resolved", action: a.kind, summary }
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
