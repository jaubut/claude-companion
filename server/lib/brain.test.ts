import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import {
  RESTART_WINDOW_MS, START_GRACE_MS, VOICE_CONSENT_MS,
  bootSeed, brainCommandAllowed, brainEnabled, brainToolVerdict, deliveryText, idleCompactDue, isBrainHook, isSupervisedTask,
  rolloverDue, superviseStep, voiceConsent,
} from "./brain"

// brain-v2 policy (lib/brain.ts): pure, so every rule is pinned here.

describe("brainToolVerdict", () => {
  test("edit tools and question tools are denied, whatever the input", () => {
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "AskUserQuestion"]) {
      expect(brainToolVerdict(t, { file_path: "/x" }).decision).toBe("deny")
    }
  })
  test("read tools, Turso reads + note writes, Gmail drafts are allowed; sending mail is not", () => {
    for (const t of ["Read", "Grep", "Glob", "WebSearch", "mcp__turso__query", "mcp__turso__note_update", "mcp__claude_ai_Gmail__create_draft"]) {
      expect(brainToolVerdict(t, {}).decision).toBe("allow")
    }
    for (const t of ["mcp__claude_ai_Gmail__send_message", "mcp__turso__exec", "Agent", "Task", "SomethingNew"]) {
      expect(brainToolVerdict(t, {}).decision).toBe("deny")
    }
  })
  test("Bash: bin/*, dispatch.sh, read-only git/gh — one command, no chaining", () => {
    const ok = [
      "bin/propose --turn t1 --note projects/x --prompt hi", "./bin/lead tls", "/srv/brain/bin/propose --turn a",
      "~/.claude/tools/dispatch.sh abc queued", "$HOME/.claude/tools/dispatch.sh abc", `${homedir()}/.claude/tools/dispatch.sh x`,
      "git status", "git log --oneline -5", "gh pr view 12 --json state", "gh run list",
    ]
    for (const c of ok) expect(brainCommandAllowed(c, homedir(), "/srv/brain")).toBe(true)
    const bad = [
      "rm -rf /", "git push origin main", "git commit -m x", "gh pr merge 12", "gh api -X POST /x",
      "git status; rm -rf ~", "git log | head", "bin/propose && rm x", "echo $(id)", "git diff > /tmp/x",
      "bin/../../etc/x", "curl http://x", "~/.claude/tools/dispatch.sh.evil", "",
    ]
    for (const c of bad) expect(brainCommandAllowed(c, homedir(), "/srv/brain")).toBe(false)
    expect(brainToolVerdict("Bash", { command: "git push" }).decision).toBe("deny")
    expect(brainToolVerdict("Bash", { command: "bin/propose --turn x" }).decision).toBe("allow")
  })
})

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
