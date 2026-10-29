import { describe, expect, test } from "bun:test"
import {
  type SweepView, type WorkerFacts, SETTLED_SWEEPS, WORKER_GRACE_MS, classifyBrainWs, classifyWorker, envValue, reapMode, settledNow, workerLabel,
} from "./brain-workers"

// brain-workers policy (lib/brain-workers.ts): the verdict table from the
// Change Plan's Verify 1. Pure — no herdr, no db.

const TASK = "0123456789abcdef0123456789abcdef"
const NOW = 1_800_000_000_000

const brainWs = (o: Partial<SweepView> = {}): SweepView => ({
  workspaceId: "w34", label: "brain", paneCount: 1, pane: "w34:p1", agentStatus: "unknown", atShell: true,
  env: ["HOME=/home/j", "COMPANION_TASK_ID=brain"], ...o,
})
const workerWs = (o: Partial<SweepView> = {}): SweepView => ({
  workspaceId: "w50", label: workerLabel(TASK), paneCount: 1, pane: "w50:p1", agentStatus: "done", atShell: false,
  env: [`DISPATCH_TASK_ID=${TASK}`, "DISPATCH_WORKER=1"], ...o,
})
const facts = (o: Partial<WorkerFacts> = {}): WorkerFacts => ({
  proposal: { proposalId: "a1b2c3d4", threadId: "brain" }, snapshotOk: true,
  task: { phase: "pr", updatedAt: NOW - WORKER_GRACE_MS - 1 }, settledSweeps: SETTLED_SWEEPS, now: NOW, ...o,
})
const LIVE = { workspaceIds: ["w40"], panes: ["w40:p1"] }

describe("reapMode", () => {
  test("observe by default; only exact on/off switch it", () => {
    expect(reapMode(undefined)).toBe("observe")
    expect(reapMode("")).toBe("observe")
    expect(reapMode("yes")).toBe("observe")
    expect(reapMode("on")).toBe("on")
    expect(reapMode(" OFF ")).toBe("off")
  })
})

describe("classifyBrainWs", () => {
  test("non-current brain workspace at its shell with env brain → close", () => {
    expect(classifyBrainWs(brainWs(), LIVE)).toEqual({ verdict: "close", reason: "brain leftover", owned: true })
  })
  test("current brain workspace (agent's workspace or a brain session's pane) → keep self", () => {
    expect(classifyBrainWs(brainWs({ workspaceId: "w40", pane: "w40:p1" }), LIVE).reason).toBe("self")
    expect(classifyBrainWs(brainWs(), { workspaceIds: [], panes: ["w34:p1"] }).reason).toBe("self")
  })
  test("cc-* / builder-* / tko-* → keep, foreign", () => {
    for (const label of ["cc-work", "builder-mac-wt-x", "tko-mac-a617f2e8"]) {
      expect(classifyBrainWs(brainWs({ label, env: [] }), LIVE)).toMatchObject({ verdict: "keep", owned: false })
      expect(classifyWorker(brainWs({ label, env: [] }), facts())).toMatchObject({ verdict: "keep", owned: false })
    }
  })
  test("a `brain` label without the brain env → keep, foreign", () => {
    expect(classifyBrainWs(brainWs({ env: ["HOME=/x"] }), LIVE)).toMatchObject({ verdict: "keep", owned: false })
  })
  test("pane_count 2 → keep; claude still in front → keep; env unreadable → keep; brain state unknown → keep", () => {
    expect(classifyBrainWs(brainWs({ paneCount: 2 }), LIVE).verdict).toBe("keep")
    expect(classifyBrainWs(brainWs({ atShell: false }), LIVE).verdict).toBe("keep")
    expect(classifyBrainWs(brainWs({ atShell: null }), LIVE).verdict).toBe("keep")
    expect(classifyBrainWs(brainWs({ env: null }), LIVE)).toMatchObject({ verdict: "keep", reason: "env unreadable" })
    expect(classifyBrainWs(brainWs(), null)).toMatchObject({ verdict: "keep", reason: "brain state unknown" })
  })
})

