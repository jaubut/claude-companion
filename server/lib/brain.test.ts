import { describe, expect, test } from "bun:test"
import {
  brainToolStep,
  RESTART_WINDOW_MS, START_GRACE_MS, VOICE_CONSENT_MS,
  bootSeed, brainEnabled, deliveryText, idleCompactDue, isBrainHook, isSupervisedTask,
  rolloverDue, superviseStep, voiceConsent,
} from "./brain"

// brain-v2 policy (lib/brain.ts): pure, so every rule is pinned here. The
// brain's tool limits are not here: it is a normal session (brain/CLAUDE.md,
// brain/.claude/settings.json, auto-judge → phone; SUPER skipped — hooks-brain.test.ts).

test("isBrainHook / isSupervisedTask", () => {
  expect(isBrainHook("brain")).toBe(true)
  expect(isBrainHook("")).toBe(false)
  expect(isBrainHook(undefined)).toBe(false)
  expect(isBrainHook("lead-x")).toBe(false)
  expect(isSupervisedTask("lead-tls")).toBe(true)
  expect(isSupervisedTask("brain")).toBe(true)
  expect(isSupervisedTask("0123abcd")).toBe(false)
  expect(brainEnabled({ COMPANION_BRAIN: "1" })).toBe(true)
  expect(brainEnabled({})).toBe(false)
})

describe("superviseStep", () => {
  const base = { paused: false, alive: false, state: "starting" as const, spawnedAt: 0, restarts: [] as number[], now: 10_000_000 }
  test("dead → spawn, recorded as a restart", () => {
    expect(superviseStep(base)).toEqual({ state: "starting", action: "spawn", restarts: [base.now] })
  })
  test("a spawn inside its start grace is waited on", () => {
    expect(superviseStep({ ...base, spawnedAt: base.now - START_GRACE_MS + 1 }).action).toBe("none")
  })
  test("3 restarts inside the window → down; restarts outside it age out", () => {
    const three = [base.now - 1000, base.now - 2000, base.now - 3000]
    expect(superviseStep({ ...base, restarts: three })).toMatchObject({ state: "down", action: "none" })
    const old = three.map((t) => t - RESTART_WINDOW_MS)
    expect(superviseStep({ ...base, restarts: old })).toMatchObject({ action: "spawn", restarts: [base.now] })
  })
  test("paused wins: stop a live agent, never spawn a dead one", () => {
    expect(superviseStep({ ...base, paused: true, alive: true })).toMatchObject({ state: "paused", action: "stop" })
    expect(superviseStep({ ...base, paused: true })).toMatchObject({ state: "paused", action: "none" })
  })
  test("down is sticky: no respawn even after the window clears (a manual resume / restart resets state)", () => {
    expect(superviseStep({ ...base, state: "down" })).toMatchObject({ state: "down", action: "none" })
    expect(superviseStep({ ...base, state: "down", restarts: [base.now - 2 * RESTART_WINDOW_MS] })).toMatchObject({ state: "down", action: "none" })
    expect(superviseStep({ ...base, state: "starting" }).action).toBe("spawn")
  })
  test("alive → up", () => {
    expect(superviseStep({ ...base, alive: true, state: "up" })).toMatchObject({ state: "up", action: "none" })
  })
})

describe("voiceConsent", () => {
  const now = 50_000_000
  const voice = { threadId: "brain", role: "user", createdAt: now - 60_000, card: { kind: "voice", source: "app" } }
  test("a fresh app voice turn in the brain thread → consent", () => {
    expect(voiceConsent(voice, now, false)).toBe(true)
  })
  test("typed turn, > 10 min, already used, other thread, missing turn → the tap", () => {
    expect(voiceConsent({ ...voice, card: null }, now, false)).toBe(false)
    expect(voiceConsent({ ...voice, createdAt: now - VOICE_CONSENT_MS - 1 }, now, false)).toBe(false)
    expect(voiceConsent(voice, now, true)).toBe(false)
    expect(voiceConsent({ ...voice, threadId: "general" }, now, false)).toBe(false)
    expect(voiceConsent({ ...voice, role: "orchestrator" }, now, false)).toBe(false)
    expect(voiceConsent({ ...voice, card: { kind: "voice", source: "telegram" } }, now, false)).toBe(false)
    expect(voiceConsent(null, now, false)).toBe(false)
  })
})

test("idleCompactDue: only idle ≥ 15 min AND context > 60 %", () => {
  const now = 100_000_000
  expect(idleCompactDue({ lastTurnAt: now - 16 * 60_000, contextPct: 61, now, busy: false })).toBe(true)
  expect(idleCompactDue({ lastTurnAt: now - 14 * 60_000, contextPct: 90, now, busy: false })).toBe(false)
  expect(idleCompactDue({ lastTurnAt: now - 16 * 60_000, contextPct: 60, now, busy: false })).toBe(false)
  expect(idleCompactDue({ lastTurnAt: now - 16 * 60_000, contextPct: null, now, busy: false })).toBe(false)
  expect(idleCompactDue({ lastTurnAt: now - 16 * 60_000, contextPct: 90, now, busy: true })).toBe(false)
})

test("deliveryText / bootSeed / rolloverDue", () => {
  const turns = [{ id: "t1", text: "dispatch  the\nfix", createdAt: 1, card: { kind: "voice" } }, { id: "t2", text: "and?", createdAt: 2 }]
  expect(deliveryText(turns)).toBe("[turn t1] (voice) dispatch the fix\n[turn t2] and?")
  expect(bootSeed({ memoryRef: "RES-AAAA", open: turns })).toContain("Read your memory note RES-AAAA first.")
  expect(bootSeed({ memoryRef: null, open: [] })).toContain("No open turns.")
  const four = new Date(2026, 9, 28, 4, 5)
  expect(rolloverDue(four, null)).toBe(true)
  expect(rolloverDue(four, four.toISOString().slice(0, 10))).toBe(false)
  expect(rolloverDue(new Date(2026, 9, 28, 5, 0), null)).toBe(false)
})

describe("brainToolStep", () => {
  test("names the brain's tools in present and past tense", () => {
    expect(brainToolStep("Bash", { command: "./bin/thread 'shepherd'" })).toMatchObject({ kind: "searching", running: "Searching the thread", done: "Searched the thread" })
    expect(brainToolStep("Bash", { command: "bin/lead tls" })).toMatchObject({ kind: "dispatching", running: "Filing a lead" })
    expect(brainToolStep("Bash", { command: "ls" })).toMatchObject({ kind: "working", done: "Ran a command", detail: null })
    expect(brainToolStep("mcp__turso__note_update", { ref_code: "RES-1" })).toMatchObject({ kind: "writing", running: "Writing a note", detail: "RES-1" })
    expect(brainToolStep("mcp__turso__query", { sql: "SELECT 1" })).toMatchObject({ kind: "reading", running: "Reading notes" })
    expect(brainToolStep("mcp__claude_ai_Gmail__create_draft", {})).toMatchObject({ kind: "writing", running: "Drafting an email" })
    expect(brainToolStep("mcp__claude_ai_Gmail__get_draft", {})).toMatchObject({ kind: "reading", running: "Reading mail" })
    expect(brainToolStep("mcp__claude_ai_Gmail__send_message", {})).toMatchObject({ running: "Sending an email" })
    expect(brainToolStep("WebSearch", { query: "herdr states" })).toMatchObject({ kind: "searching", detail: "herdr states" })
    expect(brainToolStep("mcp__claude_ai_Google_Calendar__list_events", {})).toMatchObject({ kind: "working", running: "Using list events", done: "Used list events" })
  })
})
