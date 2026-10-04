import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BodyComponentDetail } from "./body"
import { type InvestigationReport, type InvestigationResult, RETRY_MS, createInvestigationStore } from "./body-investigate"
import * as m from "./body-investigate-engine"
import type { RunOutcome } from "./body-investigator"
import type { Task } from "./orchestrator-chat"

// Engine level: in-memory store, fake Turso detail, fake runner, fake peer.
// The engine is seams-only (no companion.db), so it is imported statically —
// a test that loaded orchestrator-db here would steal orchestrator-chat.test's
// legacy fixture (STATE.md, P1 notes).

type Mod = typeof m

const T0 = Date.UTC(2026, 9, 4, 12)
const RESULT: InvestigationResult = {
  rootCause: "script deleted", evidence: ["ls: no such file"], confidence: 0.9, severity: "med",
  recommendedFix: { summary: "restore it", steps: ["git checkout run.ts"], risk: "low", reversible: true }, retire: false, notes: "",
}

function detail(id: string, state = "dead"): BodyComponentDetail {
  return {
    ok: true, generated_at: "g",
    component: { id, host: id.split(":")[0]!, kind: "launchd", name: id.split(":")[2]!, schedule_s: 60, criticality: "med", depends_on: [], notes: "", first_seen: null, last_seen: null, retired: false, dependents: [], dependents_count: 0 },
    vitals: { component_id: id, observed_at: "o", state: state as "dead", last_exit: 1, last_run_at: null, last_ok_at: null, runs_total: 1, runs_delta: 0, consecutive_failures: 2, detail: "d" },
    events: [],
  }
}

interface RigOpts {
  local?: "mac" | "zettlab"
  enabled?: boolean
  run?: (prompt: string) => Promise<RunOutcome>
  forward?: Mod["createBodyInvestigator"] extends (d: infer D) => unknown ? D extends { forward: infer F } ? F : never : never
  sendReport?: ((r: InvestigationReport) => Promise<boolean>) | null
  problems?: { id: string; host: string | null; state: string; criticality: string | null }[]
  db?: Database
  clock?: { t: number }
}

function rig(o: RigOpts = {}) {
  const clock = o.clock ?? { t: T0 }
  const store = createInvestigationStore(o.db ?? new Database(":memory:"))
  const prompts: string[] = []
  const applied: { report: InvestigationReport; recordId: string }[] = []
  let enabled = o.enabled ?? true
  const inv = m.createBodyInvestigator({
    store,
    localHost: () => o.local ?? "mac",
    enabled: () => enabled,
    now: () => clock.t,
    fetchDetail: async (id) => detail(id),
    listProblems: async () => o.problems ?? [],
    paths: () => ({ files: [], commands: [], cwd: "/Users/j/tools", repo: "/Users/j/tools" }),
    run: async (p) => { prompts.push(p); return o.run ? o.run(p) : { ok: true, result: RESULT, raw: "" } },
    forward: o.forward ?? null,
    sendReport: o.sendReport ?? null,
    apply: async (report, rec) => { applied.push({ report, recordId: rec.id }); return report.result?.recommendedFix ? "prop1" : null },
    log: () => {},
  })
  return { inv, store, prompts, applied, clock, setEnabled: (v: boolean) => { enabled = v } }
}

