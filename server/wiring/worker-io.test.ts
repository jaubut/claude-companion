import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Herdr } from "../lib/herdr"
import type { HerdrDelivery } from "../lib/herdr-inject"

// Real sqlite (COMPANION_DB_PATH, set before the import), a fake herdr and a fake
// clock: the herdr side of worker IO end to end, no herdr or tmux spawned.
process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "cc-wio-")), "test.db")
const chat = await import("../lib/orchestrator-chat")
const io = await import("./worker-io")
const { createLiveness, START_GRACE_MS } = await import("./takeover-liveness")

const IDLE = "────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ? for shortcuts"
const DIALOG = [
  "────────────────────────────────────────",
  "   2 new MCP servers found in .mcp.json",
  "   Select any you wish to enable.",
  "   ❯ 1. ☐ foo",
  "     2. ☐ bar",
  "   Space to select · Enter to confirm · Esc to reject all",
].join("\n")

interface FakeAgent { pane: string; workspace: string; label: string; panes?: number; front?: "shell" | "busy" }

function fakeHerdr(agents: Record<string, FakeAgent>, screen: () => string | null = () => IDLE) {
  const calls: string[][] = []
  const h: Herdr = {
    async gate() { return null },
    async read() { return screen() },
    async call(args) {
      calls.push(args)
      const [a, b, c] = args
      if (a === "agent" && b === "get") {
        const ag = agents[c!]
        if (!ag) throw Object.assign(new Error("agent_not_found"), { code: "agent_not_found" })
        return { agent: { pane_id: ag.pane, workspace_id: ag.workspace, agent_status: "idle" } }
      }
      if (a === "workspace" && b === "get") {
        const ag = Object.values(agents).find((x) => x.workspace === c)
        return { workspace: { label: ag?.label ?? "", pane_count: ag?.panes ?? 1 } }
      }
      if (a === "pane" && b === "process-info") {
        const ag = Object.values(agents).find((x) => x.pane === args[3])
        return { process_info: { shell_pid: 10, foreground_process_group_id: ag?.front === "shell" ? 10 : 20 } }
      }
      return {}
    },
  }
  return { h, calls }
}

interface Rig { turns: string[]; delivered: { pane: string; text: string }[]; gaveUp: string[]; clock: { t: number } }

function wire(h: Herdr, deliver: (pane: string) => HerdrDelivery = () => ({ ok: true }), sessions: { key: string; taskId: string }[] = []): Rig {
  const r: Rig = { turns: [], delivered: [], gaveUp: [], clock: { t: 1_000_000 } }
  io.setWorkerIODeps({
    herdr: h,
    deliver: async (pane, text) => { r.delivered.push({ pane, text }); return deliver(pane) },
    sessions: () => sessions,
    turn: (text) => r.turns.push(text),
    gaveUp: (_t, blocker) => r.gaveUp.push(blocker),
    now: () => r.clock.t,
    sleep: async (ms) => { r.clock.t += ms },
    log: () => {},
  })
  return r
}

function herdrTask(prompt: string, agent: string, pane: string) {
  const t = chat.createProposal(prompt, "/w", "why", "general")
  chat.setTaskSpawn(t.taskId, null, null, { agent, pane })
  return chat.getTask(t.taskId)!
}

const live: string[] = []
const track = <T extends { taskId: string }>(t: T): T => { live.push(t.taskId); return t }

beforeEach(() => {
  for (const id of live.splice(0)) chat.setTaskStatus(id, "done")
})
afterAll(() => {
  for (const id of live.splice(0)) chat.setTaskStatus(id, "done")
})

