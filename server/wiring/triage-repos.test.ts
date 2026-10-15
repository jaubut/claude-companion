import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { Autonomy } from "../lib/resolver"
import { REPO_YES_INSTRUCTION } from "../lib/resolver"
import type { SourceItem, TriageOption } from "../lib/triage"
import { type ExecOutcome, createTriageEngine } from "../lib/triage-engine"
import { type TriageStore, createTriageStore } from "../lib/triage-store"
import { TursoUnreachable } from "../lib/turso"
import type { DispatchTask } from "../lib/dispatch-tasks"
import { actionTurn } from "./triage"
import { type RepoRunnerDeps, createRepoRunner, sweepInterruptedRuns } from "./triage-repos"

// The repo-card runner (needs-you-repo-yes-no, 2026-10-15) over the real
// triage engine and a real sqlite store (:memory:), with fake seams for the
// executor, the resolver, the PR ledger and Opus: Yes acts only on the posted
// snapshot, held PRs never move, pattern-B idempotency, one run per repo, the
// boot sweep, and No's one Opus rework with consent gating.

let sources: SourceItem[]
let executed: { id: string; kind: string; by: string | undefined; text: string | null }[]
let execOut: (src: SourceItem, option: TriageOption) => ExecOutcome
let asks: { id: string; instruction: string | null; autonomy: Autonomy | undefined }[]
let resolverOn: boolean
let unparked: string[]
let unparkFails: boolean
let revised: { id: string; title: string; prompt: string }[]
let reworkOut: string | null
let reworkPrompts: string[]
let probeFails: boolean
let turns: string[]
let store: TriageStore
let clock: number

function task(id: string, repo: string | null, version = "v1"): SourceItem {
  return {
    source: "task", refId: id, version, title: `Task ${id}`, project: "Dash", repo, createdAt: 10, updatedAt: 10,
    facts: { blocker: "Which currency?" }, url: null, ref: { source: "task", taskId: id, status: "blocked", channel: "general" },
  }
}
function proposal(id: string, repo: string | null, version = "1"): SourceItem {
  return {
    source: "proposal", refId: id, version, title: `Proposal ${id}`, project: "Dash", repo, createdAt: 5, updatedAt: 5,
    facts: { prompt: "Do it" }, url: null, ref: { source: "proposal", taskId: id, macFix: false },
  }
}
function pr(n: number, repo: string, parked: string): SourceItem {
  const url = `https://github.com/jaubut/${repo}/pull/${n}`
  return {
    source: "pr", refId: `jaubut/${repo}#${n}`, version: `v|${n}`, title: `PR ${n}`, project: repo, repo, createdAt: 30, updatedAt: 30,
    facts: { reason: parked }, url, hints: { safetyNet: false, parked }, ref: { source: "pr", taskId: `t${n}`, prUrl: url, repo: `jaubut/${repo}`, number: n },
  }
}

function setup(over: Partial<RepoRunnerDeps> = {}) {
  const engine = createTriageEngine({
    collect: async () => sources, phrase: async () => null,
    current: async (src) => sources.find((s) => s.refId === src.refId && s.source === src.source) ?? null,
    execute: async (src, option, text, by) => {
      executed.push({ id: `${src.source}:${src.refId}`, kind: option.action.kind, by, text: option.action.kind === "answer" ? option.action.text : text })
      return execOut(src, option)
    },
    store, broadcast: () => {}, now: () => clock,
    resolver: {
      enabled: () => resolverOn, pump: () => {}, consider: () => {}, view: () => null,
      ask: (id, _src, instruction, autonomy) => {
        if (!resolverOn) return { ok: false, error: "resolver_disabled" }
        asks.push({ id, instruction, autonomy })
        return { ok: true, runId: asks.length }
      },
    },
  })
  const runner = createRepoRunner({
    engine, store,
    unparkPr: async (src) => {
      if (unparkFails) throw new TursoUnreachable("turso 503")
      unparked.push(`${src.source}:${src.refId}`)
      return "done"
    },
    revise: async (src, title, prompt) => { revised.push({ id: `${src.source}:${src.refId}`, title, prompt }); return "p-new" },
    rework: async (prompt) => { reworkPrompts.push(prompt); return reworkOut },
    probe: async () => { if (probeFails) throw new TursoUnreachable("down") },
    turn: (text) => { turns.push(text) },
    now: () => clock,
    ...over,
  })
  return { engine, runner }
}

