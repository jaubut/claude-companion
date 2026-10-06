import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Transcript lookup for the test trigger, against a temp projects root (never
// the real ~/.claude).

const dir = mkdtempSync(join(tmpdir(), "auto-compact-wiring-"))
process.env.COMPANION_DB_PATH ??= join(dir, "test.db")
const { compactTargetForKey, findTranscriptSync } = await import("./auto-compact")
const { recordSession } = await import("../lib/sessions")
const { transcriptPath } = await import("../lib/session-titles")

function writeAt(path: string, mtimeSec: number): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "{}\n")
  utimesSync(path, mtimeSec, mtimeSec)
}

describe("findTranscriptSync", () => {
  test("cwd-derived path wins when it exists", () => {
    const root = mkdtempSync(join(dir, "p-"))
    const direct = transcriptPath("/work/a", "sid1", root)
    writeAt(direct, 1000)
    writeAt(join(root, "-elsewhere", "sid1.jsonl"), 2000)
    expect(findTranscriptSync("/work/a", "sid1", root)).toBe(direct)
  })

  test("falls back to the newest <sid>.jsonl under any project dir", () => {
    const root = mkdtempSync(join(dir, "p-"))
    writeAt(join(root, "-old", "sid2.jsonl"), 1000)
    writeAt(join(root, "-new", "sid2.jsonl"), 3000)
    writeAt(join(root, "-mid", "sid2.jsonl"), 2000)
    expect(findTranscriptSync("/work/b", "sid2", root)).toBe(join(root, "-new", "sid2.jsonl"))
  })

  test("neither found → the cwd path (test() then reports transcript_unreadable)", () => {
    const root = mkdtempSync(join(dir, "p-"))
    expect(findTranscriptSync("/work/c", "sid3", root)).toBe(transcriptPath("/work/c", "sid3", root))
    expect(findTranscriptSync("/work/c", "sid3", join(root, "missing"))).toBe(transcriptPath("/work/c", "sid3", join(root, "missing")))
  })
})

test("compactTargetForKey uses the fallback transcript", () => {
  const root = mkdtempSync(join(dir, "p-"))
  const elsewhere = join(root, "-resumed-from", "ac-wiring-sid.jsonl")
  writeAt(elsewhere, 1000)
  const s = recordSession({ cwd: "/tmp/ac-wiring", sessionId: "ac-wiring-sid", tty: "/dev/ttys901", agentStatus: "idle" })!
  expect(compactTargetForKey(s.key, root)?.transcriptPath).toBe(elsewhere)
})
