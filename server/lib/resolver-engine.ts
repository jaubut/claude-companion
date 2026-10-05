import {
  type Autonomy, FIX_RUN_MS, type ResolverConfig, TRANSIENT_MAX_PER_DAY, TRANSIENT_REASON, TRANSIENT_RETRY_MS, digestText, resolverInfo, resolverKey,
} from "./resolver"
import type { ResolverStore, RunRow } from "./resolver-store"
import { type Phrase, type ResolverInfo, type ResolverOutcome, type Severity, type SourceItem, heuristicSeverity, itemId } from "./triage"

// The resolver's scheduler over injected seams (wiring/resolver.ts is the live
// work). Triage asks it, per item, on every render:
//   consider  a new (item, resolver key) → a queued run, within the daily budget
//   view      queued / resolving (hidden from `items`, listed in `resolving[]`) | resolved (hidden)
//             | prepared (Opus's card) | failed (the normal card, marked) | null (the normal card)
//   ask       Jeremie's `ask_opus`: an elevated run, outside the daily budget
// ≤ maxConcurrent runs at once, one per item. The backlog drains elevated
// first, then urgent → normal → low, oldest first; a normal run still queued
// after queueMaxMs falls through. A queued row a restart / the kill switch
// dropped is queued again on the next render. Every run has a deadline. The
// kill switch stops new runs and shows every waiting item as a normal card.

