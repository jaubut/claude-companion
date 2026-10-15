import { randomUUID } from "node:crypto"
import { companionLog } from "../lib/log"
import { db } from "../lib/orchestrator-db"
import { type ReworkMember, type ReworkStep, parseRework, reworkPolicy, reworkPrompt, reworkSummary } from "../lib/repo-rework"
import { REPO_YES_INSTRUCTION } from "../lib/resolver"
import type { SourceItem, TriageAction, TriageItem } from "../lib/triage"
import type { ExecOutcome, TriageEngine } from "../lib/triage-engine"
import { type RepoCard, type RepoMember, type RepoRun, type RepoRunResult, type RepoRunView, yesPlan, runSummary } from "../lib/triage-repos"
import { type TriageStore, createTriageStore } from "../lib/triage-store"
import { TursoUnreachable } from "../lib/turso"
import { repoSeams, triageEngine } from "./triage"

// Repo cards, the runner (docs/orchestrator-triage-api.md#repo-cards):
// POST /api/orchestrator/repos/<repo>/(yes|no) → one `triage_repo_runs` row
// (the only writer), 202, then the run in the background, one member at a
// time, each through the triage engine's guarded paths:
//   Yes  proposal → actOn(approve) · task / superseded PR → the resolver,
//        delegated · parked PR → `pr:unpark` (by manual: the shepherd's full
//        gates again, never pr:approved-merge) · held PRs never move.
//   No   ONE Opus rework (lib/repo-rework.ts) → the steps its policy allows.
// Idempotency = pattern B: UNIQUE (repo, Idempotency-Key) replays the stored
// row; one running run per repo (409 repo_busy). Per-item results + summary
// land on the card's `run`, plus one orchestrator turn.

export interface RepoRunnerDeps {
  engine: Pick<TriageEngine, "list" | "refresh" | "render" | "repos" | "items" | "source" | "actOn" | "ask" | "resolverOn">
  store: TriageStore
  /** `pr:unpark` for a parked PR (meta.url from the park row, by "manual"); "already" = its newest pr:* row is no park. */
  unparkPr: (src: SourceItem) => Promise<"done" | "already">
  /** Reject a proposal and file Opus's rescope (wiring/proposals.ts reviseProposal); the new id or null. */
  revise: (src: SourceItem, title: string, prompt: string, why: string) => Promise<string | null>
  /** One Opus call; null = no answer. */
  rework: (prompt: string) => Promise<string | null>
  /** Throws when Turso is unreachable (checked before any row is written). */
  probe: () => Promise<void>
  /** One orchestrator turn per run (#General). */
  turn: (text: string) => void
  now?: () => number
  log?: (msg: string) => void
}

export interface RepoRequest {
  /** The card key: the repo name, or "_other". */
  repo: string
  decision: "yes" | "no"
  version: string
  members?: { id: string; version: string }[]
  note?: string | null
  idemKey: string | null
}

export interface RepoReply { status: number; body: Record<string, unknown> }

const viewOf = (r: RepoRun): RepoRunView => ({
  id: r.id, decision: r.decision, status: r.status, note: r.note, summary: r.summary, results: r.results, createdAt: r.createdAt, finishedAt: r.finishedAt,
})

const errorCode = (err: unknown): string => {
  const name = (err as Error)?.name
  return err instanceof TursoUnreachable ? "turso_unreachable" : name === "GhUnreachable" ? "gh_unreachable" : "unavailable"
}

