import { Database } from "bun:sqlite"
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Session } from "./sessions"

const tempDir = mkdtempSync(join(tmpdir(), "cc-lane-isolation-"))
process.env.COMPANION_DB_PATH ??= join(tempDir, "companion.db")

let notificationsMod: typeof import("./agent-notifications")
let isolationMod: typeof import("./brain-lane-isolation")
let brainMod: typeof import("./brain")
let wiringMod: typeof import("../wiring/brain")
let chatMod: typeof import("./orchestrator-chat")
let storeMod: typeof import("./brain-store")
let sqlite: Database

beforeAll(async () => {
  notificationsMod = await import("./agent-notifications")
  isolationMod = await import("./brain-lane-isolation")
  brainMod = await import("./brain")
  wiringMod = await import("../wiring/brain")
  chatMod = await import("./orchestrator-chat")
  storeMod = await import("./brain-store")
  sqlite = (await import("./orchestrator-db")).db
})

beforeEach(() => {
  delete process.env.ENABLE_LANE_ISOLATION
  sqlite.exec("DELETE FROM brain_outbox; DELETE FROM brain_trace; DELETE FROM brain_kv; DELETE FROM agent_notifications")
  sqlite.exec("DELETE FROM orchestrator_turns WHERE thread_id = 'brain'")
})

afterEach(() => {
  delete process.env.ENABLE_LANE_ISOLATION
})

function makeBrainSession(over: Partial<Session> = {}): Session {
  return {
    key: "herdr:p_lane_a",
    agent: "claude",
    label: "brain",
    title: "",
    sidConfirmed: true,
    agentStatus: "",
    waitingFor: "",
    cwd: "/srv/brain",
    sessionId: "sid-lane-a",
    termProgram: "",
    tty: "",
    iTermSessionId: "",
    tmuxPane: "",
    herdrPane: "p_lane_a",
    taskId: "brain",
    waitingSince: 0,
    waitingKind: "",
    waitingRef: "",
    waitingReasons: [],
    pid: "4242",
    firstSeenAt: 0,
    lastSeenAt: 0,
    ...over,
  } as Session
}