describe("prompt delivery (herdr)", () => {
  test("delivered once: prompt_sent_at stamped, one 'prompt delivered' turn; a second call is deduped", async () => {
    const { h } = fakeHerdr({ "cc-a": { pane: "w1:p1", workspace: "w1", label: "cc-a" } })
    const r = wire(h)
    const t = track(herdrTask("fix it", "cc-a", "w1:p1"))
    io.deliverWorkerPrompt(t)
    io.deliverWorkerPrompt(t)
    await io.workerIOIdle()
    io.deliverWorkerPrompt(chat.getTask(t.taskId)!)
    await io.workerIOIdle()
    expect(r.delivered).toEqual([{ pane: "w1:p1", text: "fix it" }])
    expect(r.turns).toEqual([`[${t.taskId}] prompt delivered`])
    expect(typeof chat.getTask(t.taskId)?.promptSentAt).toBe("number")
  })

  test("a start dialog: one 'waiting on' turn, the prompt goes in after it clears", async () => {
    let up = true
    const { h } = fakeHerdr({ "cc-b": { pane: "w2:p1", workspace: "w2", label: "cc-b" } }, () => (up ? DIALOG : IDLE))
    const r = wire(h)
    const real = r.clock
    io.setWorkerIODeps({ sleep: async (ms) => { real.t += ms; if (real.t > 1_000_000 + 5 * 60_000) up = false } })
    const t = track(herdrTask("go", "cc-b", "w2:p1"))
    io.deliverWorkerPrompt(t)
    await io.workerIOIdle()
    expect(r.turns).toEqual([
      `⏸️ [${t.taskId}] worker waiting on "2 new MCP servers found in .mcp.json" — answer it on the phone; the prompt goes in once it clears`,
      `[${t.taskId}] prompt delivered`,
    ])
    expect(r.delivered).toHaveLength(1)
  })

  test("cancelled while waiting: nothing typed, nothing failed", async () => {
    const { h } = fakeHerdr({ "cc-c": { pane: "w3:p1", workspace: "w3", label: "cc-c" } }, () => DIALOG)
    const r = wire(h)
    const t = track(herdrTask("go", "cc-c", "w3:p1"))
    io.setWorkerIODeps({ sleep: async (ms) => { r.clock.t += ms; chat.setTaskStatus(t.taskId, "cancelled") } })
    io.deliverWorkerPrompt(t)
    await io.workerIOIdle()
    expect(r.delivered).toEqual([])
    expect(r.gaveUp).toEqual([])
    expect(chat.getTask(t.taskId)?.promptSentAt).toBeNull()
  })

  test("gave up: the turn and the blocker name the reason (leading_dash)", async () => {
    const { h } = fakeHerdr({ "cc-d": { pane: "w4:p1", workspace: "w4", label: "cc-d" } })
    const r = wire(h, () => ({ ok: false, blocked: false, reason: "leading_dash" }))
    const t = track(herdrTask("-x", "cc-d", "w4:p1"))
    io.deliverWorkerPrompt(t)
    await io.workerIOIdle()
    expect(r.turns.at(-1)).toContain("prompt never delivered (leading_dash)")
    expect(r.gaveUp).toEqual(["prompt never delivered: leading_dash"])
    expect(chat.getTask(t.taskId)?.promptSentAt).toBeNull()
  })

  test("boot resume pumps only the rows listPendingHerdrPrompts returns", async () => {
    const { h } = fakeHerdr({
      "cc-p": { pane: "w5:p1", workspace: "w5", label: "cc-p" },
      "cc-s": { pane: "w6:p1", workspace: "w6", label: "cc-s" },
    })
    const r = wire(h)
    const pending = track(herdrTask("pending", "cc-p", "w5:p1"))
    const sent = track(herdrTask("sent", "cc-s", "w6:p1"))
    chat.markPromptSent(sent.taskId)
    const tmux = track(chat.createProposal("tmux", "/w", "why", "general"))
    chat.setTaskSpawn(tmux.taskId, "cc-tmux")
    io.resumeWorkerPrompts(chat.listPendingHerdrPrompts())
    await io.workerIOIdle()
    expect(r.delivered).toEqual([{ pane: "w5:p1", text: "pending" }])
    expect(chat.listPendingHerdrPrompts().map((t) => t.taskId)).not.toContain(pending.taskId)
  })
})

describe("killWorker (herdr)", () => {
  test("closes the agent's workspace only when its label matches and it holds one pane", async () => {
    const ours = fakeHerdr({ "cc-k": { pane: "w7:p1", workspace: "w7", label: "cc-k" } })
    wire(ours.h)
    const t = track(herdrTask("k", "cc-k", "w7:p1"))
    await io.killWorker(t)
    expect(ours.calls).toContainEqual(["workspace", "close", "w7"])

    const relabelled = fakeHerdr({ "cc-k": { pane: "w7:p1", workspace: "w7", label: "someone-else" } })
    wire(relabelled.h)
    await io.killWorker(t)
    const split = fakeHerdr({ "cc-k": { pane: "w7:p1", workspace: "w7", label: "cc-k", panes: 2 } })
    wire(split.h)
    await io.killWorker(t)
    for (const f of [relabelled, split]) expect(f.calls.some((c) => c[0] === "workspace" && c[1] === "close")).toBe(false)
  })

  test("an absent agent is a no-op", async () => {
    const f = fakeHerdr({})
    wire(f.h)
    await io.killWorker(track(herdrTask("k", "cc-gone", "w8:p1")))
    expect(f.calls).toEqual([["agent", "get", "cc-gone"]])
  })
})

