import { describe, expect, test } from "bun:test"
import {
  AutoCompactor,
  type AutoCompactDeps,
  CANCEL_MS,
  COMPACT_TEXT,
  COOLDOWN_MS,
  type GateInput,
  IDLE_MS,
  type InputState,
  compactBoundaries,
  contextTokens,
  gate,
  lastHumanPromptAt,
  openBackgroundTasks,
  thresholdFromEnv,
} from "./auto-compact"

// ── transcript fixtures ────────────────────────────────────────────────────

function assistant(input: number, cacheRead: number, cacheCreate: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: 10 } },
    ...extra,
  })
}
function userPrompt(text: string, ts: string): string {
  return JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: text } })
}
function boundary(pre: number, post: number, uuid = "b1"): string {
  return JSON.stringify({ type: "system", subtype: "compact_boundary", uuid, timestamp: "2026-10-05T00:00:00Z", compactMetadata: { trigger: "manual", preTokens: pre, postTokens: post } })
}
function bgLaunch(id: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 100", run_in_background: true } }] } })
}
function bgResult(id: string, taskId: string): string {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/x` }] } })
}
function bgNotify(id: string, taskId: string): string {
  return JSON.stringify({ type: "queue-operation", content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` })
}
function kill(taskId: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_kill", name: "KillShell", input: { shell_id: taskId } }] } })
}
const lines = (...l: string[]) => l.join("\n") + "\n"

describe("transcript parsing", () => {
  test("context = last main-chain assistant input + cache_read + cache_creation", () => {
    const t = lines(assistant(1, 100, 10), assistant(2, 600_000, 5_000), assistant(9, 9_000_000, 0, { isSidechain: true }), assistant(0, 0, 0))
    expect(contextTokens(t)).toBe(605_002)
  })
  test("nothing after the latest compact boundary → unknown", () => {
    expect(contextTokens(lines(assistant(1, 700_000, 0), boundary(700_001, 30_000)))).toBeNull()
    expect(contextTokens(lines(assistant(1, 700_000, 0), boundary(700_001, 30_000), assistant(1, 31_000, 0)))).toBe(31_001)
  })
  test("compact boundaries carry pre/post tokens", () => {
    expect(compactBoundaries(lines(boundary(969_933, 28_951)))).toEqual([{ uuid: "b1", timestamp: "2026-10-05T00:00:00Z", preTokens: 969_933, postTokens: 28_951, trigger: "manual" }])
  })
  test("background tasks: open until notified or killed", () => {
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "b0jy")))).toEqual(["b0jy"])
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "b0jy"), bgNotify("toolu_a", "b0jy")))).toEqual([])
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "b0jy"), kill("b0jy")))).toEqual([])
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a")))).toEqual(["toolu_a"])
  })
  test("last human prompt ignores tool results and task notifications", () => {
    const t = lines(userPrompt("do it", "2026-10-05T10:00:00Z"), bgResult("toolu_a", "x"), userPrompt("<task-notification>…</task-notification>", "2026-10-05T11:00:00Z"))
    expect(lastHumanPromptAt(t)).toBe(Date.parse("2026-10-05T10:00:00Z"))
  })
})

describe("threshold setting", () => {
  test("default 600k, 0 = off, garbage = default", () => {
    expect(thresholdFromEnv({})).toBe(600_000)
    expect(thresholdFromEnv({ AUTO_COMPACT_TOKENS: "0" })).toBe(0)
    expect(thresholdFromEnv({ AUTO_COMPACT_TOKENS: "450000" })).toBe(450_000)
    expect(thresholdFromEnv({ AUTO_COMPACT_TOKENS: "lots" })).toBe(600_000)
  })
})

