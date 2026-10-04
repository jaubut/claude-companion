import { Database } from "bun:sqlite"
import { detectColumns, listDispatchTasks } from "../lib/dispatch-tasks"
import type { DispatchWiring } from "../lib/dispatch-poller"
import { getChannel } from "../lib/orchestrator-channels"
import { listProposals } from "../lib/orchestrator-chat"
import { resolverConfig, routable } from "../lib/resolver"
import type { Job } from "../lib/resolver-engine"
import { createResolverStore } from "../lib/resolver-store"
import { type PlanReport, type WorkSeams, createResolverWork } from "../lib/resolver-work"
import { type SourceItem, itemId } from "../lib/triage"
import { realGh } from "../lib/triage-pr"
import { bodySources, prSources, proposalSource, queryPrRows, taskSources } from "../lib/triage-sources"
import { type ExecFn, tursoQuery } from "../lib/turso"
import { investigationStore } from "./body-investigate"
import { liveSeams } from "./resolver"

// `bun cli.ts resolver-dry-run`: the real triage sources (Turso read-only, the
// local companion.db — point COMPANION_DB_PATH at a COPY), the real read-only
// Opus analysis and `gh` reads, and NOTHING executed: every write seam throws.
// Prints what the resolver WOULD do per item.

export interface DryRunRow {
  id: string
  source: string
  title: string
  verdict: string
  summary: string
  confidence: number | null
  why: string
  category: string
  analysis: string
  ms: number
  error?: string
}

const refuse = (what: string) => async (): Promise<never> => { throw new Error(`dry run: ${what} refused`) }

export async function collectReadOnly(now: number = Date.now()): Promise<SourceItem[]> {
  const cols = await detectColumns(tursoQuery)
  const tasks = taskSources(await listDispatchTasks(tursoQuery, cols), () => null)
  const prs = prSources(await queryPrRows(tursoQuery, cols), now)
  const proposals = listProposals().map((t) => {
    const ch = getChannel(t.threadId)
    return proposalSource(t, { channelName: ch?.name ?? null, project: ch?.noteTitle ?? null, macFix: false })
  }).filter((s): s is SourceItem => !!s)
  const body = bodySources(investigationStore(), now, { isProblem: () => null, criticality: () => null })
  return [...tasks, ...prs, ...proposals, ...body]
}

export async function resolverDryRun(opts: { limit: number; only?: string | null; concurrency?: number; log?: (m: string) => void } = { limit: 10 }): Promise<DryRunRow[]> {
  const cfg = resolverConfig({ ...process.env, COMPANION_RESOLVER: "1" }, () => false)
  const log = opts.log ?? (() => {})
  const noExec: ExecFn = async () => { throw new Error("dry run: Turso write refused") }
  const dispatch = { query: tursoQuery, exec: noExec, columns: () => detectColumns(tursoQuery), cached: () => null, threadIdFor: () => "general" } as unknown as DispatchWiring
  const store = createResolverStore(new Database(":memory:"))
  const live = liveSeams({ dispatch, gh: realGh, execute: refuse("execute"), store })
  const seams: WorkSeams = {
    ...live,
    applyBody: refuse("applyBody"), execute: refuse("execute"), comment: refuse("comment"), fix: refuse("fix"),
    unpark: refuse("unpark"), revise: refuse("revise"), record: refuse("record"), turn: () => {},
    log,
  }
  const reports = new Map<string, PlanReport>()
  const work = createResolverWork(seams, (r) => reports.set(itemId(r.src.source, r.src.refId), r))
  const all = (await collectReadOnly()).filter((s) => routable(s, { createdByResolver: () => false }))
  const picked = all.filter((s) => !opts.only || s.source === opts.only).slice(0, opts.limit)
  log(`[dry-run] ${all.length} routable item(s), running ${picked.length} with ${cfg.model}`)
  const rows: DryRunRow[] = []
  let next = 0
  async function lane(): Promise<void> {
    while (next < picked.length) {
      const src = picked[next++]!
      const id = itemId(src.source, src.refId)
      const t0 = Date.now()
      log(`[dry-run] ${id} …`)
      const job: Job = {
        run: { id: 0, itemId: id, rkey: "", version: src.version, source: src.source, refKey: id, status: "running", autonomy: "normal", instruction: null, model: cfg.model, summary: "", phrase: null, severity: null, action: null, reason: null, createdAt: t0, startedAt: t0, finishedAt: null, day: null },
        src, autonomy: "normal", instruction: null, dryRun: true, model: cfg.model, deadline: t0 + cfg.timeoutMs, repeat: false,
      }
      const res = await work(job).catch((err) => ({ kind: "failed" as const, summary: (err as Error)?.message ?? String(err) }))
      const r = reports.get(id)
      rows.push({
        id, source: src.source, title: src.title, verdict: r?.verdict ?? `fall through (${res.kind})`,
        summary: res.summary, confidence: r?.out?.confidence ?? null, why: r?.out?.why ?? "", category: r?.out?.category ?? "",
        analysis: r?.out?.analysis ?? "", ms: Date.now() - t0, ...(r?.error ? { error: r.error } : {}),
      })
      log(`[dry-run] ${id} → ${r?.verdict ?? res.kind} (${Math.round((Date.now() - t0) / 1000)} s)`)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? cfg.maxConcurrent) }, lane))
  return rows
}

export function formatDryRun(rows: DryRunRow[]): string {
  const out = ["| item | source | would do | conf. | why / category | time |", "|---|---|---|---|---|---|"]
  for (const r of rows) {
    const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim()
    out.push(`| ${cell(r.title).slice(0, 70)} (\`${cell(r.id).slice(0, 40)}\`) | ${r.source} | ${cell(r.verdict).slice(0, 220)} | ${r.confidence === null ? "—" : `${Math.round(r.confidence * 100)} %`} | ${cell([r.why, r.category].filter(Boolean).join(" / ")) || "—"} | ${Math.round(r.ms / 1000)} s |`)
  }
  out.push("", "Reasoning:")
  for (const r of rows) out.push(`- ${r.id}: ${r.analysis ? r.analysis.replace(/\s+/g, " ").slice(0, 600) : r.error ?? r.summary}`)
  return out.join("\n")
}
