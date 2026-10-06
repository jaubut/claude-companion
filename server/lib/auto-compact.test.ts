import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { KEEP_MAX, SessionScan, buildKeep, isClosingPrompt, stateNextLines } from "./auto-compact-keep"
import { compactionStats, ensureCompactionLog, insertCompaction } from "./auto-compact-stats"
import {
  AutoCompactor,
  type AutoCompactDeps,
  BackgroundScan,
  type CompactionDone,
  boundaryFromEnv,
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

describe("compactGate", () => {
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

function harness(opts: { transcript: string; status?: string; input?: InputState; threshold?: number; extra?: Partial<AutoCompactDeps> }) {
  let now = Date.parse("2026-10-05T12:00:00Z")
  let seq = 0
  let timers: Timer[] = []
  const pushes: Array<{ kind: string; title: string }> = []
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
    push: async (kind, _t, title) => { pushes.push({ kind, title }) },
    inject: async (_k, text) => { injects.push(text); return state.injectOk ? { ok: true } : { ok: false, error: "dialog_open" } },
    log: (l) => logs.push(l),
    ...opts.extra,
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
  return { c, state, pushes, injects, logs, reads, advance, target, nowAt: () => now }
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

// ── task boundaries + state-aware keep (lib/auto-compact-keep.ts) ──────────
// Fixtures are trimmed copies of real Zettlab transcript tails (2026-10):
// a squash merge of chantalmasse-website#14, a dispatch.sh completion, a
// Turso note INSERT through the pipeline API, a file-dev-task.sh filing.

const SID = "c447e8b2-062c-4655-b74a-8eef0d18e0bc"
let toolSeq = 0
function bash(command: string, result: string, ts: string, isError = false): string[] {
  const id = `toolu_01EPKtrVMzDmAYBGbT88K${String(++toolSeq).padStart(3, "0")}`
  return [
    JSON.stringify({ parentUuid: "p", isSidechain: false, type: "assistant", timestamp: ts, sessionId: SID, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command, description: "x" } }] } }),
    JSON.stringify({ parentUuid: "p", isSidechain: false, type: "user", timestamp: ts, sessionId: SID, cwd: "/home/aubut/work", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: result, is_error: isError }] } }),
  ]
}
const T = (min: number) => new Date(Date.parse("2026-10-05T11:00:00Z") + min * 60_000).toISOString()

const PR14_VIEW = bash(
  "cd ~/lanes/chantalmasse-website && gh pr view 14 --json state,mergedAt,title,headRefName,url 2>&1",
  '{"headRefName":"fix/booking-reminder-missed-clients","mergedAt":null,"state":"OPEN","title":"fix(booking-reminder): stop dropping clients from the 24h reminder","url":"https://github.com/jaubut/chantalmasse-website/pull/14"}',
  T(1),
)
const PR14_MERGE = bash(
  "cd /tmp/claude-1000/scratchpad/cm && gh pr merge 14 --squash 2>&1 | tail -2; gh pr view 14 --json state,mergeCommit --jq '.state+\" \"+.mergeCommit.oid'",
  "MERGED 7da5bdfe351c35d89d7275ad404aad8ea1601ee8\nShell cwd was reset to /home/aubut/work",
  T(2),
)
const PR14_MERGE_FAIL = bash(
  "gh pr merge 14 --squash 2>&1 | tail -2",
  "X Pull request jaubut/chantalmasse-website#14 is not mergeable: the merge commit cannot be cleanly created.",
  T(2),
)
const TASK_DONE = bash(
  "bash ~/.claude/tools/dispatch.sh 3f8ea8adb605fe096b3dff82addad13e completed builder",
  "dispatch.sh: 3f8ea8adb605fe096b3dff82addad13e → completed",
  T(3),
)
const TASK_SQL_DONE = bash(
  'reqs="{\\"type\\":\\"execute\\",\\"stmt\\":{\\"sql\\":\\"UPDATE tasks SET done=1 WHERE id=?\\",\\"args\\":[{\\"type\\":\\"text\\",\\"value\\":\\"9be30c71\\"}]}}"; curl -s "$TURSO/v2/pipeline" -d "$reqs"',
  "ok 1 None",
  T(3),
)
const NOTE_INSERT = bash(
  "python3 - <<E > $S/ins.json\nargs=[t('resources/2026-10-03-bistro-mavia-booking-spec'),t('resources'),t('resources/2026-10-03-bistro-mavia-booking-spec.md')]\nprint(json.dumps({\"requests\":[{\"type\":\"execute\",\"stmt\":{\"sql\":\"INSERT INTO notes (id, folder, filename) VALUES (?, ?, ?)\"}}]}))\nE\ncurl -s \"https://tls-dashboard-jaubut.aws-us-east-1.turso.io/v2/pipeline\" -d @$S/ins.json",
  "affected 1 []\naffected 0 [['resources/2026-10-03-bistro-mavia-booking-spec', 'RES-MVBK', 'Spec: Bistro Mavia built-in reservation system (replaces Libro)', '15476']]",
  T(4),
)
const DEV_TASK = bash(
  '~/.claude/tools/file-dev-task.sh PRJ-WCLS builder "bank-match-multi-invoice-client-sum" "Bank reconciliation: match one deposit to several invoices" "Today a bank deposit can only be linked to one invoice"',
  "filed 47de97dff69c90641bc0d52f946f5cee",
  T(4),
)
const NOTE_LISTING = bash(
  "UPDATE notes SET status='archived' WHERE id=? -- then list",
  "PRJ-AAAA a\nPRJ-BBBB b\nPRJ-CCCC c\nRES-DDDD d",
  T(5),
)
const scanOf = (...l: string[]) => {
  const s = new SessionScan()
  s.feed(parseLines(lines(...l)), NOW)
  return s
}
const WORK = userPrompt("merge pr 14 if CI is green", T(0))