describe("gate", () => {
  const now = 10_000_000
  const ok: GateInput = {
    threshold: 600_000, tokens: 650_000, now, lastUserActivityAt: now - IDLE_MS, idleMs: IDLE_MS,
    agentStatus: "idle", backgroundTasks: 0, lastAttemptAt: 0, cooldownMs: COOLDOWN_MS, input: "empty",
  }
  test("passes when every condition holds", () => expect(gate(ok)).toEqual({ ok: true }))
  test("off", () => expect(gate({ ...ok, threshold: 0 })).toEqual({ ok: false, reason: "off" }))
  test("threshold is strict", () => {
    expect(gate({ ...ok, tokens: 600_000 })).toEqual({ ok: false, reason: "below_threshold" })
    expect(gate({ ...ok, tokens: null })).toEqual({ ok: false, reason: "below_threshold" })
  })
  test("idle window", () => expect(gate({ ...ok, lastUserActivityAt: now - IDLE_MS + 1 })).toEqual({ ok: false, reason: "user_active" }))
  test("typing", () => expect(gate({ ...ok, input: "typing" })).toEqual({ ok: false, reason: "typing" }))
  test("busy / waiting / unknown status", () => {
    for (const s of ["busy", "waiting", ""]) expect(gate({ ...ok, agentStatus: s })).toEqual({ ok: false, reason: "busy" })
  })
  test("background tasks", () => expect(gate({ ...ok, backgroundTasks: 1 })).toEqual({ ok: false, reason: "background_tasks" }))
  test("cooldown", () => {
    expect(gate({ ...ok, lastAttemptAt: now - COOLDOWN_MS + 1 })).toEqual({ ok: false, reason: "cooldown" })
    expect(gate({ ...ok, lastAttemptAt: now - COOLDOWN_MS })).toEqual({ ok: true })
  })
  test("no readable pane never passes", () => {
    expect(gate({ ...ok, input: "unknown" })).toEqual({ ok: false, reason: "pane_not_ready" })
    expect(gate({ ...ok, input: "not_ready" })).toEqual({ ok: false, reason: "pane_not_ready" })
  })
})

// ── controller with a fake clock ───────────────────────────────────────────

interface Timer { at: number; fn: () => void; id: number }

function harness(opts: { transcript: string; status?: string; input?: InputState; threshold?: number }) {
  let now = Date.parse("2026-10-05T12:00:00Z")
  let seq = 0
  let timers: Timer[] = []
  const pushes: Array<{ kind: string; title: string }> = []
  const injects: string[] = []
  const logs: string[] = []
  const state = { transcript: opts.transcript, status: opts.status ?? "idle", input: opts.input ?? ("empty" as InputState), injectOk: true }
  const deps: AutoCompactDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, id: ++seq }; timers.push(t); return t.id },
    clearTimer: (id) => { timers = timers.filter((t) => t.id !== id) },
    threshold: () => opts.threshold ?? 600_000,
    readTranscript: async () => state.transcript,
    agentStatus: async () => state.status,
    inputState: async () => state.input,
    push: async (kind, _t, title) => { pushes.push({ kind, title }) },
    inject: async (_k, text) => { injects.push(text); return state.injectOk ? { ok: true } : { ok: false, error: "dialog_open" } },
    log: (l) => logs.push(l),
  }
  const c = new AutoCompactor(deps)
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  async function advance(ms: number): Promise<void> {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > end) break
      timers.shift()
      now = next.at
      next.fn()
      await flush()
    }
    now = end
    await flush()
  }
  const target = { key: "k1", name: "wt", sessionId: "sid", transcriptPath: "/t.jsonl" }
  return { c, state, pushes, injects, logs, advance, target, nowAt: () => now }
}

const OLD_PROMPT = userPrompt("start", "2026-10-05T11:00:00Z") // an hour before the fake clock
const BIG = lines(OLD_PROMPT, assistant(1, 650_000, 0))

