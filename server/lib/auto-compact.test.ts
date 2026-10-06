import { describe, expect, test } from "bun:test"
import {
  AutoCompactor,
  type AutoCompactDeps,
  BackgroundScan,
  CANCEL_MS,
  COMPACT_TEXT,
  BG_MAX_AGE_MS,
  COOLDOWN_MS,
  type GateInput,
  IDLE_MS,
  type InputState,
  SCAN_CHUNK_BYTES,
  TAIL_START_BYTES,
  compactBoundaries,
  compactGate as gate,
  inScope,
  scopeFromEnv,
  contextTokens as contextTokensOf,
  lastHumanPromptAt as lastHumanPromptAtOf,
  openBackgroundTasks as openBackgroundTasksOf,
  parseLines,
  thresholdFromEnv,
} from "./auto-compact"

// The helpers take parsed entries; the fixtures are JSONL text.
const contextTokens = (t: string) => contextTokensOf(parseLines(t))
const lastHumanPromptAt = (t: string) => lastHumanPromptAtOf(parseLines(t))
const NOW = Date.parse("2026-10-05T12:00:00Z")
const openBackgroundTasks = (t: string, now = NOW) => openBackgroundTasksOf(parseLines(t), now)

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
function bgLaunch(id: string, ts?: string): string {
  return JSON.stringify({ type: "assistant", ...(ts ? { timestamp: ts } : {}), message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 100", run_in_background: true } }] } })
}
function bgResult(id: string, taskId: string): string {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/x` }] } })
}
function bgNotify(id: string, taskId: string): string {
  return JSON.stringify({ type: "queue-operation", content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` })
}
function kill(taskId: string, name = "KillShell", key = "shell_id"): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_kill", name, input: { [key]: taskId } }] } })
}
function killResult(text: string, isError = false): string {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_kill", content: text, ...(isError ? { is_error: true } : {}) }] } })
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
    expect(compactBoundaries(parseLines(lines(boundary(969_933, 28_951))))).toEqual([{ uuid: "b1", timestamp: "2026-10-05T00:00:00Z", preTokens: 969_933, postTokens: 28_951, trigger: "manual" }])
  })
  test("background tasks: open until notified or killed", () => {
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "b0jy")))).toEqual(["b0jy"])
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "b0jy"), bgNotify("toolu_a", "b0jy")))).toEqual([])
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "b0jy"), kill("b0jy"), killResult("Successfully killed shell: b0jy")))).toEqual([])
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "b0jy"), kill("b0jy", "TaskStop", "task_id"),
      killResult('{"message":"Successfully stopped task: b0jy (sleep 100)","task_id":"b0jy"}')))).toEqual([])
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a")))).toEqual(["toolu_a"])
  })
  test("a failed or unconfirmed stop leaves the task open", () => {
    const base = [bgLaunch("toolu_a"), bgResult("toolu_a", "b0jy"), kill("b0jy", "TaskStop", "task_id")]
    expect(openBackgroundTasks(lines(...base))).toEqual(["b0jy"]) // no result yet
    expect(openBackgroundTasks(lines(...base, killResult("Error: no task found with ID b0jy", true)))).toEqual(["b0jy"])
    expect(openBackgroundTasks(lines(...base, killResult("Task b0jy is not running")))).toEqual(["b0jy"])
    expect(openBackgroundTasks(lines(...base, killResult("Successfully stopped task: b0jy", true)))).toEqual(["b0jy"])
  })
  test("launches before the latest compact boundary are ignored", () => {
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "old1"), boundary(700_000, 30_000), assistant(1, 31_000, 0)))).toEqual([])
    expect(openBackgroundTasks(lines(boundary(700_000, 30_000), bgLaunch("toolu_b"), bgResult("toolu_b", "new1")))).toEqual(["new1"])
  })
  test("launches older than BG_MAX_AGE_MS are ignored", () => {
    const old = new Date(NOW - BG_MAX_AGE_MS - 1).toISOString()
    const fresh = new Date(NOW - BG_MAX_AGE_MS + 60_000).toISOString()
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a", old), bgResult("toolu_a", "x")))).toEqual([])
    expect(openBackgroundTasks(lines(bgLaunch("toolu_a", fresh), bgResult("toolu_a", "x")))).toEqual(["x"])
  })
  test("a launch with no timestamp ages from when it was scanned", () => {
    const scan = new BackgroundScan()
    scan.feed(parseLines(lines(bgLaunch("toolu_a"), bgResult("toolu_a", "x"))), NOW)
    expect(scan.open(NOW + BG_MAX_AGE_MS)).toEqual(["x"])
    expect(scan.open(NOW + BG_MAX_AGE_MS + 1)).toEqual([])
  })
  test("last human prompt ignores tool results and task notifications", () => {
    const t = lines(userPrompt("do it", "2026-10-05T10:00:00Z"), bgResult("toolu_a", "x"), userPrompt("<task-notification>…</task-notification>", "2026-10-05T11:00:00Z"))
    expect(lastHumanPromptAt(t)).toBe(Date.parse("2026-10-05T10:00:00Z"))
  })
})

