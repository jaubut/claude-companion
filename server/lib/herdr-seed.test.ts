import { describe, expect, test } from "bun:test"
import type { HerdrDelivery } from "./herdr-inject"
import { type LandedIO, type PumpOpts, SEED_RETRY_MS, SEED_TRIES, SEED_WAIT_MS, type SeedGate, promptLanded, pumpPrompt, seedGate } from "./herdr-seed"

// Pure: a fake clock (sleep advances it), a scripted gate and delivery.

const DIALOG = [
  "────────────────────────────────────────",
  "   2 new MCP servers found in .mcp.json",
  "   Select any you wish to enable.",
  "   ❯ 1. ☐ foo",
  "     2. ☐ bar",
  "   Space to select · Enter to confirm · Esc to reject all",
].join("\n")
const IDLE = "────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ? for shortcuts"

interface Rig { opts: PumpOpts; clock: { t: number }; delivered: number[]; dialogs: string[] }

function rig(gate: (now: number) => SeedGate, deliver: () => HerdrDelivery = () => ({ ok: true }), wanted: (now: number) => boolean = () => true): Rig {
  const clock = { t: 0 }
  const r: Rig = { clock, delivered: [], dialogs: [], opts: null as unknown as PumpOpts }
  r.opts = {
    gate: async () => gate(clock.t),
    deliver: async () => { r.delivered.push(clock.t); return deliver() },
    stillWanted: () => wanted(clock.t),
    onDialog: (title) => r.dialogs.push(title),
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms },
  }
  return r
}

const MIN = 60_000

describe("pumpPrompt", () => {
  test("a dialog up for 5 min then cleared: one alert, the prompt goes in exactly once after it clears", async () => {
    const r = rig((now) => (now < 5 * MIN ? { kind: "dialog", title: "MCP" } : { kind: "ready" }))
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "delivered" })
    expect(r.dialogs).toEqual(["MCP"])
    expect(r.delivered).toHaveLength(1)
    expect(r.delivered[0]!).toBeGreaterThanOrEqual(5 * MIN)
  })

  test("the task is cancelled mid-wait: deliver is never called and the next pass drops it", async () => {
    const r = rig(() => ({ kind: "dialog", title: "MCP" }), () => ({ ok: true }), (now) => now < 2 * MIN)
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "dropped" })
    expect(r.delivered).toEqual([])
  })

  test("typed input holds the prompt without spending a try", async () => {
    const r = rig((now) => (now < 10 * MIN ? { kind: "typing" } : { kind: "ready" }))
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "delivered" })
    expect(r.delivered).toEqual([10 * MIN])
    expect(r.dialogs).toEqual([])
  })

  test("24 non-dialog refusals → gave_up naming the reason", async () => {
    const r = rig(() => ({ kind: "ready" }), () => ({ ok: false, blocked: false, reason: "leading_dash" }))
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "gave_up", reason: "leading_dash" })
    expect(r.delivered).toHaveLength(SEED_TRIES)
  })

  test("a blocked refusal is not a try; a dialog that never clears gives up after the 2 h cap", async () => {
    const blocked = rig(() => ({ kind: "ready" }), () => ({ ok: false, blocked: true, reason: "agent_blocked" }))
    const out = await pumpPrompt(blocked.opts)
    expect(out.kind).toBe("gave_up")
    expect(blocked.delivered.length).toBe(SEED_WAIT_MS / SEED_RETRY_MS)
    const stuck = rig(() => ({ kind: "dialog", title: "" }))
    expect(await pumpPrompt(stuck.opts)).toEqual({ kind: "gave_up", reason: "waited 2 h" })
    expect(stuck.delivered).toEqual([])
    expect(stuck.dialogs).toEqual([""])
  })
})

describe("seedGate", () => {
  const status = (s: string | null) => async () => s

  test("a dialog on the screen wins, without asking herdr", async () => {
    let asked = false
    const g = await seedGate(async () => DIALOG, async () => { asked = true; return "idle" })
    expect(g).toEqual({ kind: "dialog", title: "2 new MCP servers found in .mcp.json" })
    expect(asked).toBe(false)
  })

  test("herdr's agent blocked → an untitled dialog", async () => {
    expect(await seedGate(async () => IDLE, status("blocked"))).toEqual({ kind: "dialog", title: "" })
  })

  test("typed input → typing; an empty input box or an unreadable screen → ready", async () => {
    expect(await seedGate(async () => IDLE.replace("❯ ", "❯ hello"), status("idle"))).toEqual({ kind: "typing" })
    expect(await seedGate(async () => IDLE, status("idle"))).toEqual({ kind: "ready" })
    expect(await seedGate(async () => null, status(null))).toEqual({ kind: "ready" })
  })
})