describe("AutoCompactor", () => {
  test("idle + big → countdown push, then /compact, then boundary push", async () => {
    const h = harness({ transcript: BIG })
    await h.c.onStop(h.target)
    await h.advance(0)
    expect(h.pushes).toEqual([{ kind: "countdown", title: "compacting wt in 60s — cancel?" }])
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([COMPACT_TEXT])
    h.state.transcript = lines(OLD_PROMPT, assistant(1, 650_000, 0), boundary(650_001, 28_951))
    await h.advance(15_000)
    expect(h.pushes[1]).toEqual({ kind: "done", title: "compacted wt: 650k -> 29k tokens" })
    expect(h.c.status()).toEqual([])
  })

  test("below threshold → nothing scheduled", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, assistant(1, 500_000, 0)) })
    await h.c.onStop(h.target)
    await h.advance(10 * 60_000)
    expect(h.pushes).toEqual([])
    expect(h.c.status()).toEqual([])
  })

  test("threshold 0 = off", async () => {
    const h = harness({ transcript: BIG, threshold: 0 })
    await h.c.onStop(h.target)
    await h.advance(10 * 60_000)
    expect(h.pushes).toEqual([])
  })

  test("waits out the idle window after a recent prompt", async () => {
    const h = harness({ transcript: BIG })
    h.c.noteUserActivity("k1") // prompt just now
    await h.c.onStop(h.target)
    await h.advance(IDLE_MS - 1_000)
    expect(h.pushes).toEqual([])
    await h.advance(1_000)
    expect(h.pushes.map((p) => p.kind)).toEqual(["countdown"])
  })

  test("a user prompt during the countdown cancels; no inject", async () => {
    const h = harness({ transcript: BIG })
    await h.c.onStop(h.target)
    await h.advance(0)
    h.c.noteUserActivity("k1")
    await h.advance(CANCEL_MS * 2)
    expect(h.injects).toEqual([])
  })

  test("typing in the pane cancels; no inject", async () => {
    const h = harness({ transcript: BIG })
    h.c.noteUserActivity("k1")
    await h.c.onStop(h.target)
    await h.advance(30_000)
    h.state.input = "typing"
    await h.advance(IDLE_MS + CANCEL_MS)
    expect(h.pushes).toEqual([])
    expect(h.injects).toEqual([])
  })

  test("typing between push and fire → not injected", async () => {
    const h = harness({ transcript: BIG })
    await h.c.onStop(h.target)
    await h.advance(0)
    h.state.input = "typing"
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([])
  })

  test("phone cancel stops the inject and starts the cooldown", async () => {
    const h = harness({ transcript: BIG })
    await h.c.onStop(h.target)
    await h.advance(0)
    expect(h.c.cancel("k1")).toBe(true)
    expect(h.c.cancel("k1")).toBe(false)
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([])
    // Next Stop inside 30 min: cooldown, no push.
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS * 2)
    expect(h.pushes.length).toBe(1)
    // After the cooldown: eligible again.
    await h.advance(COOLDOWN_MS)
    await h.c.onStop(h.target)
    await h.advance(0)
    expect(h.pushes.length).toBe(2)
  })

  test("busy session → skipped, one attempt per Stop (no retry)", async () => {
    const h = harness({ transcript: BIG, status: "busy" })
    await h.c.onStop(h.target)
    await h.advance(0)
    h.state.status = "idle"
    await h.advance(10 * 60_000)
    expect(h.pushes).toEqual([])
    expect(h.logs.some((l) => l.includes("skipped — busy"))).toBe(true)
  })

  test("goes busy during the countdown → not injected", async () => {
    const h = harness({ transcript: BIG })
    await h.c.onStop(h.target)
    await h.advance(0)
    h.state.status = "busy"
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([])
  })

  test("running background task → skipped", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, bgLaunch("toolu_a"), bgResult("toolu_a", "b1"), assistant(1, 650_000, 0)) })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS * 2)
    expect(h.pushes).toEqual([])
    expect(h.logs.some((l) => l.includes("background_tasks"))).toBe(true)
  })

  test("inject refused by the guard → no boundary watch, logged", async () => {
    const h = harness({ transcript: BIG })
    h.state.injectOk = false
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    expect(h.injects.length).toBe(1)
    expect(h.c.status()).toEqual([])
    expect(h.logs.some((l) => l.includes("inject refused — dialog_open"))).toBe(true)
  })

  test("a new Stop supersedes the scheduled check (still one attempt)", async () => {
    const h = harness({ transcript: BIG })
    h.c.noteUserActivity("k1")
    await h.c.onStop(h.target)
    await h.advance(60_000)
    await h.c.onStop(h.target)
    await h.advance(IDLE_MS + CANCEL_MS)
    expect(h.pushes.filter((p) => p.kind === "countdown").length).toBe(1)
    expect(h.injects.length).toBe(1)
  })
})
