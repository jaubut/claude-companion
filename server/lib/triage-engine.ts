import { ANSWER_MAX } from "./dispatch-tasks"
import type { AskResult, ResolverView } from "./resolver-engine"
import {
  type Phrase, type ResolvingItem, type Severity, type SourceItem, type TriageItem, type TriageOption,
  buildItem, fallbackPhrase, heuristicSeverity, itemId, orderItems, triageDigest, validatePhrase, withAskOpus,
} from "./triage"
import type { TriageStore } from "./triage-store"
import { TursoUnreachable } from "./turso"

// The triage loop over injected seams (wiring/triage.ts is the live instance).
//   refresh  collect → cached phrase for (id, version) or the fallback now +
//            ONE background phrasing per new/changed item → order → emit the
//            `orchestrator_triage` frame only when the items changed.
//   choose   Idempotency-Key replay (stored choice records) → 404 / 400 / 422
//            → snooze locally, or re-read the source (409 stale when its
//            version moved) and run the mapped action through the executor.

export type ExecOutcome =
  | { kind: "done"; detail?: Record<string, unknown> }
  /** Accepted, lands later (merge intent: approval recorded, the PR shepherd merges) → 202 `queued`. */
  | { kind: "queued"; detail: Record<string, unknown> }
  | { kind: "stale"; reason?: string }
  | { kind: "error"; status: number; error: string; extra?: Record<string, unknown> }

/** The Opus resolver as triage sees it (lib/resolver-engine.ts; null = off). */
export interface TriageResolverHook {
  enabled(): boolean
  /** Start pending work / expire waits (once per render). */
  pump(): void
  consider(id: string, src: SourceItem): void
  view(id: string, src: SourceItem): ResolverView | null
  ask(id: string, src: SourceItem, instruction: string | null): AskResult
}

export interface TriageEngineDeps {
  /** Everything that needs Jeremie right now (unphrased). */
  collect: () => Promise<SourceItem[]>
  /** The model's raw text for one item, or null (unavailable). */
  phrase: (src: SourceItem) => Promise<string | null>
  /** Optional pre-classifier (Jev); null = heuristics. */
  severity?: (src: SourceItem, phrase: Phrase) => Promise<Severity | null>
  /** Re-read one source now; null = it no longer needs Jeremie. May throw TursoUnreachable. */
  current: (src: SourceItem) => Promise<SourceItem | null>
  execute: (src: SourceItem, option: TriageOption, text: string | null) => Promise<ExecOutcome>
  store: TriageStore
  broadcast: (frame: Record<string, unknown>) => void
  now?: () => number
  log?: (msg: string) => void
  maxConcurrent?: number
  resolver?: TriageResolverHook | null
  /** Rows for the "Opus is on it" line that are not resolver runs (approved merges waiting on GitHub). */
  pending?: () => ResolvingItem[]
}

export interface ChooseInput { id: string; optionId: string; text?: string | null; idemKey?: string | null }
export interface ChooseResult { status: number; body: Record<string, unknown> }

export const HOUR_MS = 60 * 60_000

