import { describe, expect, test } from "bun:test"
import { ACK_TEXT, type BrainHints, type BrainResult, type FrontDoorDeps, type TasksRoute, createFrontDoor } from "./front-door"
import type { Decided, Intent, RouterMode } from "./jev-router"
import type { RouteLogRow } from "./jev-route-log"
import type { Channel } from "./orchestrator-channels"
import { buildCatalog } from "./project-catalog"

const NOTES = [{ noteId: "projects/2026-03-26-chantal-masse-website", ref: "PRJ-UC3L", title: "Chantal Massé — Website", status: "done" }]
const catalog = buildCatalog(NOTES, "{ match: /chantal-masse-website/i, path: `${HOME}/chantalmasse-website` },", { home: "/h", isDir: () => true })
const site = catalog.candidates[0]!
const CH: Channel = {
  id: "general", name: "General", cwd: null, createdAt: 0, archived: false, autoDispatch: false,
  trust: { approved: 0, rejected: 0, streak: 0, eligible: false }, noteId: null, noteTitle: null, noteRef: null,
}

function decided(intent: Intent, conf = 0.9, project = true): Decided {
  return { ok: true, decision: { intent, intentConf: conf, project: project ? site : null, projectConf: project ? 0.9 : 0, projectSource: project ? "jev" : "none", jevMs: 150 } }
}

function harness(mode: RouterMode, d: Decided, over: Partial<FrontDoorDeps> = {}) {
  const calls = { brain: [] as BrainHints[], decide: 0, status: [] as unknown[], quick: [] as string[], proposals: [] as unknown[] }
  const turns: string[] = []
  const transient: string[] = []
  const logs: RouteLogRow[] = []
  const deps: FrontDoorDeps = {
    mode: () => mode,
    minConf: () => 0.7,
    catalog: async () => ({ projects: [{ noteId: site.noteId!, ref: site.ref, title: site.title, openAgentTasks: 0 }], catalog }),
    decide: async () => { calls.decide++; return d },
    thread: () => [{ id: "u1", threadId: "general", role: "user", text: "q", taskId: null, createdAt: 1 }],
    runBrain: async (_t, _c, hints) => { calls.brain.push(hints); turns.push("brain reply"); return { kind: "task", noteId: "projects/x" } satisfies BrainResult },
    status: async (p) => { calls.status.push(p); return "Queue (all projects): 1 running" },
    quickLook: async (prompt, repo) => { calls.quick.push(repo); return { ok: true, text: JSON.stringify({ answer: "Nuxt 3.12 (latest 4.1)", facts: ["package.json: nuxt ^3.12"], needsChange: true, proposal: { title: "Upgrade Nuxt", prompt: "Upgrade nuxt to 4.1" } }) } },
    emitTurn: (text) => turns.push(text),
    emitTransient: (text) => transient.push(text),
    stageProposal: async (p) => { calls.proposals.push(p) },
    log: (row) => logs.push(row),
    now: () => 1000,
    ackDelayMs: 10_000,
    ...over,
  }
  return { fd: createFrontDoor(deps), calls, turns, transient, logs }
}

describe("off", () => {
  test("old brain only: no Jev call, no log", async () => {
    const h = harness("off", decided("status"))
    await h.fd.handle("what's running?", CH)
    expect([h.calls.decide, h.calls.brain.length, h.logs.length]).toEqual([0, 1, 0])
    expect(h.calls.brain[0]).toEqual({})
  })
})

describe("shadow", () => {
  test("old brain answers with no hints; Jev logged with the old outcome", async () => {
    const h = harness("shadow", decided("quick_look"))
    await h.fd.handle("is chantalmasse.com on the latest nuxt?", CH)
    expect(h.calls.decide).toBe(1)
    expect(h.calls.brain.length).toBe(1)
    expect(Object.keys(h.calls.brain[0]!)).toEqual(["prebuilt"]) // no route hints in shadow
    expect(h.calls.status.length + h.calls.quick.length).toBe(0)
    expect(h.turns).toEqual(["brain reply"])
    expect(h.logs[0]).toMatchObject({
      mode: "shadow", intent: "quick_look", intentConf: 0.9, project: "chantal-masse-website", projectNoteId: site.noteId,
      route: "brain", oldOutcome: "task", oldNoteId: "projects/x", jevMs: 150, error: null,
    })
  })

  test("a Jev failure is logged as an error row, the answer is unaffected", async () => {
    const h = harness("shadow", { ok: false, error: "no_key", jevMs: 0 })
    await h.fd.handle("hi", CH)
    expect(h.turns).toEqual(["brain reply"])
    expect(h.logs[0]).toMatchObject({ intent: null, error: "no_key", oldOutcome: "task" })
  })
})