describe("threshold setting", () => {
  test("off unless set to a positive number (opt-in)", () => {
    expect(thresholdFromEnv({})).toBe(0)
    expect(thresholdFromEnv({ AUTO_COMPACT_TOKENS: "" })).toBe(0)
    expect(thresholdFromEnv({ AUTO_COMPACT_TOKENS: "0" })).toBe(0)
    expect(thresholdFromEnv({ AUTO_COMPACT_TOKENS: "-5" })).toBe(0)
    expect(thresholdFromEnv({ AUTO_COMPACT_TOKENS: "lots" })).toBe(0)
    expect(thresholdFromEnv({ AUTO_COMPACT_TOKENS: "600000" })).toBe(600_000)
  })
})

describe("AUTO_COMPACT_ONLY scope", () => {
  test("parse: unset/blank → [] (every session); comma list trimmed", () => {
    expect(scopeFromEnv({})).toEqual([])
    expect(scopeFromEnv({ AUTO_COMPACT_ONLY: " , " })).toEqual([])
    expect(scopeFromEnv({ AUTO_COMPACT_ONLY: "tmux:%3, wt-*" })).toEqual(["tmux:%3", "wt-*"])
  })
  test("match key exactly or name by glob, case-insensitive", () => {
    const t = { key: "tmux:%3", name: "WT-Companion" }
    expect(inScope(t, [])).toBe(true)
    expect(inScope(t, ["tmux:%3"])).toBe(true)
    expect(inScope(t, ["wt-*"])).toBe(true)
    expect(inScope(t, ["other", "wt-compan?on"])).toBe(true)
    expect(inScope(t, ["tmux:%"])).toBe(false)
    expect(inScope(t, ["wt"])).toBe(false)
    expect(inScope(t, ["wt-(.*)"])).toBe(false) // regex chars are literal
  })
})

