import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { SourceItem, TriageOption } from "./triage"
import { type ExecOutcome, HOUR_MS, createTriageEngine } from "./triage-engine"
import { FALLBACK_RETRY_MS, createTriageStore } from "./triage-store"
import { TursoUnreachable } from "./turso"

// The triage loop over fakes: phrase once per (id, version), cache
// invalidation, fallback, frame once per change, ordering, snooze, choose
// (404 / 400 / 422 / 409 stale / 503 / idempotent replay).

let clock = 1_000_000
let sources: SourceItem[] = []
let current: Map<string, SourceItem | null>
let phraseCalls: string[] = []
let modelOut: (src: SourceItem) => string | null
let frames: Record<string, unknown>[] = []
let executed: { id: string; option: TriageOption; text: string | null }[] = []
let execOut: ExecOutcome
let currentThrows: Error | null = null
let modelGate: Promise<void> | null = null

function blocked(id: string, version = "v1", createdAt = 100, blocker = "Which currency?"): SourceItem {
  return {
    source: "task", refId: id, version, title: `Task ${id}`, project: "Dash", createdAt, updatedAt: createdAt,
    facts: { blocker }, url: null, ref: { source: "task", taskId: id, status: "blocked", channel: "general" },
  }
}

const goodModel = (src: SourceItem) => JSON.stringify({
  title: `Phrased ${src.refId}`, problem: "It waits for a currency.", action: "Answer CAD.",
  options: [{ label: "Use CAD", action: { kind: "answer", text: "CAD" } }, { label: "Cancel", action: { kind: "cancel" } }],
})

function engine() {
  return createTriageEngine({
    collect: async () => sources,
    phrase: async (src) => {
      phraseCalls.push(`${src.refId}@${src.version}`)
      if (modelGate) await modelGate
      return modelOut(src)
    },
    current: async (src) => {
      if (currentThrows) throw currentThrows
      return current.has(src.refId) ? current.get(src.refId)! : src
    },
    execute: async (src, option, text) => { executed.push({ id: src.refId, option, text }); return execOut },
    store: createTriageStore(new Database(":memory:")),
    broadcast: (f) => frames.push(f),
    now: () => clock,
  })
}

beforeEach(() => {
  clock = 1_000_000
  sources = [blocked("t1")]
  current = new Map()
  phraseCalls = []
  modelOut = goodModel
  frames = []
  executed = []
  execOut = { kind: "done" }
  currentThrows = null
  modelGate = null
})

describe("refresh + phrasing cache", () => {
  test("GET never waits for the model: fallback first, the phrased item replaces it in one more frame", async () => {
    let release!: () => void
    modelGate = new Promise((r) => { release = r })
    const e = engine()
    const first = await e.list()
    expect(first.items[0]!.problem).toBe("Which currency?") // fallback = blocker text
    expect(frames).toHaveLength(1)
    release()
    await e.idle()
    expect(e.items()[0]!.title).toBe("Phrased t1")
    expect(frames).toHaveLength(2)
    expect(frames[1]).toMatchObject({ type: "orchestrator_triage", items: [{ id: "task:t1", title: "Phrased t1" }] })
  })

  test("one model call per new item; refreshes with no change emit no frame", async () => {
    const e = engine()
    await e.refresh(); await e.idle()
    await e.refresh(); await e.refresh(); await e.idle()
    expect(phraseCalls).toEqual(["t1@v1"])
    expect(frames).toHaveLength(2)
  })

  test("a changed underlying version re-phrases (cache invalidation), the id stays the same", async () => {
    const e = engine()
    await e.refresh(); await e.idle()
    sources = [blocked("t1", "v2", 100, "Which branch?")]
    await e.refresh(); await e.idle()
    expect(phraseCalls).toEqual(["t1@v1", "t1@v2"])
    expect(e.items().map((i) => i.id)).toEqual(["task:t1"])
  })

  test("invalid model output → fallback, retried only after the retry window", async () => {
    modelOut = () => JSON.stringify({ problem: "x", action: "y", options: [{ label: "Merge", action: { kind: "merge" } }, { label: "z", action: { kind: "cancel" } }] })
    const e = engine()
    await e.refresh(); await e.idle()
    expect(e.items()[0]!.options.map((o) => o.action.kind)).toEqual(["answer_custom", "requeue", "cancel"])
    await e.refresh(); await e.idle()
    expect(phraseCalls).toHaveLength(1)
    clock += FALLBACK_RETRY_MS
    modelOut = goodModel
    await e.refresh(); await e.idle()
    expect(phraseCalls).toHaveLength(2)
    expect(e.items()[0]!.title).toBe("Phrased t1")
  })

  test("model unavailable (null) → fallback item, never an error", async () => {
    modelOut = () => null
    const e = engine()
    await e.refresh(); await e.idle()
    expect(e.items()[0]).toMatchObject({ id: "task:t1", problem: "Which currency?", recommended: "a" })
  })

  test("ordering: urgent first, then oldest", async () => {
    modelOut = () => null
    sources = [blocked("new", "v", 300), blocked("old", "v", 100), blocked("prod", "v", 200, "Prod is down — roll back?")]
    const e = engine()
    await e.refresh(); await e.idle()
    expect(e.items().map((i) => i.refId)).toEqual(["prod", "old", "new"])
  })
})