describe("live", () => {
  test("status → code answer, no model", async () => {
    const h = harness("live", decided("status", 0.95, false))
    await h.fd.handle("what's running?", CH)
    expect(h.calls.brain.length).toBe(0)
    expect(h.calls.status).toEqual([null])
    expect(h.turns).toEqual(["Queue (all projects): 1 running"])
    expect(h.logs[0]).toMatchObject({ route: "status", oldOutcome: null })
  })

  test("status scoped to a project the message named", async () => {
    const h = harness("live", decided("status"))
    await h.fd.handle("what's running on chantal?", CH)
    expect(h.calls.status).toEqual([{ noteId: site.noteId, title: site.title }])
  })

  test("quick_look → ack turn, facts, proposal card when a change is needed", async () => {
    const h = harness("live", decided("quick_look"))
    await h.fd.handle("is chantalmasse.com on the latest nuxt?", CH)
    expect(h.calls.quick).toEqual(["/h/chantalmasse-website"])
    expect(h.turns[0]).toBe("🔎 checking chantalmasse-website…")
    expect(h.turns[1]).toBe("🔎 chantalmasse-website — Nuxt 3.12 (latest 4.1)\n• package.json: nuxt ^3.12")
    expect(h.calls.proposals[0]).toMatchObject({ kind: "proposal", cwd: "/h/chantalmasse-website", noteId: site.noteId, agent: "builder", title: "Upgrade Nuxt" })
    expect(h.calls.brain.length).toBe(0)
  })

  test("quick_look with no change needed → no card; runner failure → failure turn", async () => {
    const h = harness("live", decided("quick_look"), { quickLook: async () => ({ ok: true, text: '{"answer":"Yes, 4.1","facts":[],"needsChange":false,"proposal":null}' }) })
    await h.fd.handle("latest nuxt?", CH)
    expect(h.calls.proposals.length).toBe(0)
    const f = harness("live", decided("quick_look"), { quickLook: async () => ({ ok: false, error: "timed out after 60 s" }) })
    await f.fd.handle("latest nuxt?", CH)
    expect(f.turns[1]).toContain("couldn't check (timed out after 60 s)")
  })

  test("task → compose directly with the resolved project; body → forced digest", async () => {
    const t = harness("live", decided("task"))
    await t.fd.handle("upgrade nuxt on chantalmasse.com", CH)
    expect(t.calls.brain[0]).toMatchObject({ forceTask: true, forceBodyDigest: false, resolved: { noteId: site.noteId, repo: "/h/chantalmasse-website" } })
    expect(t.logs[0]).toMatchObject({ route: "task", oldOutcome: null })
    const b = harness("live", decided("body", 0.9, false))
    await b.fd.handle("is zettlab ok", CH)
    expect(b.calls.brain[0]).toMatchObject({ forceTask: false, forceBodyDigest: true, resolved: null })
    expect(b.logs[0]).toMatchObject({ route: "body", oldOutcome: "task" })
  })

  test("low confidence, chat, or a Jev error → old brain", async () => {
    for (const d of [decided("status", 0.5), decided("chat"), { ok: false, error: "timeout", jevMs: 2000 } as Decided]) {
      const h = harness("live", d)
      await h.fd.handle("hmm", CH)
      expect(h.calls.brain.length).toBe(1)
      expect(h.calls.brain[0]!.forceTask).toBe(false)
      expect(h.logs[0]!.route).toBe("brain")
    }
  })

  test("a crash before any answer falls back to the plain old brain", async () => {
    const h = harness("live", decided("status"), { catalog: async () => { throw new Error("boom") } })
    await h.fd.handle("x", CH)
    expect(h.calls.brain).toEqual([{}])
  })
})

