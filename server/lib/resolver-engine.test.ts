import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { ResolverConfig } from "./resolver"
import { type Job, type WorkResult, createResolverEngine, localDay, maybeDigest } from "./resolver-engine"
import { type ResolverStore, createResolverStore } from "./resolver-store"
import { ASK_OPUS_ID, type Phrase, type SourceItem, fallbackPhrase } from "./triage"
import { createTriageEngine } from "./triage-engine"
import { createTriageStore } from "./triage-store"

// The resolver scheduler: hidden while working, resolved / prepared / failed
// views, the daily budget, ≤ 2 concurrent, the queue wait, the kill switch,
// timeouts (fall-through), ask_opus escalation, restart recovery, the digest;
// then the triage integration (resolving[], the Opus card, the ask_opus option).

let clock = Date.parse("2026-10-04T10:00:00")
let cfg: ResolverConfig
let store: ResolverStore
let jobs: Job[]
let gates: Map<string, { resolve: (r: WorkResult) => void }>
let changes: boolean[]

function task(id: string, blocker = "Which currency?"): SourceItem {
  return {
    source: "task", refId: id, version: `blocked|v-${id}`, title: `Task ${id}`, project: "Dash", createdAt: 1, updatedAt: 1,
    facts: { status: "blocked", blocker }, url: null, ref: { source: "task", taskId: id, status: "blocked", channel: "general" },
  }
}

function tripItem(): SourceItem {
  return {
    source: "trip", refId: "trip-1", version: "1", title: "Trip Granby → Montréal", project: "Travel log", createdAt: 1, updatedAt: 1,
    facts: { problem: "Trip — business?" }, url: null,
    ref: { source: "trip", tripId: "trip-1", guess: "business", clientSlug: "humance", clientName: "Humance", altSlug: null, altName: null },
  }
}

const preparedCard = (src: SourceItem): Phrase => ({ ...fallbackPhrase(src), title: "Opus card", context: "Opus analysis" })