describe("trigger + dedupe through the engine", () => {
  test("a transition runs once, records done, reports with the proposal id", async () => {
    const r = rig()
    const out = await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", fromState: "ok", trigger: "alert" })
    expect(out.status).toBe("started")
    await r.inv.idle()
    expect(r.prompts).toHaveLength(1)
    expect(r.prompts[0]).toContain("mac:launchd:x")
    const rec = r.store.get(out.id!)!
    expect(rec).toMatchObject({ status: "done", reported: true, proposalId: "prop1", runOn: "local", attempt: 1 })
    expect(rec.result?.rootCause).toBe("script deleted")
    expect(r.applied[0]!.report).toMatchObject({ componentId: "mac:launchd:x", status: "done", cwd: "/Users/j/tools", repo: true, runOn: "mac" })
  })

  test("same-state repeat: duplicate while open, cooldown after; a state change starts a new one", async () => {
    let release!: () => void
    const r = rig({ run: () => new Promise((res) => { release = () => res({ ok: true, result: RESULT, raw: "" }) }) })
    const first = await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "alert" })
    expect(await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", fromState: "dead", trigger: "alert" })).toMatchObject({ status: "duplicate", id: first.id })
    release()
    await r.inv.idle()
    r.clock.t += 60_000
    expect(await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "sweep" })).toMatchObject({ status: "skipped", reason: "cooldown" })
    const again = r.inv.consider({ componentId: "mac:launchd:x", state: "crash_loop", trigger: "alert" })
    expect((await again).status).toBe("started")
    release()
    await r.inv.idle()
    expect(r.prompts).toHaveLength(2)
  })

  test("not a problem state, kill switch", async () => {
    const r = rig()
    expect(await r.inv.consider({ componentId: "mac:launchd:x", state: "ok", trigger: "alert" })).toMatchObject({ status: "skipped" })
    r.setEnabled(false)
    expect(await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "alert" })).toEqual({ status: "disabled" })
    await r.inv.sweep()
    expect(r.prompts).toHaveLength(0)
  })

  test("budget: a 4th concurrent run waits", async () => {
    const releases: (() => void)[] = []
    const r = rig({ run: () => new Promise((res) => releases.push(() => res({ ok: true, result: RESULT, raw: "" }))) })
    for (const n of ["a", "b", "c"]) expect((await r.inv.consider({ componentId: `mac:launchd:${n}`, state: "dead", trigger: "sweep" })).status).toBe("started")
    expect(await r.inv.consider({ componentId: "mac:launchd:d", state: "dead", trigger: "sweep" })).toMatchObject({ status: "skipped", reason: "busy (3 running)" })
    await Bun.sleep(0)
    for (const f of releases) f()
    await r.inv.idle()
    expect((await r.inv.consider({ componentId: "mac:launchd:d", state: "dead", trigger: "sweep" })).status).toBe("started")
    await Bun.sleep(0)
    for (const f of releases) f()
    await r.inv.idle()
  })

  test("a failed run is recorded failed and reported with its attempt", async () => {
    const r = rig({ run: async () => ({ ok: false, error: "unparseable investigator output" }) })
    const out = await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "alert" })
    await r.inv.idle()
    expect(r.store.get(out.id!)).toMatchObject({ status: "failed", error: "unparseable investigator output", reported: true })
    expect(r.applied[0]!.report).toMatchObject({ status: "failed", attempt: 1, result: null })
    r.clock.t += RETRY_MS
    expect((await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "sweep" })).status).toBe("started")
    await r.inv.idle()
    expect(r.applied[1]!.report.attempt).toBe(2)
  })
})

