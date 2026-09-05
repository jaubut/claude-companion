import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-titles-")), "companion.db")
const titles = await import("./session-titles")

test("titleFromPrompt names a chat after a real prompt, never a command or fragment", () => {
  expect(titles.titleFromPrompt("  Fix the   invoice PDF export ")).toBe("Fix the invoice PDF export")
  expect(titles.titleFromPrompt("/clear")).toBeNull()
  expect(titles.titleFromPrompt("!ls -la")).toBeNull()
  expect(titles.titleFromPrompt("<command-name>/exit</command-name>")).toBeNull()
  expect(titles.titleFromPrompt("<system-reminder>\nstuff\n</system-reminder>\nyo, we need to find which day we film")).toBe("yo, we need to find which day we film")
  expect(titles.titleFromPrompt("<ide_opened_file>a.ts</ide_opened_file> fix the export")).toBe("fix the export")
  expect(titles.titleFromPrompt("<local-command-stdout>ok</local-command-stdout>")).toBeNull()
  expect(titles.titleFromPrompt("ok")).toBeNull()
  const long = titles.titleFromPrompt("Use the AskUserQuestion tool right now, before anything else, to ask me two questions")
  expect(long!.length).toBeLessThanOrEqual(titles.TITLE_MAX + 1)
  expect(long!.endsWith("…")).toBe(true)
  expect(long).toBe("Use the AskUserQuestion tool right now, before…")
})

test("titles persist by session id", () => {
  expect(titles.storedTitle("sid-1")).toBeNull()
  titles.rememberTitle("sid-1", "Ship the thing")
  expect(titles.storedTitle("sid-1")).toBe("Ship the thing")
  titles.rememberTitle("sid-1", "Ship the other thing")
  expect(titles.storedTitle("sid-1")).toBe("Ship the other thing")
  titles.rememberTitle("", "ignored")
  expect(titles.storedTitle("")).toBeNull()
})

test("titleFromTranscript skips summaries, injected XML and tool results, takes the first real prompt", async () => {
  const projects = mkdtempSync(join(tmpdir(), "cc-projects-"))
  const dir = join(projects, "-home-aubut")
  mkdirSync(dir)
  const lines = [
    JSON.stringify({ type: "summary", summary: "not this" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Rename the camera files for the BRP shoot" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "later prompt" } }),
  ]
  writeFileSync(join(dir, "abc.jsonl"), lines.join("\n") + "\n")
  expect(await titles.titleFromTranscript("/home/aubut", "abc", projects)).toBe("Rename the camera files for the BRP shoot")
  expect(await titles.titleFromTranscript("/home/aubut", "missing", projects)).toBeNull()
  // started elsewhere: the file lives under another project dir → still found
  expect(await titles.titleFromTranscript("/home/aubut/lanes/qa", "abc", projects)).toBe("Rename the camera files for the BRP shoot")
  expect(titles.transcriptPath("/home/aubut/lanes/qa", "s1", "/p")).toBe("/p/-home-aubut-lanes-qa/s1.jsonl")
})
