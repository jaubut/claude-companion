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
  set: {
    alive: boolean; paused: boolean; sessions: Session[]; reply: { status: number; body: Record<string, unknown> }; now: number; spawn: SpawnResult
    agentPane: string
    /** Runs inside alive() / stopAgent(): lets a test flip the flag mid-tick. */
    duringAlive?: () => void
    duringStop?: () => void
  }
}

function harness(): Harness {
  const h: Harness = {
    delivered: [], frames: [], pushes: 0, spawns: 0, stops: 0,
    set: { alive: false, paused: false, sessions: [], reply: { status: 200, body: { ok: true } }, now: 1_000_000, spawn: { ok: true, app: "herdr", herdrPane: "p_brain", sessionName: "brain" }, agentPane: "" },
  } as unknown as Harness
  h.w = mod.createBrainWiring({
    now: () => h.set.now,
    alive: async () => { h.set.duringAlive?.(); return h.set.alive },
    agentPane: async () => h.set.agentPane,
    spawn: async () => { h.spawns++; return h.set.spawn },
    stopAgent: async () => { h.stops++; h.set.duringStop?.() },
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
  h.w.setSpawnedPaneForTests("p_brain")
  h.w.onSessionStart(session())
  await Bun.sleep(1)
  await h.w.onStop("sid-brain", "")
  h.delivered.length = 0
}

const userTurn = (text: string) => chat.appendTurn("user", text, null, "brain")

describe("supervisor", () => {
  test("a dead brain is respawned; 3 respawns in 5 min → down + one push; down lasts until a manual resume", async () => {
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
    h.set.now += 10 * 60_000 // the window clears: still down
    await h.w.tick()
    expect(h.spawns).toBe(3)
    expect(h.w.status().state).toBe("down")
    h.w.resume()
    await Bun.sleep(1)
    expect(h.spawns).toBe(4)
  })

  test("the pause flag is re-read right before a spawn (set while the tick awaited) → no spawn", async () => {
    const h = harness()
    h.set.duringAlive = () => { h.set.paused = true }
    await h.w.tick()
    expect(h.spawns).toBe(0)
    h.set.duringAlive = undefined
    h.set.paused = false
    h.set.duringStop = () => { h.set.paused = true } // restart: paused while stopping
    expect(await h.w.restart()).toBeNull()
    expect(h.spawns).toBe(0)
  })

  test("SessionStart while paused adopts nothing; a paused flag set after adoption stops delivery", async () => {
    const h = harness()
    h.set.alive = true
    h.set.sessions = [session()]
    h.w.setSpawnedPaneForTests("p_brain")
    h.set.paused = true
    h.w.onSessionStart(session())
    expect(h.w.status().sessionKey).toBeNull()
    h.set.paused = false
    await upBrain(h)
    h.set.paused = true
    h.w.enqueue(userTurn("while paused"))
    await Bun.sleep(1)
    expect(h.delivered).toEqual([])
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

describe("adoption", () => {
  test("only the session in the spawned pane; empty or other pane refused", () => {
    const h = harness()
    h.set.alive = true
    h.w.onSessionStart(session()) // no spawned pane yet
    expect(h.w.status().sessionKey).toBeNull()
    h.w.setSpawnedPaneForTests("p_brain")
    h.w.onSessionStart(session({ herdrPane: "p_other", key: "herdr:p_other" }))
    expect(h.w.status().sessionKey).toBeNull()
    h.w.onSessionStart(session({ herdrPane: "" , key: "tty:x" }))
    expect(h.w.status().sessionKey).toBeNull()
    h.w.onSessionStart(session())
    expect(h.w.status()).toMatchObject({ state: "up", sessionKey: "herdr:p_brain" })
  })

  test("never replaces a live adopted session", async () => {
    const h = harness()
    await upBrain(h)
    const intruder = session({ key: "herdr:p_brain#2", sessionId: "sid-intruder" })
    h.set.sessions = [session(), intruder]
    h.w.onSessionStart(intruder)
    expect(h.w.status().sessionKey).toBe("herdr:p_brain")
    await h.w.onStop("sid-intruder", "fake")
    expect(chat.getThread("brain").some((t) => t.text === "fake")).toBe(false)
  })

  test("after a Companion restart the pane comes from herdr's brain agent", async () => {
    const h = harness()
    h.set.alive = true
    h.set.agentPane = "p_brain"
    h.set.sessions = [session()]
    await h.w.tick()
    expect(h.w.status()).toMatchObject({ state: "up", sessionKey: "herdr:p_brain" })
    expect(h.spawns).toBe(0)
  })
})

describe("busy deadline", () => {
  test("a typed turn with no hook from the brain for 10 min stops blocking delivery; a hook keeps it busy", async () => {
    const h = harness()
    await upBrain(h)
    h.w.enqueue(userTurn("first"))
    await Bun.sleep(1)
    const second = userTurn("second")
    h.w.enqueue(second)
    await Bun.sleep(1)
    expect(h.delivered).toHaveLength(1)
    h.set.now += 9 * 60_000
    h.w.noteActivity("sid-brain") // the brain is working
    h.set.now += 9 * 60_000
    await h.w.tick()
    expect(h.delivered).toHaveLength(1)
    h.w.noteActivity("sid-someone-else") // not the brain: does not count
    h.set.now += 2 * 60_000
    await h.w.tick()
    expect(h.delivered.map((d) => d.text)).toEqual([expect.stringContaining("first"), `[turn ${second.id}] second`])
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
