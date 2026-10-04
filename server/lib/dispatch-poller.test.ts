import { beforeEach, describe, expect, test } from "bun:test"
import type { ApnsPayload } from "./apns"
import { type Mirror, type Seen, buildDispatchDigest, createDispatchWiring } from "./dispatch-poller"
import { type DispatchTask, phaseOf, seenKey } from "./dispatch-tasks"
import type { Channel } from "./orchestrator-channels"
import type { Turn } from "./orchestrator-chat"
import type { QueryFn, Row } from "./turso"
import { TursoUnreachable } from "./turso"

// Poller policy against a fake Turso (QueryFn seam) and an in-memory cursor
// with the production key/phase functions: diff per value, silent seed,
// restart safety, channel routing, push gating. No sqlite here — the real
// cursor + routes are covered in routes/orchestrator-dispatch.test.ts.

const ID = (n: number) => n.toString(16).padStart(32, "0")
let rows: Row[]
let columns: string[]
let failing: boolean
let links: Map<string, string>
let store: Map<string, Seen & { at: number }>
let turns: Turn[]

const fakeQuery: QueryFn = async (sql) => {
  if (failing) throw new TursoUnreachable("network")
  if (sql.includes("pragma_table_info")) return columns.map((name) => ({ name }))
  // Like Turso: an optional column comes back only when the SELECT names it.
  if (sql.includes("FROM tasks t")) {
    return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !/^dispatch_(pr|result)/.test(k) || sql.includes(k))))
  }
  return []
}

const memMirror: Mirror = {
  seenKey,
  lastSeen: (id) => store.get(id) ?? null,
  markSeen: (t: DispatchTask, now = 0) => { store.set(t.id, { phase: phaseOf(t), updatedAt: t.updatedAtRaw, key: seenKey(t), at: now }) },
  seenCount: () => store.size,
  pruneSeen: () => 0,
}

const channel = (id: string): Channel => ({
  id, name: id, cwd: null, createdAt: 0, archived: false, autoDispatch: false,
  trust: { approved: 0, rejected: 0, streak: 0, eligible: false }, noteId: null, noteTitle: null, noteRef: null,
})

function task(n: number, over: Row = {}): Row {
  return {
    id: ID(n), note_id: "projects/none", text: `task ${n}`, assignee: "agent:builder", done: 0,
    created_at: "2026-10-03 10:00:00", updated_at: "2026-10-03 10:00:00",
    dispatch_status: "queued", dispatch_blocker: null, dispatch_owner: null, note_title: "Some project", note_ref: null, ...over,
  }
}

function rig(pushEnabled = true) {
  const frames: Record<string, unknown>[] = []
  const pushes: ApnsPayload[] = []
  const logs: string[] = []
  const w = createDispatchWiring({
    query: fakeQuery,
    broadcast: (f) => frames.push(f),
    appendTurn: (text, taskId, channelId) => {
      const t: Turn = { id: String(turns.length), threadId: channelId, role: "orchestrator", text, taskId, createdAt: 0 }
      turns.push(t)
      return t
    },
    push: (p) => pushes.push(p),
    pushEnabled: () => pushEnabled,
    linkedNotes: () => links,
    getChannel: channel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    mirror: memMirror,
    generalChannel: "general",
    log: (m) => logs.push(m),
  })
  const of = (type: string) => frames.filter((f) => f.type === type)
  const reset = () => { frames.length = 0; pushes.length = 0 }
  return { w, frames, pushes, logs, of, reset }
}

const turnsFor = (taskId: string) => turns.filter((t) => t.taskId === taskId)
const blocked = (n: number, at: string, over: Row = {}) => task(n, { dispatch_status: "blocked", dispatch_blocker: "no repo mapped", updated_at: at, ...over })

beforeEach(() => {
  rows = []
  columns = ["id", "dispatch_status"]
  failing = false
  links = new Map()
  store = new Map()
  turns = []
})

