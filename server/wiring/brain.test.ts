import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Session } from "../lib/sessions"
import type { SpawnResult } from "../lib/spawn-session"

// brain-v2 supervisor + delivery (wiring/brain.ts) over fake deps: no herdr,
// no panes. Real Companion sqlite (outbox, trace, turns) in an isolated db.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-wiring-")), "test.db")

let mod: typeof import("./brain")
let chat: typeof import("../lib/orchestrator-chat")
let store: typeof import("../lib/brain-store")
let sqlite: typeof import("../lib/orchestrator-db")["db"]

beforeAll(async () => {
  mod = await import("./brain")
  chat = await import("../lib/orchestrator-chat")
  store = await import("../lib/brain-store")
  sqlite = (await import("../lib/orchestrator-db")).db
})

beforeEach(() => {
  sqlite.exec("DELETE FROM brain_outbox; DELETE FROM brain_trace; DELETE FROM brain_kv")
  sqlite.exec("DELETE FROM orchestrator_turns WHERE thread_id = 'brain'")
})

function session(over: Partial<Session> = {}): Session {
  return {
    key: "herdr:p_brain", agent: "claude", label: "brain", title: "", sidConfirmed: true, agentStatus: "", waitingFor: "",
    cwd: "/srv/brain", sessionId: "sid-brain", termProgram: "", tty: "", iTermSessionId: "", tmuxPane: "",
    herdrPane: "p_brain", taskId: "brain", waitingSince: 0, waitingKind: "", waitingRef: "", waitingReasons: [],
    pid: "4242", firstSeenAt: 0, lastSeenAt: 0, ...over,
  } as Session
}

interface Harness {
  w: ReturnType<typeof import("./brain").createBrainWiring>
  delivered: Array<{ text: string; key: string }>
  frames: Record<string, unknown>[]
  pushes: number
  spawns: number
  stops: number
  set: { alive: boolean; paused: boolean; sessions: Session[]; reply: { status: number; body: Record<string, unknown> }; now: number; spawn: SpawnResult }
}

function harness(): Harness {
  const h: Harness = {
    delivered: [], frames: [], pushes: 0, spawns: 0, stops: 0,
    set: { alive: false, paused: false, sessions: [], reply: { status: 200, body: { ok: true } }, now: 1_000_000, spawn: { ok: true, app: "herdr", herdrPane: "p_brain", sessionName: "brain" } },
  } as unknown as Harness
  h.w = mod.createBrainWiring({
    now: () => h.set.now,
    alive: async () => h.set.alive,
    spawn: async () => { h.spawns++; return h.set.spawn },
    stopAgent: async () => { h.stops++ },
    sessions: () => h.set.sessions,
    sessionByKey: (k) => h.set.sessions.find((s) => s.key === k) ?? null,
    deliver: async (text, key) => { h.delivered.push({ text, key }); return Response.json(h.set.reply.body, { status: h.set.reply.status }) },
    broadcast: (f) => { h.frames.push(f) },
    push: () => { h.pushes++ },
    paused: { read: () => h.set.paused, write: (on) => { h.set.paused = on } },
    contextPct: () => null,
    compact: async () => true,
    dispatch: {} as never,
    host: "test",
    log: () => {},
  })
  return h
}

/** A live, adopted brain with its boot seed already typed. */
async function upBrain(h: Harness): Promise<void> {
  h.set.alive = true
  h.set.sessions = [session()]
  h.w.onSessionStart(session())
  await Bun.sleep(1)
  await h.w.onStop("sid-brain", "")
  h.delivered.length = 0
}

const userTurn = (text: string) => chat.appendTurn("user", text, null, "brain")