describe("classifyWorker", () => {
  test("terminal ≥ grace + settled ×2 → close", () => {
    expect(classifyWorker(workerWs(), facts())).toEqual({ verdict: "close", reason: "finished (pr)", owned: true })
    for (const phase of ["completed", "done", "failed", "cancelled"]) expect(classifyWorker(workerWs(), facts({ task: { phase, updatedAt: 0 } })).verdict).toBe("close")
  })
  test("the grace is 2 minutes past Turso updated_at", () => {
    expect(WORKER_GRACE_MS).toBe(120_000)
    expect(classifyWorker(workerWs(), facts({ task: { phase: "pr", updatedAt: NOW - 119_000 } }))).toMatchObject({ verdict: "keep", reason: "pr, in grace" })
  })
  test("dispatch workspace of a non-brain task → keep, foreign", () => {
    expect(classifyWorker(workerWs(), facts({ proposal: { proposalId: "x", threadId: "general" } }))).toMatchObject({ verdict: "keep", owned: false })
    expect(classifyWorker(workerWs(), facts({ proposal: null }))).toMatchObject({ verdict: "keep", owned: false })
  })
  test("a label that doesn't match its DISPATCH_TASK_ID → keep, foreign", () => {
    expect(classifyWorker(workerWs({ label: "dispatch-ffffffff" }), facts())).toMatchObject({ verdict: "keep", owned: false })
  })
  test("brain task running / blocked / queued → keep", () => {
    for (const phase of ["running", "blocked", "queued", "pending", "none"]) {
      expect(classifyWorker(workerWs(), facts({ task: { phase, updatedAt: 0 } }))).toMatchObject({ verdict: "keep", reason: `running (${phase})` })
    }
  })
  test("pane_count 2 → keep; not yet settled twice → keep", () => {
    expect(classifyWorker(workerWs({ paneCount: 2 }), facts()).verdict).toBe("keep")
    expect(classifyWorker(workerWs(), facts({ settledSweeps: 1 }))).toMatchObject({ verdict: "keep", reason: "settling" })
  })
  test("env unreadable → keep; snapshot null → keep; task unknown → keep", () => {
    expect(classifyWorker(workerWs({ env: null }), facts()).verdict).toBe("keep")
    expect(classifyWorker(workerWs(), facts({ snapshotOk: false }))).toMatchObject({ verdict: "keep", reason: "dispatch state unknown" })
    expect(classifyWorker(workerWs(), facts({ task: null }))).toMatchObject({ verdict: "keep", reason: "task unknown" })
  })
  test("a done trace row never decides: Turso `queued` (requeued) → keep", () => {
    // The trace row is not an input at all: only the live Turso phase is.
    expect(classifyWorker(workerWs(), facts({ task: { phase: "queued", updatedAt: 0 } })).verdict).toBe("keep")
  })
  test("manual (the brain asked): no grace, a settled read now is enough", () => {
    const fresh = facts({ task: { phase: "pr", updatedAt: NOW }, settledSweeps: 0, manual: true })
    expect(classifyWorker(workerWs(), fresh).verdict).toBe("close")
    expect(classifyWorker(workerWs({ agentStatus: "working" }), fresh)).toMatchObject({ verdict: "keep", reason: "settling" })
  })
})

describe("settledNow / envValue", () => {
  test("done / idle, or no agent with the shell in front", () => {
    expect(settledNow(workerWs({ agentStatus: "idle" }))).toBe(true)
    expect(settledNow(workerWs({ agentStatus: "unknown", atShell: true }))).toBe(true)
    expect(settledNow(workerWs({ agentStatus: "unknown", atShell: false }))).toBe(false)
    expect(settledNow(workerWs({ agentStatus: "working", atShell: true }))).toBe(false)
  })
  test("null env stays null (unreadable); a missing key is ''", () => {
    expect(envValue(null, "X")).toBeNull()
    expect(envValue(["A=1"], "X")).toBe("")
    expect(envValue(["X=a=b"], "X")).toBe("a=b")
  })
})
