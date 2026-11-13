import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FeedEvent, appendFeedEvent, getFeed } from "./feed"
import { transcriptPath } from "./session-titles"
import { summarize } from "./tool-format"
import { HISTORY_MAX, eventsFromTranscript, historyFor, historyRows, type HistorySession } from "./transcript-backfill"

// After a restart the in-memory feed is empty, so an idle session's chat on a
// phone stayed empty. GET /api/sessions/history rebuilds its older rows from
// the transcript (historyFor), with ids stable across calls and nothing the
// feed replay already carries.

const SID = "6981d4c3-f227-4b0c-882f-1583741598b6"
const session: HistorySession = { key: "claude:tty:/dev/pts/4", agent: "claude", cwd: "/home/aubut/work", sessionId: SID, tty: "/dev/pts/4" }
const T0 = Date.parse("2026-10-26T17:03:00Z")
let dir = ""
let path = ""
let n = 0

const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const line = (o: Record<string, unknown>) => `${JSON.stringify({ uuid: `u-${++n}`, sessionId: SID, ...o })}\n`
const prompt = (s: number, text: string) => line({ type: "user", timestamp: at(s), message: { role: "user", content: text } })
const reply = (s: number, content: unknown[]) => line({ type: "assistant", timestamp: at(s), message: { role: "assistant", content } })
const toolResult = (s: number) => line({ type: "user", timestamp: at(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } })

function chalet(): void {
  writeFileSync(path, [
    line({ type: "permission-mode", permissionMode: "auto" }),
    prompt(0, "my friend is selling her chalet in Sutton"),
    reply(5, [{ type: "thinking", thinking: "look up comps" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls listings" } }]),
    toolResult(6),
    line({ type: "user", isMeta: true, timestamp: at(7), message: { role: "user", content: "<system-reminder>x</system-reminder>" } }),
    reply(10, [{ type: "text", text: "Priced about 8% over comps." }]),
  ].join(""))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backfill-"))
  path = transcriptPath(session.cwd, SID, dir)
  mkdirSync(join(path, ".."), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("transcript backfill", () => {
  test("after a restart (empty feed) a listed session's rows come back from its transcript", async () => {
    chalet()
    expect(getFeed().some((e) => e.sessionId === SID)).toBe(false)
    const rows = await historyFor(session, dir)
    expect(rows.map((e) => [e.kind, e.text ?? e.summary])).toEqual([
      ["user_prompt", "my friend is selling her chalet in Sutton"],
      ["assistant_thinking", "look up comps"],
      ["tool_start", summarize("Bash", { command: "ls listings" })],
      ["assistant_text", "Priced about 8% over comps."],
    ])
    for (const e of rows) expect(e).toMatchObject({ key: session.key, sessionId: SID, tty: "/dev/pts/4", cwd: session.cwd })
    expect(rows[0]!.ts).toBe(T0)
  })

  test("ids are stable across requests, so a replayed row is the same row", async () => {
    chalet()
    const a = await historyFor(session, dir)
    const b = await historyFor(session, dir)
    expect(b).toEqual(a)
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length)
    expect(a.every((e) => e.id.startsWith(`tx:${SID}:`))).toBe(true)
  })

  test("rows the feed already carries (live events, other ids) are not returned again", () => {
    chalet()
    appendFileSync(path, reply(60, [{ type: "text", text: "Want me to draft the offer?" }]))
    const ident = { cwd: session.cwd, tty: session.tty, sessionId: SID }
    // The live producers emitted the last reply (and a later prompt) with
    // random ids, ts a poll after the transcript line.
    const feed: FeedEvent[] = [
      { id: crypto.randomUUID(), ts: T0 + 61_500, kind: "assistant_text", text: "Want me to draft the offer?", ...ident },
      { id: crypto.randomUUID(), ts: T0 + 90_000, kind: "user_prompt", text: "yes", ...ident },
    ]
    for (const e of feed) appendFeedEvent(e)
    const rows = historyRows(path, session, getFeed())
    const texts = rows.map((e) => e.text ?? e.summary)
    expect(texts).not.toContain("Want me to draft the offer?")
    expect(texts).not.toContain("yes")
    expect(texts).toContain("Priced about 8% over comps.")
    // The client view: backfill rows then the feed's, no content twice.
    const all = [...rows, ...getFeed().filter((e) => e.sessionId === SID)].map((e) => `${e.kind}|${e.text ?? e.summary}`)
    expect(new Set(all).size).toBe(all.length)
  })

  test("only the newest 40 rows, from a bounded tail read", () => {
    writeFileSync(path, line({ type: "user", timestamp: at(0), message: { role: "user", content: "x".repeat(300_000) } }))
    for (let i = 1; i <= 100; i++) appendFileSync(path, prompt(i, `prompt ${i}`))
    const rows = historyRows(path, session, [], T0 + 1_000_000)
    expect(rows).toHaveLength(HISTORY_MAX)
    expect(rows[0]!.text).toBe("prompt 61")
    expect(rows.at(-1)!.text).toBe("prompt 100")
    // A tail shorter than the file never parses the cut first line.
    expect(eventsFromTranscript(path, session, 4096).every((e) => e.text !== "x".repeat(300_000))).toBe(true)
  })

  test("codex, a malformed session id, or a relative cwd yield nothing", async () => {
    chalet()
    expect(await historyFor({ ...session, agent: "codex" }, dir)).toEqual([])
    expect(await historyFor({ ...session, sessionId: "../../etc/passwd" }, dir)).toEqual([])
    expect(await historyFor({ ...session, cwd: "work" }, dir)).toEqual([])
  })

  test("no transcript on disk: nothing", async () => {
    expect(await historyFor(session, dir)).toEqual([])
  })

  test("Antigravity (agy/gemini) transcript steps map to FeedEvent rows", async () => {
    const { eventsFromAgyTranscript } = await import("./agy-feed")
    const agyFile = `${dir}/agy-transcript.jsonl`
    writeFileSync(agyFile, [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        created_at: at(0),
        content: "<USER_REQUEST>\nresume this session inside companion\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: at(1000),
        thinking: "Checking transcript backfill and discover.ts.",
        tool_calls: [{ name: "read_file", args: { Path: "\"/Users/jeremieaubut/claude-companion/server/routes/api.ts\"" } }],
        content: "Here is how we wire Antigravity sessions into Companion.",
      }),
    ].join("\n") + "\n")
    const rows = eventsFromAgyTranscript(agyFile, { ...session, agent: "gemini" })
    expect(rows.map((r) => r.kind)).toEqual(["user_prompt", "assistant_thinking", "tool_start", "assistant_text"])
    expect(rows[0]!.text).toBe("resume this session inside companion")
    expect(rows[3]!.text).toBe("Here is how we wire Antigravity sessions into Companion.")
  })

  test("Antigravity (agy/gemini) ask_question tool calls render in feed and raise live PendingQuestion", async () => {
    const { eventsFromAgyTranscript, syncAgyOpenQuestion } = await import("./agy-feed")
    const { getPendingQuestions } = await import("./questions")
    const agyFile = `${dir}/agy-ask-question.jsonl`
    const askStep = JSON.stringify({
      step_index: 10,
      type: "PLANNER_RESPONSE",
      created_at: at(2000),
      thinking: "Need clarification from Jeremie.",
      tool_calls: [{
        name: "ask_question",
        args: {
          questions: JSON.stringify([{
            is_multi_select: false,
            options: ["(Recommended) GCP Montréal", "Cloudflare Workers"],
            question: "Where should we land LE FAR?",
          }]),
        },
      }],
    })
    const answerStep = JSON.stringify({
      step_index: 11,
      type: "GENERIC",
      created_at: at(3000),
      content: "Created At: 2026-11-12T13:50:34-05:00\nCompleted At: 2026-11-12T13:51:13-05:00\nA1: (Recommended) GCP Montréal",
    })
    writeFileSync(agyFile, [askStep, answerStep].join("\n") + "\n")
    const rows = eventsFromAgyTranscript(agyFile, { ...session, agent: "gemini" })
    expect(rows.map((r) => r.kind)).toEqual(["assistant_thinking", "tool_start", "assistant_text", "user_prompt"])
    expect(rows[1]!.tool).toBe("ask_question")
    expect(rows[1]!.summary).toBe("Where should we land LE FAR?")
    expect(rows[2]!.text).toContain("**Where should we land LE FAR?**")
    expect(rows[2]!.text).toContain("1. (Recommended) GCP Montréal")
    expect(rows[3]!.text).toBe("A1: (Recommended) GCP Montréal")

    // Live PendingQuestion lifecycle: open when ask_question is the last step, cleared when answered
    const convo = { id: "agy-q-convo", title: "LE FAR", cwd: "/Users/jeremieaubut", status: "idle" as const, updatedAtMs: Date.now(), stepCount: 11 }
    const ident = { key: "gemini:sid:agy-q-convo", cwd: "/Users/jeremieaubut", sessionId: "agy-q-convo" }
    syncAgyOpenQuestion([askStep], convo, ident)
    const pending = getPendingQuestions().find((q) => q.sessionId === "agy-q-convo")
    expect(pending).toBeDefined()
    expect(pending?.agent).toBe("gemini")
    expect(pending?.questions[0]?.question).toBe("Where should we land LE FAR?")
    expect(pending?.questions[0]?.options.map((o) => o.label)).toEqual(["(Recommended) GCP Montréal", "Cloudflare Workers"])

    syncAgyOpenQuestion([askStep, answerStep], convo, ident)
    expect(getPendingQuestions().find((q) => q.sessionId === "agy-q-convo")).toBeUndefined()
  })

  test("Antigravity backgrounded tool (status: RUNNING) does not freeze delta cursor or keep completed turn busy", async () => {
    const {
      agyTranscriptPath,
      agyFullTranscriptPath,
      inferAgyTranscriptStatus,
      readAgyTranscriptDelta,
      resetAgyFeedStateForTests,
    } = await import("./agy-feed")
    resetAgyFeedStateForTests()

    const sid = "a63bd666-aeca-47af-9be5-5e494a36ecda"
    const txPath = agyTranscriptPath(sid, dir)
    const fullTxPath = agyFullTranscriptPath(sid, dir)
    mkdirSync(join(txPath, ".."), { recursive: true })

    const convo = {
      id: sid,
      title: "GCP Cloud Run Setup",
      cwd: "/Users/jeremieaubut",
      status: "busy" as const,
      updatedAtMs: Date.now(),
      stepCount: 2,
    }

    // Initial read before backgrounded command
    writeFileSync(txPath, [
      JSON.stringify({
        step_index: 8678,
        type: "USER_INPUT",
        status: "DONE",
        created_at: at(0),
        content: "<USER_REQUEST>\nim in\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 8679,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: at(1),
        thinking: "Checking gcloud auth.",
        tool_calls: [{ name: "default_api:run_command", args: { CommandLine: "\"gcloud projects list\"", toolSummary: "\"List GCP projects\"" } }],
      }),
    ].join("\n") + "\n")

    const firstBatch = readAgyTranscriptDelta(convo, dir)
    expect(firstBatch.map((e) => e.kind)).toEqual(["user_prompt", "assistant_thinking", "tool_start"])

    // Now Antigravity appends a backgrounded GENERIC step (status: "RUNNING" permanently in append-only JSONL)
    // followed by the completion and a truncated PLANNER_RESPONSE whose full text is in transcript_full.jsonl
    const fullProse = ("Awesome — `jeremie.aubut@gmail.com` is authenticated!\n\n" + "Detailed Cloud Run steps ".repeat(60)).trim()
    const truncatedProse = "Awesome — `jeremie.aubut@gmail.com` is authenticated!\n<truncated 829 bytes>\nDone!"

    writeFileSync(fullTxPath, [
      JSON.stringify({
        step_index: 8682,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: at(5),
        content: fullProse,
      }),
    ].join("\n") + "\n")

    // Simulate a phone-injected prompt already in the live feed
    const injectedId = crypto.randomUUID()
    appendFeedEvent({
      id: injectedId,
      ts: Date.parse(at(6)) + 200,
      kind: "user_prompt",
      text: "https://developers.google.com/profile/benefits return 404",
      cwd: convo.cwd,
      sessionId: sid,
    })

    appendFileSync(txPath, [
      JSON.stringify({
        step_index: 8680,
        type: "GENERIC",
        status: "RUNNING",
        created_at: at(2),
        content: "Created At: 2026-11-13T03:42:31-05:00\nTool is running as a background task with task id: 525120ff-c846-47e9-8dd6-f9ed66cb8bc8.",
      }),
      JSON.stringify({
        step_index: 8681,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: at(4),
        content: "<SYSTEM_MESSAGE>\nBackground task finished\n</SYSTEM_MESSAGE>",
      }),
      JSON.stringify({
        step_index: 8682,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: at(5),
        content: truncatedProse,
        truncated_fields: ["content"],
      }),
      JSON.stringify({
        step_index: 8683,
        type: "USER_INPUT",
        status: "DONE",
        created_at: at(6),
        content: "<USER_REQUEST>\nhttps://developers.google.com/profile/benefits return 404\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 8684,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: at(7),
        content: "Use https://developers.google.com/profile/u/0/benefits instead!",
      }),
    ].join("\n") + "\n")

    const secondBatch = readAgyTranscriptDelta({ ...convo, status: "idle", stepCount: 7 }, dir)
    // Should emit tool_end for 8680, full untruncated assistant_text for 8682, skip duplicate injected user_prompt 8683, and emit assistant_text for 8684
    expect(secondBatch.map((e) => e.kind)).toEqual(["tool_end", "assistant_text", "assistant_text"])
    expect(secondBatch[0]!.outputExcerpt).toBe("Running in background")
    expect(secondBatch[1]!.text).toBe(fullProse)
    expect(secondBatch[1]!.text).not.toContain("<truncated ")
    expect(secondBatch[2]!.text).toBe("Use https://developers.google.com/profile/u/0/benefits instead!")

    // Verify inferAgyTranscriptStatus reports "idle" even though step 8680 had status:"RUNNING"
    expect(inferAgyTranscriptStatus(sid, dir, true)).toBe("idle")
  })
})
