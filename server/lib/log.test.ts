import { expect, test } from "bun:test"
import { companionLog, formatLogLines, logPrefix } from "./log"

test("prefix carries an ISO UTC timestamp before [companion]", () => {
  const p = logPrefix(new Date("2026-09-24T12:34:56.789Z"))
  expect(p).toBe("\x1b[2m2026-09-24T12:34:56.789Z [companion]\x1b[0m")
})

test("companionLog writes one timestamped line to stderr", () => {
  const orig = process.stderr.write.bind(process.stderr)
  const out: string[] = []
  process.stderr.write = ((chunk: string) => { out.push(chunk); return true }) as typeof process.stderr.write
  try {
    companionLog("\x1b[32mdelivered (tmux)\x1b[0m → %89")
  } finally {
    process.stderr.write = orig
  }
  expect(out).toHaveLength(1)
  expect(out[0]).toMatch(/^\x1b\[2m\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[companion\]\x1b\[0m \x1b\[32mdelivered \(tmux\)\x1b\[0m → %89\n$/)
})

test("every physical line of a multiline message is timestamped", () => {
  const now = new Date("2026-09-24T12:34:56.789Z")
  const p = logPrefix(now)
  expect(formatLogLines("first\nsecond\n  at stack (x.ts:1)", now)).toBe(`${p} first\n${p} second\n${p}   at stack (x.ts:1)\n`)
})

test("a single-line message is unchanged in shape", () => {
  const now = new Date("2026-09-24T12:34:56.789Z")
  expect(formatLogLines("ok", now)).toBe(`${logPrefix(now)} ok\n`)
})
