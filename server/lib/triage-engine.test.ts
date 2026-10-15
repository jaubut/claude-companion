import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { type SourceItem, type TriageOption, expiredDigest } from "./triage"
import { CARD_TTL_MS, type ExecOutcome, HOUR_MS, createTriageEngine } from "./triage-engine"
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
    const row = (id: string) => ({ id, source: "pr" as const, title: "Approved — merging once the conflict clears · x", project: "Dash", repo: null, resolver: { status: "queued" as const, summary: "Approved", model: "pr-shepherd", finishedAt: null } })
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

describe("card TTL (2026-10-14)", () => {
  test("task / proposal cards idle 14+ days: logged, dismissed for that version, listed for the digest; new activity brings them back", async () => {
    const day = 24 * HOUR_MS
    clock = 100 * day
    const proposal: SourceItem = {
      source: "proposal", refId: "p-old", version: "7", title: "Epic Games login agent", project: null, createdAt: clock - 20 * day, updatedAt: clock - 20 * day,
      facts: { reasoning: "", prompt: "x" }, url: null, ref: { source: "proposal", taskId: "p-old", macFix: false },
    }
    const idlePr: SourceItem = {
      source: "pr", refId: "o/r#1", version: "v", title: "Old PR", project: "Dash", createdAt: clock - 30 * day, updatedAt: clock - 30 * day,
      facts: { reason: "x" }, url: "https://github.com/o/r/pull/1", ref: { source: "pr", taskId: "t1", prUrl: "https://github.com/o/r/pull/1", repo: "o/r", number: 1 },
    }
    sources = [blocked("stale", "v1", clock - CARD_TTL_MS - 1), blocked("fresh", "v1", clock - CARD_TTL_MS + 60_000), proposal, idlePr]
    const logged: { id: string; days: number }[] = []
    let failOnce = true
    const store = createTriageStore(new Database(":memory:"))
    const e = createTriageEngine({
      collect: async () => sources, phrase: async () => null, current: async (s) => s,
      execute: async () => execOut, store, broadcast: () => {}, now: () => clock,
      expire: async (src, idle) => {
        if (src.refId === "p-old" && failOnce) { failOnce = false; throw new Error("turso down") }
        logged.push({ id: src.refId, days: Math.floor(idle / day) })
      },
    })
    await e.refresh()
    // The proposal's log write failed: it stays a card (never dismissed silently); PRs have no TTL.
    expect(logged).toEqual([{ id: "stale", days: 14 }])
    expect(e.items().map((i) => i.id).sort()).toEqual(["pr:o/r#1", "proposal:p-old", "task:fresh"])
    await e.refresh()
    expect(logged).toEqual([{ id: "stale", days: 14 }, { id: "p-old", days: 20 }])
    expect(e.items().map((i) => i.id).sort()).toEqual(["pr:o/r#1", "task:fresh"])
    // Once per version: another refresh logs nothing more.
    await e.refresh()
    expect(logged).toHaveLength(2)
    expect(e.expiredSince(clock - day).map((c) => c.itemId)).toEqual(["task:stale", "proposal:p-old"])
    expect(expiredDigest(e.expiredSince(clock - day))).toBe("🗂 Triage dismissed 2 idle cards (14+ days, no activity): Task stale · Epic Games login agent")
    expect(expiredDigest([])).toBeNull()
    // Activity (a new version) brings the task back.
    sources = [blocked("stale", "v2", clock), blocked("fresh", "v1", clock - CARD_TTL_MS + 60_000), proposal]
    await e.refresh()
    expect(e.items().map((i) => i.id).sort()).toEqual(["task:fresh", "task:stale"])
  })
})

describe("repo field (needs-you-by-repo, 2026-10-15)", () => {
  test("a repo flip null → name keeps id + version: no re-phrase, exactly one more frame, choose 200 (not 409)", async () => {
    const e = engine()
    await e.refresh(); await e.idle()
    const before = frames.length
    expect(e.items()[0]).toMatchObject({ id: "task:t1", repo: null })
    sources = [{ ...blocked("t1"), repo: "claude-companion" }]
    await e.refresh(); await e.idle()
    expect(phraseCalls).toEqual(["t1@v1"]) // phrase cache keyed (id, version): still a hit
    expect(frames.length).toBe(before + 1)
    expect(e.items()[0]).toMatchObject({ id: "task:t1", repo: "claude-companion", title: "Phrased t1" })
    await e.refresh(); await e.idle()
    expect(frames.length).toBe(before + 1) // identical re-render → no frame
    // current() stays repo-free (only .version is compared)
    current.set("t1", blocked("t1"))
    const res = await e.choose({ id: "task:t1", optionId: e.items()[0]!.options[0]!.id })
    expect(res.status).toBe(200)
    expect(executed).toHaveLength(1)
  })

  test("a real version bump is still 409 stale, and `next` carries repo", async () => {
    sources = [{ ...blocked("t1"), repo: "TLSTUDIO" }]
    const e = engine()
    await e.refresh(); await e.idle()
    const opt = e.items()[0]!.options[0]!.id
    current.set("t1", blocked("t1", "v2"))
    sources = [{ ...blocked("t1", "v2"), repo: "TLSTUDIO" }]
    const res = await e.choose({ id: "task:t1", optionId: opt })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "stale", next: { id: "task:t1", repo: "TLSTUDIO" } })
  })

  test("busy (resolving) rows and pending rows carry repo", async () => {
    sources = [{ ...blocked("t1"), repo: "claude-companion" }, blocked("t2", "v1", 200)]
    const info = { status: "resolving" as const, summary: "Opus is on it", model: "opus", finishedAt: null }
    const e = createTriageEngine({
      collect: async () => sources, phrase: async () => null, current: async (s) => s,
      execute: async () => execOut, store: createTriageStore(new Database(":memory:")), broadcast: (f) => frames.push(f), now: () => clock,
      resolver: {
        enabled: () => true, pump: () => {}, consider: () => {}, ask: () => ({ ok: false, error: "not_routable" }),
        view: (_id, src) => ({ state: "resolving", info }),
      },
      pending: () => [{ id: "pr:jaubut/TLSTUDIO#4", source: "pr", title: "Approved · x", project: "TLSTUDIO", repo: "TLSTUDIO", resolver: { status: "queued", summary: "Approved", model: "pr-shepherd", finishedAt: null } }],
    })
    await e.refresh()
    expect(e.resolving().map((r) => [r.id, r.repo])).toEqual([
      ["task:t1", "claude-companion"], ["task:t2", null], ["pr:jaubut/TLSTUDIO#4", "TLSTUDIO"],
    ])
    expect(frames.at(-1)).toMatchObject({ resolving: [{ repo: "claude-companion" }, { repo: null }, { repo: "TLSTUDIO" }] })
  })
})