describe("a refused delivery that landed anyway", () => {
  test("a timeout whose prompt went in counts as delivered: deliver is called once, never re-sent", async () => {
    const r = rig(() => ({ kind: "ready" }), () => ({ ok: false, blocked: false, reason: "timeout" }))
    r.opts.landed = async () => true
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "delivered" })
    expect(r.delivered).toHaveLength(1)
  })

  test("a refusal that did not land is retried as before", async () => {
    let n = 0
    const r = rig(() => ({ kind: "ready" }), () => (++n < 3 ? { ok: false, blocked: false, reason: "timeout" } : { ok: true }))
    r.opts.landed = async () => false
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "delivered" })
    expect(r.delivered).toHaveLength(3)
  })

  test("promptLanded: herdr's agent working, or the prompt's first line in the transcript", async () => {
    const text = "Fix the   Turso\nconnection refused in body"
    const io = (screen: string | null, status: string | null) => landedIO([screen], [status]).io
    expect(await promptLanded(text, io(IDLE, "working"))).toBe(true)
    expect(await promptLanded(text, io(`> Fix the Turso connection\n${IDLE}`, "idle"))).toBe(true)
    expect(await promptLanded(text, io(IDLE, "idle"))).toBe(false)
    expect(await promptLanded(text, io(null, null))).toBe(false)
  })
})

describe("a slow boot (agent_not_ready)", () => {
  test("is waited out without spending tries: 40 not-ready refusals, then it goes in", async () => {
    let n = 0
    const r = rig(() => ({ kind: "ready" }), () => (++n <= 40 ? { ok: false, blocked: false, reason: "agent is not ready", code: "agent_not_ready" } : { ok: true }))
    expect(40).toBeGreaterThan(SEED_TRIES)
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "delivered" })
    expect(r.delivered).toHaveLength(41)
  })

  test("never ready: bounded by the 2 h cap", async () => {
    const r = rig(() => ({ kind: "ready" }), () => ({ ok: false, blocked: false, reason: "agent is not ready", code: "agent_not_ready" }))
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "gave_up", reason: "waited 2 h" })
    expect(r.clock.t).toBeGreaterThanOrEqual(SEED_WAIT_MS)
  })
})

describe("refusals no retry can fix", () => {
  test("leading_dash gives up on the first refusal, naming it", async () => {
    const r = rig(() => ({ kind: "ready" }), () => ({ ok: false, blocked: false, reason: "leading_dash", code: "leading_dash" }))
    r.opts.landed = async () => { throw new Error("never asked: nothing was sent") }
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "gave_up", reason: "leading_dash" })
    expect(r.delivered).toHaveLength(1)
    expect(r.clock.t).toBe(0)
  })
})

/** Scripted screens / statuses (the last one repeats) and a count of Enters sent. */
function landedIO(screens: (string | null)[], statuses: (string | null)[]) {
  const st = { enters: 0, sleeps: 0, si: 0, ai: 0 }
  const next = <T>(xs: T[], k: "si" | "ai"): T => xs[Math.min(st[k]++, xs.length - 1)]!
  const io: LandedIO = {
    screen: async () => next(screens, "si"),
    agentStatus: async () => next(statuses, "ai"),
    enter: async () => { st.enters++; return true },
    sleep: async () => { st.sleeps++ },
  }
  return { io, st }
}

describe("promptLanded: the input box", () => {
  const text = "Fix the Turso connection refused in body"
  const box = (typed: string) => IDLE.replace("❯ ", `❯ ${typed}`)

  test("an unsubmitted paste in the input box: Enter once, then delivered (box empty)", async () => {
    const { io, st } = landedIO([box("Fix the Turso connection refused in body"), IDLE], ["idle", "idle"])
    expect(await promptLanded(text, io)).toBe(true)
    expect(st.enters).toBe(1)
  })

  test("a long paste shown as [Pasted text #1 …]: Enter, never re-pasted; agent working → delivered", async () => {
    const { io, st } = landedIO([box("[Pasted text #1 +42 lines]")], ["idle", "working"])
    expect(await promptLanded(text, io)).toBe(true)
    expect(st.enters).toBe(1)
    const r = rig(() => ({ kind: "ready" }), () => ({ ok: false, blocked: false, reason: "timeout" }))
    r.opts.landed = () => promptLanded(text, io)
    expect(await pumpPrompt(r.opts)).toEqual({ kind: "delivered" })
    expect(r.delivered).toHaveLength(1)
  })

  test("Enter sent but the box still holds it: not landed (the pump then waits on the typed text, no re-paste)", async () => {
    const stuck = box("Fix the Turso connection refused in body")
    const { io, st } = landedIO([stuck, stuck], ["idle", "idle"])
    expect(await promptLanded(text, io)).toBe(false)
    expect(st.enters).toBe(1)
  })

  test("the text only in the transcript above an empty box: landed, no Enter", async () => {
    const { io, st } = landedIO([`> Fix the Turso connection refused in body\n\n⏺ Looking at it\n${IDLE}`], ["idle"])
    expect(await promptLanded(text, io)).toBe(true)
    expect(st.enters).toBe(0)
  })

  test("other text in the box (Jeremie typing) is not our paste: no Enter, not landed", async () => {
    const { io, st } = landedIO([box("hello there")], ["idle"])
    expect(await promptLanded(text, io)).toBe(false)
    expect(st.enters).toBe(0)
  })
})