describe("host routing", () => {
  test("Zettlab runs its own and cloud components; never the Mac's locally", async () => {
    const r = rig({ local: "zettlab" })
    expect((await r.inv.consider({ componentId: "zettlab:docker:x", state: "dead", trigger: "alert" })).status).toBe("started")
    expect((await r.inv.consider({ componentId: "cloud:http:dash", state: "failing", trigger: "alert" })).status).toBe("started")
    await r.inv.idle()
    expect(r.prompts).toHaveLength(2)
  })

  test("Zettlab forwards a Mac component; unreachable → pending_host → re-forwarded on the sweep", async () => {
    let up = false
    const calls: unknown[] = []
    const r = rig({
      local: "zettlab",
      forward: async (i) => { calls.push(i); return up ? { kind: "accepted", status: "started" } : { kind: "unreachable", reason: "peer unreachable (TimeoutError)" } },
      problems: [{ id: "mac:launchd:x", host: "mac", state: "dead", criticality: "low" }],
    })
    const first = await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", fromState: "ok", trigger: "alert" })
    expect(first).toMatchObject({ status: "pending_host", reason: "peer unreachable (TimeoutError)" })
    expect(r.prompts).toHaveLength(0)
    up = true
    await r.inv.sweep()
    expect(r.store.get(first.id!)).toMatchObject({ status: "forwarded", runOn: "peer", error: null })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ componentId: "mac:launchd:x", state: "dead", fromState: "ok" })
    // forwarded = open: no second forward
    await r.inv.sweep()
    expect(calls).toHaveLength(2)
  })

  test("no peer configured → pending_host naming the env var", async () => {
    const r = rig({ local: "zettlab" })
    expect(await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "alert" })).toMatchObject({ status: "pending_host", reason: "no peer configured (COMPANION_BODY_PEER)" })
  })

  test("the Mac never runs or forwards Zettlab components; a hopped request is never re-forwarded", async () => {
    const mac = rig({ local: "mac" })
    expect(await mac.inv.consider({ componentId: "zettlab:docker:x", state: "dead", trigger: "alert" })).toEqual({ status: "not_owner" })
    expect((await mac.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "forward", hop: true })).status).toBe("started")
    await mac.inv.idle()
    const z = rig({ local: "zettlab", forward: async () => ({ kind: "accepted", status: "started" }) })
    expect(await z.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "forward", hop: true })).toEqual({ status: "not_owner" })
  })

  test("Mac reports to its peer; falls back to its own #Body when that fails", async () => {
    const sent: InvestigationReport[] = []
    let accept = true
    const r = rig({ local: "mac", sendReport: async (rep) => { sent.push(rep); return accept } })
    const a = await r.inv.consider({ componentId: "mac:launchd:a", state: "dead", trigger: "alert" })
    await r.inv.idle()
    expect(sent).toHaveLength(1)
    expect(r.applied).toHaveLength(0)
    expect(r.store.get(a.id!)).toMatchObject({ reported: true })
    accept = false
    await r.inv.consider({ componentId: "mac:launchd:b", state: "dead", trigger: "alert" })
    await r.inv.idle()
    expect(r.applied.map((x) => x.report.componentId)).toEqual(["mac:launchd:b"])
  })

  test("receiveReport closes the forwarded record once; a replay is a no-op; an unknown one is inserted", async () => {
    const r = rig({ local: "zettlab", forward: async () => ({ kind: "accepted", status: "started" }) })
    const fwd = await r.inv.consider({ componentId: "mac:launchd:x", state: "dead", trigger: "alert" })
    const report: InvestigationReport = {
      id: "mac00001", componentId: "mac:launchd:x", host: "mac", state: "dead", status: "done", attempt: 1, startedAt: T0, finishedAt: T0 + 5,
      runOn: "mac", result: RESULT, error: null, cwd: "/Users/j/tools", repo: true,
    }
    expect(await r.inv.receiveReport(report)).toBe("applied")
    expect(r.store.get(fwd.id!)).toMatchObject({ status: "done", peerId: "mac00001", reported: true, proposalId: "prop1" })
    expect(await r.inv.receiveReport(report)).toBe("duplicate")
    expect(r.applied).toHaveLength(1)
    expect(await r.inv.receiveReport({ ...report, id: "mac00002", componentId: "mac:launchd:y" })).toBe("applied")
    expect(r.store.latest("mac:launchd:y")).toMatchObject({ status: "done", peerId: "mac00002", runOn: "peer" })
  })
})