describe("compactGate", () => {
  const now = 10_000_000
  const ok: GateInput = {
    threshold: 600_000, tokens: 650_000, now, lastUserActivityAt: now - IDLE_MS, idleMs: IDLE_MS,
    agentStatus: "idle", backgroundTasks: 0, lastAttemptAt: 0, cooldownMs: COOLDOWN_MS, input: "empty",
  }
  test("passes when every condition holds", () => expect(gate(ok)).toEqual({ ok: true }))
  test("force skips only the size check", () => {
    expect(gate({ ...ok, tokens: 1_000, force: true })).toEqual({ ok: true })
    expect(gate({ ...ok, tokens: null, force: true })).toEqual({ ok: true })
    expect(gate({ ...ok, threshold: 0, force: true })).toEqual({ ok: false, reason: "off" })
    expect(gate({ ...ok, tokens: 1_000, force: true, agentStatus: "busy" })).toEqual({ ok: false, reason: "busy" })
  })
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

function harness(opts: { transcript: string; status?: string; input?: InputState; threshold?: number; eligible?: boolean }) {
  let now = Date.parse("2026-10-05T12:00:00Z")
  let seq = 0
  let timers: Timer[] = []
  const pushes: Array<{ kind: string; title: string }> = []
  const bodies: string[] = []
  const injects: string[] = []
  const logs: string[] = []
  const state = { transcript: opts.transcript, status: opts.status ?? "idle", input: opts.input ?? ("empty" as InputState), injectOk: true }
  const reads: Array<[number, number]> = []
  const deps: AutoCompactDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, id: ++seq }; timers.push(t); return t.id },
    clearTimer: (id) => { timers = timers.filter((t) => t.id !== id) },
    threshold: () => opts.threshold ?? 600_000,
    transcriptSize: async () => Buffer.byteLength(state.transcript),
    readTranscript: async (_p, start, end) => {
      reads.push([start, end])
      return Buffer.from(state.transcript).subarray(start, end).toString("utf8")
    },
    agentStatus: async () => state.status,
    inputState: async () => state.input,
    push: async (kind, _t, title, body) => { pushes.push({ kind, title }); bodies.push(body) },
    inject: async (_k, text) => { injects.push(text); return state.injectOk ? { ok: true } : { ok: false, error: "dialog_open" } },
    log: (l) => logs.push(l),
    ...(opts.eligible === undefined ? {} : { eligible: () => opts.eligible! }),
  }
  const c = new AutoCompactor(deps)
  const flush = async () => { for (let i = 0; i < 500; i++) await Promise.resolve() }
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
  return { c, state, pushes, bodies, injects, logs, reads, advance, target, nowAt: () => now }
}

const OLD_PROMPT = userPrompt("start", "2026-10-05T11:00:00Z") // an hour before the fake clock
const BIG = lines(OLD_PROMPT, assistant(1, 650_000, 0))

