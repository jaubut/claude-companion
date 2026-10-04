import { type Autonomy, FIX_RUN_MS, type ResolverConfig, digestText, resolverInfo, resolverKey } from "./resolver"
import type { ResolverStore, RunRow } from "./resolver-store"
import { type Phrase, type ResolverInfo, type Severity, type SourceItem, itemId } from "./triage"

// The resolver's scheduler over injected seams (wiring/resolver.ts is the live
// work). Triage asks it, per item, on every render:
//   consider  a new (item, resolver key) → a queued run, within the daily budget
//   view      resolving (hidden from `items`) | resolved (hidden) | prepared (Opus's card)
//             | failed (the normal card, marked) | null (the normal card)
//   ask       Jeremie's `ask_opus`: an elevated run, outside the daily budget
// ≤ maxConcurrent runs at once, one per item; a normal run that waited longer
// than queueMaxMs is skipped (falls through); every run has a deadline. The
// kill switch stops new runs and shows every waiting item as a normal card.

export type WorkResult =
  | { kind: "resolved"; action: string; summary: string; reason?: string }
  | { kind: "prepared"; phrase: Phrase; severity?: Severity | null; summary: string; action?: string; reason?: string }
  | { kind: "failed"; summary: string }

export interface Job {
  run: RunRow
  src: SourceItem
  autonomy: Autonomy
  instruction: string | null
  dryRun: boolean
  model: string
  /** Epoch ms: past it, the work must not act any more. */
  deadline: number
  /** The item came back after Opus resolved it: prepare a card, never act on its own again. */
  repeat: boolean
}

export type ResolverView =
  | { state: "resolving"; info: ResolverInfo }
  | { state: "resolved"; info: ResolverInfo }
  | { state: "prepared"; phrase: Phrase; severity: Severity | null; info: ResolverInfo }
  | { state: "failed"; info: ResolverInfo }

export type AskResult = { ok: true; runId: number } | { ok: false; error: "resolver_disabled" | "not_routable" }

export interface ResolverEngineDeps {
  store: ResolverStore
  config: () => ResolverConfig
  routable: (src: SourceItem) => boolean
  work: (job: Job) => Promise<WorkResult>
  /** Something changed (a run started / finished): re-render or re-collect triage. */
  onChange: (finished: boolean) => void
  /** The item's stable ref (a PR URL survives version changes); default = the item id. */
  refKey?: (src: SourceItem) => string
  now?: () => number
  log?: (msg: string) => void
}