export function createTriageEngine(deps: TriageEngineDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const max = deps.maxConcurrent ?? 2
  let sources = new Map<string, SourceItem>()
  let items: TriageItem[] = []
  let resolving: ResolvingItem[] = []
  let generatedAt = 0
  let lastKey = ""
  let collected = false
  let refreshing: Promise<void> | null = null
  let again = false
  const phrasing = new Map<string, Promise<void>>()
  const waiting: (() => void)[] = []
  let running = 0
  const choosing = new Map<string, Promise<ChooseResult>>()

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= max) await new Promise<void>((r) => waiting.push(r))
    running++
    try {
      return await fn()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  async function phraseOne(id: string, src: SourceItem): Promise<void> {
    const raw = await slot(() => deps.phrase(src)).catch(() => null)
    const valid = validatePhrase(raw, src)
    if (raw !== null && !valid) log(`[triage] ${id}: model output invalid — fallback`)
    const phrase = valid ?? fallbackPhrase(src)
    const severity = (await deps.severity?.(src, phrase).catch(() => null)) ?? heuristicSeverity(src)
    deps.store.savePhrase(id, { version: src.version, phrase, severity, origin: valid ? "model" : "fallback", createdAt: now() })
    if (sources.get(id)?.version === src.version) render()
  }

  function schedule(id: string, src: SourceItem): void {
    const key = `${id}\n${src.version}`
    if (phrasing.has(key)) return
    const p = phraseOne(id, src)
      .catch((err) => log(`[triage] phrase ${id} failed: ${(err as Error)?.message ?? err}`))
      .finally(() => phrasing.delete(key))
    phrasing.set(key, p)
  }

  function publish(next: TriageItem[], nextResolving: ResolvingItem[]): void {
    items = next
    resolving = nextResolving
    const key = JSON.stringify([next, nextResolving])
    if (key === lastKey) return
    lastKey = key
    generatedAt = now()
    deps.broadcast({ type: "orchestrator_triage", items, resolving, generatedAt })
  }

  /** Rebuild the list from the last collection (cache hits, else fallback + schedule). */
  function render(): void {
    const t = now()
    const out: TriageItem[] = []
    const busy: ResolvingItem[] = []
    const r = deps.resolver ?? null
    r?.pump()
    const ask = r?.enabled() ? withAskOpus : (i: TriageItem) => i
    for (const [id, src] of sources) {
      if (deps.store.snoozedUntil(id, t)) continue
      r?.consider(id, src)
      const v = r?.view(id, src) ?? null
      if (v?.state === "resolving") {
        busy.push({ id, source: src.source, title: src.title, project: src.project, resolver: v.info })
        continue
      }
      if (v?.state === "resolved") continue
      if (v?.state === "prepared") {
        out.push(ask(buildItem(src, v.phrase, v.severity ?? heuristicSeverity(src), v.info)))
        continue
      }
      const failed = v?.state === "failed" ? v.info : undefined
      const cached = deps.store.phrase(id, src.version, t)
      if (cached) {
        out.push(ask(buildItem(src, cached.phrase, cached.severity, failed)))
        continue
      }
      out.push(ask(buildItem(src, fallbackPhrase(src), heuristicSeverity(src), failed)))
      schedule(id, src)
    }
    const shown = new Set([...out.map((i) => i.id), ...busy.map((b) => b.id)])
    const waiting = (deps.pending?.() ?? []).filter((p) => !shown.has(p.id))
    publish(orderItems(out), [...(r ? orderBusy(busy, r) : busy), ...waiting])
  }

  /** Queue places settle once every item was considered; working runs first, then the queue in order. */
  function orderBusy(busy: ResolvingItem[], r: TriageResolverHook): ResolvingItem[] {
    const fresh = busy.map((b) => {
      const src = sources.get(b.id)
      const v = src ? r.view(b.id, src) : null
      return v?.state === "resolving" ? { ...b, resolver: v.info } : b
    })
    const place = (b: ResolvingItem) => b.resolver.status === "queued" ? b.resolver.queuePosition ?? Number.MAX_SAFE_INTEGER : 0
    return fresh.sort((x, y) => place(x) - place(y))
  }

  let lastPrune = 0
  async function refreshOnce(): Promise<void> {
    if (now() - lastPrune > HOUR_MS) {
      lastPrune = now()
      deps.store.prune(now())
    }
    const list = await deps.collect()
    sources = new Map(list.map((s) => [itemId(s.source, s.refId), s]))
    collected = true
    render()
  }

  /** Single-flight; a request during a run triggers exactly one more run. */
  function refresh(): Promise<void> {
    if (refreshing) {
      again = true
      return refreshing
    }
    refreshing = (async () => {
      try {
        do {
          again = false
          await refreshOnce().catch((err) => log(`[triage] refresh failed: ${(err as Error)?.message ?? err}`))
        } while (again)
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  async function list(): Promise<{ items: TriageItem[]; resolving: ResolvingItem[]; generatedAt: number }> {
    if (!collected) await refresh()
    return { items, resolving, generatedAt: generatedAt || now() }
  }

  const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ChooseResult => ({ status, body: { ok: false, error, ...extra } })
  const itemNow = (id: string) => items.find((i) => i.id === id) ?? null

  async function stale(id: string): Promise<ChooseResult> {
    await refresh()
    return fail(409, "stale", { id, next: itemNow(id) })
  }

  async function runChoice(input: ChooseInput, seen: { kind: string }): Promise<ChooseResult> {
    if (!collected) await refresh()
    let item = itemNow(input.id)
    if (!item) {
      await refresh()
      item = itemNow(input.id)
    }
    const src = sources.get(input.id)
    if (!item && resolving.some((r) => r.id === input.id)) return fail(409, "resolving", { id: input.id, next: null })
    if (!item || !src) return fail(404, "no_such_item", { id: input.id })
    const option = item.options.find((o) => o.id === input.optionId)
    if (!option) return fail(400, "unknown_option", { id: input.id })
    seen.kind = option.action.kind
    const text = input.text?.trim() || null
    if ((option.action.kind === "answer_custom" || option.action.kind === "classify_custom") && !text) return fail(422, "text_required", { id: input.id })
    if (text && text.length > ANSWER_MAX) return fail(400, "text_too_long", { id: input.id })
    if (option.action.kind === "ask_opus") return askOpus(input, src, option.action.instruction ?? null, text)
    if (option.action.kind === "snooze") {
      deps.store.snooze(input.id, now() + option.action.hours * HOUR_MS)
      render()
      return done(input)
    }
    let cur: SourceItem | null
    try {
      cur = await deps.current(src)
    } catch (err) {
      return unavailable(err)
    }
    if (!cur || cur.version !== src.version) return stale(input.id)
    let out: ExecOutcome
    try {
      out = await deps.execute(src, option, text)
    } catch (err) {
      return unavailable(err)
    }
    if (out.kind === "stale") return stale(input.id)
    if (out.kind === "error") return fail(out.status, out.error, { id: input.id, ...out.extra })
    await refresh()
    if (out.kind === "queued") return done(input, out.detail, 202, "queued")
    return done(input, out.detail)
  }

  /** Hand the item back to Opus: the typed text wins over a prefilled instruction. */
  function askOpus(input: ChooseInput, src: SourceItem, prefilled: string | null, text: string | null): ChooseResult {
    const r = deps.resolver
    if (!r) return fail(409, "resolver_disabled", { id: input.id })
    const out = r.ask(input.id, src, text ?? prefilled)
    if (!out.ok) return fail(409, out.error, { id: input.id })
    render()
    return done(input, { resolver: "resolving" })
  }

  function unavailable(err: unknown): ChooseResult {
    const name = (err as Error)?.name
    const what = err instanceof TursoUnreachable ? "turso_unreachable" : name === "GhUnreachable" ? "gh_unreachable"
      : name === "DashboardUnreachable" || name === "DashboardKeyMissing" ? "dashboard_unreachable" : "unavailable"
    log(`[triage] choose failed: ${(err as Error)?.message ?? err}`)
    return fail(503, what)
  }

  function done(input: ChooseInput, detail?: Record<string, unknown>, status = 200, result: "done" | "queued" = "done"): ChooseResult {
    const next = items.find((i) => i.id !== input.id) ?? null
    const body = { ok: true, id: input.id, result, next, ...(detail ? { detail } : {}) }
    if (input.idemKey) {
      deps.store.saveChoice({ itemId: input.id, idemKey: input.idemKey, optionId: input.optionId, result: body, createdAt: now() })
    }
    return { status, body }
  }

  /** One line per choose, whatever the outcome: item, option + action, HTTP status, result or error code. */
  function logChoice(input: ChooseInput, kind: string, res: ChooseResult): void {
    const b = res.body
    const what = b.ok === false ? `error=${String(b.error ?? "?")}` : `result=${String(b.result ?? "?")}`
    const reason = b.detail && typeof b.detail === "object" ? (b.detail as Record<string, unknown>).reason : undefined
    log(`[triage] choose ${input.id} option=${input.optionId} → ${kind} · ${res.status} ${what}${reason ? ` reason=${String(reason)}` : ""}`)
  }

  /** At most once per (id, Idempotency-Key): a stored success replays; a concurrent repeat shares the run. */
  async function choose(input: ChooseInput): Promise<ChooseResult> {
    if (input.idemKey) {
      const rec = deps.store.choice(input.id, input.idemKey)
      if (rec) {
        const res = { status: 200, body: { ...rec.result, result: "replay" } }
        logChoice(input, "replay", res)
        return res
      }
      const inflight = choosing.get(`${input.id}\n${input.idemKey}`)
      if (inflight) return inflight
    }
    const seen = { kind: "?" }
    const run = runChoice(input, seen)
      .then((res) => {
        logChoice(input, seen.kind, res)
        return res
      }, (err: unknown) => {
        log(`[triage] choose ${input.id} option=${input.optionId} → ${seen.kind} · threw: ${(err as Error)?.message ?? err}`)
        throw err
      })
    if (!input.idemKey) return run
    const key = `${input.id}\n${input.idemKey}`
    const p = run.finally(() => choosing.delete(key))
    choosing.set(key, p)
    return p
  }

  return {
    refresh, list, choose, render,
    items: (): TriageItem[] => items,
    resolving: (): ResolvingItem[] => resolving,
    digest: (): string | null => triageDigest(items),
    /** Test seam: every background phrasing finished. */
    async idle(): Promise<void> {
      while (phrasing.size) await Promise.all([...phrasing.values()])
    },
  }
}

export type TriageEngine = ReturnType<typeof createTriageEngine>