const snapshot = (card: { members: { id: string; version: string }[] }) => card.members.map((m) => ({ id: m.id, version: m.version }))

beforeEach(() => {
  sources = [task("a", "dash"), proposal("p", "dash"), pr(1, "dash", "CI still failing after 2 fixes"), pr(2, "dash", "touches src/auth.ts — needs your review"), task("o", "other-repo")]
  executed = []; asks = []; unparked = []; revised = []; reworkPrompts = []; turns = []
  execOut = () => ({ kind: "done" })
  resolverOn = true
  unparkFails = false
  probeFails = false
  reworkOut = null
  clock = 1_000_000
  store = createTriageStore(new Database(":memory:"))
})

describe("Yes", () => {
  test("acts on the posted snapshot: proposal approved, task to Opus (delegated), parked PR handed back; held PR never moves", async () => {
    const { engine, runner } = setup()
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    expect(card.held).toEqual(["pr:jaubut/dash#2"])
    const res = await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: [...snapshot(card), { id: "pr:jaubut/dash#2", version: "v|2" }], idemKey: "k1" })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ ok: true, repo: "dash", result: "running", skipped: [{ id: "pr:jaubut/dash#2", reason: "held" }] })
    await runner.idle()
    expect(executed).toEqual([{ id: "proposal:p", kind: "approve", by: "your Yes", text: null }])
    expect(asks).toEqual([{ id: "task:a", instruction: REPO_YES_INSTRUCTION, autonomy: "delegated" }])
    expect(unparked).toEqual(["pr:jaubut/dash#1"])
    const run = store.repoRun("dash", "k1")!
    expect(run.status).toBe("done")
    expect(run.results.map((r) => [r.id, r.result])).toEqual([["proposal:p", "done"], ["task:a", "with_opus"], ["pr:jaubut/dash#1", "handed_back"]])
    expect(run.summary).toBe("1 started · 1 with Opus · 1 handed back")
    expect(turns).toEqual(["✅ Your Yes on dash: 1 started · 1 with Opus · 1 handed back"])
    expect(engine.repos().find((c) => c.repo === "dash")!.run).toMatchObject({ status: "done", summary: run.summary })
  })

  test("a tampered member version is skipped as changed; an item that arrived after the snapshot is untouched", async () => {
    const { engine, runner } = setup()
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    sources.push(task("late", "dash"))
    await engine.refresh()
    const posted = snapshot(card).map((m) => (m.id === "proposal:p" ? { ...m, version: "tampered" } : m))
    const res = await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: posted, idemKey: "k2" })
    expect(res.body.skipped).toEqual([{ id: "proposal:p", reason: "changed" }])
    await runner.idle()
    expect(executed).toEqual([])
    expect(asks.map((a) => a.id)).toEqual(["task:a"])
  })

  test("a member that moved between the snapshot and its turn is skipped as changed (re-read before acting)", async () => {
    const { engine, runner } = setup()
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    sources = sources.map((s) => (s.refId === "p" ? proposal("p", "dash", "2") : s))
    await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: snapshot(card), idemKey: "k3" })
    await runner.idle()
    expect(executed).toEqual([])
    expect(store.repoRun("dash", "k3")!.results.find((r) => r.id === "proposal:p")).toMatchObject({ result: "skipped", reason: "changed" })
  })

  test("partial failure: per-item results, the rest still runs; failed items stay members of the next card", async () => {
    const { engine, runner } = setup()
    execOut = () => ({ kind: "error", status: 409, error: "live cap" })
    unparkFails = true
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: snapshot(card), idemKey: "k4" })
    await runner.idle()
    const run = store.repoRun("dash", "k4")!
    expect(run.summary).toBe("1 with Opus · 2 failed (live cap, turso_unreachable)")
    const next = engine.repos().find((c) => c.repo === "dash")!
    expect(next.members.map((m) => m.id)).toContain("proposal:p")
    expect(next.version).not.toBe(card.version)
  })

  test("resolver off (other host): tasks are held back (opus_off), the rest still runs", async () => {
    resolverOn = false
    const { engine, runner } = setup()
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: snapshot(card), idemKey: "k5" })
    await runner.idle()
    expect(store.repoRun("dash", "k5")!.results.find((r) => r.id === "task:a")).toMatchObject({ result: "skipped", reason: "opus_off" })
    expect(unparked).toEqual(["pr:jaubut/dash#1"])
  })

  test("zero actionable → 409 stale with the next card; unknown repo → 404; Turso down → 503 and no run row", async () => {
    const { engine, runner } = setup()
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    const stale = await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: [{ id: "task:a", version: "old" }], idemKey: "k6" })
    expect(stale).toMatchObject({ status: 409, body: { ok: false, error: "stale", next: { id: "repo:dash", version: card.version } } })
    expect((await runner.submit({ repo: "nope", decision: "yes", version: "x", members: [{ id: "task:a", version: "v1" }], idemKey: "k7" })).status).toBe(404)
    probeFails = true
    const down = await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: snapshot(card), idemKey: "k8" })
    expect(down).toMatchObject({ status: 503, body: { error: "turso_unreachable" } })
    expect(store.repoRun("dash", "k8")).toBeNull()
    expect(store.repoRun("dash", "k6")).toBeNull()
  })

  test("pattern B: the same Idempotency-Key replays the stored row (no second run); another key while running → 409 repo_busy", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { engine, runner } = setup({ unparkPr: async (src) => { await gate; unparked.push(src.refId); return "done" } })
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    const first = await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: snapshot(card), idemKey: "same" })
    expect(first.status).toBe(202)
    const busy = await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: snapshot(card), idemKey: "other" })
    expect(busy).toMatchObject({ status: 409, body: { error: "repo_busy", run: { id: first.body.runId, status: "running" } } })
    const replay = await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: snapshot(card), idemKey: "same" })
    expect(replay).toMatchObject({ status: 200, body: { ok: true, result: "replay", runId: first.body.runId, run: { status: "running" } } })
    release()
    await runner.idle()
    expect(unparked).toEqual(["jaubut/dash#1"])
    const again = await runner.submit({ repo: "dash", decision: "yes", version: card.version, members: snapshot(card), idemKey: "same" })
    expect(again).toMatchObject({ status: 200, body: { result: "replay", run: { status: "done" } } })
    expect(asks).toHaveLength(1)
  })

  test("boot sweep: a running row a restart interrupted → interrupted; its key replays the stored row", async () => {
    const { engine, runner } = setup()
    await engine.list()
    const row = store.insertRun({ repoKey: "dash", cardVersion: "v", decision: "yes", note: null, idemKey: "boot" }, clock)!
    expect(sweepInterruptedRuns(store, clock + 1)).toBe(1)
    expect(store.repoRun("dash", "boot")).toMatchObject({ id: row.id, status: "interrupted", finishedAt: clock + 1 })
    expect(store.runningRun("dash")).toBeNull()
    const replay = await runner.submit({ repo: "dash", decision: "yes", version: "v", members: [{ id: "task:a", version: "v1" }], idemKey: "boot" })
    expect(replay).toMatchObject({ status: 200, body: { result: "replay", run: { status: "interrupted" } } })
  })
})