/** Local calendar day, YYYY-MM-DD (the daily budget and the digest). */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function createResolverEngine(deps: ResolverEngineDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const refKey = deps.refKey ?? ((s: SourceItem) => itemId(s.source, s.refId))
  const jobs = new Map<number, SourceItem>()
  const runningItems = new Set<string>()
  const inflight = new Set<Promise<void>>()
  let pending: boolean | null = null

  /** Coalesced, never re-entrant: triage calls consider() from inside its own render. */
  function changed(finished: boolean): void {
    if (pending !== null) { pending ||= finished; return }
    pending = finished
    queueMicrotask(() => {
      const f = pending ?? false
      pending = null
      deps.onChange(f)
    })
  }

  function info(r: RunRow, status: ResolverInfo["status"]): ResolverInfo {
    const summary = r.summary || (r.status === "queued" ? "Opus will look at it shortly" : "Opus is working on it")
    return resolverInfo(status, summary, r.model, r.finishedAt)
  }

  const repeats = new Set<number>()

  function enqueue(id: string, src: SourceItem, autonomy: Autonomy, instruction: string | null, repeat = false): RunRow {
    const cfg = deps.config()
    const run = deps.store.insert({ itemId: id, rkey: resolverKey(src), version: src.version, source: src.source, refKey: refKey(src), autonomy, instruction, model: cfg.model }, now())
    jobs.set(run.id, src)
    if (repeat) repeats.add(run.id)
    return run
  }

  /** Resolved on another version and still here (re-blocked on the same question, a lost race): a recurrence. */
  const recurred = (r: RunRow | null, src: SourceItem): boolean => !!r && r.status === "resolved" && r.version !== src.version

  function consider(id: string, src: SourceItem): void {
    const cfg = deps.config()
    if (!cfg.enabled || !deps.routable(src)) return
    const last = deps.store.latest(id, resolverKey(src))
    if (last && !recurred(last, src)) return
    const waiting = deps.store.queued().filter((r) => r.autonomy === "normal").length
    if (deps.store.startedOn(localDay(now())) + waiting >= cfg.maxPerDay) return
    enqueue(id, src, "normal", null, !!last)
    log(`[resolver] ${id} queued${last ? " (came back after Opus resolved it)" : ""}`)
    pump()
  }

  function view(id: string, src: SourceItem): ResolverView | null {
    const r = deps.store.latest(id, resolverKey(src))
    if (!r || recurred(r, src)) return null
    switch (r.status) {
      case "queued":
      case "running":
        return deps.config().enabled || r.status === "running" ? { state: "resolving", info: info(r, "resolving") } : null
      case "resolved": return { state: "resolved", info: info(r, "prepared") }
      case "prepared": return r.phrase ? { state: "prepared", phrase: r.phrase, severity: r.severity, info: info(r, "prepared") } : null
      case "failed": return { state: "failed", info: info(r, "failed") }
      case "skipped": return null
    }
  }

  function ask(id: string, src: SourceItem, instruction: string | null): AskResult {
    if (!deps.config().enabled) return { ok: false, error: "resolver_disabled" }
    if (!deps.routable(src)) return { ok: false, error: "not_routable" }
    const run = enqueue(id, src, "elevated", instruction?.trim() || null)
    log(`[resolver] ${id} handed back to Opus${run.instruction ? `: ${run.instruction.slice(0, 80)}` : ""}`)
    pump()
    changed(false)
    return { ok: true, runId: run.id }
  }

  function skip(r: RunRow, why: string): void {
    deps.store.update(r.id, { status: "skipped", summary: why, finishedAt: now() })
    jobs.delete(r.id)
    log(`[resolver] ${r.itemId} skipped — ${why}`)
  }

  /** Start what fits; skip what waited too long or was orphaned by a restart. */
  function pump(): void {
    const cfg = deps.config()
    let moved = false
    for (const r of deps.store.queued()) {
      if (!jobs.has(r.id)) { skip(r, "lost its item (restart)"); moved = true; continue }
      if (!cfg.enabled) { skip(r, "resolver disabled"); moved = true; continue }
      if (r.autonomy === "normal" && now() - r.createdAt > cfg.queueMaxMs) { skip(r, "waited too long for a slot"); moved = true; continue }
      if (runningItems.size >= cfg.maxConcurrent || runningItems.has(r.itemId)) continue
      start(r, cfg)
      moved = true
    }
    if (moved) changed(false)
  }

  function start(r: RunRow, cfg: ResolverConfig): void {
    const src = jobs.get(r.id)!
    const t = now()
    const run = deps.store.update(r.id, { status: "running", startedAt: t, day: localDay(t) })!
    runningItems.add(r.itemId)
    const job: Job = { run, src, autonomy: r.autonomy, instruction: r.instruction, dryRun: cfg.dryRun, model: cfg.model, deadline: t + cfg.timeoutMs, repeat: repeats.has(r.id) }
    let timer: ReturnType<typeof setTimeout> | null = null
    // The deadline gates the analysis and the start of any action; a fix run that started in time gets its own FIX_RUN_MS.
    const hard = cfg.timeoutMs + (r.source === "pr" ? FIX_RUN_MS : 0)
    const timeout = new Promise<WorkResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "failed", summary: `timed out after ${Math.round(hard / 60_000)} min` }), hard)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    const p = Promise.race([deps.work(job), timeout])
      .catch((err): WorkResult => ({ kind: "failed", summary: `resolver error: ${(err as Error)?.message ?? err}` }))
      .then((res) => finish(r, res))
      .finally(() => {
        if (timer) clearTimeout(timer)
        runningItems.delete(r.itemId)
        jobs.delete(r.id)
        repeats.delete(r.id)
        inflight.delete(p)
        pump()
        changed(true)
      })
    inflight.add(p)
    log(`[resolver] ${r.itemId} start (${r.autonomy}${cfg.dryRun ? ", dry run" : ""})`)
  }

  function finish(r: RunRow, res: WorkResult): void {
    const finishedAt = now()
    if (res.kind === "resolved") {
      deps.store.update(r.id, { status: "resolved", action: res.action, summary: res.summary, reason: res.reason ?? null, finishedAt })
    } else if (res.kind === "prepared") {
      deps.store.update(r.id, {
        status: "prepared", action: res.action ?? "prepared", summary: res.summary, reason: res.reason ?? null,
        phrase: res.phrase, severity: res.severity ?? null, finishedAt,
      })
    } else {
      deps.store.update(r.id, { status: "failed", action: "failed", summary: res.summary, finishedAt })
    }
    log(`[resolver] ${r.itemId} ${res.kind}: ${res.summary.slice(0, 120)}`)
  }

  /** Boot: rows a restart interrupted fall through. */
  function recover(): number {
    return deps.store.closeInterrupted(now())
  }

  return {
    consider, view, ask, pump, recover,
    enabled: (): boolean => deps.config().enabled,
    running: (): number => runningItems.size,
    /** Test seam: every started run finished. */
    async idle(): Promise<void> {
      while (inflight.size) await Promise.all([...inflight])
    },
  }
}

export type ResolverEngine = ReturnType<typeof createResolverEngine>

/** Once a day, at/after `hour`: "Opus handled N items today: …" (#General). Returns the text posted, or null. */
export function maybeDigest(store: ResolverStore, now: number, hour: number, post: (text: string) => void): string | null {
  if (new Date(now).getHours() < hour) return null
  const day = localDay(now)
  if (store.meta("digest_day") === day) return null
  store.setMeta("digest_day", day)
  const text = digestText(store.countsOn(day))
  if (text) post(text)
  return text
}
