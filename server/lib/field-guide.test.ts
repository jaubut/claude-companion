import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FIELD_GUIDE_MAX_CHARS, FIELD_GUIDE_MAX_LINES, composeWorkerPrompt, readFieldGuide } from "./field-guide"
import { WORKER_FOOTER } from "./worker-invocation"

const HEADER = "## Repo Field Guide (FIELD_GUIDE.md - operational traps)"
let dir = ""
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "field-guide-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("readFieldGuide", () => {
  test("wraps the file, strips HTML comments, trims", () => {
    writeFileSync(join(dir, "FIELD_GUIDE.md"), "<!-- maintainer note\nspans lines -->\n\n- trap one\n- trap two\n\n")
    expect(readFieldGuide(dir)).toBe(`${HEADER}\n- trap one\n- trap two`)
  })

  test("caps at 100 lines and 6,000 chars", () => {
    writeFileSync(join(dir, "FIELD_GUIDE.md"), Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n"))
    const lines = readFieldGuide(dir)!.split("\n")
    expect(lines).toHaveLength(FIELD_GUIDE_MAX_LINES + 1)
    expect(lines.at(-1)).toBe("line 100")
    writeFileSync(join(dir, "FIELD_GUIDE.md"), "x".repeat(10_000))
    expect(readFieldGuide(dir)!.length).toBe(HEADER.length + 1 + FIELD_GUIDE_MAX_CHARS)
  })

  test("null when missing, empty, comment-only, a directory, or a symlink (even one inside the worktree)", () => {
    expect(readFieldGuide(dir)).toBeNull()
    writeFileSync(join(dir, "FIELD_GUIDE.md"), "<!-- nothing -->\n")
    expect(readFieldGuide(dir)).toBeNull()
    rmSync(join(dir, "FIELD_GUIDE.md"))
    mkdirSync(join(dir, "FIELD_GUIDE.md"))
    expect(readFieldGuide(dir)).toBeNull()
    rmSync(join(dir, "FIELD_GUIDE.md"), { recursive: true })
    writeFileSync(join(dir, "real.md"), "- inside")
    symlinkSync(join(dir, "real.md"), join(dir, "FIELD_GUIDE.md"))
    expect(readFieldGuide(dir)).toBeNull()
  })

  test("a symlink out of the worktree is never read", () => {
    const outside = mkdtempSync(join(tmpdir(), "field-guide-out-"))
    try {
      writeFileSync(join(outside, "secret.md"), "- secret")
      symlinkSync(join(outside, "secret.md"), join(dir, "FIELD_GUIDE.md"))
      expect(readFieldGuide(dir)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("composeWorkerPrompt", () => {
  const base = { prompt: "Do it", worktree: "", branchNote: "", designContext: "", maxChars: 100_000 }
  test("turn 1: brief, guide, design context, footer; resume skips the guide; slash commands pass through", () => {
    writeFileSync(join(dir, "FIELD_GUIDE.md"), "- trap")
    const o = { ...base, worktree: dir, designContext: "DESIGN" }
    expect(composeWorkerPrompt({ ...o, resume: false })).toBe(`Do it\n\n${HEADER}\n- trap\n\nDESIGN\n\n${WORKER_FOOTER}`)
    expect(composeWorkerPrompt({ ...o, resume: true })).toBe(`Do it\n\nDESIGN\n\n${WORKER_FOOTER}`)
    expect(composeWorkerPrompt({ ...o, resume: false, prompt: "/review" })).toBe("/review")
  })

  test("never exceeds maxChars", () => {
    writeFileSync(join(dir, "FIELD_GUIDE.md"), "x".repeat(5_000))
    const out = composeWorkerPrompt({ ...base, worktree: dir, resume: false, prompt: "p".repeat(2_000), maxChars: 3_000 })
    expect(out.length).toBeLessThanOrEqual(3_000)
    expect(out.endsWith(WORKER_FOOTER)).toBe(true)
  })
})