function makeEngine() {
  return createResolverEngine({
    store,
    config: () => cfg,
    routable: (src) => src.source !== "trip",
    work: (job) => {
      jobs.push(job)
      return new Promise<WorkResult>((resolve) => gates.set(job.src.refId, { resolve }))
    },
    onChange: (finished) => changes.push(finished),
    now: () => clock,
  })
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const id = (s: SourceItem) => `${s.source}:${s.refId}`

beforeEach(() => {
  clock = Date.parse("2026-10-04T10:00:00")
  cfg = { enabled: true, model: "claude-opus-5-5", maxConcurrent: 2, maxPerDay: 20, timeoutMs: 20 * 60_000, queueMaxMs: 15 * 60_000, dryRun: false }
  store = createResolverStore(new Database(":memory:"))
  jobs = []
  gates = new Map()
  changes = []
})

describe("scheduler", () => {
  test("a new item is hidden while Opus works it, then resolved (hidden) or prepared (Opus's card)", async () => {
    const e = makeEngine()
    const a = task("a"), b = task("b")
    e.consider(id(a), a)
    e.consider(id(b), b)
    expect(e.view(id(a), a)?.state).toBe("resolving")
    expect(jobs.map((j) => j.src.refId)).toEqual(["a", "b"])
    expect(jobs[0]!.model).toBe("claude-opus-5-5")
    gates.get("a")!.resolve({ kind: "resolved", action: "answer", summary: "Opus answered: CAD" })
    gates.get("b")!.resolve({ kind: "prepared", phrase: preparedCard(b), summary: "Needs Jeremie: client wording" })
    await e.idle()
    expect(e.view(id(a), a)).toMatchObject({ state: "resolved" })
    const v = e.view(id(b), b)
    expect(v).toMatchObject({ state: "prepared", info: { status: "prepared", summary: "Needs Jeremie: client wording", model: "claude-opus-5-5" } })
    expect(changes).toContain(true)
  })

  test("one run per (item, resolver key): a re-render never re-runs it", () => {
    const e = makeEngine()
    const a = task("a")
    e.consider(id(a), a)
    e.consider(id(a), a)
    expect(jobs).toHaveLength(1)
  })

  test("≤ 2 concurrent: the third waits (hidden), starts when a slot frees", async () => {
    const e = makeEngine()
    const items = ["a", "b", "c"].map((x) => task(x))
    for (const s of items) e.consider(id(s), s)
    expect(jobs).toHaveLength(2)
    expect(e.view(id(items[2]!), items[2]!)?.state).toBe("resolving")
    gates.get("a")!.resolve({ kind: "failed", summary: "x" })
    await flush()
    await flush()
    expect(jobs.map((j) => j.src.refId)).toEqual(["a", "b", "c"])
  })

  test("a waiting run past the queue limit is skipped: the normal card, nothing lost", () => {
    const e = makeEngine()
    const items = ["a", "b", "c"].map((x) => task(x))
    for (const s of items) e.consider(id(s), s)
    clock += cfg.queueMaxMs + 1
    e.pump()
    expect(e.view(id(items[2]!), items[2]!)).toBeNull()
  })

  test("daily budget: past maxPerDay a new item is not taken (normal card)", async () => {
    cfg.maxPerDay = 2
    const e = makeEngine()
    const items = ["a", "b", "c"].map((x) => task(x))
    for (const s of items) e.consider(id(s), s)
    expect(jobs).toHaveLength(2)
    expect(e.view(id(items[2]!), items[2]!)).toBeNull()
    gates.get("a")!.resolve({ kind: "failed", summary: "x" })
    await flush()
    e.consider(id(items[2]!), items[2]!)
    expect(jobs).toHaveLength(2)
  })

  test("kill switch: nothing new starts and waiting items show as normal cards", () => {
    const e = makeEngine()
    cfg.enabled = false
    const a = task("a")
    e.consider(id(a), a)
    expect(jobs).toHaveLength(0)
    expect(e.view(id(a), a)).toBeNull()
    cfg.enabled = true
    cfg.maxConcurrent = 0
    e.consider(id(a), a)
    expect(e.view(id(a), a)?.state).toBe("resolving")
    cfg.enabled = false
    expect(e.view(id(a), a)).toBeNull()
    e.pump()
    expect(store.queued()).toHaveLength(0)
  })

  test("a run past its deadline falls through as failed", async () => {
    cfg.timeoutMs = 5
    const e = makeEngine()
    const a = task("a")
    e.consider(id(a), a)
    await e.idle()
    expect(e.view(id(a), a)).toMatchObject({ state: "failed", info: { status: "failed" } })
    expect(e.view(id(a), a)!.info.summary).toContain("timed out")
  })

  test("a crashing run falls through as failed", async () => {
    const e = createResolverEngine({ store, config: () => cfg, routable: () => true, work: async () => { throw new Error("boom") }, onChange: () => {}, now: () => clock })
    const a = task("a")
    e.consider(id(a), a)
    await e.idle()
    expect(e.view(id(a), a)?.info.summary).toBe("resolver error: boom")
  })

  test("ask_opus: an elevated run with the instruction, outside the daily budget; refused when off", async () => {
    cfg.maxPerDay = 1
    const e = makeEngine()
    const a = task("a"), b = task("b")
    e.consider(id(a), a)
    gates.get("a")!.resolve({ kind: "prepared", phrase: preparedCard(a), summary: "card" })
    await e.idle()
    expect(e.ask(id(b), b, "do it")).toMatchObject({ ok: true })
    expect(jobs.at(-1)).toMatchObject({ autonomy: "elevated", instruction: "do it" })
    expect(e.ask(id(a), a, " make it smaller ")).toMatchObject({ ok: true })
    expect(e.view(id(a), a)?.state).toBe("resolving")
    cfg.enabled = false
    expect(e.ask(id(a), a, null)).toEqual({ ok: false, error: "resolver_disabled" })
    expect(e.ask(id(tripItem()), tripItem(), null)).toEqual({ ok: false, error: "resolver_disabled" })
    cfg.enabled = true
    expect(e.ask(id(tripItem()), tripItem(), null)).toEqual({ ok: false, error: "not_routable" })
  })

  test("a resolved item that comes back on a new version (re-blocked, same question) gets a card-only run, never hidden forever", async () => {
    const e = makeEngine()
    const a = task("a")
    e.consider(id(a), a)
    gates.get("a")!.resolve({ kind: "resolved", action: "answer", summary: "Opus answered: CAD" })
    await e.idle()
    expect(e.view(id(a), a)?.state).toBe("resolved")
    const back = { ...a, version: "blocked|later" }
    expect(e.view(id(back), back)).toBeNull()
    e.consider(id(back), back)
    expect(jobs.at(-1)).toMatchObject({ repeat: true, autonomy: "normal" })
    expect(e.view(id(back), back)?.state).toBe("resolving")
    gates.get("a")!.resolve({ kind: "prepared", phrase: preparedCard(back), summary: "came back" })
    await e.idle()
    e.consider(id(back), back)
    expect(jobs).toHaveLength(2)
    expect(e.view(id(back), back)?.state).toBe("prepared")
  })

  test("restart: queued/running rows fall through", () => {
    const e = makeEngine()
    const a = task("a")
    e.consider(id(a), a)
    expect(makeEngine().recover()).toBe(1)
    expect(e.view(id(a), a)).toMatchObject({ state: "failed", info: { summary: "interrupted by a server restart" } })
  })

  test("dry-run config reaches the job", () => {
    cfg.dryRun = true
    const e = makeEngine()
    const a = task("a")
    e.consider(id(a), a)
    expect(jobs[0]!.dryRun).toBe(true)
  })
})

describe("backlog (budget starvation)", () => {
  const failed = (x: string, createdAt: number): SourceItem => ({ ...task(x), createdAt, version: `failed|${x}`, facts: { status: "failed", error: "x" }, ref: { source: "task", taskId: x, status: "failed", channel: "general" } })
  const aged = (x: string, createdAt: number): SourceItem => ({ ...task(x), createdAt })

  test("waiting items are listed as queued with their place; the backlog drains urgent → low, oldest first", async () => {
    const e = makeEngine()
    const [a, b] = [aged("a", 1), aged("b", 2)]
    e.consider(id(a), a)
    e.consider(id(b), b)
    const low = failed("c", 1), young = aged("d", 50), old = aged("e", 10)
    for (const s of [low, young, old]) e.consider(id(s), s)
    expect(e.view(id(old), old)).toMatchObject({ state: "resolving", info: { status: "queued", queuePosition: 1, summary: "Opus queued (1)" } })
    expect(e.view(id(young), young)?.info.queuePosition).toBe(2)
    expect(e.view(id(low), low)?.info.queuePosition).toBe(3)
    expect(e.view(id(a), a)?.info.status).toBe("resolving")
    expect(e.queued()).toBe(3)
    gates.get("a")!.resolve({ kind: "failed", summary: "x" })
    gates.get("b")!.resolve({ kind: "failed", summary: "x" })
    await flush(); await flush()
    expect(jobs.map((j) => j.src.refId)).toEqual(["a", "b", "e", "d"])
  })

  test("ask_opus runs never count against the daily budget", async () => {
    cfg.maxPerDay = 1
    const e = makeEngine()
    const a = task("a"), b = task("b"), c = task("c")
    e.ask(id(a), a, "do it")
    e.ask(id(b), b, "do it")
    gates.get("a")!.resolve({ kind: "failed", summary: "x" })
    gates.get("b")!.resolve({ kind: "failed", summary: "x" })
    await e.idle()
    e.consider(id(c), c)
    expect(jobs.map((j) => j.src.refId)).toEqual(["a", "b", "c"])
  })

  test("a queued row a restart dropped is queued again on the next render (never a dead card)", () => {
    cfg.maxConcurrent = 0
    const e = makeEngine()
    const a = task("a")
    e.consider(id(a), a)
    expect(makeEngine().recover()).toBe(1)
    const fresh = makeEngine()
    expect(fresh.view(id(a), a)).toBeNull()
    fresh.consider(id(a), a)
    expect(fresh.view(id(a), a)?.info.status).toBe("queued")
  })

  test("the run's outcome reaches the view", async () => {
    const e = makeEngine()
    const a = task("a")
    e.consider(id(a), a)
    gates.get("a")!.resolve({ kind: "prepared", phrase: preparedCard(a), summary: "Fix failed: no checkout", outcome: "failed" })
    await e.idle()
    expect(e.view(id(a), a)).toMatchObject({ state: "prepared", info: { status: "prepared", summary: "Fix failed: no checkout", outcome: "failed" } })
  })
})

describe("digest", () => {
  test("once a day after the hour, with the day's counts", async () => {
    const e = makeEngine()
    for (const x of ["a", "b"]) {
      const s = task(x)
      e.consider(id(s), s)
    }
    gates.get("a")!.resolve({ kind: "resolved", action: "answer", summary: "Opus answered: CAD" })
    gates.get("b")!.resolve({ kind: "prepared", phrase: preparedCard(task("b")), summary: "card" })
    await e.idle()
    const posted: string[] = []
    expect(maybeDigest(store, clock, 21, (t) => posted.push(t))).toBeNull()
    const evening = Date.parse("2026-10-04T21:05:00")
    expect(maybeDigest(store, evening, 21, (t) => posted.push(t))).toBe("🤖 Opus handled 2 items today: answered 1, closed 0, prepared 1 for you.")
    expect(maybeDigest(store, evening + 60_000, 21, (t) => posted.push(t))).toBeNull()
    expect(posted).toHaveLength(1)
    expect(localDay(evening)).toBe("2026-10-04")
  })
})

describe("triage integration", () => {
  function triage(resolver: ReturnType<typeof makeEngine> | null, sources: SourceItem[], frames: Record<string, unknown>[] = []) {
    return createTriageEngine({
      collect: async () => sources, phrase: async () => null, current: async (s) => s,
      execute: async () => ({ kind: "done" }), store: createTriageStore(new Database(":memory:")),
      broadcast: (f) => frames.push(f), now: () => clock, resolver,
    })
  }

  test("new items are listed in resolving[], not items; Opus's card then shows with resolver info + Ask Opus", async () => {
    const r = makeEngine()
    const a = task("a")
    const frames: Record<string, unknown>[] = []
    const t = triage(r, [a, tripItem()], frames)
    const first = await t.list()
    expect(first.items.map((i) => i.id)).toEqual(["trip:trip-1"])
    expect(first.items[0]!.options.some((o) => o.action.kind === "ask_opus")).toBe(false)
    expect(first.resolving).toEqual([{ id: "task:a", source: "task", title: "Task a", project: "Dash", resolver: expect.objectContaining({ status: "resolving", model: "claude-opus-5-5" }) }])
    expect(frames.at(-1)).toMatchObject({ type: "orchestrator_triage", resolving: [expect.objectContaining({ id: "task:a" })] })
    gates.get("a")!.resolve({ kind: "prepared", phrase: preparedCard(a), summary: "Opus: needs your call on client wording" })
    await r.idle()
    await flush()
    t.render()
    const item = t.items().find((i) => i.id === "task:a")!
    expect(item.title).toBe("Opus card")
    expect(item.context).toBe("Opus analysis")
    expect(item.resolver).toMatchObject({ status: "prepared", summary: "Opus: needs your call on client wording", model: "claude-opus-5-5" })
    expect(item.options.at(-1)).toMatchObject({ id: ASK_OPUS_ID, action: { kind: "ask_opus" } })
    expect(t.resolving()).toEqual([])
  })

  test("choose ask_opus hands it back with the typed instruction; the item goes back to resolving", async () => {
    const r = makeEngine()
    const a = task("a")
    const t = triage(r, [a])
    await t.list()
    gates.get("a")!.resolve({ kind: "prepared", phrase: preparedCard(a), summary: "card" })
    await r.idle()
    await flush()
    t.render()
    const res = await t.choose({ id: "task:a", optionId: ASK_OPUS_ID, text: "just fix it" })
    expect(res.status).toBe(200)
    expect(res.body.detail).toEqual({ resolver: "resolving" })
    expect(jobs.at(-1)).toMatchObject({ autonomy: "elevated", instruction: "just fix it" })
    expect(t.resolving().map((x) => x.id)).toEqual(["task:a"])
    const again = await t.choose({ id: "task:a", optionId: "a" })
    expect(again).toMatchObject({ status: 409, body: { error: "resolving" } })
  })

  test("a resolved item disappears; a failed run falls through to the normal card, marked", async () => {
    const r = makeEngine()
    const a = task("a"), b = task("b")
    const t = triage(r, [a, b])
    await t.list()
    gates.get("a")!.resolve({ kind: "resolved", action: "answer", summary: "Opus answered: CAD" })
    gates.get("b")!.resolve({ kind: "failed", summary: "Opus run failed: claude exited 1" })
    await r.idle()
    await flush()
    t.render()
    expect(t.items().map((i) => i.id)).toEqual(["task:b"])
    expect(t.items()[0]!.resolver).toMatchObject({ status: "failed", summary: "Opus run failed: claude exited 1" })
    expect(t.items()[0]!.options[0]!.action.kind).toBe("answer_custom")
  })

  test("no resolver: no resolving[], no Ask Opus option, ask_opus refused", async () => {
    const t = triage(null, [task("a")])
    const l = await t.list()
    expect(l.resolving).toEqual([])
    expect(l.items[0]!.options.some((o) => o.action.kind === "ask_opus")).toBe(false)
  })
})