export function createRepoRunner(deps: RepoRunnerDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const inflight = new Set<Promise<void>>()
  const keyOf = (card: RepoCard): string => card.id.slice("repo:".length)

  async function cardFor(repo: string): Promise<RepoCard | null> {
    const find = () => deps.engine.repos().find((c) => keyOf(c) === repo) ?? null
    await deps.engine.list()
    if (find()) return find()
    await deps.engine.refresh()
    return find()
  }

  const fail = (status: number, error: string, extra: Record<string, unknown> = {}): RepoReply => ({ status, body: { ok: false, error, ...extra } })

  /** Same (repo, key) → the stored row; another run in progress → repo_busy. */
  function replayOrBusy(repo: string, idemKey: string): RepoReply | null {
    const prior = deps.store.repoRun(repo, idemKey)
    if (prior) return { status: 200, body: { ok: true, repo, runId: prior.id, result: "replay", run: viewOf(prior) } }
    const busy = deps.store.runningRun(repo)
    return busy ? fail(409, "repo_busy", { repo, run: viewOf(busy) }) : null
  }

  async function submit(req: RepoRequest): Promise<RepoReply> {
    const idemKey = req.idemKey ?? `auto-${randomUUID()}`
    if (req.decision === "no" && !deps.engine.resolverOn()) return fail(409, "resolver_disabled", { repo: req.repo })
    const early = replayOrBusy(req.repo, idemKey)
    if (early) return early
    const card = await cardFor(req.repo)
    if (!card) return fail(404, "no_such_repo", { repo: req.repo })
    let skipped: { id: string; reason: string }[] = []
    let act: RepoMember[] = []
    if (req.decision === "yes") {
      const plan = yesPlan(card, req.members ?? [])
      if (!plan.act.length) return fail(409, "stale", { repo: req.repo, next: card, skipped: plan.skipped })
      act = plan.act
      skipped = plan.skipped
    } else if (card.version !== req.version) {
      return fail(409, "stale", { repo: req.repo, next: card })
    }
    try {
      await deps.probe()
    } catch (err) {
      log(`[repo-cards] ${req.repo} ${req.decision}: ${(err as Error)?.message ?? err}`)
      return fail(503, errorCode(err), { repo: req.repo })
    }
    // Re-checked after the awaits: a concurrent request may have taken the repo meanwhile.
    const late = replayOrBusy(req.repo, idemKey)
    if (late) return late
    const run = deps.store.insertRun({ repoKey: req.repo, cardVersion: card.version, decision: req.decision, note: req.note ?? null, idemKey }, now())
    if (!run) return replayOrBusy(req.repo, idemKey) ?? fail(409, "repo_busy", { repo: req.repo })
    deps.engine.render()
    const work = (req.decision === "yes" ? yes(run, card, act) : no(run, card, req.note ?? ""))
      .catch((err) => finish(run, card, [], `run failed: ${(err as Error)?.message ?? err}`, "failed"))
      .finally(() => inflight.delete(work))
    inflight.add(work)
    log(`[repo-cards] ${req.repo} ${req.decision} run ${run.id} started (${act.length || card.members.length} item(s))`)
    return { status: 202, body: { ok: true, repo: req.repo, runId: run.id, result: "running", skipped } }
  }

  async function finish(run: RepoRun, card: RepoCard, results: RepoRunResult[], summary: string, status: "done" | "failed" = "done"): Promise<void> {
    deps.store.updateRun(run.id, { status, results, summary, finishedAt: now() })
    deps.turn(run.decision === "yes" ? `✅ Your Yes on ${card.name}: ${summary}` : `🤖 ${summary}`)
    log(`[repo-cards] ${run.repoKey} run ${run.id} ${status}: ${summary}`)
    await deps.engine.refresh()
  }

  /** One ExecOutcome → a per-item result. */
  function outcome(id: string, out: ExecOutcome, ok: RepoRunResult["result"] = "done"): RepoRunResult {
    if (out.kind === "done" || out.kind === "queued") return { id, result: ok }
    if (out.kind === "stale") return { id, result: "skipped", reason: out.reason === "gone" ? "gone" : "changed" }
    return { id, result: "failed", reason: out.error }
  }

  async function yesOne(m: RepoMember): Promise<RepoRunResult> {
    const src = deps.engine.source(m.id)
    if (!src) return { id: m.id, result: "skipped", reason: "gone" }
    if (src.version !== m.version) return { id: m.id, result: "skipped", reason: "changed" }
    try {
      if (m.does === "approve") {
        return outcome(m.id, await deps.engine.actOn(m.id, { id: "repo-yes", label: "Approve", action: { kind: "approve" } }, null, m.version, "your Yes"))
      }
      if (m.does === "hand_back") {
        return (await deps.unparkPr(src)) === "done" ? { id: m.id, result: "handed_back" } : { id: m.id, result: "skipped", reason: "already handed back" }
      }
      const asked = deps.engine.ask(m.id, REPO_YES_INSTRUCTION, "delegated")
      if (asked.ok) return { id: m.id, result: "with_opus" }
      return asked.error === "resolver_disabled" ? { id: m.id, result: "skipped", reason: "opus_off" } : { id: m.id, result: "failed", reason: asked.error }
    } catch (err) {
      return { id: m.id, result: "failed", reason: errorCode(err) }
    }
  }

  async function yes(run: RepoRun, card: RepoCard, act: RepoMember[]): Promise<void> {
    const results: RepoRunResult[] = []
    for (const m of act) results.push(await yesOne(m))
    await finish(run, card, results, runSummary(results))
  }

  function reworkMembers(card: RepoCard): ReworkMember[] {
    const items = new Map<string, TriageItem>(deps.engine.items().map((i) => [i.id, i]))
    return [...card.members.map((m) => m.id), ...card.held].flatMap((id) => {
      const item = items.get(id)
      const src = deps.engine.source(id)
      if (!item || !src) return []
      const recommended = item.options.find((o) => o.id === item.recommended)?.label ?? ""
      return [{ id, source: item.source, title: item.title, problem: item.problem, recommended, held: card.held.includes(id), blocked: src.ref.source === "task" && src.ref.status === "blocked" }]
    })
  }

  async function step(s: ReworkStep, version: string): Promise<RepoRunResult & { kind: ReworkStep["kind"] }> {
    const base = { id: s.id, kind: s.kind }
    const src = deps.engine.source(s.id)
    if (!src || src.version !== version) return { ...base, result: "skipped", reason: "changed" }
    const exec = async (action: TriageAction, text: string | null = null) =>
      ({ ...base, ...outcome(s.id, await deps.engine.actOn(s.id, { id: "repo-no", label: action.kind, action }, text, version, "Opus")) })
    try {
      switch (s.kind) {
        case "keep": return { ...base, result: "kept" }
        case "reject": return exec({ kind: "reject" })
        case "cancel": return exec({ kind: "cancel" })
        case "close_pr": return exec({ kind: "close_pr" })
        case "answer": return exec({ kind: "answer", text: s.text })
        case "revise": {
          const id = await deps.revise(src, s.title, s.prompt, s.why)
          return id ? { ...base, result: "done" } : { ...base, result: "skipped", reason: "changed" }
        }
        case "ask_opus": {
          const asked = deps.engine.ask(s.id, s.instruction, "elevated")
          return asked.ok ? { ...base, result: "with_opus" } : { ...base, result: "failed", reason: asked.error }
        }
      }
    } catch (err) {
      return { ...base, result: "failed", reason: errorCode(err) }
    }
  }

  async function no(run: RepoRun, card: RepoCard, note: string): Promise<void> {
    const members = reworkMembers(card)
    const raw = await deps.rework(reworkPrompt(card.name, note, members)).catch(() => null)
    const out = raw ? parseRework(raw) : null
    if (!out) return finish(run, card, [], "Opus did not answer — nothing changed", "failed")
    const { run: steps, refused } = reworkPolicy(out, members, note)
    for (const r of refused) log(`[repo-cards] ${run.repoKey} No: ${r.kind} on ${r.id} refused (${r.reason})`)
    const versions = new Map(card.members.map((m) => [m.id, m.version]))
    const results: (RepoRunResult & { kind: ReworkStep["kind"] })[] = []
    for (const s of steps) results.push(await step(s, versions.get(s.id) ?? ""))
    const touched = new Set(results.filter((r) => r.result !== "kept").map((r) => r.id))
    const n = (kind: ReworkStep["kind"]) => results.filter((r) => r.kind === kind && (r.result === "done" || r.result === "with_opus")).length
    const kept = members.filter((m) => !m.held && !touched.has(m.id)).length
    const failed = results.filter((r) => r.result === "failed" || r.result === "skipped").length
    const head = reworkSummary({ rejected: n("reject"), rescoped: n("revise"), answered: n("answer"), cancelled: n("cancel"), closed: n("close_pr"), handed: n("ask_opus"), kept, failed })
    const summary = `${head}${out.summary ? `. ${out.summary}` : ""}`.slice(0, 300)
    await finish(run, card, results.map(({ kind: _k, ...r }) => r), summary)
  }

  return {
    submit,
    /** Test seam: every background run finished. */
    async idle(): Promise<void> {
      while (inflight.size) await Promise.all([...inflight])
    },
  }
}

export type RepoRunner = ReturnType<typeof createRepoRunner>

/** Boot: a run a restart interrupted is closed `interrupted` (its key still replays the stored row). */
export function sweepInterruptedRuns(store: TriageStore, now: number): number {
  let n = 0
  for (const run of store.latestRuns().values()) {
    if (run.status !== "running") continue
    store.updateRun(run.id, { status: "interrupted", summary: run.summary ?? "interrupted by a server restart", finishedAt: now })
    n++
  }
  return n
}

let live: RepoRunner | null = null
/** The wired runner (built on first use) over the live triage engine. */
export function repoRunner(): RepoRunner {
  live ??= createRepoRunner({ engine: triageEngine(), store: createTriageStore(db), ...repoSeams(), log: companionLog })
  return live
}
