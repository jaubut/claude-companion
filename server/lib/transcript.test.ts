import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getState, readTranscriptDelta, hashText } from "./transcript"
import { onFeed, type FeedEvent } from "./feed"

// Pins the contract recordTurnEnd's retry depends on: the delta reader
// returns how many blocks it emitted, dedupes by hash, primes silently, and
// keeps the token high-water mark. Real files, real feed store.

const dir = mkdtempSync(join(tmpdir(), "cc-transcript-"))
const line = (o: unknown) => JSON.stringify(o) + "\n"
const assistant = (text: string, tokens = 0) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], usage: { output_tokens: tokens } } })

function capture(): { events: FeedEvent[]; off: () => void } {
  const events: FeedEvent[] = []
  const off = onFeed((ev) => { events.push(ev) })
  return { events, off }
}

test("returns the number of blocks emitted; a re-read emits nothing new", () => {
  const path = join(dir, "a.jsonl")
  writeFileSync(path, line({ type: "user", message: { role: "user", content: "hi" } }) + assistant("first") + assistant("second"))
  const s = getState({ transcriptPath: path, tty: "/dev/t1", cwd: "/x" })
  const { events, off } = capture()
  expect(readTranscriptDelta(s)).toBe(2)
  expect(events.map((e) => e.text)).toEqual(["first", "second"])
  expect(s.streamedThisTurn).toBe(true)
  expect(readTranscriptDelta(s)).toBe(0) // deduped by hash
  appendFileSync(path, assistant("third"))
  expect(readTranscriptDelta(s)).toBe(1) // the late-flushed block counts
  off()
})

test("silent read primes the seen set without emitting", () => {
  const path = join(dir, "b.jsonl")
  writeFileSync(path, assistant("already on screen"))
  const s = getState({ transcriptPath: path, tty: "/dev/t2", cwd: "/x" })
  const { events, off } = capture()
  expect(readTranscriptDelta(s, { silent: true })).toBe(0)
  expect(events).toHaveLength(0)
  expect(s.streamedThisTurn).toBe(false)
  expect(s.seenAssistantText.has(hashText("already on screen"))).toBe(true)
  expect(readTranscriptDelta(s)).toBe(0) // primed → never echoed later
  off()
})

test("token count is a high-water mark across entries", () => {
  const path = join(dir, "c.jsonl")
  writeFileSync(path, assistant("a", 500) + assistant("b", 200))
  const s = getState({ transcriptPath: path, tty: "/dev/t3", cwd: "/x" })
  readTranscriptDelta(s, { silent: true })
  expect(s.lastTokens).toBe(500)
})

test("getState migrates a weak-keyed record when the transcript path arrives", () => {
  const weak = getState({ tty: "/dev/t4", cwd: "/x" })
  weak.turnStartedAt = 42
  const strong = getState({ tty: "/dev/t4", cwd: "/x", transcriptPath: join(dir, "d.jsonl") })
  expect(strong).toBe(weak)
  expect(strong.transcriptPath).toBe(join(dir, "d.jsonl"))
  expect(strong.turnStartedAt).toBe(42)
})