describe("herdr liveness", () => {
  test("starts at spawnedAt, not createdAt: a 1 h old proposal spawned 30 s ago, agent not registered yet, is not gone", async () => {
    const { h } = fakeHerdr({ "cc-l": { pane: "w9:p1", workspace: "w9", label: "cc-l", front: "shell" } })
    const r = wire(h)
    const t = { ...track(herdrTask("l", "cc-l", "w9:p1")), createdAt: r.clock.t - 3_600_000, spawnedAt: r.clock.t - 30_000 }
    expect(await io.herdrGone(t)).toBe(false)
    expect(await io.herdrGone({ ...t, spawnedAt: r.clock.t - START_GRACE_MS - 1 })).toBe(true)
  })

  test("claude in front of the pane (a dialog up) is alive; an absent agent is gone", async () => {
    const { h } = fakeHerdr({ "cc-m": { pane: "w10:p1", workspace: "w10", label: "cc-m", front: "busy" } })
    wire(h)
    const t = track(herdrTask("m", "cc-m", "w10:p1"))
    expect(await io.workerAlive(t)).toBe(true)
    expect(await io.herdrGone(t)).toBe(false)
    const gone = track(herdrTask("n", "cc-absent", "w11:p1"))
    expect(await io.workerAlive(gone)).toBe(false)
    expect(await io.herdrGone(gone)).toBe(true)
  })
})

describe("createLiveness sessionTaskId", () => {
  const absent = fakeHerdr({}).h

  test("alive(name, sessionTaskId) matches a session by task id ≠ agent name", async () => {
    const l = createLiveness(() => ({ herdr: absent, sessions: () => [{ key: "k", taskId: "abcd1234" }], now: () => 0 }))
    expect(await l.alive("cc--claude-3", { sessionTaskId: "abcd1234" })).toBe(true)
    expect(await l.alive("cc--claude-3")).toBe(false)
  })

  test("the default sessionTaskId = name keeps takeover behaviour", async () => {
    const l = createLiveness(() => ({ herdr: absent, sessions: () => [{ key: "k", taskId: "tko-mac-abcd1234" }], now: () => 0 }))
    expect(await l.alive("tko-mac-abcd1234")).toBe(true)
    expect(await l.missing("tko-mac-abcd1234", 0)).toBe(false)
    expect(await l.missing("tko-mac-other", 0)).toBe(true)
  })
})

describe("herdr name / pane reuse", () => {
  test("an agent of that name in another pane is a stranger: not alive, gone even inside the start grace", async () => {
    const { h } = fakeHerdr({ "cc-r": { pane: "w20:p1", workspace: "w20", label: "cc-r", front: "busy" } })
    const r = wire(h)
    const t = { ...track(herdrTask("r", "cc-r", "w19:p1")), spawnedAt: r.clock.t - 1_000 }
    expect(await io.workerAlive(t)).toBe(false)
    expect(await io.herdrGone(t)).toBe(true)
  })

  test("a workspace other than the recorded one is a stranger too", async () => {
    const { h } = fakeHerdr({ "cc-ws": { pane: "w21:p1", workspace: "w22", label: "cc-ws", front: "busy" } })
    wire(h)
    const t = chat.createProposal("ws", "/w", "why", "general")
    chat.setTaskSpawn(t.taskId, null, null, { agent: "cc-ws", pane: "w21:p1", workspace: "w21" })
    track(t)
    expect(chat.getTask(t.taskId)?.herdrWorkspace).toBe("w21")
    expect(await io.workerAlive(chat.getTask(t.taskId)!)).toBe(false)
  })

  test("never types into a pane the agent no longer owns", async () => {
    const { h } = fakeHerdr({ "cc-s2": { pane: "w24:p1", workspace: "w24", label: "cc-s2" } })
    const r = wire(h)
    const t = track(herdrTask("secret prompt", "cc-s2", "w23:p1"))
    io.deliverWorkerPrompt(t)
    await io.workerIOIdle()
    expect(r.delivered).toEqual([])
    expect(r.gaveUp).toHaveLength(1)
  })

  test("kill leaves a same-named agent in another pane alone", async () => {
    const f = fakeHerdr({ "cc-k2": { pane: "w26:p1", workspace: "w26", label: "cc-k2" } })
    wire(f.h)
    await io.killWorker(track(herdrTask("k", "cc-k2", "w25:p1")))
    expect(f.calls.some((c) => c[0] === "workspace" && c[1] === "close")).toBe(false)
  })

  test("seen-live state is per task: a new task reusing the agent name gets its own start grace", async () => {
    const { h } = fakeHerdr({ "cc-same": { pane: "w27:p1", workspace: "w27", label: "cc-same", front: "shell" } })
    const sessions: { key: string; taskId: string }[] = []
    const r = wire(h, () => ({ ok: true }), sessions)
    const first = track(herdrTask("a", "cc-same", "w27:p1"))
    sessions.push({ key: "k1", taskId: first.taskId })
    expect(await io.herdrGone({ ...first, spawnedAt: r.clock.t })).toBe(false) // seen live under its own id
    sessions.length = 0
    expect(await io.herdrGone({ ...first, spawnedAt: r.clock.t })).toBe(true) // seen live, now gone
    const second = { ...track(herdrTask("b", "cc-same", "w27:p1")), spawnedAt: r.clock.t - 10_000 }
    expect(await io.herdrGone(second)).toBe(false)
  })
})