describe("closing prompts", () => {
  test("short thanks / ok words only", () => {
    for (const t of ["nice", "perf!", "ok merci", "good job 👍", "Dope.", "thanks", "nice work"]) expect(isClosingPrompt(t)).toBe(true)
    for (const t of ["", "ok fix it", "nice, now do the iOS card", "ok go ahead and merge", "yes"]) expect(isClosingPrompt(t)).toBe(false)
  })
})

describe("SessionScan: unit-of-work boundaries", () => {
  test("a squash merge closes the unit", () => {
    expect(scanOf(WORK, ...PR14_VIEW, ...PR14_MERGE).closedSince(0)).toBe("pr_merged")
  })
  test("viewing an open PR is not a boundary", () => {
    expect(scanOf(WORK, ...PR14_VIEW).closedSince(0)).toBeNull()
  })
  test("a failed merge is not a boundary", () => {
    expect(scanOf(WORK, ...PR14_VIEW, ...PR14_MERGE_FAIL).closedSince(0)).toBeNull()
    expect(scanOf(WORK, ...bash("gh pr merge 14", "Exit code 1\nGraphQL: Pull request is not mergeable", T(2), true)).closedSince(0)).toBeNull()
  })
  test("dispatch.sh completed / UPDATE tasks done=1 close the unit", () => {
    expect(scanOf(WORK, ...TASK_DONE).closedSince(0)).toBe("task_completed")
    expect(scanOf(WORK, ...TASK_SQL_DONE).closedSince(0)).toBe("task_completed")
  })
  test("a closing prompt after a finished turn closes the unit", () => {
    expect(scanOf(WORK, assistant(1, 300_000, 0), userPrompt("perf", T(10))).closedSince(0)).toBe("closing_prompt")
  })
  test("a new work prompt after the merge reopens the unit", () => {
    expect(scanOf(WORK, ...PR14_MERGE, userPrompt("now update the iOS card", T(10))).closedSince(0)).toBeNull()
    expect(scanOf(WORK, ...PR14_MERGE, userPrompt("nice", T(10)), userPrompt("now the iOS card", T(11))).closedSince(0)).toBeNull()
  })
  test("closings already used (consumed) or before a compaction do not count", () => {
    expect(scanOf(WORK, ...PR14_MERGE).closedSince(Date.parse(T(2)) + 1)).toBeNull()
    const compacted = JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: T(5), compactMetadata: { preTokens: 1, postTokens: 1 } })
    expect(scanOf(WORK, ...PR14_MERGE, compacted).closedSince(0)).toBeNull()
  })
})