describe("sweep", () => {
  test("stale forwards fail; pending_host for a recovered component is dropped; problems ordered by criticality", async () => {
    const order: string[] = []
    const r = rig({
      local: "zettlab",
      run: async (p) => { order.push(/component (\S+)/.exec(p)![1]!); return { ok: true, result: RESULT, raw: "" } },
      problems: [
        { id: "zettlab:docker:low", host: "zettlab", state: "dead", criticality: "low" },
        { id: "zettlab:docker:crit", host: "zettlab", state: "failing", criticality: "critical" },
      ],
    })
    const stale = r.store.insert({ componentId: "mac:launchd:s", host: "mac", state: "dead", trigger: "alert", status: "forwarded", runOn: "peer", attempt: 1, startedAt: T0 - 31 * 60_000 }, T0 - 31 * 60_000)
    const gone = r.store.insert({ componentId: "mac:launchd:g", host: "mac", state: "dead", trigger: "alert", status: "pending_host", runOn: "peer", attempt: 1, startedAt: T0 }, T0)
    await r.inv.sweep()
    await r.inv.idle()
    expect(r.store.get(stale.id)).toMatchObject({ status: "failed", error: "no report from the mac within 30 min" })
    expect(r.store.get(gone.id)).toMatchObject({ status: "dropped" })
    expect(order).toEqual(["zettlab:docker:crit", "zettlab:docker:low"])
  })

  test("restart idempotence: a new engine on the same db never re-runs a finished investigation", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-inv-restart-")), "c.db")
    const problems = [{ id: "mac:launchd:x", host: "mac", state: "dead", criticality: "med" }]
    const clock = { t: T0 }
    const a = rig({ db: new Database(file), problems, clock })
    await a.inv.sweep()
    await a.inv.idle()
    expect(a.prompts).toHaveLength(1)
    // an orphaned running row too, as if the process died mid-run
    a.store.insert({ componentId: "mac:launchd:y", host: "mac", state: "dead", trigger: "sweep", status: "running", runOn: "local", attempt: 1, startedAt: T0 }, T0)

    clock.t += 60_000
    const b = rig({ db: new Database(file), problems: [...problems, { id: "mac:launchd:y", host: "mac", state: "dead", criticality: "med" }], clock })
    expect(b.inv.recover()).toHaveLength(1)
    await b.inv.sweep()
    await b.inv.idle()
    expect(b.prompts).toHaveLength(0) // x in cooldown, y's interrupted run retries only after 10 min
    clock.t += RETRY_MS
    await b.inv.sweep()
    await b.inv.idle()
    expect(b.prompts.map((p) => /component (\S+)/.exec(p)![1])).toEqual(["mac:launchd:y"])
  })
})