describe("choose", () => {
  async function ready() {
    const e = engine()
    await e.refresh(); await e.idle()
    return e
  }

  test("runs the mapped action and returns the next item", async () => {
    sources = [blocked("t1", "v1", 100), blocked("t2", "v1", 200)]
    const e = await ready()
    sources = [blocked("t2", "v1", 200)] // the executor moved t1
    const r = await e.choose({ id: "task:t1", optionId: "a" })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, id: "task:t1", result: "done", next: { id: "task:t2" } })
    expect(executed).toEqual([{ id: "t1", option: expect.objectContaining({ action: { kind: "answer", text: "CAD" } }), text: null }])
    expect(e.items().map((i) => i.id)).toEqual(["task:t2"])
  })

  test("404 unknown item · 400 unknown option · 422 answer_custom without text", async () => {
    modelOut = () => null // fallback: a = answer_custom
    const e = await ready()
    expect((await e.choose({ id: "task:nope", optionId: "a" })).status).toBe(404)
    expect((await e.choose({ id: "task:t1", optionId: "z" })).body).toMatchObject({ error: "unknown_option" })
    const r = await e.choose({ id: "task:t1", optionId: "a", text: "  " })
    expect(r).toMatchObject({ status: 422, body: { error: "text_required" } })
    expect(executed).toHaveLength(0)
    const ok = await e.choose({ id: "task:t1", optionId: "a", text: "Use CAD" })
    expect(ok.status).toBe(200)
    expect(executed[0]!.text).toBe("Use CAD")
  })

  test("409 stale when the underlying version moved; the item comes back refreshed", async () => {
    const e = await ready()
    const moved = blocked("t1", "v2", 100, "A new question?")
    current.set("t1", moved)
    sources = [moved]
    const r = await e.choose({ id: "task:t1", optionId: "a" })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ ok: false, error: "stale", id: "task:t1", next: { id: "task:t1", problem: "A new question?" } })
    expect(executed).toHaveLength(0)
  })

  test("409 stale when the item is gone underneath, or the guarded write lost its race", async () => {
    const e = await ready()
    current.set("t1", null)
    expect((await e.choose({ id: "task:t1", optionId: "a" })).status).toBe(409)
    current.delete("t1")
    execOut = { kind: "stale", reason: "conflict" }
    expect((await e.choose({ id: "task:t1", optionId: "a" })).body).toMatchObject({ error: "stale" })
  })

  test("503 when Turso is unreachable; executor errors keep their status", async () => {
    const e = await ready()
    currentThrows = new TursoUnreachable("timeout")
    expect(await e.choose({ id: "task:t1", optionId: "a" })).toMatchObject({ status: 503, body: { error: "turso_unreachable" } })
    currentThrows = null
    execOut = { kind: "error", status: 503, error: "gh_unreachable" }
    expect(await e.choose({ id: "task:t1", optionId: "a" })).toMatchObject({ status: 503, body: { error: "gh_unreachable" } })
  })

  test("Idempotency-Key: a repeat replays the stored result, a concurrent repeat shares the run, the action runs once", async () => {
    const e = await ready()
    const [a, b] = await Promise.all([
      e.choose({ id: "task:t1", optionId: "a", idemKey: "k1" }),
      e.choose({ id: "task:t1", optionId: "a", idemKey: "k1" }),
    ])
    const c = await e.choose({ id: "task:t1", optionId: "a", idemKey: "k1" })
    expect(executed).toHaveLength(1)
    expect(a.body.result).toBe("done")
    expect(b.body.result).toBe("done")
    expect(c).toMatchObject({ status: 200, body: { ok: true, id: "task:t1", result: "replay" } })
    // A refusal is not remembered: the same key retries for real.
    execOut = { kind: "error", status: 502, error: "merge_unverified" }
    expect((await e.choose({ id: "task:t1", optionId: "a", idemKey: "k2" })).status).toBe(502)
    execOut = { kind: "done" }
    expect((await e.choose({ id: "task:t1", optionId: "a", idemKey: "k2" })).body.result).toBe("done")
    expect(executed).toHaveLength(3)
  })

  test("snooze is local: hidden (one frame), never executed, back after it expires", async () => {
    const e = await ready()
    // A failed task's fallback carries a snooze option.
    sources = [{ ...blocked("f1"), ref: { source: "task", taskId: "f1", status: "failed", channel: null }, facts: { blocker: "crashed" } }]
    modelOut = () => null
    await e.refresh(); await e.idle()
    const opt = e.items()[0]!.options.find((o) => o.action.kind === "snooze")!
    const before = frames.length
    const r = await e.choose({ id: "task:f1", optionId: opt.id })
    expect(r.body).toMatchObject({ ok: true, result: "done", next: null })
    expect(executed).toHaveLength(0)
    expect(e.items()).toHaveLength(0)
    expect(frames.length).toBe(before + 1)
    clock += 24 * HOUR_MS
    await e.refresh()
    expect(e.items().map((i) => i.id)).toEqual(["task:f1"])
  })
})