describe("No", () => {
  const steps = (s: unknown[], consent = false) => JSON.stringify({ summary: "Smaller scope first.", consent, steps: s })

  test("one Opus rework: reject / revise / answer / ask_opus run; cancel without consent words is refused", async () => {
    const { engine, runner } = setup()
    sources.push(proposal("p2", "dash"))
    const card = (await engine.refresh(), engine.repos().find((c) => c.repo === "dash")!)
    reworkOut = steps([
      { id: "proposal:p", kind: "reject", why: "later" },
      { id: "proposal:p2", kind: "revise", title: "CSV only", prompt: "Add a CSV-only export", why: "smaller" },
      { id: "task:a", kind: "cancel", why: "obsolete" },
      { id: "pr:jaubut/dash#1", kind: "ask_opus", instruction: "rebase it and retry", why: "x" },
      { id: "pr:jaubut/dash#2", kind: "close_pr", why: "held" },
    ])
    const res = await runner.submit({ repo: "dash", decision: "no", version: card.version, note: "Too big — do the CSV part first", idemKey: "n1" })
    expect(res).toMatchObject({ status: 202, body: { ok: true, result: "running" } })
    await runner.idle()
    expect(reworkPrompts).toHaveLength(1)
    expect(reworkPrompts[0]).toContain("Too big — do the CSV part first")
    expect(executed).toEqual([{ id: "proposal:p", kind: "reject", by: "Opus", text: null }])
    expect(revised).toEqual([{ id: "proposal:p2", title: "CSV only", prompt: "Add a CSV-only export" }])
    expect(asks).toEqual([{ id: "pr:jaubut/dash#1", instruction: "rebase it and retry", autonomy: "elevated" }])
    const run = store.repoRun("dash", "n1")!
    expect(run).toMatchObject({ decision: "no", note: "Too big — do the CSV part first", status: "done" })
    expect(run.summary).toStartWith("Opus re-planned after your No: rejected 1, rescoped 1, handed to Opus 1, kept 1")
    expect(turns.at(-1)).toStartWith("🤖 Opus re-planned after your No")
    expect(engine.repos().find((c) => c.repo === "dash")!.version).not.toBe(card.version)
  })

  test("consent words let cancel run", async () => {
    const { engine, runner } = setup()
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    reworkOut = steps([{ id: "task:a", kind: "cancel", why: "obsolete" }])
    await runner.submit({ repo: "dash", decision: "no", version: card.version, note: "vas-y", idemKey: "n2" })
    await runner.idle()
    expect(executed).toEqual([{ id: "task:a", kind: "cancel", by: "Opus", text: null }])
  })

  test("resolver off → 409 resolver_disabled before any row; a moved card → 409 stale; Opus silent → failed run", async () => {
    resolverOn = false
    const { engine, runner } = setup()
    const card = (await engine.list()).repos.find((c) => c.repo === "dash")!
    expect(await runner.submit({ repo: "dash", decision: "no", version: card.version, note: "x", idemKey: "n3" })).toMatchObject({ status: 409, body: { error: "resolver_disabled" } })
    expect(store.repoRun("dash", "n3")).toBeNull()
    resolverOn = true
    expect(await runner.submit({ repo: "dash", decision: "no", version: "old", note: "x", idemKey: "n4" })).toMatchObject({ status: 409, body: { error: "stale", next: { id: "repo:dash" } } })
    reworkOut = null
    await runner.submit({ repo: "dash", decision: "no", version: card.version, note: "x", idemKey: "n5" })
    await runner.idle()
    expect(store.repoRun("dash", "n5")).toMatchObject({ status: "failed", summary: "Opus did not answer — nothing changed" })
    expect(executed).toEqual([])
  })
})

describe("the answer turn says it came from the Yes (2026-10-15, PR #168 drift check)", () => {
  const t = { id: "abcdef0123456789", agent: "builder", title: "Invoice totals" } as DispatchTask

  test("a delegated actor appends '(your Yes on <repo>)'; plain Opus and Jeremie's tap read as before", () => {
    expect(actionTurn("answer", t, "Per line.", "Opus (your Yes on dash)")).toBe("🤖 Opus answered [abcdef01] builder — Invoice totals (your Yes on dash)\nAnswer: Per line.")
    expect(actionTurn("requeue", t, null, "Opus (your Yes on dash)")).toBe("🤖 Opus requeued [abcdef01] builder — Invoice totals (your Yes on dash)")
    expect(actionTurn("answer", t, "Per line.", "Opus")).toBe("🤖 Opus answered [abcdef01] builder — Invoice totals\nAnswer: Per line.")
    expect(actionTurn("cancel", t, null, "triage")).toBe("cancelled [abcdef01] builder — Invoice totals (triage)")
  })
})