export type WorkResult =
  | { kind: "resolved"; action: string; summary: string; reason?: string; outcome?: ResolverOutcome }
  | { kind: "prepared"; phrase: Phrase; severity?: Severity | null; summary: string; action?: string; reason?: string; outcome?: ResolverOutcome }
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
  /** Backlog order: lower first (default: severity rank, then the oldest). */
  priority?: (src: SourceItem) => [number, number]
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

  const RANK: Record<Severity, number> = { urgent: 0, normal: 1, low: 2 }
  const priority = deps.priority ?? ((s: SourceItem) => [RANK[heuristicSeverity(s)], s.createdAt] as [number, number])

  /** Queued rows in start order: elevated (Jeremie asked) first, then urgent → low, oldest first. */
  let order: RunRow[] | null = null
  function ordered(): RunRow[] {
    if (order) return order
    const key = (r: RunRow): [number, number, number, number] => {
      const src = jobs.get(r.id)
      const [rank, born] = src ? priority(src) : [9, 0]
      return [r.autonomy === "elevated" ? 0 : 1, rank, born, r.id]
    }
    const keyed = deps.store.queued().map((r) => ({ r, k: key(r) }))
    keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.k[3] - b.k[3])
    order = keyed.map((x) => x.r)
    return order
  }

  function info(r: RunRow, status: ResolverInfo["status"]): ResolverInfo {
    if (status === "queued") {
      const pos = ordered().findIndex((q) => q.id === r.id) + 1
      return resolverInfo("queued", r.summary || (pos ? `Opus queued (${pos})` : "Opus will look at it shortly"), r.model, null, { queuePosition: pos || null })
    }
    const summary = r.summary || "Opus is working on it"
    return resolverInfo(status, summary, r.model, r.finishedAt, { outcome: r.outcome })
  }

  const repeats = new Set<number>()

  function enqueue(id: string, src: SourceItem, autonomy: Autonomy, instruction: string | null, repeat = false): RunRow {
    const cfg = deps.config()
    const run = deps.store.insert({ itemId: id, rkey: resolverKey(src), version: src.version, source: src.source, refKey: refKey(src), autonomy, instruction, model: cfg.model }, now())
    jobs.set(run.id, src)
    order = null
    if (repeat) repeats.add(run.id)
    return run
  }

  /** Resolved on another version and still here (re-blocked on the same question, a lost race): a recurrence. */
  const recurred = (r: RunRow | null, src: SourceItem): boolean => !!r && r.status === "resolved" && r.version !== src.version
  /** Dropped before it ever ran (restart, kill switch): take it again. A row that waited too long stays dropped. */
  const requeueable = (r: RunRow | null): boolean => !!r && ((r.status === "skipped" && r.reason !== "wait") || retryDue(r))
  /** Its action never ran for a passing reason (the Mac unreachable): once the retry delay passed, within the daily cap. */
  const retryDue = (r: RunRow): boolean =>
    r.status === "prepared" && !!r.reason?.startsWith(TRANSIENT_REASON) && now() - (r.finishedAt ?? r.createdAt) >= TRANSIENT_RETRY_MS
    && deps.store.countReason(r.itemId, r.rkey, TRANSIENT_REASON, now() - 24 * 60 * 60_000) < TRANSIENT_MAX_PER_DAY

  function consider(id: string, src: SourceItem): void {
    const cfg = deps.config()
    if (!cfg.enabled || !deps.routable(src)) return
    const last = deps.store.latest(id, resolverKey(src))
    if (last && !recurred(last, src) && !requeueable(last)) return
    // The daily budget counts normal runs only: Jeremie's ask_opus runs never starve the backlog.
    const waiting = deps.store.queued().filter((r) => r.autonomy === "normal").length
    if (deps.store.startedOn(localDay(now())) + waiting >= cfg.maxPerDay) return
    const repeat = !!last && recurred(last, src)
    enqueue(id, src, "normal", null, repeat)
    log(`[resolver] ${id} queued${repeat ? " (came back after Opus resolved it)" : ""}`)
    pump()
  }

  function view(id: string, src: SourceItem): ResolverView | null {
    const r = deps.store.latest(id, resolverKey(src))
    if (!r || recurred(r, src)) return null
    switch (r.status) {
      case "queued":
        return deps.config().enabled ? { state: "resolving", info: info(r, "queued") } : null
      case "running":
        return { state: "resolving", info: info(r, "resolving") }
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

  function skip(r: RunRow, why: string, reason: "restart" | "disabled" | "wait"): void {
    deps.store.update(r.id, { status: "skipped", summary: why, reason, finishedAt: now() })
    jobs.delete(r.id)
    order = null
    log(`[resolver] ${r.itemId} skipped — ${why}`)
  }

  /** Start what fits; skip what waited too long or was orphaned by a restart. */
  function pump(): void {
    const cfg = deps.config()
    let moved = false
    for (const r of [...ordered()]) {
      if (!jobs.has(r.id)) { skip(r, "lost its item (restart)", "restart"); moved = true; continue }
      if (!cfg.enabled) { skip(r, "resolver disabled", "disabled"); moved = true; continue }
      if (r.autonomy === "normal" && now() - r.createdAt > cfg.queueMaxMs) { skip(r, "waited too long for a slot", "wait"); moved = true; continue }
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
    order = null
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
      deps.store.update(r.id, { status: "resolved", action: res.action, summary: res.summary, reason: res.reason ?? null, outcome: res.outcome ?? "done", finishedAt })
    } else if (res.kind === "prepared") {
      deps.store.update(r.id, {
        status: "prepared", action: res.action ?? "prepared", summary: res.summary, reason: res.reason ?? null,
        phrase: res.phrase, severity: res.severity ?? null, outcome: res.outcome ?? "planned", finishedAt,
      })
    } else {
      deps.store.update(r.id, { status: "failed", action: "failed", summary: res.summary, outcome: "failed", finishedAt })
    }
    log(`[resolver] ${r.itemId} ${res.kind}: ${res.summary.slice(0, 120)}`)
  }

  /** Boot: rows a restart interrupted fall through (running) or queue again on the next render (queued). */
  function recover(): number {
    order = null
    return deps.store.closeInterrupted(now())
  }

  return {
    consider, view, ask, pump, recover,
    enabled: (): boolean => deps.config().enabled,
    running: (): number => runningItems.size,
    /** Runs waiting for a slot. */
    queued: (): number => ordered().length,
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