describe("merge intent: queued outcome, pending rows, one log line per choose", () => {
  const pr = (id: string): SourceItem => ({
    source: "pr", refId: id, version: "v1", title: `PR ${id}`, project: "Dash", createdAt: 5, updatedAt: 5,
    facts: { reason: "touches books" }, url: `https://github.com/o/r/pull/${id}`, ref: { source: "pr", taskId: `t${id}`, prUrl: `https://github.com/o/r/pull/${id}`, repo: "o/r", number: 1 },
  })

  test("a queued execute → 202 { result: queued, detail }, logged with its status", async () => {
    const logs: string[] = []
    sources = [pr("1")]
    execOut = { kind: "queued", detail: { state: "approved_pending", reason: "conflict" } }
    const e = createTriageEngine({
      collect: async () => sources, phrase: async () => null, current: async (s) => s,
      execute: async () => execOut, store: createTriageStore(new Database(":memory:")), broadcast: () => {}, now: () => clock, log: (m) => logs.push(m),
    })
    await e.refresh()
    const item = e.items()[0]!
    const merge = item.options.find((o) => o.action.kind === "merge")!
    const r = await e.choose({ id: item.id, optionId: merge.id })
    expect(r).toMatchObject({ status: 202, body: { ok: true, id: item.id, result: "queued", detail: { state: "approved_pending", reason: "conflict" } } })
    expect(logs).toContain(`[triage] choose ${item.id} option=${merge.id} → merge · 202 result=queued reason=conflict`)
  })

  test("refusals and errors are logged too (status + code)", async () => {
    const logs: string[] = []
    sources = [pr("2")]
    execOut = { kind: "error", status: 502, error: "merge_unverified" }
    const e = createTriageEngine({
      collect: async () => sources, phrase: async () => null, current: async (s) => s,
      execute: async () => execOut, store: createTriageStore(new Database(":memory:")), broadcast: () => {}, now: () => clock, log: (m) => logs.push(m),
    })
    await e.refresh()
    const item = e.items()[0]!
    const merge = item.options.find((o) => o.action.kind === "merge")!
    expect((await e.choose({ id: item.id, optionId: merge.id })).status).toBe(502)
    expect(logs).toContain(`[triage] choose ${item.id} option=${merge.id} → merge · 502 error=merge_unverified`)
    await e.choose({ id: "pr:nope", optionId: "a" })
    expect(logs.at(-1)).toBe("[triage] choose pr:nope option=a → ? · 404 error=no_such_item")
  })

  test("pending rows join `resolving` after the resolver's, never twice and never next to a card", async () => {
    sources = [pr("3")]
    const row = (id: string) => ({ id, source: "pr" as const, title: "Approved — merging once the conflict clears · x", project: "Dash", resolver: { status: "queued" as const, summary: "Approved", model: "pr-shepherd", finishedAt: null } })
    const e = createTriageEngine({
      collect: async () => sources, phrase: async () => null, current: async (s) => s,
      execute: async () => execOut, store: createTriageStore(new Database(":memory:")), broadcast: (f) => frames.push(f), now: () => clock,
      pending: () => [row("pr:9"), row("pr:3")],
    })
    await e.refresh()
    expect(e.resolving().map((r) => r.id)).toEqual(["pr:9"])
    expect(frames.at(-1)).toMatchObject({ resolving: [{ id: "pr:9" }] })
  })
})