describe("SessionScan: durable pointers", () => {
  test("PRs with repo and last state, notes and ref codes this session wrote", () => {
    const s = scanOf(WORK, ...PR14_VIEW, ...PR14_MERGE, ...NOTE_INSERT, ...DEV_TASK, ...NOTE_LISTING,
      ...bash("gh pr create --title x --body y", "https://github.com/jaubut/claude-companion/pull/140", T(6)))
    expect(s.snapshot()).toEqual({
      prs: [{ number: 140, repo: "jaubut/claude-companion", state: "OPEN" }, { number: 14, repo: "jaubut/chantalmasse-website", state: "MERGED" }],
      noteIds: ["resources/2026-10-03-bistro-mavia-booking-spec"],
      refCodes: ["PRJ-WCLS", "RES-MVBK"], // the 4-ref listing is not a write of those notes
    })
  })
  test("sidechain (subagent) tool calls are not this session's", () => {
    const side = PR14_MERGE.map((l) => JSON.stringify({ ...JSON.parse(l), isSidechain: true }))
    expect(scanOf(WORK, ...side).snapshot().prs).toEqual([])
  })
})

describe("stateNextLines", () => {
  test("the resume / next section and Next: lines", () => {
    const md = "# STATE\n\n## 📌 Resume here (next session)\n\n- Ship v0.7 R2 rewire\n- Wire spend caps\n\n### detail\n- sub point\n\n## Active Decisions\n- not next\n\n**Next:** run the smoke test\n"
    expect(stateNextLines(md)).toEqual(["Ship v0.7 R2 rewire", "Wire spend caps", "sub point", "**Next:** run the smoke test"])
    expect(stateNextLines("# STATE\n## Active Decisions\n- a\n")).toEqual([])
  })
})

describe("buildKeep", () => {
  test("nothing durable → today's generic keep", () => {
    expect(buildKeep(null)).toBe(COMPACT_TEXT)
    expect(buildKeep({ prs: [], notes: [], next: [], human: [] })).toBe(COMPACT_TEXT)
  })
  test("PRs (open first), notes + open tasks, STATE.md next, human steps — one line", () => {
    const k = buildKeep({
      prs: [{ number: 14, repo: "jaubut/chantalmasse-website", state: "MERGED" }, { number: 140, repo: "jaubut/claude-companion", state: "OPEN" }],
      notes: [{ id: "projects/2026-06-22-companion-orchestrator", ref: "PRJ-OR1T", openTasks: ["iOS token card\nshows compactions"] }],
      next: ["Ship v0.7"],
      human: ["Approve the vault PR"],
    })
    expect(k).toBe("/compact keep: current task, decisions made; PRs: jaubut/claude-companion#140 OPEN, jaubut/chantalmasse-website#14 MERGED; "
      + "Turso note projects/2026-06-22-companion-orchestrator (PRJ-OR1T) open tasks: iOS token card shows compactions; "
      + "STATE.md next: Ship v0.7; pending human steps: Approve the vault PR")
  })
  test("capped at KEEP_MAX", () => {
    const long = "x".repeat(300)
    const k = buildKeep({ prs: [], notes: Array.from({ length: 4 }, (_, i) => ({ id: `projects/n${i}`, ref: "", openTasks: [long, long, long, long, long] })), next: [long], human: [long] })
    expect(k.length).toBeLessThanOrEqual(KEEP_MAX)
    expect(k.includes("\n")).toBe(false)
  })
  test("strips control characters from typed keep text", () => {
    const k = buildKeep({ prs: [], notes: [], next: ["clear \u001b[2J then \u0003 stop"], human: [] })
    expect(k.startsWith("/compact keep:")).toBe(true)
    expect(k.includes("\u001b")).toBe(false)
    expect(k.includes("\u0003")).toBe(false)
  })
})