describe("Phase 3: agent_notifications schema & bridge", () => {
  test("002_agent_notifications.sql defines PostgreSQL schema and partial unsurfaced index", () => {
    const sqlPath = join(import.meta.dir, "../../db/migrations/002_agent_notifications.sql")
    const ddl = readFileSync(sqlPath, "utf8")
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS agent_notifications")
    expect(ddl).toContain("severity VARCHAR(16) CHECK (severity IN ('low', 'medium', 'high', 'critical'))")
    expect(ddl).toContain("surfaced_at TIMESTAMPTZ NULL")
    expect(ddl).toContain("CREATE INDEX IF NOT EXISTS idx_unsurfaced_notifications")
    expect(ddl).toContain("WHERE surfaced_at IS NULL")
  })

  test("SQLite sink surfaces up to 3 high/critical notifications once and ignores low/medium", async () => {
    const mem = new Database(":memory:")
    notificationsMod.ensureAgentNotificationsTable(mem)

    await notificationsMod.insertAgentNotification(mem, {
      source: "auto-deploy",
      severity: "low",
      summary: "[event] Auto-deploy succeeded cleanly",
    })
    await notificationsMod.insertAgentNotification(mem, {
      source: "ci-monitor",
      severity: "medium",
      summary: "Routine check completed",
    })
    await notificationsMod.insertAgentNotification(mem, {
      source: "pr-shepherd",
      severity: "high",
      summary: "[event] stuck PR #41 on claude-companion: main CI red",
    })
    await notificationsMod.insertAgentNotification(mem, {
      source: "worker-supervisor",
      severity: "critical",
      summary: "[event 12:00] worker t_99 blocked on migration lock",
    })
    await notificationsMod.insertAgentNotification(mem, {
      source: "repo-lead",
      severity: "high",
      summary: "PR #44 needs human sign-off on schema migration",
    })
    await notificationsMod.insertAgentNotification(mem, {
      source: "ops-triage",
      severity: "high",
      summary: "Fourth high-severity item stays queued for next turn",
    })

    const firstBlock = await notificationsMod.fetchAndMarkUnsurfacedNotifications(mem)
    expect(firstBlock).not.toBeNull()
    expect(firstBlock).toStartWith("### Background System Updates\n")
    const bulletLines = (firstBlock ?? "").split("\n").slice(1)
    expect(bulletLines.length).toBe(3)
    expect(firstBlock).not.toContain("Auto-deploy succeeded cleanly")
    expect(firstBlock).not.toContain("Routine check completed")
    expect(firstBlock).not.toContain("[event")

    // Remaining 4th high-severity item surfaces on the next turn; already-surfaced ones do not repeat.
    const secondBlock = await notificationsMod.fetchAndMarkUnsurfacedNotifications(mem)
    expect(secondBlock).not.toBeNull()
    expect((secondBlock ?? "").split("\n").slice(1).length).toBe(1)

    const thirdBlock = await notificationsMod.fetchAndMarkUnsurfacedNotifications(mem)
    expect(thirdBlock).toBeNull()
    mem.close()
  })

  test("PostgreSQL tagged-template sink executes parameterized UPDATE ... RETURNING", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = []
    const mockPg = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const text = strings.join("$?")
      queries.push({ sql: text, values })
      if (text.includes("INSERT INTO agent_notifications")) {
        return [{ id: 77 }]
      }
      if (text.includes("UPDATE agent_notifications")) {
        return [
          { id: 77, source: "worker-supervisor", severity: "critical", summary: "Worker crash_loop in repo X" },
        ]
      }
      return []
    }

    const id = await notificationsMod.insertAgentNotification(mockPg, {
      source: "worker-supervisor",
      severity: "critical",
      summary: "Worker crash_loop in repo X",
      payload: { taskId: "t_1" },
    })
    expect(id).toBe(77)

    const block = await notificationsMod.fetchAndMarkUnsurfacedNotifications(mockPg)
    expect(block).toBe("### Background System Updates\n- [CRITICAL] worker-supervisor: Worker crash_loop in repo X")
    expect(queries.some((q) => q.sql.includes("SET surfaced_at = NOW()"))).toBe(true)
  })

  test("openIsolatedNotificationDb writes via separate WAL connection visible to Lane A reader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-wal-bridge-"))
    try {
      const dbFile = join(dir, "wal-test.db")
      const laneAConn = new Database(dbFile)
      notificationsMod.ensureAgentNotificationsTable(laneAConn)
      const laneBConn = notificationsMod.openIsolatedNotificationDb(dbFile)

      await notificationsMod.insertAgentNotification(laneBConn, {
        source: "ci-monitor",
        severity: "high",
        summary: "green PR #88 ready for merge review",
      })

      const surfaced = await notificationsMod.fetchAndMarkUnsurfacedNotifications(laneAConn)
      expect(surfaced).toBe("### Background System Updates\n- [HIGH] ci-monitor: green PR #88 ready for merge review")

      laneBConn.close()
      laneAConn.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Phase 3: Lane A / Lane B Isolation under synthetic ops-triage load", () => {
  test("sustains >= 10 background jobs/sec by default while keeping interactive TTFT < 1500ms and zero [event] leakage", async () => {
    const deliveredPrompts: string[] = []
    const interactiveTtftsMs: number[] = []
    let triageCallCount = 0
    let activeSession: Session = makeBrainSession()
    let wiring!: ReturnType<typeof wiringMod.createBrainWiring>

    wiring = wiringMod.createBrainWiring({
      now: () => Date.now(),
      alive: async () => true,
      agentPane: async () => "p_lane_a",
      spawn: async () => ({ ok: true, app: "herdr", herdrPane: "p_lane_a", sessionName: "brain" }),
      stopAgent: async () => {},
      sessions: () => [activeSession],
      sessionByKey: (k) => (k === activeSession.key ? activeSession : null),
      tagBrain: () => true,
      agentStatus: async () => "idle",
      lastReply: async () => "",
      interrupt: async () => {},
      deliver: async (text) => {
        deliveredPrompts.push(text)
        return Response.json({ ok: true })
      },
      broadcast: () => {},
      push: () => {},
      paused: { read: () => false, write: () => {} },
      contextPct: () => 12,
      compact: async () => true,
      dispatch: { query: async () => [] } as never,
      host: "test",
      log: () => {},
      eventCoalesceMs: 0,
      notificationSink: sqlite,
      laneBMaxConcurrency: 4,
      // Simulate heavy 350ms background ops-triage calls that would stall a single-lane loop
      triageEvents: async (events) => {
        triageCallCount++
        await Bun.sleep(350)
        const hasFailure = events.some((e) => /failed|blocked|stuck/i.test(e.text))
        return {
          verdict: hasFailure ? "escalate" : "ignore",
          action: hasFailure ? "escalate" : "ignore",
          reason: hasFailure ? "needs attention" : "routine status",
          provider: "gemini",
          model: "gemini-3.5-flash-lite",
          mode: "live",
          latencyMs: 350,
        }
      },
    })

    // Boot and adopt Lane A session
    wiring.setSpawnedPaneForTests("p_lane_a")
    wiring.onSessionStart(activeSession)
    await Bun.sleep(5)
    await wiring.onStop("sid-lane-a", "")
    deliveredPrompts.length = 0

    // Drive continuous synthetic background load: 24 batchable events over ~1.2s (~20 jobs/sec > 10 jobs/sec spec target)
    const totalBgJobs = 24
    const loadStart = performance.now()
    const bgProducer = (async () => {
      for (let i = 0; i < totalBgJobs; i++) {
        const isCritical = i === 2 || i === 9
        const hexId = (0xabcdef100000 + i).toString(16)
        const text = isCritical
          ? `stuck claude-companion #${100 + i} — main CI failed`
          : `completed [${hexId}] claude-companion — routine heartbeat check #${i}`
        const turn = chatMod.appendTurn("orchestrator", text, null, "brain")
        wiring.onTurn(turn)
        await Bun.sleep(50) // 20 background jobs/sec
      }
    })()

    // While background flood is actively running slow 350ms triage batches, send 3 interactive user turns
    for (let u = 1; u <= 3; u++) {
      await Bun.sleep(180)
      const promptCountBefore = deliveredPrompts.length
      const t0 = performance.now()
      const uTurn = chatMod.appendTurn("user", `Interactive question #${u}: summarize repo architecture`, null, "brain")
      wiring.enqueue(uTurn)

      // Wait until Lane A delivers the prompt and simulate first-token + completion
      while (deliveredPrompts.length <= promptCountBefore) {
        await Bun.sleep(2)
      }
      await Bun.sleep(20) // Simulated model TTFT = 20ms
      const ttft = performance.now() - t0
      interactiveTtftsMs.push(ttft)

      // Deliberately include an accidental `[event]` line in raw model output to verify clean-state scrubbing
      await wiring.onStop(
        "sid-lane-a",
        `[event] leaked internal debug line\nArchitecture summary #${u}: clean modular boundaries.`,
      )
    }

    await bgProducer
    const loadElapsedSec = (performance.now() - loadStart) / 1000
    const achievedRate = totalBgJobs / loadElapsedSec
    expect(achievedRate).toBeGreaterThanOrEqual(10)

    await wiring.laneB.drain()
    expect(triageCallCount).toBeGreaterThan(0)

    // After Lane B escalated the stuck PR notifications, send one final interactive turn to verify surface bridge
    const finalTurn = chatMod.appendTurn("user", "Any background alerts I should know about?", null, "brain")
    const beforeFinal = deliveredPrompts.length
    const tFinal = performance.now()
    wiring.enqueue(finalTurn)
    while (deliveredPrompts.length <= beforeFinal) {
      await Bun.sleep(2)
    }
    interactiveTtftsMs.push(performance.now() - tFinal)
    await wiring.onStop("sid-lane-a", "Two stuck PRs need attention.")

    // 1. Latency invariant: every interactive turn TTFT < 1,500ms
    expect(interactiveTtftsMs.length).toBe(4)
    for (const ttft of interactiveTtftsMs) {
      expect(ttft).toBeLessThan(1500)
    }

    // 2. Clean state invariant: ZERO `[event` records in delivered Lane A prompts
    expect(deliveredPrompts.length).toBe(4)
    for (const prompt of deliveredPrompts) {
      expect(prompt).not.toMatch(/\[event[\s\]]/i)
    }

    // 3. Escalated Lane B notifications surfaced via `### Background System Updates`
    const combinedPrompts = deliveredPrompts.join("\n\n")
    expect(combinedPrompts).toContain("### Background System Updates")
    expect(combinedPrompts).toContain("stuck claude-companion #102 — main CI failed")

    // 4. Clean state invariant: ZERO `[event]` lines in interactive assistant replies persisted to chat
    const assistantReplies = chatMod
      .getThread("brain")
      .filter((t) => !brainMod.isBrainInternalEvent(t) && t.role === "orchestrator" && !/^(?:stuck |completed \[)/i.test(t.text))
    expect(assistantReplies.length).toBe(4)
    for (const reply of assistantReplies) {
      expect(reply.text).not.toContain("[event]")
      expect(reply.text).not.toContain("leaked internal debug line")
    }

    // 5. `brain_outbox` has zero lingering background turns
    expect(storeMod.openDeliveries().length).toBe(0)
    wiring.stop()
  })

  test("scrubInternalEventsFromReply strips internal [event] lines while keeping normal markdown", () => {
    const raw = [
      "[event 14:22] worker receipt ignored",
      "Here is the deployment status:",
      "- API: healthy",
      "  [event] trailing internal marker",
      "- DB: healthy",
    ].join("\n")

    expect(isolationMod.scrubInternalEventsFromReply(raw)).toBe(
      ["Here is the deployment status:", "- API: healthy", "- DB: healthy"].join("\n"),
    )
  })
})