describe("AutoCompactor", () => {
  test("idle + big → countdown push, then /compact, then boundary push", async () => {
    const h = harness({ transcript: BIG })
    await h.c.onStop(h.target)
    await h.advance(0)
    expect(h.pushes).toEqual([{ kind: "countdown", title: "compacting wt in 60s" }])
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([COMPACT_TEXT])
    const injectedAt = Buffer.byteLength(h.state.transcript)
    h.state.transcript = lines(OLD_PROMPT, assistant(1, 650_000, 0), boundary(650_001, 28_951))
    h.reads.length = 0
    await h.advance(15_000)
    expect(h.pushes[1]).toEqual({ kind: "done", title: "compacted wt: 650k -> 29k tokens" })
    expect(h.c.status()).toEqual([])
    // The boundary watch read only the bytes appended after the inject.
    expect(h.reads).toEqual([[injectedAt, Buffer.byteLength(h.state.transcript)]])
  })

  test("an old boundary before the inject is not mistaken for the result", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, boundary(900_000, 20_000, "old"), assistant(1, 650_000, 0)) })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([COMPACT_TEXT])
    await h.c.onCompacted("k1")
    await h.advance(15_000 * 3)
    expect(h.pushes.map((p) => p.kind)).toEqual(["countdown"])
    expect(h.c.status().map((s) => s.phase)).toEqual(["awaiting_boundary"])
  })

  test("onStop reads only the transcript tail of a big file", async () => {
    const filler = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_f", content: "x".repeat(10_000) }] } })
    const big = lines(OLD_PROMPT, ...Array.from({ length: 300 }, () => filler), assistant(1, 650_000, 0)) // ~3 MB
    const h = harness({ transcript: big })
    await h.c.onStop(h.target)
    const size = Buffer.byteLength(big)
    expect(h.reads).toEqual([[size - TAIL_START_BYTES, size]])
    expect(h.c.status().map((s) => s.tokens)).toEqual([650_001])
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

  test("failed TaskStop does not unblock: skipped", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, bgLaunch("toolu_a"), bgResult("toolu_a", "b1"), kill("b1", "TaskStop", "task_id"), killResult("Error: task b1 not found", true), assistant(1, 650_000, 0)) })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS * 2)
    expect(h.pushes).toEqual([])
    expect(h.logs.some((l) => l.includes("background_tasks"))).toBe(true)
  })

  test("background task launched before an earlier compaction does not block", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, bgLaunch("toolu_a"), bgResult("toolu_a", "b1"), boundary(800_000, 30_000), assistant(1, 650_000, 0)) })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([COMPACT_TEXT])
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

  // A young (< BG_MAX_AGE_MS), boundary-less session far bigger than the tail
  // cap: launches anywhere in it are seen, and nothing is parsed twice.
  const filler = JSON.stringify({ type: "user", timestamp: "2026-10-05T11:30:00Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_f", content: "x".repeat(10_000) }] } })
  const HUGE = Array.from({ length: 2_000 }, () => filler) // ~20 MB

  test("huge young session with no launches is compacted (not refused as background_tasks)", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, ...HUGE, assistant(1, 650_000, 0)) })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([COMPACT_TEXT])
    expect(h.reads.every(([a, b]) => b - a <= SCAN_CHUNK_BYTES * 16)).toBe(true)
  })

  test("a launch at the top of a huge session still blocks", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, bgLaunch("toolu_a"), bgResult("toolu_a", "b1"), ...HUGE, assistant(1, 650_000, 0)) })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS * 2)
    expect(h.injects).toEqual([])
    expect(h.logs.some((l) => l.includes("background_tasks"))).toBe(true)
  })

  test("the background scan reads only bytes appended since the last check", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, ...HUGE, assistant(1, 650_000, 0)) })
    await h.c.onStop(h.target)
    await h.advance(0) // evaluate: full scan
    const scanned = Buffer.byteLength(h.state.transcript)
    h.state.transcript += lines(assistant(1, 650_100, 0))
    h.reads.length = 0
    await h.advance(CANCEL_MS) // fire: tail + appended bytes only
    expect(h.injects).toEqual([COMPACT_TEXT])
    expect(h.reads).toContainEqual([scanned, Buffer.byteLength(h.state.transcript)])
    expect(h.reads.every(([a]) => a >= Buffer.byteLength(h.state.transcript) - TAIL_START_BYTES || a >= scanned)).toBe(true)
  })

  test("tail windows grow without re-reading parsed bytes", async () => {
    const h = harness({ transcript: lines(OLD_PROMPT, assistant(1, 650_000, 0), ...Array.from({ length: 200 }, () => filler)) })
    await h.c.onStop(h.target)
    const size = Buffer.byteLength(h.state.transcript)
    expect(h.reads[0]).toEqual([size - TAIL_START_BYTES, size])
    for (let i = 1; i < h.reads.length; i++) expect(h.reads[i]![1]).toBeLessThanOrEqual(h.reads[i - 1]![0] + 20_000)
    expect(h.c.status().map((s) => s.tokens)).toEqual([650_001])
  })

  test("a transcript rewritten shorter with the new boundary still completes", async () => {
    const h = harness({ transcript: BIG + lines(...HUGE.slice(0, 50)) })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([COMPACT_TEXT])
    const at = new Date(h.nowAt()).toISOString()
    const fresh = JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "b2", timestamp: at, compactMetadata: { trigger: "manual", preTokens: 650_001, postTokens: 30_000 } })
    h.state.transcript = lines(boundary(900_000, 20_000, "old"), fresh)
    await h.advance(15_000)
    expect(h.pushes[1]).toEqual({ kind: "done", title: "compacted wt: 650k -> 30k tokens" })
  })

  test("a rewritten transcript holding only the old boundary does not complete", async () => {
    const h = harness({ transcript: BIG + lines(...HUGE.slice(0, 50)) })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    h.state.transcript = lines(boundary(900_000, 20_000, "old"))
    await h.advance(15_000 * 2)
    expect(h.pushes.map((p) => p.kind)).toEqual(["countdown"])
  })
})

describe("AUTO_COMPACT_ONLY in the controller", () => {
  test("out-of-scope session: a big Stop arms nothing", async () => {
    const h = harness({ transcript: BIG, eligible: false })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS * 2)
    expect(h.pushes).toEqual([])
    expect(h.c.status()).toEqual([])
  })
  test("in-scope session behaves as before", async () => {
    const h = harness({ transcript: BIG, eligible: true })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([COMPACT_TEXT])
  })
})