describe("a timed-out delivery that landed", () => {
  test("is not re-sent: herdr says the agent is working → prompt_sent_at stamped once", async () => {
    let status = "idle"
    const { h } = fakeHerdr({ "cc-t": { pane: "w30:p1", workspace: "w30", label: "cc-t" } })
    const base = h.call.bind(h)
    h.call = async (args) => {
      const out = await base(args)
      if (args[0] === "agent" && args[1] === "get") (out.agent as Record<string, unknown>).agent_status = status
      return out
    }
    const r = wire(h, () => { status = "working"; return { ok: false, blocked: false, reason: "timeout" } })
    const t = track(herdrTask("go", "cc-t", "w30:p1"))
    io.deliverWorkerPrompt(t)
    await io.workerIOIdle()
    expect(r.delivered).toHaveLength(1)
    expect(r.turns).toEqual([`[${t.taskId}] prompt delivered`])
    expect(typeof chat.getTask(t.taskId)?.promptSentAt).toBe("number")
  })
})

describe("a slow boot", () => {
  test("not interactive-ready: nothing typed and no tries spent until it is, then one delivery", async () => {
    let ready = false
    const { h } = fakeHerdr({ "cc-boot": { pane: "w31:p1", workspace: "w31", label: "cc-boot" } })
    const base = h.call.bind(h)
    h.call = async (args) => {
      const out = await base(args)
      if (args[0] === "agent" && args[1] === "get") (out.agent as Record<string, unknown>).interactive_ready = ready
      return out
    }
    const r = wire(h)
    const start = r.clock.t
    io.setWorkerIODeps({ sleep: async (ms) => { r.clock.t += ms; if (r.clock.t - start > 10 * 60_000) ready = true } })
    const t = track(herdrTask("boot", "cc-boot", "w31:p1"))
    io.deliverWorkerPrompt(t)
    await io.workerIOIdle()
    expect(r.delivered).toHaveLength(1)
    expect(r.gaveUp).toEqual([])
    expect(r.turns).toEqual([`[${t.taskId}] prompt delivered`])
  })
})

describe("fail fast", () => {
  test("a prompt starting with '-' fails the task at once with the reason (real deliverViaHerdr refusal)", async () => {
    const { h } = fakeHerdr({ "cc-dash": { pane: "w32:p1", workspace: "w32", label: "cc-dash" } })
    const r = wire(h)
    const { deliverViaHerdr } = await import("../lib/herdr-inject")
    io.setWorkerIODeps({ deliver: async (pane, text) => { r.delivered.push({ pane, text }); return deliverViaHerdr(pane, text, { herdr: h }) } })
    const t = track(herdrTask("--help", "cc-dash", "w32:p1"))
    io.deliverWorkerPrompt(t)
    await io.workerIOIdle()
    expect(r.delivered).toHaveLength(1)
    expect(r.gaveUp).toEqual(["prompt never delivered: leading_dash"])
    expect(r.clock.t).toBe(1_000_000)
  })
})