describe("dispatch poller", () => {
  test("first-ever poll seeds silently: frames, no turns, no push", async () => {
    rows = [blocked(1, "2026-10-03 10:00:00")]
    const r = rig()
    expect(await r.w.poll()).toBe(true)
    expect(r.of("orchestrator_task")).toHaveLength(1)
    expect(turns).toHaveLength(0)
    expect(r.pushes).toHaveLength(0)
  })

  test("emits once per value change; a count-only change emits no task frame", async () => {
    rows = [task(2)]
    const r = rig()
    await r.w.poll() // seed
    await r.w.poll()
    r.reset()
    await r.w.poll()
    expect(r.of("orchestrator_task")).toHaveLength(0)

    // Count-only change: a second task appears; task 2 is untouched.
    rows = [task(2), task(3)]
    await r.w.poll()
    expect(r.of("orchestrator_task").map((f) => (f.task as { taskId: string }).taskId)).toEqual([ID(3)])
    expect(r.of("orchestrator_queue")).toHaveLength(1)
    expect(r.of("orchestrator_queue")[0]!.queue).toEqual({ cap: 3, live: 0, queued: 0, dispatch: { queued: 2, running: 0, blocked: 0, pr: 0 } })

    // Value change on task 2 → blocked: one frame, one turn, one push — once.
    r.reset()
    rows = [blocked(2, "2026-10-03 11:00:00"), task(3)]
    await r.w.poll()
    await r.w.poll()
    const tf = r.of("orchestrator_task")
    expect(tf).toHaveLength(1)
    expect(tf[0]!.task).toMatchObject({ taskId: ID(2), status: "error", dispatchStatus: "blocked", blocker: "no repo mapped", source: "dispatch", threadId: "general" })
    expect(turnsFor(ID(2)).map((t) => t.text)).toEqual(["blocked [00000000] builder — task 2\nReason: no repo mapped"])
    expect(turnsFor(ID(2))[0]!.threadId).toBe("general")
    expect(r.pushes).toHaveLength(1)
    expect(r.pushes[0]).toMatchObject({ title: "Blocked: task 2", category: "dispatch_task", userInfo: { kind: "dispatch_task", taskId: ID(2), channel: "general" } })

    // Same status, new updated_at (e.g. blocker rewritten): frame yes, no second turn.
    r.reset()
    rows = [blocked(2, "2026-10-03 11:30:00", { dispatch_blocker: "still no repo" }), task(3)]
    await r.w.poll()
    expect(r.of("orchestrator_task")).toHaveLength(1)
    expect(turnsFor(ID(2))).toHaveLength(1)
  })

  test("restart: cursor survives → no re-announce; boot poll catches up with a turn but never pushes", async () => {
    rows = [task(4)]
    await rig().w.poll()
    rows = [blocked(4, "2026-10-03 12:00:00")]
    const before = rig()
    await before.w.poll()
    expect(turnsFor(ID(4))).toHaveLength(1)

    const restarted = rig()
    await restarted.w.poll()
    expect(restarted.of("orchestrator_task")).toHaveLength(0)
    expect(turnsFor(ID(4))).toHaveLength(1)
    expect(restarted.pushes).toHaveLength(0)

    rows = [task(4, { dispatch_status: "queued", updated_at: "2026-10-03 12:05:00" })]
    await restarted.w.poll()
    rows = [blocked(4, "2026-10-03 12:10:00")]
    const again = rig()
    await again.w.poll()
    expect(turnsFor(ID(4))).toHaveLength(2)
    expect(again.pushes).toHaveLength(0)
  })

  test("P0 columns: absent → completed; present → pr turn with URL + verdict; done → one more turn, no push", async () => {
    const pr = "https://github.com/x/y/pull/9"
    rows = [task(6, { dispatch_status: "running" })]
    const r = rig()
    await r.w.poll()
    rows = [task(6, { dispatch_status: "completed", dispatch_blocker: "review: APPROVE", updated_at: "2026-10-03 13:00:00", dispatch_pr_url: pr })]
    await r.w.poll()
    expect(turnsFor(ID(6))[0]!.text).toStartWith("completed")

    columns = ["id", "dispatch_pr_url", "dispatch_result_ref"]
    const fresh = rig() // fresh column probe
    rows = [task(7, { dispatch_status: "running" })]
    await fresh.w.poll()
    rows = [task(7, { dispatch_status: "completed", dispatch_blocker: "review: APPROVE", updated_at: "2026-10-03 13:00:00", dispatch_pr_url: pr })]
    await fresh.w.poll()
    expect(turnsFor(ID(7))[0]!.text).toBe(`PR ready [00000000] builder — task 7\n${pr} · review: APPROVE`)
    expect(fresh.pushes.map((p) => p.title)).toEqual(["PR ready: task 7"])
    rows = [task(7, { dispatch_status: "completed", done: 1, updated_at: "2026-10-03 14:00:00", dispatch_pr_url: pr })]
    await fresh.w.poll()
    expect(turnsFor(ID(7)).map((t) => t.text.split(" ")[0])).toEqual(["PR", "done"])
    expect(fresh.pushes).toHaveLength(1)
  })

  test("cancelled (done=1) and failed are listed, not announced", async () => {
    rows = [task(11), task(12)]
    const r = rig()
    await r.w.poll()
    rows = [task(11, { dispatch_status: "cancelled", done: 1, updated_at: "2026-10-03 15:00:00" }), task(12, { dispatch_status: "failed", updated_at: "2026-10-03 15:00:00" })]
    await r.w.poll()
    expect(turns).toHaveLength(0)
    expect(r.w.tasksFor("general").map((t) => [t.status, t.dispatchStatus, t.done])).toEqual([["cancelled", "cancelled", true], ["error", "failed", false]])
  })

  test("routing: a linked channel owns its note's tasks; #Body lists blocked everywhere", async () => {
    links = new Map([["projects/linked", "dash"]])
    rows = [task(8, { note_id: "projects/linked" }), blocked(9, "2026-10-03 10:00:00")]
    const r = rig()
    await r.w.poll()
    expect(r.w.tasksFor("dash").map((t) => t.taskId)).toEqual([ID(8)])
    expect(r.w.tasksFor("dash")[0]!.threadId).toBe("dash")
    expect(r.w.tasksFor("general").map((t) => t.taskId)).toEqual([ID(9)])
    expect(r.w.tasksFor("body").map((t) => t.taskId)).toEqual([ID(9)])
    expect(r.w.decorate(channel("dash")).counts).toEqual({ queued: 1, running: 0, blocked: 0, pr: 0 })

    r.reset()
    rows = [task(8, { note_id: "projects/linked", dispatch_status: "blocked", dispatch_blocker: "y", updated_at: "2026-10-03 15:00:00" }), rows[1]!]
    await r.w.poll()
    expect(turnsFor(ID(8))[0]!.threadId).toBe("dash")
    expect(r.of("orchestrator_channel").map((f) => (f.channel as { id: string; counts: unknown }).id)).toEqual(["dash", "body"]) // body gained a blocked task too
  })

  test("push gate: disabled host never pushes; at most 3 per poll + one overflow", async () => {
    rows = [1, 2, 3, 4, 5].map((n) => task(100 + n))
    const off = rig(false)
    await off.w.poll()
    await off.w.poll()
    rows = [1, 2, 3, 4, 5].map((n) => blocked(100 + n, "2026-10-03 16:00:00"))
    await off.w.poll()
    expect(off.pushes).toHaveLength(0)

    store = new Map()
    rows = [1, 2, 3, 4, 5].map((n) => task(200 + n))
    const on = rig(true)
    await on.w.poll()
    await on.w.poll()
    rows = [1, 2, 3, 4, 5].map((n) => blocked(200 + n, "2026-10-03 16:00:00"))
    await on.w.poll()
    expect(on.pushes).toHaveLength(4)
    expect(on.pushes[3]!.collapseId).toBe("dispatch-overflow")
  })

  test("Turso failure: poll false, one log line per streak, cache kept, columns re-probed", async () => {
    rows = [task(10)]
    const r = rig()
    await r.w.poll()
    failing = true
    expect(await r.w.poll()).toBe(false)
    expect(await r.w.poll()).toBe(false)
    expect(r.logs.filter((l) => l.includes("poll failed"))).toHaveLength(1)
    expect(r.w.cached(ID(10))?.id).toBe(ID(10))
    failing = false
    columns = ["dispatch_pr_url"]
    expect(await r.w.poll()).toBe(true)
    expect(r.logs.some((l) => l.includes("recovered"))).toBe(true)
    expect(await r.w.columns()).toEqual({ prUrl: true, resultRef: false })
  })

  test("single-flight poll and a 2 s nudge window", async () => {
    rows = [task(13)]
    const r = rig()
    const [a, b] = [r.w.poll(), r.w.poll()]
    expect(a).toBe(b)
    await a
    expect(r.w.nudge()).toBe(true)
    expect(r.w.nudge()).toBe(false) // inside 2 s: arms one trailing poll instead
    r.w.stop()
  })
})