describe("AutoCompactor: boundary trigger + keep", () => {
  const MID = (...l: string[]) => lines(OLD_PROMPT, ...l, assistant(1, 300_000, 0)) // 300k: under 600k, over 250k
  const keep = { prs: [{ number: 14, repo: "jaubut/chantalmasse-website", state: "MERGED" }], notes: [], next: [], human: [] }
  const boundaryDeps = (extra: Partial<AutoCompactDeps> = {}): Partial<AutoCompactDeps> => ({
    boundaryThreshold: () => 250_000, keepState: async () => keep, ...extra,
  })
  const MERGED = MID(userPrompt("merge pr 14", "2026-10-05T11:00:00Z"), ...PR14_MERGE)

  test("PR merged + 300k → countdown, then the state-aware keep is typed", async () => {
    const h = harness({ transcript: MERGED, extra: boundaryDeps() })
    await h.c.onStop(h.target)
    expect(h.c.status().map((s) => s.trigger)).toEqual(["pr_merged"])
    await h.advance(0)
    expect(h.pushes).toEqual([{ kind: "countdown", title: "compacting wt in 60s" }])
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual(["/compact keep: current task, decisions made; PRs: jaubut/chantalmasse-website#14 MERGED"])
  })

  test("task completed / closing prompt arm it too", async () => {
    for (const t of [MID(WORK, ...TASK_DONE), MID(WORK, userPrompt("merci", "2026-10-05T11:20:00Z"))]) {
      const h = harness({ transcript: t, extra: boundaryDeps() })
      await h.c.onStop(h.target)
      await h.advance(CANCEL_MS)
      expect(h.injects.length).toBe(1)
    }
  })

  test("no closing, under the boundary floor, or boundary off → nothing", async () => {
    const cases: Array<[string, Partial<AutoCompactDeps>]> = [
      [MID(WORK, ...PR14_VIEW), boundaryDeps()],
      [lines(OLD_PROMPT, userPrompt("merge", T(0)), ...PR14_MERGE, assistant(1, 200_000, 0)), boundaryDeps()],
      [MERGED, boundaryDeps({ boundaryThreshold: () => 0 })],
      [MERGED, {}],
    ]
    for (const [t, extra] of cases) {
      const h = harness({ transcript: t, extra })
      await h.c.onStop(h.target)
      await h.advance(10 * 60_000)
      expect(h.pushes).toEqual([])
    }
  })

  test("AUTO_COMPACT_TOKENS=0 → no change: nothing armed, nothing read", async () => {
    const h = harness({ transcript: MERGED, threshold: 0, extra: boundaryDeps() })
    await h.c.onStop(h.target)
    await h.advance(10 * 60_000)
    expect(h.pushes).toEqual([])
    expect(h.reads).toEqual([])
  })

  test("same gates: a busy session is skipped", async () => {
    const h = harness({ transcript: MERGED, status: "busy", extra: boundaryDeps() })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS * 2)
    expect(h.injects).toEqual([])
    expect(h.logs.some((l) => l.includes("skipped — busy"))).toBe(true)
  })

  test("a closing is used once: no second compaction for the same merge", async () => {
    const h = harness({ transcript: MERGED, extra: boundaryDeps() })
    await h.c.onStop(h.target)
    await h.advance(0)
    h.c.cancel("k1")
    await h.advance(COOLDOWN_MS + 1)
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    expect(h.pushes.length).toBe(1)
  })

  test("keep lookup failure → generic keep; completion is recorded (X -> Y)", async () => {
    const done: CompactionDone[] = []
    const h = harness({ transcript: BIG, extra: { keepState: async () => { throw new Error("turso down") }, recordCompaction: (d) => done.push(d) } })
    await h.c.onStop(h.target)
    await h.advance(CANCEL_MS)
    expect(h.injects).toEqual([COMPACT_TEXT])
    h.state.transcript += lines(boundary(650_001, 28_951))
    await h.advance(15_000)
    expect(done.map((d) => [d.trigger, d.preTokens, d.postTokens])).toEqual([["size", 650_001, 28_951]])
  })
})

describe("boundary setting", () => {
  test("default 250k, 0 = off", () => {
    expect(boundaryFromEnv({})).toBe(250_000)
    expect(boundaryFromEnv({ AUTO_COMPACT_BOUNDARY_TOKENS: "junk" })).toBe(250_000)
    expect(boundaryFromEnv({ AUTO_COMPACT_BOUNDARY_TOKENS: "0" })).toBe(0)
    expect(boundaryFromEnv({ AUTO_COMPACT_BOUNDARY_TOKENS: "300000" })).toBe(300_000)
  })
})

describe("compaction stats", () => {
  test("count and tokens saved since a time", () => {
    const db = new Database(":memory:")
    ensureCompactionLog(db)
    insertCompaction(db, { at: 100, sessionKey: "k", name: "wt", trigger: "size", preTokens: 650_000, postTokens: 30_000 })
    insertCompaction(db, { at: 200, sessionKey: "k", name: "wt", trigger: "pr_merged", preTokens: 300_000, postTokens: 20_000 })
    expect(compactionStats(db, 150)).toEqual({ count: 1, pre_tokens: 300_000, post_tokens: 20_000, saved: 280_000 })
    expect(compactionStats(db, 0)).toEqual({ count: 2, pre_tokens: 950_000, post_tokens: 50_000, saved: 900_000 })
    expect(compactionStats(db, 300).count).toBe(0)
  })
})