describe("supervisor", () => {
  test("a dead brain is respawned; 3 respawns in 5 min → down + one push; it retries once the window clears", async () => {
    const h = harness()
    for (let i = 0; i < 3; i++) {
      await h.w.tick()
      h.set.now += 61_000 // past the start grace: the spawn never registered
    }
    expect(h.spawns).toBe(3)
    await h.w.tick()
    expect(h.w.status().state).toBe("down")
    expect(h.pushes).toBe(1)
    await h.w.tick()
    expect(h.spawns).toBe(3)
    expect(h.pushes).toBe(1)
    h.set.now += 5 * 60_000
    await h.w.tick()
    expect(h.spawns).toBe(4)
  })

  test("paused flag: the next tick stops a live brain and never spawns; resume lets the next tick spawn", async () => {
    const h = harness()
    await upBrain(h)
    expect(h.w.status().state).toBe("up")
    h.set.paused = true
    await h.w.tick()
    expect(h.stops).toBe(1)
    expect(h.w.status().state).toBe("paused")
    h.set.alive = false
    for (let i = 0; i < 2; i++) { h.set.now += 61_000; await h.w.tick() }
    expect(h.spawns).toBe(0)
    h.w.resume()
    await Bun.sleep(1)
    expect(h.set.paused).toBe(false)
    expect(h.spawns).toBe(1)
  })

  test("pause() writes the flag, restart() while paused is refused", async () => {
    const h = harness()
    expect(h.w.pause().state).toBe("paused")
    expect(h.set.paused).toBe(true)
    expect(await h.w.restart()).toBeNull()
    expect(h.spawns).toBe(0)
  })

  test("a fresh spawn's first delivery is the boot seed citing every open turn", async () => {
    const h = harness()
    const t = userTurn("what is blocked?")
    h.w.enqueue(t)
    await h.w.tick()
    expect(h.spawns).toBe(1)
    h.set.alive = true
    h.set.sessions = [session()]
    h.w.onSessionStart(session())
    await Bun.sleep(1)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.key).toBe("herdr:p_brain")
    expect(h.delivered[0]!.text).toStartWith("[boot]")
    expect(h.delivered[0]!.text).toContain(`[turn ${t.id}] what is blocked?`)
  })
})

describe("delivery is strict", () => {
  test("queued turns go to the adopted brain session by key; the reply lands in the thread and the next turn goes in", async () => {
    const h = harness()
    await upBrain(h)
    const a = userTurn("first")
    h.w.enqueue(a)
    await Bun.sleep(1)
    expect(h.delivered.map((d) => d.text)).toEqual([`[turn ${a.id}] first`])
    const b = userTurn("second")
    h.w.enqueue(b) // busy: waits for the Stop
    await Bun.sleep(1)
    expect(h.delivered).toHaveLength(1)
    await h.w.onStop("sid-brain", "Answer to first")
    expect(chat.getThread("brain").some((t) => t.role === "orchestrator" && t.text === "Answer to first")).toBe(true)
    expect(h.delivered.map((d) => d.text)).toEqual([`[turn ${a.id}] first`, `[turn ${b.id}] second`])
  })

  test("no key / wrong taskId / session id mismatch → nothing typed, the turn stays queued", async () => {
    for (const bad of [{ taskId: "" }, { sessionId: "sid-other" }]) {
      const h = harness()
      await upBrain(h)
      h.set.sessions = [session(bad)]
      const t = userTurn(`bad ${JSON.stringify(bad)}`)
      h.w.enqueue(t)
      await Bun.sleep(1)
      expect(h.delivered).toEqual([])
      expect(store.takeDeliveries()).toContain(t.id)
      sqlite.exec("DELETE FROM brain_outbox")
    }
    const h = harness() // never adopted: no key at all
    h.set.alive = true
    const t = userTurn("no key")
    h.w.enqueue(t)
    await h.w.tick()
    expect(h.delivered).toEqual([])
  })

  test("a Stop from another session id is ignored", async () => {
    const h = harness()
    await upBrain(h)
    await h.w.onStop("sid-intruder", "fake reply")
    expect(chat.getThread("brain").some((t) => t.text === "fake reply")).toBe(false)
  })

  test("not_submitted → maybe, never retyped into that session", async () => {
    const h = harness()
    await upBrain(h)
    h.set.reply = { status: 409, body: { ok: false, error: "not_submitted" } }
    const t = userTurn("maybe lost")
    h.w.enqueue(t)
    await Bun.sleep(1)
    expect(h.delivered).toHaveLength(1)
    expect(store.openDeliveries().find((r) => r.turnId === t.id)?.state).toBe("maybe")
    h.set.reply = { status: 200, body: { ok: true } }
    await h.w.tick()
    await h.w.onStop("sid-brain", "")
    expect(h.delivered).toHaveLength(1)
  })

  test("enqueue never throws and the turn is persisted while the brain is down", () => {
    const h = harness()
    const t = userTurn("while down")
    expect(() => h.w.enqueue(t)).not.toThrow()
    expect(store.takeDeliveries()).toContain(t.id)
    expect(h.delivered).toEqual([])
  })
})