describe("AutoCompactor.test (on-demand trigger)", () => {
  const SMALL = lines(OLD_PROMPT, assistant(1, 40_000, 0))

  test("small session: countdown push, 60 s, then /compact, then done", async () => {
    const h = harness({ transcript: SMALL })
    expect(await h.c.test(h.target)).toEqual({ ok: true, waitMs: 0, tokens: 40_001 })
    await h.advance(0)
    expect(h.pushes).toEqual([{ kind: "countdown", title: "compacting wt in 60s" }])
    await h.advance(CANCEL_MS - 1)
    expect(h.injects).toEqual([])
    await h.advance(1)
    expect(h.injects).toEqual([COMPACT_TEXT])
    h.state.transcript += lines(boundary(40_001, 9_000))
    await h.advance(15_000)
    expect(h.pushes[1]).toEqual({ kind: "done", title: "compacted wt: 40k -> 9k tokens" })
  })

  test("countdown body shows the count, or leaves it out when unknown", async () => {
    const h = harness({ transcript: SMALL })
    await h.c.test(h.target)
    await h.advance(0)
    expect(h.bodies[0]).toBe("Context 40k tokens. To cancel, type anything in the session's pane.")
    const u = harness({ transcript: lines(OLD_PROMPT, assistant(1, 40_000, 0), boundary(40_001, 9_000)) })
    expect(await u.c.test(u.target)).toMatchObject({ ok: true, tokens: null })
    await u.advance(0)
    expect(u.bodies).toEqual(["To cancel, type anything in the session's pane."])
  })

  test("ignores AUTO_COMPACT_ONLY (explicit target)", async () => {
    const h = harness({ transcript: SMALL, eligible: false })
    expect((await h.c.test(h.target)).ok).toBe(true)
  })

  test("refused when the feature is off", async () => {
    const h = harness({ transcript: SMALL, threshold: 0 })
    expect(await h.c.test(h.target)).toEqual({ ok: false, error: "off" })
    expect(h.c.status()).toEqual([])
  })

  test("refused when the session is busy (or waiting)", async () => {
    for (const status of ["busy", "waiting"]) {
      const h = harness({ transcript: SMALL, status })
      expect(await h.c.test(h.target)).toEqual({ ok: false, error: "busy" })
      expect(h.c.status()).toEqual([])
    }
  })

  test("cancel during the countdown → no inject", async () => {
    const h = harness({ transcript: SMALL })
    await h.c.test(h.target)
    await h.advance(0)
    expect(h.c.cancel("k1")).toBe(true)
    await h.advance(CANCEL_MS * 2)
    expect(h.injects).toEqual([])
  })

  test("typing in the pane during the countdown → no inject", async () => {
    const h = harness({ transcript: SMALL })
    await h.c.test(h.target)
    await h.advance(0)
    h.state.input = "typing"
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([])
  })

  test("still waits out the idle window after a recent prompt", async () => {
    const h = harness({ transcript: SMALL })
    h.c.noteUserActivity("k1")
    const r = await h.c.test(h.target)
    expect(r).toEqual({ ok: true, waitMs: IDLE_MS, tokens: 40_001 })
    await h.advance(IDLE_MS - 1)
    expect(h.pushes).toEqual([])
    await h.advance(1)
    expect(h.pushes.map((p) => p.kind)).toEqual(["countdown"])
  })

  test("refused during cooldown and while a compaction is in flight", async () => {
    const h = harness({ transcript: SMALL })
    await h.c.test(h.target)
    await h.advance(CANCEL_MS)
    expect(await h.c.test(h.target)).toEqual({ ok: false, error: "in_progress" })
    h.state.transcript += lines(boundary(40_001, 9_000))
    await h.advance(15_000)
    expect(await h.c.test(h.target)).toEqual({ ok: false, error: "cooldown" })
  })

  test("a later normal Stop on a small session does not re-arm the test", async () => {
    const h = harness({ transcript: SMALL })
    await h.c.test(h.target)
    await h.c.onStop(h.target) // supersedes; below threshold → nothing
    await h.advance(CANCEL_MS * 2)
    expect(h.pushes).toEqual([])
  })
})