describe("report applier", () => {
  function applier(o: { pushEnabled?: boolean; localHost?: "mac" | "zettlab" } = {}) {
    const turns: { text: string; taskId: string | null }[] = []
    const frames: Record<string, unknown>[] = []
    const proposals: { prompt: string; cwd: string; reasoning: string; target: unknown }[] = []
    const pushes: unknown[] = []
    const events: unknown[][] = []
    const cards: unknown[] = []
    let created = true
    const apply = m.createReportApplier({
      appendTurn: (text, taskId = null) => { turns.push({ text, taskId }); return { id: `t${turns.length}` } },
      ensureChannel: () => { const c = created; created = false; return { created: c, channel: { id: "body" } } },
      createProposal: (prompt, cwd, reasoning, target) => {
        proposals.push({ prompt, cwd, reasoning, target })
        return { taskId: "prop0001", threadId: "body", prompt, cwd, reasoning, status: "proposed", sessionKey: null, tmuxSession: null, logTail: null, createdAt: T0, updatedAt: T0, ...target } as Task
      },
      broadcast: (f) => frames.push(f),
      push: (p) => pushes.push(p),
      pushEnabled: () => o.pushEnabled ?? true,
      writeEvent: async (...a) => { events.push(a) },
      noteId: () => "projects/x",
      home: "/Users/j",
      // Applied on the component's own host (the fixture's base.host): platform-independent.
      localHost: () => (o.localHost ?? "mac"),
      now: () => T0,
      log: () => {},
      recordFixCard: (c) => cards.push(c),
    })
    return { apply, turns, frames, proposals, pushes, events, cards }
  }
  const rec = (id = "inv1") => ({ id }) as Parameters<ReturnType<typeof m.createReportApplier>>[1]
  const base: InvestigationReport = {
    id: "inv1", componentId: "mac:launchd:x", host: "mac", state: "dead", status: "done", attempt: 1, startedAt: T0, finishedAt: T0,
    runOn: "mac", result: RESULT, error: null, cwd: "/Users/j/tools", repo: true,
  }

  test("fix → 🔍 turn, proposal card (builder in the repo), task frame, Turso event; med severity never pushes", async () => {
    const a = applier()
    expect(await a.apply(base, rec())).toBe("prop0001")
    expect(a.turns[0]!.text).toStartWith("🔍 mac:launchd:x — script deleted (confidence 90%)")
    expect(a.proposals[0]).toMatchObject({ cwd: "/Users/j/tools", target: { noteId: "projects/x", agent: "builder", title: "Fix mac:launchd:x: restore it" } })
    expect(a.proposals[0]!.prompt).toContain("1. git checkout run.ts")
    expect(a.turns[1]).toMatchObject({ taskId: "prop0001" })
    expect(a.turns[1]!.text).toContain("· host mac")
    expect(a.turns[1]!.text).toContain("Approve to run it live on the mac (in /Users/j/tools).")
    // a Mac card remembers its host + cwd, so approval runs live on the Mac
    expect(a.cards).toEqual([{ taskId: "prop0001", host: "mac", componentId: "mac:launchd:x", cwd: "/Users/j/tools", noteId: "projects/x", agent: "builder", title: "Fix mac:launchd:x: restore it", investigationId: "inv1" }])
    expect(a.frames.map((f) => f.type)).toEqual(["orchestrator_channel", "orchestrator", "orchestrator", "orchestrator_task"])
    expect(a.events).toEqual([["mac:launchd:x", new Date(T0).toISOString(), "dead", "investigation inv1: script deleted (90%, med) · fix proposed [prop0001]"]])
    expect(a.pushes).toHaveLength(0)
  })

  test("a zettlab / cloud fix keeps the normal card (no host routing record)", async () => {
    const a = applier()
    await a.apply({ ...base, componentId: "zettlab:docker:x", host: "zettlab" }, rec())
    expect(a.cards).toHaveLength(0)
    expect(a.turns[1]!.text).toContain("Approve to file it.")
  })

  test("a card for another host gets a host-neutral ~/.claude (the Mac localizes it)", async () => {
    const a = applier({ localHost: "zettlab" })
    await a.apply({ ...base, cwd: null, repo: false }, rec())
    expect(a.proposals[0]).toMatchObject({ cwd: "~/.claude", target: { agent: "claude" } })
  })

  test("no fix → no proposal; no repo → claude in ~/.claude; high severity pushes", async () => {
    const a = applier()
    expect(await a.apply({ ...base, result: { ...RESULT, recommendedFix: null, severity: "high" } }, rec())).toBeNull()
    expect(a.proposals).toHaveLength(0)
    expect(a.turns.at(-1)!.text).toEndWith("No fix proposed.")
    expect(a.pushes).toHaveLength(1)
    expect(a.events[0]![3]).toContain("· no fix")
    await a.apply({ ...base, cwd: null, repo: false }, rec())
    expect(a.proposals[0]).toMatchObject({ cwd: "/Users/j/.claude", target: { agent: "claude" } })
  })

  test("failure: turn + event; push only on the second failure (and only with a sender)", async () => {
    const a = applier()
    await a.apply({ ...base, status: "failed", result: null, error: "timed out after 10 min" }, rec())
    expect(a.turns[0]!.text).toBe("🔍 mac:launchd:x — investigation failed: timed out after 10 min (will retry)")
    expect(a.pushes).toHaveLength(0)
    await a.apply({ ...base, status: "failed", result: null, error: "timed out after 10 min", attempt: 2 }, rec())
    expect(a.pushes).toHaveLength(1)
    expect(a.events).toHaveLength(2)
    const quiet = applier({ pushEnabled: false })
    await quiet.apply({ ...base, status: "failed", result: null, error: "x", attempt: 2 }, rec())
    expect(quiet.pushes).toHaveLength(0)
  })
})