describe("buildDispatchDigest (brain context)", () => {
  const blocked = (i: number): DispatchTask => ({
    id: String(i).padStart(32, "0"), noteId: "n", title: `task ${i}`, agent: "builder", status: "blocked", done: false,
    blocker: "needs   an\nanswer", owner: null, prUrl: null, resultRef: null, projectTitle: "Dash", projectRef: null,
    createdAt: 0, updatedAt: i, updatedAtRaw: String(i),
  })
  test("counts, top 5 blocked with flattened reasons, overflow line, ≤ 800 chars", () => {
    const d = buildDispatchDigest("all projects", { queued: 2, running: 1, blocked: 7, pr: 1 }, [1, 2, 3, 4, 5, 6, 7].map(blocked))
    expect(d.split("\n")[0]).toBe("Dispatch queue (all projects): 2 queued · 1 running · 7 blocked · 1 PR open")
    expect(d).toContain("- [00000000] builder — task 1 (Dash): needs an answer")
    expect(d).not.toContain("task 6")
    expect(d).toContain("…and 2 more blocked")
    expect(buildDispatchDigest("x", { queued: 0, running: 0, blocked: 0, pr: 0 }, [])).toBe("Dispatch queue (x): 0 queued · 0 running · 0 blocked · 0 PR open")
    expect(buildDispatchDigest("x", { queued: 0, running: 0, blocked: 9, pr: 0 }, [1, 2, 3, 4, 5].map(blocked), 120).length).toBeLessThanOrEqual(120)
  })
})