describe("ack", () => {
  test("transient ack when the answer is slow, none when it is fast", async () => {
    const slow = harness("off", decided("chat"), { ackDelayMs: 5, runBrain: async () => { await Bun.sleep(40); return { kind: "chat" } } })
    await slow.fd.handle("x", CH)
    expect(slow.transient).toEqual([ACK_TEXT])
    const fast = harness("live", decided("status", 0.95, false), { ackDelayMs: 30 })
    await fast.fd.handle("x", CH)
    await Bun.sleep(50)
    expect(fast.transient).toEqual([])
  })
})

describe("tasks tool (PRJ-CT4M WP5)", () => {
  function tasks(o: { hint?: boolean; handled?: boolean; confirm?: boolean } = {}) {
    const seen = { handle: [] as string[], recent: [] as string[][], confirm: 0 }
    const route: TasksRoute = {
      hint: () => o.hint ?? false,
      handle: async (text, _ch, recent) => { seen.handle.push(text); seen.recent.push(recent); return o.handled ?? true },
      confirmReply: async () => { seen.confirm++; return o.confirm ?? false },
    }
    return { route, seen }
  }

  test("live: Jev my_tasks → the tasks tool answers, no brain; logged as my_tasks", async () => {
    const t = tasks()
    const h = harness("live", decided("my_tasks", 0.9, false), { tasks: t.route })
    await h.fd.handle("what is on my plate this week", CH)
    expect(t.seen.handle).toEqual(["what is on my plate this week"])
    expect(h.calls.brain.length).toBe(0)
    expect(h.logs[0]).toMatchObject({ route: "my_tasks", intent: "my_tasks" })
  })

  test("live: the keyword hint routes even when Jev says chat", async () => {
    const t = tasks({ hint: true })
    const h = harness("live", decided("chat"), { tasks: t.route })
    await h.fd.handle("move everything Granby to Friday", CH)
    expect(t.seen.handle.length).toBe(1)
    expect(h.calls.brain.length).toBe(0)
  })

  test("not_tasks hands back to the normal path", async () => {
    const t = tasks({ handled: false })
    const h = harness("live", decided("my_tasks", 0.9, false), { tasks: t.route })
    await h.fd.handle("x", CH)
    expect(t.seen.handle.length).toBe(1)
    expect(h.calls.brain.length).toBe(1)
    expect(h.logs[0]).toMatchObject({ route: "brain", oldOutcome: "task" })
  })

  test("shadow + off: never routed to the tasks tool, even on a hint (kill switch / no answer change)", async () => {
    const t = tasks({ hint: true })
    const s = harness("shadow", decided("my_tasks"), { tasks: t.route })
    await s.fd.handle("what's on my plate", CH)
    expect([t.seen.handle.length, s.calls.brain.length, s.logs[0]!.route]).toEqual([0, 1, "brain"])
    const off = tasks({ hint: true })
    const o = harness("off", decided("chat"), { tasks: off.route })
    await o.fd.handle("what's on my plate", CH)
    expect([off.seen.handle.length, o.calls.brain.length, o.calls.decide]).toEqual([0, 1, 0])
  })

  test("a confirm reply to a held card is consumed before any routing", async () => {
    const t = tasks({ confirm: true })
    const h = harness("live", decided("chat"), { tasks: t.route })
    await h.fd.handle("confirm", CH)
    expect([t.seen.confirm, t.seen.handle.length, h.calls.decide, h.calls.brain.length]).toEqual([1, 0, 0, 0])
  })

  test("a tasks tool crash falls through to the brain", async () => {
    const h = harness("live", decided("my_tasks", 0.9, false), {
      tasks: { hint: () => false, confirmReply: async () => false, handle: async () => { throw new Error("turso down") } },
    })
    await h.fd.handle("x", CH)
    expect(h.calls.brain.length).toBe(1)
  })
})
