import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BRAIN_DIR } from "../wiring/brain-headless"
import { prepareBrainTurn } from "./brain-turn-harness"
import {
  type Message,
  filterInteractiveMessages,
  pruneContext,
  stripStackTraces,
  turnsToInteractiveMessages,
} from "./context-pruning"
import { history } from "./orchestrator-brain"
import type { Turn } from "./orchestrator-chat"
import {
  foldColdSessionSummary,
  getSessionSummary,
  upsertSessionSummary,
} from "./session-summaries"

describe("Phase 2: Tiered Context Pruning, Cold Summaries & Thought Signature Preservation", () => {
  test("prunes 35-turn context with large 50KB tool outputs strictly below 24,000 token ceiling while keeping latest tool output verbatim", () => {
    const syntheticHistory: Message[] = Array.from({ length: 35 }).flatMap((_, i) => [
      { id: i * 2, role: "user" as const, content: `User prompt turn ${i}` },
      {
        id: i * 2 + 1,
        role: "tool" as const,
        toolName: "grep_repo",
        content: "X".repeat(50_000), // 50KB payload
      },
    ])

    const result = pruneContext(syntheticHistory, "Existing cold summary", 24_000)

    expect(result.estimatedTokens).toBeLessThan(24_000)
    const lastToolCall = result.messages[result.messages.length - 1]!
    expect(lastToolCall.content.length).toBe(50_000)
    expect(result.coldSummaryMarkdown).toBe("Existing cold summary")
    expect(result.coldSummarySystemBlock).toContain("### Cold Session Summary")
  })

  test("preserves latest 6 turns (including latest 4 turns) verbatim with stack traces and thoughtSignature integrity while compacting Warm and folding Cold", () => {
    const stackTraceSample = [
      "Error: Connection reset by peer",
      "    at Socket.onError (/app/server/net.ts:42:13)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n")

    const sigBase = "Et4BCtYBAXLI2ny/verbatim+thought+sig=="
    // Build 36 conversational turns (user -> assistant with thoughtSignature + tool -> assistant)
    const messages: Message[] = []
    let nextId = 0
    for (let turn = 0; turn < 36; turn++) {
      messages.push({
        id: nextId++,
        role: "user",
        content: `Turn ${turn} user ask`,
      })
      messages.push({
        id: nextId++,
        role: "assistant",
        content: `Turn ${turn} investigating.\n${stackTraceSample}`,
        thoughtSignature: `${sigBase}${turn}`,
        parts: [
          {
            thought: true,
            text: `Reasoning for turn ${turn}`,
            thoughtSignature: `${sigBase}${turn}`,
          },
          {
            functionCall: { name: "read_logs", args: { turn } },
            thoughtSignature: `${sigBase}${turn}`,
          },
          {
            // Parallel function call with no signature must remain without signature
            functionCall: { name: "check_metrics", args: { turn } },
          },
        ],
      })
      messages.push({
        id: nextId++,
        role: "tool",
        toolName: "read_logs",
        content: `Log line for turn ${turn}: ${"L".repeat(600)}\n${stackTraceSample}`,
      })
    }

    const res = pruneContext(messages, "Summary of turns 0..20", 24_000)
    expect(res.estimatedTokens).toBeLessThan(24_000)

    // Cold Window: oldest 21 turns (turns 0..20 => 63 messages) moved to coldMessages
    expect(res.coldMessages).toHaveLength(21 * 3)
    expect(res.coldMessages[0]!.content).toBe("Turn 0 user ask")

    // Active messages = 9 Warm turns (27 messages) + 6 Hot turns (18 messages) = 45 messages
    expect(res.messages).toHaveLength(15 * 3)

    // Warm Window (first 27 active messages, turns 21..29):
    // - Assistant text retained, stack trace lines stripped
    // - Tool output > 300 chars compacted to 1-line deterministic stub
    const warmAssistant = res.messages[1]!
    expect(warmAssistant.content).toContain("Turn 21 investigating.")
    expect(warmAssistant.content).not.toContain("at Socket.onError")

    const warmTool = res.messages[2]!
    expect(warmTool.content).toMatch(/^\[tool: read_logs -> \d+ bytes, \d+ lines; compacted\]$/)

    // Hot Window (last 6 turns = last 18 messages, turns 30..35 — covers latest 4 turns AND latest 6 turns):
    // - Stack traces preserved verbatim
    // - Full >600-char tool outputs preserved verbatim
    // - thoughtSignature preserved byte-for-byte verbatim without copying onto sibling parallel call
    const hotSlice = res.messages.slice(-18)
    for (let offset = 0; offset < 6; offset++) {
      const turnNum = 30 + offset
      const hotUser = hotSlice[offset * 3]!
      const hotAssistant = hotSlice[offset * 3 + 1]!
      const hotTool = hotSlice[offset * 3 + 2]!

      expect(hotUser.content).toBe(`Turn ${turnNum} user ask`)
      expect(hotAssistant.content).toContain("at Socket.onError")
      expect(hotAssistant.thoughtSignature).toBe(`${sigBase}${turnNum}`)
      expect(hotAssistant.parts?.[0]?.thoughtSignature).toBe(`${sigBase}${turnNum}`)
      expect(hotAssistant.parts?.[1]?.thoughtSignature).toBe(`${sigBase}${turnNum}`)
      expect("thoughtSignature" in (hotAssistant.parts?.[2] ?? {})).toBe(false)
      expect(hotTool.content.length).toBeGreaterThan(600)
      expect(hotTool.content).toContain("at Socket.onError")
    }
  })

  test("stripStackTraces removes JS and Python stack frames while keeping headline prose", () => {
    const raw = [
      "Database query failed: timeout",
      "    at Client.query (/srv/db.ts:19:7)",
      "Traceback (most recent call last):",
      '  File "/srv/worker.py", line 88, in run',
      "Caused by: ETIMEDOUT",
      "Please retry with backoff.",
    ].join("\n")
    expect(stripStackTraces(raw)).toBe("Database query failed: timeout\nPlease retry with backoff.")
  })

  test("Event Log Hygiene Directive: excludes [event], webhooks, heartbeats, and internal Brain wakes from interactive transcripts", () => {
    const mixedMessages: Message[] = [
      { id: 1, role: "user", content: "Deploy status?" },
      { id: 2, role: "assistant", content: "[event e-1] PR ready [abc] repo — https://github.com/jaubut/r/pull/1" },
      { id: 3, role: "assistant", content: "[heartbeat] worker alive" },
      { id: 4, role: "assistant", content: "[ci-webhook] workflow green" },
      { id: 5, role: "assistant", content: "All services are healthy on Zettlab." },
    ]
    const filtered = filterInteractiveMessages(mixedMessages)
    expect(filtered.map((m) => m.id)).toEqual([1, 5])
    expect(pruneContext(mixedMessages).messages.map((m) => m.id)).toEqual([1, 5])

    const turns: Turn[] = [
      { id: "t1", threadId: "brain", role: "user", text: "Any blockers?", taskId: null, createdAt: 1 },
      { id: "t2", threadId: "brain", role: "orchestrator", text: "stuck jaubut/claude-companion#380 — CI red", taskId: null, createdAt: 2 },
      { id: "t3", threadId: "brain", role: "orchestrator", text: "[from lead-claude-companion] merge ready", taskId: null, createdAt: 3 },
      { id: "t4", threadId: "brain", role: "orchestrator", text: "No blockers right now.", taskId: null, createdAt: 4 },
    ]
    const cleanFromTurns = turnsToInteractiveMessages(turns)
    expect(cleanFromTurns.map((m) => m.content)).toEqual(["Any blockers?", "No blockers right now."])

    const renderedHistory = history(turns, { ENABLE_CONTEXT_PRUNING: "true" })
    expect(renderedHistory).toContain("user: Any blockers?")
    expect(renderedHistory).toContain("orchestrator: No blockers right now.")
    expect(renderedHistory).not.toContain("stuck jaubut")
    expect(renderedHistory).not.toContain("[from lead-")
  })

  test("001_session_summaries.sql migration and session_summaries store support PostgreSQL and bun:sqlite plus rolling cold fold", async () => {
    const sqlPath = join(import.meta.dir, "..", "..", "db", "migrations", "001_session_summaries.sql")
    const ddl = readFileSync(sqlPath, "utf8")
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS session_summaries")
    expect(ddl).toContain("session_id VARCHAR(128) PRIMARY KEY")
    expect(ddl).toContain("summarized_up_to_turn_id INT NOT NULL")
    expect(ddl).toContain("summary_markdown TEXT NOT NULL")

    // PostgreSQL tagged-template mock
    let pgSql = ""
    let pgArgs: Array<string | number> = []
    const pgSink = async (strings: TemplateStringsArray, ...values: readonly (string | number)[]) => {
      pgSql = strings.join("?")
      pgArgs = [...values]
      return [{ session_id: "sess-pg", summarized_up_to_turn_id: 14, summaryMarkdown: undefined, summary_markdown: "- Prior context" }]
    }
    await upsertSessionSummary(pgSink, {
      sessionId: "sess-pg",
      summarizedUpToTurnId: 14,
      summaryMarkdown: "- Prior context",
    })
    expect(pgSql).toContain("INSERT INTO session_summaries")
    expect(pgArgs).toEqual(["sess-pg", 14, "- Prior context"])
    const pgLoaded = await getSessionSummary(pgSink, "sess-pg")
    expect(pgLoaded).toMatchObject({ sessionId: "sess-pg", summarizedUpToTurnId: 14, summaryMarkdown: "- Prior context" })

    // Local bun:sqlite rolling fold + prepareBrainTurn suffix injection without breaking prefix invariance
    const memDb = new Database(":memory:")
    const folded1 = await foldColdSessionSummary({
      sessionId: "sess-cold-1",
      sink: memDb,
      coldMessages: [
        { id: 0, role: "user", content: "Set up billing webhook" },
        { id: 1, role: "assistant", content: "Dispatched builder on task 11aa22bb" },
      ],
    })
    expect(folded1?.summarizedUpToTurnId).toBe(1)
    expect(folded1?.summaryMarkdown).toContain("Set up billing webhook")

    // Re-running with same turn IDs is a no-op; adding turn 2 advances cursor
    let summarizerCalls = 0
    const folded2 = await foldColdSessionSummary({
      sessionId: "sess-cold-1",
      sink: memDb,
      coldMessages: [
        { id: 0, role: "user", content: "Set up billing webhook" },
        { id: 1, role: "assistant", content: "Dispatched builder on task 11aa22bb" },
        { id: 2, role: "tool", toolName: "propose", content: '{"status":"queued"}' },
      ],
      summarizer: async (_msgs, prior, model) => {
        summarizerCalls++
        expect(model).toBe("gemini-3.5-flash-lite")
        return `${prior}\n- Queued billing webhook proposal.`
      },
    })
    expect(summarizerCalls).toBe(1)
    expect(folded2?.summarizedUpToTurnId).toBe(2)
    expect(folded2?.summaryMarkdown).toContain("Queued billing webhook proposal.")

    // Verify prepareBrainTurn strips mixed [event] lines and places Cold Session Summary strictly after ---
    const prepared = prepareBrainTurn({
      userText: "[event e-99] PR ready [abc] repo\n[turn t-10] What did we queue earlier?",
      family: "gemini",
      bootPrefixSent: false,
      legacyAgyBootPrefix: "",
      brainDir: BRAIN_DIR,
      sessionId: "sess-cold-1",
      summaryDb: memDb,
      env: { ENABLE_DYNAMIC_SKILLS: "true", ENABLE_CONTEXT_PRUNING: "true" },
    })
    expect(prepared.promptToSend).toContain("### Cold Session Summary")
    expect(prepared.promptToSend).toContain("Queued billing webhook proposal.")
    expect(prepared.promptToSend).toContain("[turn t-10] What did we queue earlier?")
    expect(prepared.promptToSend).not.toContain("[event e-99]")
    memDb.close()
  })
})