describe("peer", () => {
  test("COMPANION_BODY_PEER validation", () => {
    const own = () => "own-token-1234567890"
    expect(m.bodyPeer({}, own)).toBeNull()
    expect(m.bodyPeer({ COMPANION_BODY_PEER: "https://mac.tail.ts.net/" }, own)).toEqual({ base: "https://mac.tail.ts.net", token: "own-token-1234567890" })
    expect(m.bodyPeer({ COMPANION_BODY_PEER: "http://100.92.1.2:4245", COMPANION_BODY_PEER_TOKEN: "peer-tok" }, own)).toEqual({ base: "http://100.92.1.2:4245", token: "peer-tok" })
    expect(m.bodyPeer({ COMPANION_BODY_PEER: "http://example.com:4245" }, own)).toBeNull()
    expect(m.bodyPeer({ COMPANION_BODY_PEER: "https://u:p@x.ts.net" }, own)).toBeNull()
    expect(m.bodyPeer({ COMPANION_BODY_PEER: "nope" }, own)).toBeNull()
  })

  test("forwarder: bearer + hop header; accepted / skipped / unreachable", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = []
    let reply: () => Response = () => Response.json({ ok: true, status: "started", id: "a" })
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      return reply()
    }) as unknown as typeof fetch
    const fwd = m.peerForwarder({ base: "https://mac.ts.net", token: "tok" }, fetchFn)
    expect(await fwd({ componentId: "mac:launchd:x", state: "dead", trigger: "alert" })).toEqual({ kind: "accepted", status: "started" })
    expect(seen[0]).toMatchObject({ url: "https://mac.ts.net/api/body/investigate", headers: { authorization: "Bearer tok", "x-companion-body-hop": "1" }, body: { component_id: "mac:launchd:x", state: "dead", from_state: null } })
    reply = () => Response.json({ ok: true, status: "skipped", reason: "cooldown" })
    expect(await fwd({ componentId: "mac:launchd:x", state: "dead", trigger: "sweep" })).toEqual({ kind: "skipped", reason: "skipped (cooldown)" })
    reply = () => new Response("Unauthorized", { status: 401 })
    expect(await fwd({ componentId: "mac:launchd:x", state: "dead", trigger: "sweep" })).toEqual({ kind: "unreachable", reason: "peer http 401" })
    reply = () => { throw new TypeError("fetch failed") }
    expect((await fwd({ componentId: "mac:launchd:x", state: "dead", trigger: "sweep" })).kind).toBe("unreachable")
    const rep = m.peerReporter({ base: "https://z.ts.net", token: "tok" }, fetchFn)
    reply = () => Response.json({ ok: true, status: "applied" })
    expect(await rep({ id: "x" } as InvestigationReport)).toBe(true)
    reply = () => new Response("no", { status: 500 })
    expect(await rep({ id: "x" } as InvestigationReport)).toBe(false)
  })

  test("brain digest only for #Body and health questions", () => {
    const s = createInvestigationStore(new Database(":memory:"))
    s.insert({ componentId: "mac:launchd:x", host: "mac", state: "dead", trigger: "alert", status: "running", runOn: "local", attempt: 1, startedAt: T0 }, T0)
    expect(m.investigationDigestFor("body", "hi", s, T0)).toContain("mac:launchd:x (dead): investigating")
    expect(m.investigationDigestFor("general", "what's broken?", s, T0)).toContain("mac:launchd:x")
    expect(m.investigationDigestFor("general", "status of the pelchat quote", s, T0)).toBeNull()
  })
})
